/** Electron implementation of the launcher-provided desktop runtime capability. */

import {
  app,
  dialog,
  nativeTheme,
  net,
  Notification,
  shell,
} from 'electron'
import { spawn } from 'node:child_process'
import { RemoteControlOffer, remoteControlOfferCopy } from './remote-control-offer.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { desktopTerminalStateDirectory, openDesktopTerminal } from './desktop-terminal.ts'
import { showDesktopMessageBox } from './desktop-dialog-window.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import { ElectronShellGeneration } from './electron-shell-generation.ts'
import { isPlatformLoginDestination, type DesktopPlatformLoginRequest } from './platform-login.ts'
import { PLATFORM_LOGIN_TITLE, platformLoginUrl } from './platform-login-window.ts'
import type { DesktopOpenWorkspaceDelivery } from './launch-workspace-contract.ts'
import { electronPlatformStrategy, type ElectronPlatformStrategy } from './electron-platform.ts'
import type {
  DesktopNotification,
  DesktopLocale,
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
import type { RendererBootReport } from './renderer-boot-contract.ts'
import {
  DesktopRendererHealthGate,
  type DesktopRendererHealthGateOptions,
  type RendererHealthFailureReason,
  type RendererHealthVerdict,
} from './renderer-health.ts'
import { formatDesktopExitCode, type DesktopLogger } from './desktop-logger.ts'
import { exportDesktopDiagnostics } from './diagnostic-export.ts'
import {
  desktopDiagnosticsPrivacyCopy,
  desktopLocaleFromLanguageTag,
  desktopRestartConfirmationCopy,
  desktopTrayLabel,
  rendererRecoveryCopy,
} from './tray-locale.ts'
import {
  desktopUpdateFilename,
  downloadDesktopUpdate,
  pendingDesktopUpdateArtifact,
  recordDesktopUpdateArtifact,
  resolveDesktopUpdateArtifact,
  type DesktopUpdateArtifact,
  type UpdateArtifactResponse,
} from './update-download.ts'
import type { UpdateCheckResult } from './update-checker.ts'
import type { DesktopInstallationId } from './desktop-installation-id.ts'
import { DESKTOP_RELEASE_CHANNEL } from './product-identity.ts'
import type { DesktopReleaseChannel } from './update-checker.ts'
import {
  type WindowsVolumeQuery,
} from './windows-volume-diagnostics.ts'
import { ElectronWorkspaceAdmission } from './workspace-admission.ts'
import { pickWindowsUnicodeDirectory } from './windows-unicode-directory-picker.ts'
import { ProfileCreateWindow, type ProfileCreateWindowOptions } from './profile-create-window.ts'
import { desktopNativeCopy } from './native-dialog-copy.ts'
import {
  FileMainWindowStateStore,
  type MainWindowStateStore,
} from './main-window-state.ts'

/**
 * Read the desktop package version instead of Electron's development-app version.
 * @param moduleUrl - module below the package's `src` or `lib` directory.
 * @returns validated desktop product version.
 */
export function desktopProductVersion(moduleUrl: string = import.meta.url): string {
  const value: unknown = JSON.parse(readFileSync(new URL('../package.json', moduleUrl), 'utf8'))
  if (value === null || typeof value !== 'object' || typeof (value as { version?: unknown }).version !== 'string') {
    throw new Error('dsh-plugin-desktop: package.json has no product version')
  }
  return (value as { version: string }).version
}

/** Resolve the CommonJS preload emitted beside the Electron runtime bundle. */
export function desktopPreloadPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('./preload.cjs', moduleUrl))
}

const PRODUCT_VERSION = desktopProductVersion()

/** Main-process deadline for one Renderer generation to settle its client Loader. */
export const RENDERER_BOOT_TIMEOUT_MS = 30_000

/** HTTP statuses whose Response must be constructed without a body stream. */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

/**
 * Download-request adapter over Electron `net.request`. `net.fetch` cannot
 * supply the HTTPS check: its Response carries an empty `url` (a
 * documented Electron limitation), so redirects are followed here and the
 * settled URL is reported alongside the response for validation.
 */
