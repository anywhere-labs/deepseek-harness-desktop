import { lstat } from 'node:fs/promises'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
} from 'electron'
import { DESKTOP_ARTIFACT_CONTEXT_MENU_CHANNEL } from './artifact-context-menu-contract.ts'
import { desktopArtifactRevealCopy, resolveDesktopArtifactPath } from './artifact-reveal.ts'
import { formatDesktopExitCode } from './desktop-logger.ts'
import type { ElectronPlatformStrategy } from './electron-platform.ts'
import type { DesktopLocale, DesktopShellSpec } from './runtime.ts'
import { prepareTrayIcon } from './tray-icons.ts'
import { desktopWindowOptions } from './window-options.ts'

const MIN_ZOOM_LEVEL = -4
const MAX_ZOOM_LEVEL = 4

function clampedZoomLevel(level: number): number {
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level))
}

function isZoomShortcut(input: Electron.Input): 'in' | 'out' | 'reset' | undefined {
  if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return undefined
  if (input.key === '+' || input.key === '=') return 'in'
  if (input.key === '-' || input.key === '_') return 'out'
  if (input.key === '0') return 'reset'
  return undefined
}

export interface ElectronShellGenerationOptions {
  readonly platform: ElectronPlatformStrategy
  readonly spec: DesktopShellSpec
  readonly preloadPath: string
  readonly isQuitting: () => boolean
  readonly buildTrayTemplate: () => Electron.MenuItemConstructorOptions[]
  readonly readLocale: () => DesktopLocale
  readonly stopRendererBootMonitoring: () => void
  readonly failRendererBoot: (error: string) => void
  readonly logError: (message: string) => void
}

/** Own one BrowserWindow and Tray generation, including every native listener. */
export class ElectronShellGeneration {
  private window: BrowserWindow | undefined
  private tray: Tray | undefined
  private mounted = false
  private released = false
  private cleanupListeners: (() => void) | undefined

  constructor(private readonly options: ElectronShellGenerationOptions) {}

