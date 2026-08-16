/** Electron implementation of the launcher-provided desktop runtime capability. */

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  Tray,
} from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stat, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CancellationToken } from 'builder-util-runtime'
import electronUpdater from 'electron-updater'
import { desktopTerminalStateDirectory, openDesktopTerminal } from './desktop-terminal.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import type {
  DesktopNotification,
  DesktopPlatform,
  DesktopRuntime,
  DesktopShellSpec,
  DesktopTerminalSpec,
  DesktopThemeSource,
  DesktopTrayItem,
  DesktopTrayItemGroup,
  DesktopTrayItemRegistration,
  DesktopUpdateAdapter,
} from './runtime.ts'
import { prepareTrayIcon } from './tray-icons.ts'
import {
  DesktopUpdateFailure,
  MAX_AUTOMATIC_UPDATE_BYTES,
  type DesktopUpdaterAdapter,
} from './update-controller.ts'
import {
  DESKTOP_RELEASE_URL,
  type DesktopUpdateInstallMode,
} from './update-contract.ts'
import { desktopWindowOptions } from './window-options.ts'

const { autoUpdater } = electronUpdater
const UPDATE_DISK_RESERVE_BYTES = 512 * 1024 * 1024
const UPDATE_INSTALL_HANDOFF_TIMEOUT_MS = 120_000

/** Match electron-updater's platform cache root for capacity checks. */
function updaterCacheBase(): string {
  const home = homedir()
  if (process.platform === 'win32') return process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches')
  return process.env.XDG_CACHE_HOME ?? join(home, '.cache')
}

/** Return the presentation mode opposite the active generation. */
export function nextDesktopShellMode(mode: DesktopShellSpec['mode']): DesktopShellSpec['mode'] {
  return mode === 'compatibility' ? 'advanced' : 'compatibility'
}

/** Return the tray command describing the mode that will be activated. */
export function modeToggleLabel(mode: DesktopShellSpec['mode']): string {
  return mode === 'compatibility'
    ? 'Switch to Advanced Mode'
    : 'Switch to Compatibility Mode'
}

/**
 * Read the desktop package version instead of Electron's development-app version.
 * @param moduleUrl - module below the package's `src` or `lib` directory.
 * @returns validated desktop product version.
 */
export function desktopProductVersion(moduleUrl: string = import.meta.url): string {
  const value = desktopProductManifest(moduleUrl)
  if (typeof value.version !== 'string') {
    throw new Error('dsh-plugin-desktop: package.json has no product version')
  }
  return value.version
}

/**
 * Read the updater capability embedded by the release build.
 * @param moduleUrl - module below the package's `src` or `lib` directory.
 * @param packaged - whether the running application is packaged.
 * @param platform - current Electron platform.
 * @returns installation capability safe for this running artifact.
 */
export function desktopProductUpdateMode(
  moduleUrl: string = import.meta.url,
  packaged = app.isPackaged,
  platform: NodeJS.Platform = process.platform,
): DesktopUpdateInstallMode {
  if (!packaged) return 'unsupported'
  if (platform !== 'darwin' && platform !== 'win32') return 'manual'
  return desktopProductManifest(moduleUrl).desktopUpdateMode === 'automatic' ? 'automatic' : 'manual'
}