export function requestDesktopArtifact(url: string, init: RequestInit): Promise<UpdateArtifactResponse> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'GET', redirect: 'manual' })
    let finalUrl = url
    let settled = false
    const headers = new Headers(init.headers)
    // Approximates the fetch `cache: 'no-store` intent over the Chromium net stack.
    headers.set('cache-control', 'no-cache')
    headers.forEach((value, key) => { request.setHeader(key, value) })
    request.on('redirect', (_status, _method, redirectUrl) => {
      finalUrl = redirectUrl
      request.followRedirect()
    })
    request.on('response', incoming => {
      if (settled) return
      settled = true
      const status = incoming.statusCode
      if (status === undefined) {
        reject(new Error('dsh-plugin-desktop: the update download response carried no HTTP status.'))
        return
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item)
      }
      try {
        resolve({
          // Constructing a Response with a body throws synchronously for
          // null-body statuses (204/205/304), and a synchronous throw inside
          // this event callback would escape the Promise and crash the main
          // process, so those statuses resolve without a body stream and any
          // construction failure rejects instead.
          response: new Response(
            NULL_BODY_STATUSES.has(status)
              ? null
              : Readable.toWeb(incoming as unknown as Readable) as unknown as ReadableStream<Uint8Array>,
            { status, headers },
          ),
          finalUrl,
        })
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
    request.on('abort', () => {
      if (settled) return
      settled = true
      // ClientRequest.abort() emits 'abort', not 'error', so without this
      // handler a pre-response cancellation would leave the promise pending.
      reject(init.signal instanceof AbortSignal && init.signal.reason !== undefined
        ? init.signal.reason
        : new DOMException('The operation was aborted', 'AbortError'))
    })
    request.on('error', cause => {
      if (settled) return
      settled = true
      reject(cause)
    })
    const signal = init.signal
    if (signal instanceof AbortSignal) {
      if (signal.aborted) {
        request.abort()
        return
      }
      signal.addEventListener('abort', () => { request.abort() }, { once: true })
    }
    request.end()
  })
}

/** Native adapter used by the DSH Desktop launcher and owned by its Cordis shell plugin. */
export class ElectronDesktopRuntime implements DesktopRuntime {
  setupOnboarding?: import('./setup-onboarding-bridge.ts').DesktopOnboardingBridge
  readonly platform: DesktopPlatform
  private readonly platformStrategy: ElectronPlatformStrategy
  readonly updates: DesktopUpdateAdapter

  private generation: ElectronShellGeneration | undefined
  private currentLocale: DesktopLocale = 'en'
  private scheduled: DesktopShellSpec | undefined
  private mountTask: Promise<void> | undefined
  private quitting = false
  private readonly trayItems = new Map<symbol, DesktopTrayItem>()
  private terminalSpec: DesktopTerminalSpec | undefined
  private diagnosticExport: Promise<void> | undefined
  private readonly workspaceAdmission: ElectronWorkspaceAdmission
  private updateCleanupTask: Promise<void> | undefined
  private rendererHealthGate: DesktopRendererHealthGate | undefined
  private rendererBootHealthy = false
  private profileCreateWindow: ProfileCreateWindow | undefined
  private restartRequest: Promise<void> | undefined
  private hostStoppedRecovery: Promise<void> | undefined

  constructor(
    private readonly restart: (target?: 'recovery' | 'safe-mode') => Promise<void>,
    private readonly onRendererBoot: (report: RendererBootReport) => boolean | void = () => {},
    private readonly logger: DesktopLogger | undefined = undefined,
    workspaceVolumeQuery: WindowsVolumeQuery | undefined = undefined,
    private readonly mainWindowState: MainWindowStateStore = new FileMainWindowStateStore(app.getPath('userData')),
    installationId?: DesktopInstallationId,
  ) {
    this.platformStrategy = electronPlatformStrategy()
    this.platform = this.platformStrategy.platform
    const platformStrategy = this.platformStrategy
    this.workspaceAdmission = new ElectronWorkspaceAdmission({
      platform: this.platform,
      canPickDirectory: platformStrategy.canPickDirectory,
      locale: () => this.currentLocale,
      showOpenDialog: async options => this.generation === undefined
        ? await dialog.showOpenDialog(options)
        : await this.generation.showOpenDialog(options),
      pickWindowsUnicodeDirectory: async title => await pickWindowsUnicodeDirectory(title),
      showMessageBox: async options => await this.showDesktopMessageBox(options),
      logError: message => { this.logError(message) },
      ...(workspaceVolumeQuery === undefined ? {} : { volumeQuery: workspaceVolumeQuery }),
    })
    this.updates = {
      get isPackaged() { return app.isPackaged },
      get canDownload() { return app.isPackaged && platformStrategy.updateDownloadPlatform !== undefined },
      get currentVersion() { return PRODUCT_VERSION },
      get releaseChannel() { return DESKTOP_RELEASE_CHANNEL },
      get statePath() { return join(app.getPath('userData'), 'updates', 'state.json') },
      ...(installationId === undefined ? {} : { installationId }),
      request: (url, init) => net.fetch(url, init),
      confirmDownload: (version, channel) => this.confirmUpdateDownload(version, channel),
      showManualCheckResult: result => this.showManualUpdateCheckResult(result),
      downloadAndOpen: (version, signal, channel, installerSha256) => this.downloadAndOpenUpdate(version, signal, channel, installerSha256),
      notify: notification => { this.showNotification(notification) },
    }
  }