  async mount(beforeInteractive?: () => void): Promise<void> {
    if (this.mounted || this.window !== undefined) {
      throw new Error('dsh-plugin-desktop: native shell generation is already mounted')
    }

    const { platform, spec } = this.options
    const icon = nativeImage.createFromPath(spec.iconPath)
    if (icon.isEmpty()) {
      throw new Error(`dsh-plugin-desktop: failed to load application icon ${spec.iconPath}`)
    }
    platform.configureApplication(icon)
    const origin = new URL(spec.url).origin
    if (spec.mode === 'advanced') nativeTheme.themeSource = spec.readThemeSource()
    const window = new BrowserWindow(desktopWindowOptions(spec, icon, platform.platform, this.options.preloadPath))
    window.accessibleTitle = spec.windowTitle
    platform.configureWindow(window)
    this.window = window

    const show = (): void => { this.show() }
    const close = (event: Electron.Event): void => {
      if (this.options.isQuitting()) return
      event.preventDefault()
      window.hide()
    }
    const preserveBlankTitle = (event: Electron.Event): void => { event.preventDefault() }
    const handleZoomShortcut = (event: Electron.Event, input: Electron.Input): void => {
      const action = isZoomShortcut(input)
      if (action === undefined) return
      event.preventDefault()
      if (action === 'reset') {
        window.webContents.setZoomLevel(0)
        return
      }
      const step = action === 'in' ? 1 : -1
      window.webContents.setZoomLevel(clampedZoomLevel(window.webContents.getZoomLevel() + step))
    }
    const navigate = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>): void => {
      if (!event.isMainFrame) return
      let targetOrigin: string | undefined
      try {
        targetOrigin = new URL(event.url).origin
      } catch {
        targetOrigin = undefined
      }
      if (targetOrigin !== origin) event.preventDefault()
    }
    const redirect = (
      event: Electron.Event,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (!isMainFrame) return
      let targetOrigin: string | undefined
      try {
        targetOrigin = new URL(url).origin
      } catch {
        targetOrigin = undefined
      }
      if (targetOrigin !== origin) event.preventDefault()
    }
    const rendererGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
      const detail = `renderer process gone (reason: ${details.reason}, exitCode: ${formatDesktopExitCode(details.exitCode)})`
      this.options.logError(`dsh-plugin-desktop: ${detail}`)
      this.options.failRendererBoot(detail)
    }
    const loadFailed = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      this.options.logError(`dsh-plugin-desktop: renderer failed to load (${errorCode}: ${errorDescription})`)
      if (isMainFrame === true && errorCode !== -3) {
        this.options.failRendererBoot(
          `renderer main frame failed to load (${String(errorCode)}: ${errorDescription})`,
        )
      }
    }
    let artifactContextMenuRegistered = false
    const showArtifactContextMenu = async (
      event: Electron.IpcMainInvokeEvent,
      request: unknown,
    ): Promise<void> => {
      let senderOrigin: string | undefined
      try {
        senderOrigin = event.senderFrame === null ? undefined : new URL(event.senderFrame.url).origin
      } catch {
        senderOrigin = undefined
      }
      if (event.sender !== window.webContents || senderOrigin !== origin) {
        throw new Error('dsh-plugin-desktop: rejected artifact menu request from an untrusted renderer')
      }
      const artifactPlatform = platform.platform
      if (artifactPlatform !== 'darwin' && artifactPlatform !== 'win32') {
        throw new Error(`dsh-plugin-desktop: artifact reveal is unavailable on ${artifactPlatform}`)
      }

      let target: string | undefined
      try {
        const resolvedTarget = resolveDesktopArtifactPath(request, artifactPlatform)
        target = resolvedTarget
        if (window.isDestroyed()) throw new Error('artifact menu window is no longer available')
        const copy = desktopArtifactRevealCopy(artifactPlatform, this.options.readLocale())
        const menu = Menu.buildFromTemplate([{
          label: copy.label,
          click: () => { void this.revealArtifact(window, artifactPlatform, resolvedTarget) },
        }])
        menu.popup({ window })
      } catch (cause) {
        await this.reportArtifactRevealError(window, artifactPlatform, cause, target)
      }
    }

    app.on('activate', show)
    window.on('close', close)
    window.on('page-title-updated', preserveBlankTitle)
    window.webContents.on('before-input-event', handleZoomShortcut)
    window.webContents.on('will-frame-navigate', navigate)
    window.webContents.on('will-redirect', redirect)
    window.webContents.on('render-process-gone', rendererGone)
    window.webContents.on('did-fail-load', loadFailed)
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url)
        if (target.protocol === 'https:' || target.protocol === 'http:' || target.protocol === 'mailto:') {
          void shell.openExternal(target.href).catch((cause: unknown) => {
            this.options.logError(`dsh-plugin-desktop: failed to open external link: ${cause instanceof Error ? cause.message : String(cause)}`)
          })
        }
      } catch {
        // A malformed target is rejected with the same deny result.
      }
      return { action: 'deny' }
    })
    window.once('ready-to-show', show)
    let tray: Tray | undefined
    this.cleanupListeners = () => {
      app.off('activate', show)
      window.off('close', close)
      window.off('page-title-updated', preserveBlankTitle)
      window.off('ready-to-show', show)
      window.webContents.off('before-input-event', handleZoomShortcut)
      window.webContents.off('will-frame-navigate', navigate)
      window.webContents.off('will-redirect', redirect)
      window.webContents.off('render-process-gone', rendererGone)
      window.webContents.off('did-fail-load', loadFailed)
      if (artifactContextMenuRegistered) {
        ipcMain.removeHandler(DESKTOP_ARTIFACT_CONTEXT_MENU_CHANNEL)
        artifactContextMenuRegistered = false
      }
      tray?.off('click', show)
    }

    try {
      if (platform.platform !== 'linux') {
        ipcMain.handle(DESKTOP_ARTIFACT_CONTEXT_MENU_CHANNEL, showArtifactContextMenu)
        artifactContextMenuRegistered = true
      }
      await window.loadURL(spec.url)
      tray = new Tray(prepareTrayIcon(spec.trayIcons, platform.platform))
      this.tray = tray
      tray.setToolTip(spec.productName)
      this.refreshTrayMenu()
      tray.on('click', show)
      beforeInteractive?.()
      this.mounted = true
    } catch (cause) {
      await this.release()
      throw cause
    }
  }

  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  async showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
    const window = this.window
    return window === undefined || window.isDestroyed()
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options)
  }

  refreshTrayMenu(): void {
    if (this.tray === undefined) return
    this.tray.setContextMenu(Menu.buildFromTemplate(this.options.buildTrayTemplate()))
  }

  refreshThemeMaterial(): void {
    if (this.window !== undefined && !this.window.isDestroyed()) this.options.platform.refreshThemeMaterial(this.window)
  }

  private async revealArtifact(
    window: BrowserWindow,
    platform: 'darwin' | 'win32',
    target: string,
  ): Promise<void> {
    try {
      const metadata = await lstat(target)
      if (metadata.isDirectory()) {
        const error = await shell.openPath(target)
        if (error !== '') throw new Error(error)
      } else {
        shell.showItemInFolder(target)
      }
    } catch (cause) {
      await this.reportArtifactRevealError(window, platform, cause, target)
    }
  }

  private async reportArtifactRevealError(
    window: BrowserWindow,
    platform: 'darwin' | 'win32',
    cause: unknown,
    target?: string,
  ): Promise<void> {
    const detail = cause instanceof Error ? cause.message : String(cause)
    this.options.logError(`dsh-plugin-desktop: failed to reveal produced file${target === undefined ? '' : ` ${target}`}: ${detail}`)
    const copy = desktopArtifactRevealCopy(platform, this.options.readLocale())
    try {
      await dialog.showMessageBox(window, {
        type: 'error',
        title: copy.title,
        message: copy.message,
        ...(target === undefined ? {} : { detail: target }),
        buttons: [copy.confirm],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
    } catch (dialogCause) {
      this.options.logError(`dsh-plugin-desktop: failed to show artifact reveal error: ${dialogCause instanceof Error ? dialogCause.message : String(dialogCause)}`)
    }
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.options.stopRendererBootMonitoring()

    const window = this.window
    const tray = this.tray
    this.window = undefined
    this.tray = undefined
    if (window === undefined) return

    this.cleanupListeners?.()
    this.cleanupListeners = undefined
    tray?.destroy()
    if (!window.isDestroyed()) window.destroy()
  }
}