function desktopProductManifest(moduleUrl: string): { version?: unknown; desktopUpdateMode?: unknown } {
  const value: unknown = JSON.parse(readFileSync(new URL('../package.json', moduleUrl), 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dsh-plugin-desktop: package.json is not an object')
  }
  return value as { version?: unknown; desktopUpdateMode?: unknown }
}

const PRODUCT_VERSION = desktopProductVersion()

/** Native adapter used by the DSH Desktop launcher and owned by its Cordis shell plugin. */
export class ElectronDesktopRuntime implements DesktopRuntime {
  readonly platform: DesktopPlatform
  readonly updates: DesktopUpdateAdapter

  private window: BrowserWindow | undefined
  private tray: Tray | undefined
  private scheduled: DesktopShellSpec | undefined
  private mountTask: Promise<void> | undefined
  private release: (() => Promise<void>) | undefined
  private quitting = false
  private updateInstallRequested = false
  private releasePageOpened = false
  private readonly trayItems = new Map<symbol, DesktopTrayItem>()
  private terminalSpec: DesktopTerminalSpec | undefined

  constructor(private readonly restart: () => Promise<void>) {
    if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') {
      throw new Error(`dsh-plugin-desktop: unsupported Electron platform ${process.platform}`)
    }
    this.platform = process.platform
    this.updates = this.createDesktopUpdateAdapter()
  }

  /** @inheritdoc */
  schedule(spec: DesktopShellSpec): () => Promise<void> {
    if (this.scheduled !== undefined || this.mountTask !== undefined) {
      throw new Error('dsh-plugin-desktop: a native shell generation is already registered')
    }
    const previousThemeSource = nativeTheme.themeSource
    this.scheduled = spec
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      try {
        await this.mountTask
      } finally {
        try {
          await this.release?.()
        } finally {
          this.release = undefined
          this.mountTask = undefined
          if (this.scheduled === spec) {
            if (spec.mode === 'advanced') nativeTheme.themeSource = previousThemeSource
            this.scheduled = undefined
          }
        }
      }
    }
  }

  /** @inheritdoc */
  mountScheduled(beforeInteractive?: () => void): Promise<void> {
    const spec = this.scheduled
    if (spec === undefined) {
      return Promise.reject(new Error('dsh-plugin-desktop: the Cordis shell plugin did not register a window'))
    }
    this.mountTask ??= this.mount(spec, beforeInteractive).then((release) => { this.release = release })
    return this.mountTask
  }

  /** @inheritdoc */
  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /** @inheritdoc */
  registerTrayItem(item: DesktopTrayItem): DesktopTrayItemRegistration {
    const key = Symbol()
    this.trayItems.set(key, item)
    this.rebuildTrayMenu()
    let active = true
    return {
      refresh: () => {
        if (active) this.rebuildTrayMenu()
      },
      dispose: () => {
        if (!active) return
        active = false
        this.trayItems.delete(key)
        this.rebuildTrayMenu()
      },
    }
  }

  /**
   * Fix the profile identity before Cordis plugins can contribute terminal commands.
   * @param spec - launcher-resolved desktop profile and Harness home.
   */
  configureTerminal(spec: DesktopTerminalSpec): void {
    if (this.terminalSpec !== undefined) {
      throw new Error('dsh-plugin-desktop: terminal profile is already configured')
    }
    this.terminalSpec = { ...spec }
  }

  /** @inheritdoc */
  openTerminal(): void {
    try {
      const spec = this.terminalSpec
      if (spec === undefined) {
        throw new Error('dsh-plugin-desktop: terminal profile is not configured')
      }
      const electronVersion = process.versions.electron
      if (electronVersion === undefined) {
        throw new Error('dsh-plugin-desktop: terminal requires the Electron runtime version')
      }
      openDesktopTerminal({
        platform: this.platform,
        appExecutable: process.execPath,
        dshBootstrapPath: fileURLToPath(new URL('./desktop-cli.js', import.meta.url)),
        pnpmBinPath: packagedDependencyPath(import.meta.url, 'pnpm/bin/pnpm.mjs'),
        electronVersion,
        profileName: spec.profileName,
        productVersion: PRODUCT_VERSION,
        profileDir: spec.profileDir,
        homeDir: spec.homeDir,
        stateDir: desktopTerminalStateDirectory(app.getPath('userData'), spec.profileName),
        spawn,
        onLaunchError: cause => { this.reportTerminalLaunchError(cause) },
      })
    } catch (cause) {
      this.reportTerminalLaunchError(cause)
    }
  }

  /** @inheritdoc */
  setThemeSource(source: DesktopThemeSource): void {
    if (this.scheduled?.mode === 'advanced' && this.window !== undefined) {
      nativeTheme.themeSource = source
    }
  }

  /** @inheritdoc */
  async requestRestart(): Promise<void> {
    await this.restart()
  }

  /** @inheritdoc */
  prepareToQuit(): void {
    this.quitting = true
  }

  private contributedTrayItems(group: DesktopTrayItemGroup): Electron.MenuItemConstructorOptions[] {
    return [...this.trayItems.values()]
      .filter(item => item.group === group)
      .sort((left, right) => left.order - right.order)
      .map((item): Electron.MenuItemConstructorOptions => {
        const common = {
          label: item.label(),
          enabled: item.enabled?.() ?? true,
        }
        if (item.submenu !== undefined) {
          return {
            ...common,
            submenu: item.submenu().map(command => ({
              label: command.label(),
              enabled: command.enabled?.() ?? true,
              ...(command.type === undefined ? {} : { type: command.type }),
              ...(command.checked === undefined ? {} : { checked: command.checked() }),
              click: this.trayCommand(() => command.invoke()),
            })),
          }
        }
        return {
          ...common,
          click: this.trayCommand(() => item.invoke()),
        }
      })
  }

  /** Contain asynchronous contribution failures outside Electron menu callbacks. */
  private trayCommand(invoke: () => void | Promise<void>): () => void {
    return () => {
      void Promise.resolve().then(invoke).catch((cause: unknown) => {
        process.stderr.write(`dsh-plugin-desktop: tray command failed: ${cause instanceof Error ? cause.message : String(cause)}\n`)
      })
    }
  }

  private showNotification(notification: DesktopNotification): void {
    if (!Notification.isSupported()) return
    const nativeNotification = new Notification({
      title: notification.title,
      body: notification.body,
    })
    nativeNotification.show()
  }

  /** Build the Electron updater surface once for this process. */
  private createDesktopUpdateAdapter(): DesktopUpdateAdapter {
    const updater = this.createUpdaterAdapter()
    return {
      get isPackaged() { return app.isPackaged },
      get currentVersion() { return PRODUCT_VERSION },
      get installMode() { return desktopProductUpdateMode() },
      ...(updater === undefined ? {} : { updater }),
      createCancellation: () => new CancellationToken(),
      requestInstall: async () => { await this.requestUpdateInstall() },
      openReleasePage: async () => { await this.openUpdateReleasePage() },
      notify: notification => { this.showNotification(notification) },
    }
  }

  /** Restrict electron-updater to stable GitHub releases and bounded full downloads. */
  private createUpdaterAdapter(): DesktopUpdaterAdapter | undefined {
    if (!app.isPackaged || (this.platform !== 'darwin' && this.platform !== 'win32')) return undefined
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.disableWebInstaller = true
    autoUpdater.disableDifferentialDownload = true
    const updaterEvents = autoUpdater as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): void
      off(event: string, listener: (...args: unknown[]) => void): void
    }
    return {
      on(event, listener) { updaterEvents.on(event, listener) },
      off(event, listener) { updaterEvents.off(event, listener) },
      async checkForUpdates() {
        const result = await autoUpdater.checkForUpdates()
        if (result === null) return null
        const info = result.updateInfo as typeof result.updateInfo & { readonly desktopUpdateMode?: unknown }
        return {
          updateInfo: {
            version: info.version,
            ...(info.desktopUpdateMode === undefined ? {} : { desktopUpdateMode: info.desktopUpdateMode }),
            files: info.files.map(file => ({ size: file.size })),
          },
        }
      },
      async downloadUpdate(cancellation, expectedBytes) {
        const cacheStats = await statfs(updaterCacheBase())
        const availableBytes = BigInt(cacheStats.bavail) * BigInt(cacheStats.bsize)
        const requiredBytes = BigInt(
          Math.max(expectedBytes * 2, MAX_AUTOMATIC_UPDATE_BYTES * 2) + UPDATE_DISK_RESERVE_BYTES,
        )
        if (availableBytes < requiredBytes) {
          throw new DesktopUpdateFailure(
            'insufficient-space',
            'Insufficient disk space for an automatic update.',
          )
        }
        const downloadedFiles = await autoUpdater.downloadUpdate(cancellation as CancellationToken)
        const downloadedStats = await Promise.all(downloadedFiles.map(async path => await stat(path)))
        if (downloadedStats.some(value => value.size > MAX_AUTOMATIC_UPDATE_BYTES)) {
          throw new DesktopUpdateFailure(
            'download-too-large',
            'The downloaded update exceeded the automatic download limit.',
          )
        }
      },
    }
  }

  /** Begin Host teardown before native update handoff. */
  private async requestUpdateInstall(): Promise<void> {
    const spec = this.scheduled
    if (spec === undefined) throw new Error('dsh-plugin-desktop: no active shell can exit for update installation')
    if (this.updateInstallRequested) return
    this.updateInstallRequested = true
    this.quitting = true
    this.window?.hide()
    spec.requestQuit(0)
  }

  /** Open the fixed public release page at most once per application lifetime. */
  private async openUpdateReleasePage(): Promise<void> {
    if (this.releasePageOpened) return
    this.releasePageOpened = true
    try {
      await shell.openExternal(DESKTOP_RELEASE_URL)
    } catch (cause) {
      this.releasePageOpened = false
      throw cause
    }
  }

  /** Complete ordinary exit or hand a downloaded update to electron-updater. */
  finishNativeExit(code: number): void {
    if (!this.updateInstallRequested || code !== 0) {
      app.exit(code)
      return
    }
    const fallback = (cause: unknown): void => {
      process.stderr.write(
        `dsh-plugin-desktop: update install handoff failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      )
      app.exit(1)
    }
    const timeout = setTimeout(() => {
      fallback(new Error('update install handoff timed out'))
    }, UPDATE_INSTALL_HANDOFF_TIMEOUT_MS)
    const release = (): void => {
      clearTimeout(timeout)
      autoUpdater.off('error', fail)
      app.off('before-quit', release)
    }
    const fail = (cause: Error): void => {
      release()
      fallback(cause)
    }
    autoUpdater.once('error', fail)
    app.once('before-quit', release)
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (cause) {
      release()
      fallback(cause)
    }
  }

  /** Keep native-terminal launch failures visible in a packaged GUI process. */
  private reportTerminalLaunchError(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    process.stderr.write(`dsh-plugin-desktop: failed to open terminal: ${error.message}\n`)
    try {
      dialog.showErrorBox('Unable to Open DSH Terminal', error.message)
    } catch (dialogCause) {
      process.stderr.write(`dsh-plugin-desktop: failed to show terminal error: ${dialogCause instanceof Error ? dialogCause.message : String(dialogCause)}\n`)
    }
  }

  private rebuildTrayMenu(): void {
    const tray = this.tray
    const spec = this.scheduled
    if (tray === undefined || spec === undefined) return

    const show = (): void => { this.show() }
    const tools = this.contributedTrayItems('tools')
    const profiles = this.contributedTrayItems('profiles')
    const status = this.contributedTrayItems('status')
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: `Open ${spec.productName}`, click: show },
    ]
    if (tools.length > 0) template.push({ type: 'separator' }, ...tools)
    if (profiles.length > 0) template.push({ type: 'separator' }, ...profiles)
    if (status.length > 0) template.push({ type: 'separator' }, ...status)
    template.push(
      { type: 'separator' },
      {
        label: modeToggleLabel(spec.mode),
        enabled: this.platform !== 'linux',
        click: () => {
          void spec.requestModeChange(nextDesktopShellMode(spec.mode)).catch((cause: unknown) => {
            process.stderr.write(`dsh-plugin-desktop: failed to change shell mode: ${cause instanceof Error ? cause.message : String(cause)}\n`)
          })
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { spec.requestQuit(0) } },
    )
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  private async mount(
    spec: DesktopShellSpec,
    beforeInteractive: (() => void) | undefined,
  ): Promise<() => Promise<void>> {
    const icon = nativeImage.createFromPath(spec.iconPath)
    if (icon.isEmpty()) {
      throw new Error(`dsh-plugin-desktop: failed to load application icon ${spec.iconPath}`)
    }
    if (this.platform === 'darwin') app.dock?.setIcon(icon)
    const origin = new URL(spec.url).origin
    if (spec.mode === 'advanced') nativeTheme.themeSource = spec.readThemeSource()
    const window = new BrowserWindow(desktopWindowOptions(spec, icon, this.platform))
    window.accessibleTitle = spec.windowTitle
    if (this.platform === 'win32') window.removeMenu()
    this.window = window

    const show = (): void => { this.show() }
    const close = (event: Electron.Event): void => {
      if (this.quitting) return
      event.preventDefault()
      window.hide()
    }
    const preserveBlankTitle = (event: Electron.Event): void => { event.preventDefault() }
    const navigate = (event: Electron.Event<{ url: string }>): void => {
      let targetOrigin: string | undefined
      try {
        targetOrigin = new URL(event.url).origin
      } catch {
        targetOrigin = undefined
      }
      if (targetOrigin !== origin) event.preventDefault()
    }

    app.on('activate', show)
    window.on('close', close)
    window.on('page-title-updated', preserveBlankTitle)
    window.webContents.on('will-frame-navigate', navigate)
    window.webContents.on('will-redirect', navigate)
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url)
        if (target.protocol === 'https:' || target.protocol === 'http:' || target.protocol === 'mailto:') {
          void shell.openExternal(target.href).catch((cause: unknown) => {
            process.stderr.write(`dsh-plugin-desktop: failed to open external link: ${cause instanceof Error ? cause.message : String(cause)}\n`)
          })
        }
      } catch {
        // A malformed target is rejected with the same deny result.
      }
      return { action: 'deny' }
    })

    window.once('ready-to-show', show)
    let tray: Tray | undefined
    try {
      await window.loadURL(spec.url)
      tray = new Tray(prepareTrayIcon(spec.trayIcons, this.platform))
      this.tray = tray
      tray.setToolTip(spec.productName)
      this.rebuildTrayMenu()
      tray.on('click', show)
      beforeInteractive?.()
    } catch (cause) {
      app.off('activate', show)
      window.off('page-title-updated', preserveBlankTitle)
      tray?.off('click', show)
      tray?.destroy()
      window.destroy()
      this.tray = undefined
      this.window = undefined
      throw cause
    }

    if (tray === undefined) {
      throw new Error('dsh-plugin-desktop: native tray did not mount')
    }
    const mountedTray = tray

    let released = false
    return async () => {
      if (released) return
      released = true
      app.off('activate', show)
      window.off('close', close)
      window.off('page-title-updated', preserveBlankTitle)
      window.webContents.off('will-frame-navigate', navigate)
      window.webContents.off('will-redirect', navigate)
      mountedTray.off('click', show)
      mountedTray.destroy()
      if (!window.isDestroyed()) window.destroy()
      if (this.tray === mountedTray) this.tray = undefined
      if (this.window === window) this.window = undefined
    }
  }
}