  /** Log an Electron-scope error to the sink, falling back to stderr without a logger. */
  private logError(message: string): void {
    if (this.logger !== undefined) this.logger.error(message)
    else process.stderr.write(`${message}\n`)
  }

  /** @inheritdoc */
  get locale(): DesktopLocale {
    return this.currentLocale
  }

  /** Terminal failure class for the first Renderer boot report, when it failed. */
  get rendererBootFailureReason(): RendererHealthFailureReason | undefined {
    return this.rendererHealthGate?.failureReason
  }

  /** Arm the health gate immediately before the native shell starts loading. */
  beginRendererBootMonitoring(
    options: DesktopRendererHealthGateOptions,
    timeoutMs: number = RENDERER_BOOT_TIMEOUT_MS,
  ): Promise<RendererHealthVerdict> {
    if (this.rendererHealthGate !== undefined) {
      throw new Error('dsh-plugin-desktop: renderer boot monitoring already started')
    }
    const gate = new DesktopRendererHealthGate(options)
    this.rendererHealthGate = gate
    return gate.begin(timeoutMs).then((verdict) => {
      this.handleRendererBootVerdict(verdict.report)
      return verdict
    })
  }

  /** Stop a pending deadline while startup is being torn down for another failure. */
  stopRendererBootMonitoring(): void {
    this.rendererHealthGate?.stop()
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
          this.profileCreateWindow?.close()
          this.profileCreateWindow = undefined
          await this.generation?.release()
        } finally {
          this.generation = undefined
          this.mountTask = undefined
          if (this.scheduled === spec) {
            if (this.platform !== 'linux') nativeTheme.themeSource = previousThemeSource
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
    if (this.mountTask === undefined) {
      this.setLocalePreference(spec.readLocalePreference())
      const remoteOffer = spec.readRemoteControl && spec.enableRemoteControl ? new RemoteControlOffer({
        path: join(app.getPath('userData'), 'remote-control-offer-seen'),
        readEnabled: spec.readRemoteControl,
        enable: spec.enableRemoteControl,
        confirm: async copy => (await this.showDesktopMessageBox({
          type: 'question', title: copy.title, message: copy.message, detail: copy.detail,
          buttons: [copy.confirm, copy.cancel], defaultId: 1, cancelId: 1, noLink: true,
        })).response === 0,
        reportError: cause => this.logError(`Remote control notice: ${String(cause)}`),
      }) : undefined
      const generation = new ElectronShellGeneration({
        platform: this.platformStrategy,
        spec,
        preloadPath: desktopPreloadPath(),
        pickDirectory: () => this.pickDirectory(),
        buildApplicationMenuItems: () => this.buildApplicationMenuItems(),
        isQuitting: () => this.quitting,
        buildTrayTemplate: () => this.buildTrayTemplate(spec),
        stopRendererBootMonitoring: () => { this.stopRendererBootMonitoring() },
        abortRendererBootMonitoring: cause => { this.rendererHealthGate?.stop(cause) },
        failRendererBoot: error => { this.failRendererBoot('renderer-failed', error) },
        canRecoverRenderer: () => this.rendererBootHealthy,
        rendererRecoveryCopy: () => rendererRecoveryCopy[this.currentLocale],
        logError: message => { this.logError(message) },
        mainWindowState: this.mainWindowState,
        platformLoginTitle: () => PLATFORM_LOGIN_TITLE[this.currentLocale],
        setupOnboarding: this.setupOnboarding,
        chromeActions: {
          ...(remoteOffer ? { remoteControl: {
            read: () => remoteOffer.read(),
            open: async () => {
              try { await remoteOffer.open(this.locale) }
              catch (cause) {
                this.logError(`Remote control activation failed: ${String(cause)}`)
                const copy = remoteControlOfferCopy[this.locale]
                await this.showDesktopMessageBox({ type: 'error', title: copy.failed, message: copy.failed, detail: copy.retry })
              }
            },
          } } : {}),
          locale: () => this.locale,
          version: PRODUCT_VERSION,
          openTerminal: () => { this.openTerminal() },
          restart: () => this.requestRestart(),
          restartToRecovery: () => this.requestRecoveryRestart(),
          reload: () => { this.reloadRenderer() },
          developerTools: () => { this.toggleDeveloperTools() },
          exportDiagnostics: () => this.exportDiagnostics(),
          checkForUpdates: async () => {
            const command = [...this.trayItems.values()].find(item => item.id === 'check-for-updates')
            if (command === undefined || command.enabled?.() === false) throw new Error('Desktop update check is unavailable')
            await command.invoke()
          },
        },
      })
      this.generation = generation
      this.mountTask = generation.mount(beforeInteractive).then(() => {
        this.rendererHealthGate?.acceptNativeMount()
        void this.offerUpdateArtifactCleanup().catch((cause: unknown) => {
          this.logError(`dsh-plugin-desktop: failed to resolve update installer cleanup: ${cause instanceof Error ? cause.message : String(cause)}`)
        })
      }).catch((cause: unknown) => {
        if (this.generation === generation) this.generation = undefined
        throw cause
      })
    }
    return this.mountTask
  }

  /** @inheritdoc */
  show(): void {
    this.generation?.show()
  }

  /** @inheritdoc */
  notifyAttention(notification: DesktopNotification): void {
    this.generation?.notifyAttention(notification)
  }

  /** @inheritdoc */
  platformLogin(request: DesktopPlatformLoginRequest): void {
    if (this.quitting) return
    if (request.action === 'close') {
      this.generation?.closePlatformLogin()
      if (request.focus) this.show()
      return
    }
    if (!isPlatformLoginDestination(request.url)) {
      this.logError('dsh-plugin-desktop: refused a platform sign-in page outside HTTPS or loopback HTTP')
      return
    }
    const url = platformLoginUrl(request.url, nativeTheme.shouldUseDarkColors)
    // A system browser reaches the Host's loopback callback only while browser access is on;
    // otherwise the built-in window replays the callback with the renderer's credentials.
    if (request.external) {
      void shell.openExternal(url).catch((cause: unknown) => {
        this.logError(`dsh-plugin-desktop: failed to open the platform sign-in page: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
      return
    }
    this.generation?.openPlatformLogin(url)
  }

  /** @inheritdoc */
  async pickDirectory(): Promise<string | null> {
    return await this.workspaceAdmission.pickDirectory()
  }

  /** @inheritdoc */
  async validateDirectory(path: string): Promise<boolean> {
    return await this.workspaceAdmission.validateDirectory(path)
  }

  /**
   * Apply native policy to a folder named by a launch.
   *
   * Launch hand-offs stay off the Host runtime contract: the path is native
   * input that the main process already owns, and nothing in the Host needs to
   * be able to ask for it.
   * @param path - absolute folder the launch asked Desktop to open.
   * @returns whether the folder may be registered as a workspace.
   */
  async admitWorkspacePath(path: string): Promise<boolean> {
    return await this.workspaceAdmission.admitWorkspacePath(path)
  }

  /**
   * Hand one admitted launch folder to the mounted Host page.
   * @param path - absolute folder already admitted by native policy.
   * @returns how the page took the folder, or `'unavailable'` before a shell
   *   generation is mounted.
   */
  async openWorkspacePath(path: string): Promise<DesktopOpenWorkspaceDelivery | 'unavailable'> {
    const generation = this.generation
    if (generation === undefined) return 'unavailable'
    return await generation.openWorkspacePath(path)
  }

  /** @inheritdoc */
  openProfileCreateWindow(options: Omit<ProfileCreateWindowOptions, 'locale'>): void {
    if (this.profileCreateWindow === undefined) {
      this.profileCreateWindow = new ProfileCreateWindow({
        ...options,
        locale: this.locale,
      })
    }
    this.profileCreateWindow.open()
  }

  /** @inheritdoc */
  registerTrayItem(item: DesktopTrayItem): DesktopTrayItemRegistration {
    const key = Symbol()
    this.trayItems.set(key, item)
    this.rebuildTrayMenu()
    this.rebuildApplicationMenu()
    let active = true
    return {
      refresh: () => {
        if (!active) return
        this.rebuildTrayMenu()
        this.rebuildApplicationMenu()
      },
      dispose: () => {
        if (!active) return
        active = false
        this.trayItems.delete(key)
        this.rebuildTrayMenu()
        this.rebuildApplicationMenu()
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
  reloadRenderer(): void {
    if (this.generation === undefined) {
      throw new Error('dsh-plugin-desktop: renderer reload requires an active shell generation')
    }
    this.generation.reloadRenderer()
  }

  /** @inheritdoc */
  toggleDeveloperTools(): void {
    if (this.generation === undefined) {
      throw new Error('dsh-plugin-desktop: Developer Tools require an active shell generation')
    }
    this.generation.toggleDeveloperTools()
  }

  /** @inheritdoc */
  exportDiagnostics(): Promise<void> {
    if (this.diagnosticExport !== undefined) return this.diagnosticExport
    const operation = this.performDiagnosticExport().finally(() => {
      if (this.diagnosticExport === operation) this.diagnosticExport = undefined
    })
    this.diagnosticExport = operation
    return operation
  }

  private async performDiagnosticExport(): Promise<void> {
    const copy = desktopDiagnosticsPrivacyCopy(this.locale)
    try {
      const confirmation = await this.showDesktopMessageBox({
        type: 'warning',
        title: copy.title,
        message: copy.message,
        detail: copy.detail,
        buttons: [copy.confirm, copy.cancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      if (confirmation.response !== 0) return
      const path = await exportDesktopDiagnostics(app.getPath('userData'), {
        appVersion: PRODUCT_VERSION,
        crashDumpsDir: app.getPath('crashDumps'),
      })
      shell.showItemInFolder(path)
    } catch (cause) {
      this.reportDiagnosticExportError(cause)
    }
  }

  /** @inheritdoc */
  reportRendererBoot(report: RendererBootReport): void {
    this.rendererHealthGate?.report(report)
    this.generation?.reportRendererRecovery(report)
  }

  private handleRendererBootVerdict(report: RendererBootReport): void {
    this.rendererBootHealthy = report.status === 'healthy'
    if (report.status === 'failed') {
      const plugins = report.plugins.length === 0 ? 'Unknown client plugin' : report.plugins.join(', ')
      const error = report.error === undefined ? 'The client Loader did not provide an error message.' : report.error
      this.logError(`dsh-plugin-desktop: renderer boot failed (plugins: ${plugins}): ${error}`)
    }
    let handled = false
    try {
      handled = this.onRendererBoot(report) === true
    } catch (cause) {
      this.logError(`dsh-plugin-desktop: failed to persist renderer boot health: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (report.status === 'failed' && !handled) {
      void this.showRendererBootRecovery(report).catch((cause: unknown) => {
        this.logError(`dsh-plugin-desktop: failed to show plugin recovery: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
    }
  }

  /** @inheritdoc */
  setLocalePreference(preference: DesktopLocale | undefined): void {
    const locale = preference ?? desktopLocaleFromLanguageTag(app.getLocale())
    if (locale === this.currentLocale) return
    this.currentLocale = locale
    this.rebuildTrayMenu()
    this.rebuildApplicationMenu()
  }

  /** @inheritdoc */
  setThemeSource(source: DesktopThemeSource): void {
    if (this.platform !== 'linux' && this.generation !== undefined) {
      nativeTheme.themeSource = source
    }
  }

  /** @inheritdoc */
  async requestRestart(): Promise<void> {
    if (this.quitting) return
    if (this.restartRequest !== undefined) return await this.restartRequest
    const request = this.confirmAndRestart('normal').finally(() => {
      if (this.restartRequest === request) this.restartRequest = undefined
    })
    this.restartRequest = request
    await request
  }

  /** @inheritdoc */
  async requestRecoveryRestart(): Promise<void> {
    if (this.quitting) return
    if (this.restartRequest !== undefined) return await this.restartRequest
    const request = this.confirmAndRestart('recovery').finally(() => {
      if (this.restartRequest === request) this.restartRequest = undefined
    })
    this.restartRequest = request
    await request
  }

  async requestSafeModeRestart(): Promise<void> {
    if (this.quitting) return
    if (this.restartRequest !== undefined) return await this.restartRequest
    const request = this.confirmAndRestart('safe-mode').finally(() => {
      if (this.restartRequest === request) this.restartRequest = undefined
    })
    this.restartRequest = request
    await request
  }

  private async confirmAndRestart(target: 'normal' | 'recovery' | 'safe-mode'): Promise<void> {
    const copy = desktopRestartConfirmationCopy(this.currentLocale, target)
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: copy.title,
      message: copy.message,
      detail: copy.detail,
      buttons: [copy.confirm, copy.cancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }
    const result = await this.showDesktopMessageBox(options)
    if (result.response === 0) await this.restart(target === 'normal' ? undefined : target)
  }

  /** @inheritdoc */
  prepareToQuit(): void {
    this.quitting = true
    this.generation?.stopRendererRecovery()
    this.generation?.closePlatformLogin()
    this.stopRendererBootMonitoring()
  }

  private failRendererBoot(reason: RendererHealthFailureReason, error: string): void {
    this.rendererHealthGate?.fail(reason, error)
  }

  /**
   * Offer an in-app way out after the supervised Host exits on its own. Kept off
   * the shared `DesktopRuntime` contract on purpose: only the Electron main
   * process supervises the Host, and the Host must never be able to ask for this.
   * @param exit - the reported exit code, shown so a report can name it.
   */
  async showHostStoppedRecovery(exit: { readonly exitCode: number }): Promise<void> {
    if (this.quitting) return
    // A Host death arrives once, but the renderer keeps failing against the
    // gone endpoint afterwards. One dialog per death, never a stack of them.
    if (this.hostStoppedRecovery !== undefined) return await this.hostStoppedRecovery
    const request = this.confirmHostStopped(exit).finally(() => {
      if (this.hostStoppedRecovery === request) this.hostStoppedRecovery = undefined
    })
    this.hostStoppedRecovery = request
    await request
  }

  private async confirmHostStopped(exit: { readonly exitCode: number }): Promise<void> {
    const copy = desktopNativeCopy(this.currentLocale)
    const result = await this.showDesktopMessageBox({
      type: 'error',
      title: copy.hostStoppedTitle,
      message: copy.hostStoppedMessage,
      detail: `${copy.hostStoppedDetail(formatDesktopExitCode(exit.exitCode))}\n\n${copy.hostStoppedInstructions}`,
      buttons: [copy.restart, copy.openTerminal, copy.dismiss],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    if (result.response === 0) await this.requestRestart()
    else if (result.response === 1) this.openTerminal()
  }

  private async showRendererBootRecovery(report: Extract<RendererBootReport, { status: 'failed' }>): Promise<void> {
    const copy = desktopNativeCopy(this.currentLocale)
    const plugins = report.plugins.length === 0
      ? copy.unknownPlugin
      : report.plugins.map(plugin => `- ${plugin}`).join('\n')
    const error = report.error === undefined ? copy.missingPluginError : report.error
    const result = await this.showDesktopMessageBox({
      type: 'error',
      title: copy.pluginRecoveryTitle,
      message: copy.pluginRecoveryMessage,
      detail: `${copy.failedPlugins}\n${plugins}\n\n${error}\n\n${copy.pluginRecoveryInstructions}`,
      buttons: [copy.openTerminal, copy.restart, copy.dismiss],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    if (result.response === 0) this.openTerminal()
    else if (result.response === 1) await this.requestRestart()
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
        this.logError(`dsh-plugin-desktop: tray command failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
    }
  }

  private showNotification(notification: DesktopNotification): void {
    if (!Notification.isSupported()) return
    const nativeNotification = new Notification({
      title: notification.title,
      body: notification.body,
    })
    nativeNotification.once('click', () => { this.show() })
    nativeNotification.show()
  }

  private async showUpdateMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    return await this.showDesktopMessageBox(options)
  }

  private async showDesktopMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    return this.generation === undefined
      ? await showDesktopMessageBox(options)
      : await this.generation.showMessageBox(options)
  }

  private async showUpdateSaveDialog(options: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> {
    return this.generation === undefined
      ? await dialog.showSaveDialog(options)
      : await this.generation.showSaveDialog(options)
  }

  /** Ask before making the fixed download endpoint's counted request. */
  private async confirmUpdateDownload(
    version: string,
    channel: DesktopReleaseChannel = 'stable',
  ): Promise<boolean> {
    const copy = desktopNativeCopy(this.currentLocale)
    const result = await this.showUpdateMessageBox({
      type: 'info',
      title: copy.updateAvailableTitle,
      message: copy.updateAvailableMessage(version),
      detail: channel === DESKTOP_RELEASE_CHANNEL
        ? copy.downloadUpdate
        : copy.installStableAlongsideBeta,
      buttons: [copy.download, copy.later],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }

  /** Report one user-triggered check without exposing network or response details. */
  private async showManualUpdateCheckResult(result: UpdateCheckResult | null): Promise<void> {
    const copy = desktopNativeCopy(this.currentLocale)
    if (result === null) {
      await this.showUpdateMessageBox({
        type: 'warning',
        title: copy.updateCheckFailedTitle,
        message: copy.updateCheckFailedMessage,
        detail: copy.tryAgainLater,
        buttons: [copy.ok],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    if (result.status === 'up-to-date') {
      await this.showUpdateMessageBox({
        type: 'info',
        title: copy.upToDateTitle,
        message: copy.upToDateMessage,
        detail: copy.installedVersion(result.currentVersion),
        buttons: [copy.ok],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    await this.showUpdateMessageBox({
      type: 'info',
      title: copy.updateAvailableTitle,
      message: copy.updateAvailableMessage(result.latestVersion),
      detail: copy.installerUnavailable,
      buttons: [copy.ok],
      defaultId: 0,
      noLink: true,
    })
  }

  /** Download a confirmed installer and hand it to the native installation flow. */
  private async downloadAndOpenUpdate(
    version: string,
    signal: AbortSignal,
    channel: DesktopReleaseChannel = 'stable',
    installerSha256?: Readonly<Partial<Record<'win32' | 'darwin', string>>>,
  ): Promise<void> {
    const copy = desktopNativeCopy(this.currentLocale)
    const platform = this.platformStrategy.updateDownloadPlatform
    if (platform === undefined) {
      throw new Error(`dsh-plugin-desktop: updates are unavailable on ${this.platform}`)
    }
    const destinationPath = await this.chooseUpdateDestination(version, channel)
    if (destinationPath === undefined) return
    signal.throwIfAborted()
    const artifactPath = await downloadDesktopUpdate({
      platform,
      version,
      ...(channel === 'stable' ? {} : { channel }),
      destinationPath,
      request: requestDesktopArtifact,
      signal,
      ...(installerSha256?.[platform] === undefined ? {} : { expectedSha256: installerSha256[platform] }),
    })
    signal.throwIfAborted()
    const artifact: DesktopUpdateArtifact = { platform, version, path: artifactPath }
    try {
      await recordDesktopUpdateArtifact(app.getPath('userData'), artifact)
    } catch (cause) {
      this.logError(`dsh-plugin-desktop: failed to remember update installer for cleanup: ${cause instanceof Error ? cause.message : String(cause)}`)
    }

    if (platform === 'darwin') {
      const openError = await shell.openPath(artifactPath)
      if (openError !== '') throw new Error(`dsh-plugin-desktop: failed to open update disk image: ${openError}`)
      signal.throwIfAborted()
      await this.showUpdateMessageBox({
        type: 'info',
        title: copy.updateDownloadedTitle,
        message: copy.updateReady(version),
        detail: copy.macInstallInstructions,
        buttons: [copy.ok],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    const result = await this.showUpdateMessageBox({
      type: 'info',
      title: copy.updateDownloadedTitle,
      message: copy.updateReady(version),
      detail: copy.windowsInstallQuestion,
      buttons: [copy.restartAndInstall, copy.later],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (result.response !== 0) return

    const spec = this.scheduled
    if (spec === undefined) throw new Error('dsh-plugin-desktop: no active shell can exit for update installation')
    signal.throwIfAborted()
    await this.launchWindowsUpdateInstaller(artifactPath)
    this.quitting = true
    spec.requestQuit(0)
  }

  private async chooseUpdateDestination(
    version: string,
    channel: DesktopReleaseChannel = 'stable',
  ): Promise<string | undefined> {
    if (this.platform !== 'darwin' && this.platform !== 'win32') return undefined
    const copy = desktopNativeCopy(this.currentLocale)
    const filename = desktopUpdateFilename(this.platform, version, channel)
    const extension = this.platform === 'darwin' ? 'dmg' : 'exe'
    const result = await this.showUpdateSaveDialog({
      title: copy.saveInstallerTitle,
      defaultPath: join(app.getPath('downloads'), filename),
      buttonLabel: copy.saveAndDownload,
      filters: [{
        name: this.platform === 'darwin'
          ? copy.diskImage
          : copy.windowsInstaller,
        extensions: [extension],
      }],
      properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
    })
    return result.canceled ? undefined : result.filePath
  }

  private offerUpdateArtifactCleanup(): Promise<void> {
    if (this.updateCleanupTask !== undefined) return this.updateCleanupTask
    const task = this.performUpdateArtifactCleanup().finally(() => {
      if (this.updateCleanupTask === task) this.updateCleanupTask = undefined
    })
    this.updateCleanupTask = task
    return task
  }

  private async performUpdateArtifactCleanup(): Promise<void> {
    if (this.platform !== 'darwin' && this.platform !== 'win32') return
    const userDataPath = app.getPath('userData')
    const artifact = await pendingDesktopUpdateArtifact(userDataPath, PRODUCT_VERSION, this.platform)
    if (artifact === undefined) return
    const copy = desktopNativeCopy(this.currentLocale)
    const result = await this.showUpdateMessageBox({
      type: 'question',
      title: copy.removeInstallerTitle,
      message: copy.updateInstalled(artifact.version),
      detail: copy.removeInstallerQuestion(artifact.path),
      buttons: [copy.deleteInstaller, copy.keepInstaller],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    await resolveDesktopUpdateArtifact(userDataPath, artifact, result.response === 0)
  }

  /** Start the downloaded NSIS installer visibly before releasing the current process. */
  private async launchWindowsUpdateInstaller(installerPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(installerPath, ['--updated', '--force-run'], {
          detached: true,
          stdio: 'ignore',
          shell: false,
          // UV_PROCESS_WINDOWS_HIDE also applies SW_HIDE to GUI processes,
          // which leaves an interactive NSIS installer running invisibly.
          windowsHide: false,
        })
      } catch (cause) {
        reject(cause)
        return
      }
      const fail = (cause: Error): void => { reject(cause) }
      child.once('error', fail)
      child.once('spawn', () => {
        child.off('error', fail)
        child.once('error', cause => {
          this.logError(`dsh-plugin-desktop: update installer failed after launch: ${cause.message}`)
        })
        child.unref()
        resolve()
      })
    })
  }

  /** Keep native-terminal launch failures visible in a packaged GUI process. */
  private reportTerminalLaunchError(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    const copy = desktopNativeCopy(this.currentLocale)
    this.logError(`dsh-plugin-desktop: failed to open terminal: ${error.message}`)
    void this.showDesktopMessageBox({
      type: 'error',
      title: copy.terminalErrorTitle,
      message: copy.terminalErrorMessage,
      detail: error.message,
      buttons: [copy.ok],
      defaultId: 0,
      cancelId: 0,
    }).catch((dialogCause: unknown) => {
      this.logError(`dsh-plugin-desktop: failed to show terminal error: ${dialogCause instanceof Error ? dialogCause.message : String(dialogCause)}`)
    })
  }

  /** Keep diagnostic export failures visible in a packaged GUI process. */
  private reportDiagnosticExportError(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    const copy = desktopNativeCopy(this.currentLocale)
    this.logError(`dsh-plugin-desktop: failed to export diagnostics: ${error.message}`)
    void this.showDesktopMessageBox({
      type: 'error',
      title: copy.diagnosticsErrorTitle,
      message: copy.diagnosticsErrorMessage,
      detail: error.message,
      buttons: [copy.ok],
      defaultId: 0,
      cancelId: 0,
    }).catch((dialogCause: unknown) => {
      this.logError(`dsh-plugin-desktop: failed to show diagnostics error: ${dialogCause instanceof Error ? dialogCause.message : String(dialogCause)}`)
    })
  }

  private buildTrayTemplate(spec: DesktopShellSpec): Electron.MenuItemConstructorOptions[] {
    const show = (): void => { this.show() }
    const changeMode = (mode: DesktopShellSpec['mode']): void => {
      if (!this.platformStrategy.canToggleShellMode || mode === spec.mode) return
      void spec.requestModeChange(mode).catch((cause: unknown) => {
        this.logError(`dsh-plugin-desktop: failed to change shell mode: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
    }
    const tools = this.contributedTrayItems('tools')
    const profiles = this.contributedTrayItems('profiles')
    const status = this.contributedTrayItems('status')
    // The in-app "Reload interface" control lives inside the renderer, so it is
    // gone exactly when it is needed. This native twin keeps one restore path
    // reachable after the window has stopped drawing anything.
    const reloadRenderer = (): void => {
      try {
        this.generation?.requestRendererReload()
      } catch (cause) {
        this.logError(`dsh-plugin-desktop: failed to reload the renderer from the tray: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: desktopTrayLabel(this.locale, 'openDesktop', spec.productName), click: show },
      { label: desktopTrayLabel(this.locale, 'reloadRenderer'), click: reloadRenderer },
    ]
    if (tools.length > 0) template.push({ type: 'separator' }, ...tools)
    if (profiles.length > 0) template.push({ type: 'separator' }, ...profiles)
    if (status.length > 0) template.push({ type: 'separator' }, ...status)
    template.push(
      { type: 'separator' },
      {
        label: desktopTrayLabel(this.locale, 'shellMode', desktopTrayLabel(this.locale, spec.mode)),
        enabled: this.platformStrategy.canToggleShellMode,
        submenu: (['compatibility', 'extended', 'advanced'] as const).map(mode => ({
          label: desktopTrayLabel(this.locale, mode),
          type: 'radio',
          checked: mode === spec.mode,
          enabled: this.platformStrategy.canToggleShellMode,
          click: () => { changeMode(mode) },
        })),
      },
      { type: 'separator' },
      { label: desktopTrayLabel(this.locale, 'quit'), click: () => { spec.requestQuit(0) } },
    )
    return template
  }

  private rebuildTrayMenu(): void {
    const spec = this.scheduled
    if (spec === undefined) return
    this.generation?.refreshTrayMenu()
  }

  /** Rebuild the macOS application menu from the same native, Host-owned commands as the tray. */
  private rebuildApplicationMenu(): void {
    this.platformStrategy.refreshApplicationMenu(this.buildApplicationMenuItems())
  }

  /** Keep the app menu renderer-free by reusing trusted native tray contributions. */
  private buildApplicationMenuItems(): Electron.MenuItemConstructorOptions[] {
    const tools = this.contributedTrayItems('tools')
    const profiles = this.contributedTrayItems('profiles')
    const items: Electron.MenuItemConstructorOptions[] = []
    if (tools.length > 0) items.push(...tools)
    if (tools.length > 0 && profiles.length > 0) items.push({ type: 'separator' })
    if (profiles.length > 0) items.push(...profiles)
    const status = this.contributedTrayItems('status')
    if (status.length > 0) {
      if (items.length > 0) items.push({ type: 'separator' })
      items.push(...status)
    }
    return items
  }
}
