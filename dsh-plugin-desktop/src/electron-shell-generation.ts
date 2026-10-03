import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  session,
  shell,
  Tray,
  type WebContents,
} from 'electron'
import { isDesktopSetupWizardSelection } from './setup-wizard-contract.ts'
import { SETUP_ONBOARDING_CHANNEL } from './setup-onboarding-bridge.ts'
import { CompatibilityShell, type CompatibilityShellActions } from './compatibility-shell.ts'
import { formatDesktopExitCode } from './desktop-logger.ts'
import { showDesktopMessageBox } from './desktop-dialog-window.ts'
import { applicationNeedsReveal, revealApplication } from './electron-reveal.ts'
import type { ElectronPlatformStrategy } from './electron-platform.ts'
import {
  desktopOpenWorkspaceScript,
  type DesktopOpenWorkspaceDelivery,
} from './launch-workspace-contract.ts'
import { DESKTOP_RENDERER_ACTION_CHANNEL } from './renderer-actions-contract.ts'
import { DESKTOP_NATIVE_DIRECTORY_PICKER_CHANNEL } from './directory-picker-contract.ts'
import { createDesktopRendererActionDispatcher } from './renderer-actions-dispatch.ts'
import type { DesktopNotification, DesktopShellSpec } from './runtime.ts'
import { prepareTrayIcon } from './tray-icons.ts'
import { desktopWindowOptions } from './window-options.ts'
import type { DesktopRestartConfirmationCopy } from './tray-locale.ts'
import type { RendererBootReport } from './renderer-boot-contract.ts'
import { DesktopRendererRecovery } from './renderer-recovery.ts'
import { PlatformLoginWindow } from './platform-login-window.ts'
import { RENDERER_SURFACE_PROBE, RendererSurfaceWatchdog } from './renderer-surface-watchdog.ts'
import type { DesktopRendererAccessHeader } from './desktop-browser-access.ts'
import {
  fitMainWindowBounds,
  sameMainWindowBounds,
  type MainWindowBounds,
  type MainWindowStateStore,
} from './main-window-state.ts'

const MIN_ZOOM_LEVEL = -4
const MAX_ZOOM_LEVEL = 4
const WINDOW_STATE_WRITE_DELAY_MS = 250
/**
 * How long a forced renderer termination may take to report its exit before the
 * reload proceeds without it. Windows writes a crash dump for the hung process
 * first, which is slowest under the memory pressure that usually produced the
 * hang, so this stays well above a prompt exit while leaving the recovery
 * controller's 30s health budget room to observe the reload that follows.
 */
const REPLACEMENT_EXIT_TIMEOUT_MS = 10_000

function pairedWebSocketOrigin(origin: string): string {
  const url = new URL(origin)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else throw new Error(`dsh-plugin-desktop: unsupported renderer origin protocol ${url.protocol}`)
  return url.origin
}

/**
 * Exchange the upstream process token inside the BrowserWindow's own
 * persistent session before its marker-bearing renderer URL is loaded.
 * Keeping the exchange separate preserves the Desktop query markers across
 * the upstream redirect and keeps the launch token out of renderer history.
 */
async function authenticateRendererSession(
  renderer: WebContents,
  spec: DesktopShellSpec,
): Promise<void> {
  const session = renderer.session
  const headers = {
    [spec.rendererAccessHeader.name]: spec.rendererAccessHeader.value,
  }
  const authenticated = await session.fetch(spec.authenticationUrl, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-store',
    headers,
  })
  if (authenticated.status !== 200) {
    throw new Error(
      `dsh-plugin-desktop: browser authentication failed with HTTP ${String(authenticated.status)}`,
    )
  }
  await authenticated.body?.cancel()
}

function sameRendererCarrierOrigin(requestUrl: string, httpOrigin: string, webSocketOrigin: string): boolean {
  try {
    const origin = new URL(requestUrl).origin
    return origin === httpOrigin || origin === webSocketOrigin
  } catch {
    return false
  }
}

function withoutRendererAccessHeader(
  requestHeaders: Record<string, string>,
  headerName: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(requestHeaders)
      .filter(([name]) => name.toLowerCase() !== headerName),
  )
}

function requestBelongsToRenderer(
  details: Electron.OnBeforeSendHeadersListenerDetails,
  webContentsId: number,
): boolean {
  const providedIds = [details.webContentsId, details.webContents?.id]
    .filter((value): value is number => value !== undefined)
  return providedIds.length > 0 && providedIds.every(value => value === webContentsId)
}

function requestComesFromRendererOrigin(
  details: Electron.OnBeforeSendHeadersListenerDetails,
  origin: string,
): boolean {
  if (details.resourceType === 'mainFrame') return true
  const frame = details.frame
  if (frame === undefined || frame === null || frame.detached || frame.origin !== origin) return false
  const top = frame.top ?? (frame.parent === null ? frame : undefined)
  return top !== undefined && !top.detached && top.origin === origin
}

/**
 * Attach one generation-only capability to the renderer's HTTP and WebSocket
 * traffic. Query markers are intentionally insufficient because subresources,
 * API requests, and upgrades do not retain the main-frame query string.
 */
function installRendererAccessHeader(
  renderer: WebContents,
  origin: string,
  header: DesktopRendererAccessHeader,
): () => void {
  const webSocketOrigin = pairedWebSocketOrigin(origin)
  const webRequest = renderer.session.webRequest
  const webContentsId = renderer.id
  const listener = (
    details: Electron.OnBeforeSendHeadersListenerDetails,
    callback: (response: Electron.BeforeSendResponse) => void,
  ): void => {
    // This listener owns a dedicated renderer session and sees every target so
    // a redirect can never carry the capability away from the local carrier.
    const requestHeaders = withoutRendererAccessHeader(details.requestHeaders, header.name)
    if (!requestBelongsToRenderer(details, webContentsId)
      || !sameRendererCarrierOrigin(details.url, origin, webSocketOrigin)
      || !requestComesFromRendererOrigin(details, origin)) {
      callback({ requestHeaders })
      return
    }
    requestHeaders[header.name] = header.value
    callback({ requestHeaders })
  }
  webRequest.onBeforeSendHeaders({
    urls: ['<all_urls>'],
  }, listener)
  let active = true
  return () => {
    if (!active) return
    active = false
    webRequest.onBeforeSendHeaders(null)
  }
}

function sameOriginFrame(frameUrl: string | undefined, origin: string): boolean {
  if (frameUrl === undefined) return false
  try {
    return new URL(frameUrl).origin === origin
  } catch {
    return false
  }
}

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
  readonly setupOnboarding?: import('./setup-onboarding-bridge.ts').DesktopOnboardingBridge | undefined
  readonly platform: ElectronPlatformStrategy
  readonly spec: DesktopShellSpec
  readonly preloadPath: string
  readonly pickDirectory: () => Promise<string | null>
  readonly buildApplicationMenuItems: () => readonly Electron.MenuItemConstructorOptions[]
  readonly isQuitting: () => boolean
  readonly buildTrayTemplate: () => Electron.MenuItemConstructorOptions[]
  readonly stopRendererBootMonitoring: () => void
  readonly abortRendererBootMonitoring: (cause: unknown) => void
  readonly failRendererBoot: (error: string) => void
  readonly canRecoverRenderer: () => boolean
  readonly rendererRecoveryCopy: () => DesktopRestartConfirmationCopy
  readonly logError: (message: string) => void
  readonly mainWindowState: MainWindowStateStore
  readonly chromeActions: CompatibilityShellActions
  /** Localized caption of the built-in DeepSeek Platform sign-in window. */
  readonly platformLoginTitle: () => string
}

/** Own one BrowserWindow and Tray generation, including every native listener. */
export class ElectronShellGeneration {
  private window: BrowserWindow | undefined
  private renderer: WebContents | undefined
  private compatibilityShell: CompatibilityShell | undefined
  private tray: Tray | undefined
  private mounted = false
  private released = false
  private attentionCount = 0
  private prepareFullscreenReveal: (() => void) | undefined
  private flushWindowState: (() => void) | undefined
  private cleanupListeners: (() => void) | undefined
  private readonly rendererRecovery: DesktopRendererRecovery
  private rendererRecoveryPending = false
  private readonly surfaceWatchdog: RendererSurfaceWatchdog
  private unresponsiveRenderer = false
  private replacementExit: ReturnType<typeof setTimeout> | undefined
  private recoveryContentLoaded = false
  private recoveryChromeLoaded = false
  private readonly platformLogin: PlatformLoginWindow

  constructor(private readonly options: ElectronShellGenerationOptions) {
    this.platformLogin = new PlatformLoginWindow({
      BrowserWindow,
      session: partition => session.fromPartition(partition),
      hostOrigin: () => this.renderer === undefined ? undefined : new URL(this.options.spec.url).origin,
      host: async () => {
        const renderer = this.renderer
        if (renderer === undefined || renderer.isDestroyed()) return undefined
        const origin = new URL(this.options.spec.url).origin
        const cookies = await renderer.session.cookies.get({ url: origin })
        return {
          origin,
          cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
          header: this.options.spec.rendererAccessHeader,
        }
      },
      parent: () => this.window,
      title: () => this.options.platformLoginTitle(),
      dark: () => nativeTheme.shouldUseDarkColors,
      warn: message => { this.options.logError(message) },
    })
    this.rendererRecovery = new DesktopRendererRecovery({
      available: () => !this.released && !this.options.isQuitting()
        && this.window !== undefined && !this.window.isDestroyed(),
      reload: () => {
        this.recoveryContentLoaded = false
        this.recoveryChromeLoaded = this.compatibilityShell === undefined
        this.compatibilityShell?.chromeWebContents.reloadIgnoringCache()
        this.reloadRenderer()
      },
      exhausted: () => { void this.offerRendererRecovery() },
      log: message => { this.options.logError(`dsh-plugin-desktop: ${message}`) },
      requireSurface: () => this.window !== undefined && this.window.isVisible() && !this.window.isMinimized(),
    })
    this.surfaceWatchdog = new RendererSurfaceWatchdog({
      active: () => {
        const renderer = this.renderer
        return !this.released && !this.options.isQuitting() && this.options.canRecoverRenderer()
          && this.window !== undefined && !this.window.isDestroyed()
          && this.window.isVisible() && !this.window.isMinimized()
          && this.rendererRecovery.canProbeSurface
          && renderer !== undefined && !renderer.isDestroyed() && !renderer.isLoadingMainFrame()
      },
      probe: () => this.renderer!.executeJavaScript(RENDERER_SURFACE_PROBE),
      healthy: () => { this.rendererRecovery.confirmSurface() },
      hidden: () => { this.rendererRecovery.surfaceBecameHidden() },
      failed: (detail, unresponsive) => {
        this.options.logError(`dsh-plugin-desktop: ${detail}`)
        this.unresponsiveRenderer = unresponsive
        this.rendererRecovery.fail(detail)
      },
    })
  }

  async mount(beforeInteractive?: () => void): Promise<void> {
    if (this.mounted || this.window !== undefined) {
      throw new Error('dsh-plugin-desktop: native shell generation is already mounted')
    }

    const { platform, spec } = this.options
    const icon = nativeImage.createFromPath(spec.iconPath)
    if (icon.isEmpty()) {
      throw new Error(`dsh-plugin-desktop: failed to load application icon ${spec.iconPath}`)
    }
    platform.configureApplication(icon, spec.productName, this.options.buildApplicationMenuItems())
    const origin = new URL(spec.url).origin
    if (platform.platform !== 'linux') nativeTheme.themeSource = spec.readThemeSource()
    let persistedBounds: MainWindowBounds | undefined
    let restoredBounds: MainWindowBounds | undefined
    try {
      persistedBounds = this.options.mainWindowState.read()
      if (persistedBounds !== undefined) {
        const display = screen.getDisplayMatching(persistedBounds)
        restoredBounds = fitMainWindowBounds(persistedBounds, display.workArea, {
          width: spec.minWidth,
          height: spec.minHeight,
        })
      }
    } catch (cause) {
      this.options.logError(`dsh-plugin-desktop: failed to restore main-window state: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const isolated = spec.mode !== 'advanced' && platform.platform !== 'linux'
    const windowOptions = desktopWindowOptions(spec, icon, platform.platform, this.options.preloadPath)
    const window = new BrowserWindow({
      ...windowOptions,
      ...(isolated ? { webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: 'dsh-desktop-compatibility-host',
      } } : {}),
      ...(restoredBounds ?? {}),
    })
    window.accessibleTitle = spec.windowTitle
    platform.configureWindow(window)
    this.window = window
    try {
      if (isolated) {
        this.compatibilityShell = new CompatibilityShell(window, spec, platform.platform, this.options.preloadPath, this.options.chromeActions)
      }
    } catch (cause) {
      await this.release()
      throw cause
    }
    const renderer = this.compatibilityShell?.webContents ?? window.webContents
    const chrome = this.compatibilityShell?.chromeWebContents ?? window.webContents
    this.renderer = renderer

    // Desktop-owned actions stay on the Electron lifetime. The page reaches the
    // main process directly, so a Host generation that exited, hung, or never
    // booted cannot take restart, terminal, or diagnostics down with it.
    const dispatchRendererAction = createDesktopRendererActionDispatcher(
      this.options.chromeActions,
      message => { this.options.logError(message) },
    )
    renderer.ipc.handle(DESKTOP_RENDERER_ACTION_CHANNEL, async (event, action: unknown) => {
      if (this.released || event.sender !== renderer
        || event.senderFrame === null || event.senderFrame !== renderer.mainFrame
        || !sameOriginFrame(event.senderFrame.url, origin)) {
        throw new Error('dsh-plugin-desktop: untrusted Desktop action sender')
      }
      await dispatchRendererAction(action)
    })

    if (platform.platform === 'darwin') {
      renderer.ipc.handle(DESKTOP_NATIVE_DIRECTORY_PICKER_CHANNEL, async event => {
        if (this.released || event.sender !== renderer
          || event.senderFrame === null || event.senderFrame !== renderer.mainFrame
          || !sameOriginFrame(event.senderFrame.url, origin)) {
          throw new Error('dsh-plugin-desktop: untrusted directory picker sender')
        }
        return await this.options.pickDirectory()
      })
    }

    renderer.ipc.handle(SETUP_ONBOARDING_CHANNEL, async (event, request: unknown) => {
      if (this.released || event.sender !== renderer || event.senderFrame !== renderer.mainFrame
        || !sameOriginFrame(event.senderFrame.url, origin)) throw new Error('Untrusted setup sender')
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid setup request')
      const value = request as { action?: unknown; profile?: unknown; selection?: unknown }
      if (value.action === 'read') return await this.options.setupOnboarding?.read() ?? null
      if (value.action === 'apply-pending' && typeof value.profile === 'string' && this.options.setupOnboarding?.applyPending) {
        return this.options.setupOnboarding.applyPending(value.profile)
      }
      if (value.action === 'dismiss-account' && typeof value.profile === 'string' && this.options.setupOnboarding) {
        return this.options.setupOnboarding.dismissAccount(value.profile)
      }
      if (value.action !== 'finish' || typeof value.profile !== 'string' || !this.options.setupOnboarding) throw new Error('Setup is unavailable')
      if (value.selection !== undefined && !isDesktopSetupWizardSelection(value.selection)) throw new Error('Invalid setup selection')
      const { spec } = this.options
      await this.options.setupOnboarding.finish(value.profile, value.selection,
        spec.applySetupSettings === undefined ? undefined : settings => spec.applySetupSettings!(settings))
    })

    let stateWriteTimer: ReturnType<typeof setTimeout> | undefined
    const persistWindowState = (): void => {
      if (stateWriteTimer !== undefined) {
        clearTimeout(stateWriteTimer)
        stateWriteTimer = undefined
      }
      if (window.isDestroyed()) return
      const bounds = window.getNormalBounds()
      if (persistedBounds !== undefined && sameMainWindowBounds(bounds, persistedBounds)) return
      try {
        this.options.mainWindowState.write(bounds)
        persistedBounds = { ...bounds }
      } catch (cause) {
        this.options.logError(`dsh-plugin-desktop: failed to save main-window state: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    const scheduleWindowStateWrite = (): void => {
      if (stateWriteTimer !== undefined) clearTimeout(stateWriteTimer)
      stateWriteTimer = setTimeout(persistWindowState, WINDOW_STATE_WRITE_DELAY_MS)
      stateWriteTimer.unref()
    }
    this.flushWindowState = persistWindowState

    const show = (): void => { this.show() }
    let startupSurfaceRevealed = false
    const revealStartupSurface = (): void => {
      if (window.isDestroyed()) return
      // A late ready-to-show must not override the user's decision to hide the
      // window after the startup surface was revealed early.
      if (startupSurfaceRevealed) return
      startupSurfaceRevealed = true
      this.show()
    }
    const activate = (): void => {
      if (applicationNeedsReveal(window, platform.platform)) this.show()
    }
    const clearAttention = (): void => { this.clearAttention() }
    // Closing the window must never strand the Host. Where the tray is
    // guaranteed reachable the window hides; elsewhere it minimizes, which
    // keeps every session running and leaves one reachable surface behind.
    const dismissWindow = (): void => {
      if (platform.hidesWindowOnClose) window.hide()
      else window.minimize()
    }
    let fullscreenExitPending = false
    let hideAfterFullscreenExit = false
    let restoreAfterFullscreenExit = false
    let restoreFullscreenOnShow = false
    const finishFullscreenExit = (): void => {
      if (!fullscreenExitPending) return
      fullscreenExitPending = false
      const shouldHide = hideAfterFullscreenExit
      const shouldRestore = restoreAfterFullscreenExit
      hideAfterFullscreenExit = false
      restoreAfterFullscreenExit = false
      if (window.isDestroyed()) return
      if (shouldHide) {
        dismissWindow()
        return
      }
      if (shouldRestore) {
        restoreFullscreenOnShow = false
        window.setFullScreen(true)
      }
    }
    const prepareFullscreenReveal = (): void => {
      if (!restoreFullscreenOnShow || window.isDestroyed()) return
      if (fullscreenExitPending) {
        hideAfterFullscreenExit = false
        restoreAfterFullscreenExit = true
        return
      }
      if (window.isFullScreen()) {
        restoreFullscreenOnShow = false
        return
      }
      restoreFullscreenOnShow = false
      window.setFullScreen(true)
    }
    const cleanupFullscreenTransition = (): void => {
      if (fullscreenExitPending) window.off('leave-full-screen', finishFullscreenExit)
      fullscreenExitPending = false
      hideAfterFullscreenExit = false
      restoreAfterFullscreenExit = false
      restoreFullscreenOnShow = false
    }
    this.prepareFullscreenReveal = prepareFullscreenReveal
    const close = (event: Electron.Event): void => {
      persistWindowState()
      if (this.options.isQuitting()) return
      event.preventDefault()
      if (platform.platform === 'darwin' && fullscreenExitPending) {
        hideAfterFullscreenExit = true
        restoreAfterFullscreenExit = false
        return
      }
      if (platform.platform === 'darwin' && window.isFullScreen()) {
        fullscreenExitPending = true
        hideAfterFullscreenExit = true
        restoreFullscreenOnShow = true
        window.once('leave-full-screen', finishFullscreenExit)
        window.setFullScreen(false)
        return
      }
      dismissWindow()
    }
    const preserveBlankTitle = (event: Electron.Event): void => { event.preventDefault() }
    const handleZoomShortcut = (event: Electron.Event, input: Electron.Input): void => {
      const action = isZoomShortcut(input)
      if (action === undefined) return
      event.preventDefault()
      if (action === 'reset') {
        renderer.setZoomLevel(0)
        return
      }
      const step = action === 'in' ? 1 : -1
      renderer.setZoomLevel(clampedZoomLevel(renderer.getZoomLevel() + step))
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
      this.surfaceWatchdog.reset()
      if (this.replacementExit !== undefined && (details.reason === 'crashed' || details.reason === 'killed')) {
        this.finishRendererReplacement(details)
        return
      }
      const detail = `renderer process gone (reason: ${details.reason}, exitCode: ${formatDesktopExitCode(details.exitCode)})`
      this.options.logError(`dsh-plugin-desktop: ${detail}`)
      this.options.failRendererBoot(detail)
      if (details.reason !== 'clean-exit' && details.reason !== 'killed'
        && this.options.canRecoverRenderer()) {
        this.rendererRecovery.fail(detail)
      }
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
        if (this.options.canRecoverRenderer()) {
          this.rendererRecovery.fail(`renderer main frame failed to load (${String(errorCode)}: ${errorDescription})`)
        }
      }
    }
    const loaded = (): void => {
      this.clearReplacementExit()
      this.recoveryContentLoaded = true
      if (this.recoveryChromeLoaded) this.rendererRecovery.loaded()
    }
    const chromeLoaded = (): void => {
      this.recoveryChromeLoaded = true
      if (this.recoveryContentLoaded) this.rendererRecovery.loaded()
    }

    app.on('activate', activate)
    const resetSurface = (): void => {
      this.surfaceWatchdog.reset()
      this.rendererRecovery.visibilityChanged()
    }
    window.on('hide', resetSurface)
    window.on('minimize', resetSurface)
    window.on('show', resetSurface)
    window.on('restore', resetSurface)
    if (platform.platform === 'darwin') app.on('did-become-active', activate)
    window.on('close', close)
    window.on('focus', clearAttention)
    window.on('move', scheduleWindowStateWrite)
    window.on('resize', scheduleWindowStateWrite)
    window.on('page-title-updated', preserveBlankTitle)
    renderer.on('before-input-event', handleZoomShortcut)
    renderer.on('will-frame-navigate', navigate)
    renderer.on('will-redirect', redirect)
    renderer.on('render-process-gone', rendererGone)
    renderer.on('did-fail-load', loadFailed)
    renderer.on('did-start-loading', resetSurface)
    renderer.on('did-finish-load', loaded)
    if (isolated) {
      chrome.on('before-input-event', handleZoomShortcut)
      chrome.on('render-process-gone', rendererGone)
      chrome.on('did-fail-load', loadFailed)
      chrome.on('did-finish-load', chromeLoaded)
    }
    renderer.setWindowOpenHandler(({ url }) => {
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
    window.once('ready-to-show', revealStartupSurface)
    let tray: Tray | undefined
    let removeRendererAccessHeader: (() => void) | undefined
    this.cleanupListeners = () => {
      window.off('hide', resetSurface)
      window.off('minimize', resetSurface)
      window.off('show', resetSurface)
      window.off('restore', resetSurface)
      app.off('activate', activate)
      if (platform.platform === 'darwin') app.off('did-become-active', activate)
      window.off('close', close)
      window.off('focus', clearAttention)
      window.off('move', scheduleWindowStateWrite)
      window.off('resize', scheduleWindowStateWrite)
      window.off('page-title-updated', preserveBlankTitle)
      window.off('ready-to-show', revealStartupSurface)
      cleanupFullscreenTransition()
      renderer.off('before-input-event', handleZoomShortcut)
      renderer.off('will-frame-navigate', navigate)
      renderer.off('will-redirect', redirect)
      renderer.off('render-process-gone', rendererGone)
      renderer.off('did-fail-load', loadFailed)
      renderer.off('did-start-loading', resetSurface)
      renderer.off('did-finish-load', loaded)
      if (!renderer.isDestroyed()) {
        renderer.ipc.removeHandler(DESKTOP_RENDERER_ACTION_CHANNEL)
        if (platform.platform === 'darwin') renderer.ipc.removeHandler(DESKTOP_NATIVE_DIRECTORY_PICKER_CHANNEL)
        renderer.ipc.removeHandler(SETUP_ONBOARDING_CHANNEL)
      }
      if (isolated) {
        chrome.off('before-input-event', handleZoomShortcut)
        chrome.off('render-process-gone', rendererGone)
        chrome.off('did-fail-load', loadFailed)
        chrome.off('did-finish-load', chromeLoaded)
      }
      removeRendererAccessHeader?.()
      removeRendererAccessHeader = undefined
      tray?.off('click', show)
      if (stateWriteTimer !== undefined) {
        clearTimeout(stateWriteTimer)
        stateWriteTimer = undefined
      }
    }

    try {
      await this.compatibilityShell?.load()
      await authenticateRendererSession(renderer, spec)
      removeRendererAccessHeader = installRendererAccessHeader(
        renderer,
        origin,
        spec.rendererAccessHeader,
      )
      revealStartupSurface()
      if (isolated) await renderer.loadURL(spec.url)
      else await window.loadURL(spec.url)
      if (isolated) renderer.focus()
      tray = new Tray(prepareTrayIcon(spec.trayIcons, platform.platform))
      this.tray = tray
      tray.setToolTip(spec.productName)
      this.refreshTrayMenu()
      tray.on('click', show)
      beforeInteractive?.()
      this.mounted = true
      this.surfaceWatchdog.start()
    } catch (cause) {
      this.options.abortRendererBootMonitoring(cause)
      await this.release()
      throw cause
    }
  }

  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    this.clearAttention()
    revealApplication(window, this.options.platform.platform)
    this.prepareFullscreenReveal?.()
    if (this.rendererRecovery.exhausted) void this.offerRendererRecovery()
  }

  /**
   * Show a DeepSeek Platform authorization page in the built-in sign-in window.
   * @param url - authorization URL validated at the Host/native boundary.
   */
  openPlatformLogin(url: string): void {
    if (this.released || this.renderer === undefined) return
    this.platformLogin.open(url)
  }

  /** Close the built-in sign-in window after its attempt ended. */
  closePlatformLogin(): void {
    this.platformLogin.close()
  }

  reportRendererRecovery(report: RendererBootReport): void {
    this.rendererRecovery.report(report)
  }

  stopRendererRecovery(): void {
    this.surfaceWatchdog.stop()
    this.rendererRecovery.stop()
  }

  private async offerRendererRecovery(): Promise<void> {
    const window = this.window
    if (this.rendererRecoveryPending || this.released || this.options.isQuitting()
      || window === undefined || window.isDestroyed() || !this.rendererRecovery.exhausted) return
    this.rendererRecoveryPending = true
    try {
      this.show()
      const copy = this.options.rendererRecoveryCopy()
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title: copy.title,
        message: copy.message,
        detail: `${copy.detail}\n\n${this.rendererRecovery.detail}`,
        buttons: [copy.confirm, copy.cancel],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (result.response !== 0 || this.released || this.options.isQuitting()
        || this.window !== window || window.isDestroyed()) return
      this.rendererRecovery.retry()
    } catch (cause) {
      this.options.logError(`dsh-plugin-desktop: renderer recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      this.rendererRecoveryPending = false
    }
  }

  /** Reload the active renderer without permitting arbitrary renderer commands. */
  reloadRenderer(): void {
    this.surfaceWatchdog.reset()
    const window = this.window
    if (window === undefined || window.isDestroyed()) {
      throw new Error('dsh-plugin-desktop: renderer reload requires a mounted window')
    }
    if (this.unresponsiveRenderer) {
      this.unresponsiveRenderer = false
      if (this.beginRendererReplacement()) return
    }
    this.renderer?.reloadIgnoringCache()
  }

  /**
   * Restore the interface from a native affordance that stays reachable while
   * the renderer cannot draw anything. An exhausted recovery is restarted
   * through its own controller so that a successful reload also clears the
   * degraded state instead of leaving the fallback prompt armed forever.
   */
  requestRendererReload(): void {
    if (this.rendererRecovery.exhausted) {
      this.rendererRecovery.retry()
      return
    }
    this.reloadRenderer()
  }

  /**
   * Terminate a renderer that has stopped answering the main process, and
   * reload only once its exit is confirmed.
   *
   * `forcefullyCrashRenderer()` returns before the process is gone, so a reload
   * issued in the same turn is handed to a RenderFrameHost that is already
   * being torn down, and Chromium cancels it along with the process. Driving
   * the reload from `render-process-gone` instead lets Chromium spawn a fresh
   * renderer, with a deadline covering an exit notification that never arrives.
   *
   * @returns whether the termination was issued and now owns the reload.
   */
  private beginRendererReplacement(): boolean {
    const renderer = this.renderer
    if (renderer === undefined || renderer.isDestroyed()) return false
    this.clearReplacementExit()
    this.replacementExit = setTimeout(() => {
      this.replacementExit = undefined
      this.options.logError('dsh-plugin-desktop: forced renderer termination reported no exit within the deadline; reloading anyway')
      this.renderer?.reloadIgnoringCache()
    }, REPLACEMENT_EXIT_TIMEOUT_MS)
    this.replacementExit.unref()
    // Name the deliberate termination in the log. Windows writes a crash dump
    // for the hung process, and an unattributed dump cannot be told apart from
    // a spontaneous renderer crash when the collected evidence is triaged.
    this.options.logError('dsh-plugin-desktop: terminating unresponsive renderer; the crash dump it produces is deliberate')
    renderer.forcefullyCrashRenderer()
    return true
  }

  /** Consume the exit owed by a forced termination and start the real reload. */
  private finishRendererReplacement(details: Electron.RenderProcessGoneDetails): void {
    this.clearReplacementExit()
    this.options.logError(
      `dsh-plugin-desktop: unresponsive renderer replaced (reason: ${details.reason}, exitCode: ${formatDesktopExitCode(details.exitCode)})`,
    )
    this.renderer?.reloadIgnoringCache()
  }

  private clearReplacementExit(): void {
    if (this.replacementExit === undefined) return
    clearTimeout(this.replacementExit)
    this.replacementExit = undefined
  }

  /** Toggle Developer Tools for the active renderer. */
  toggleDeveloperTools(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) {
      throw new Error('dsh-plugin-desktop: Developer Tools require a mounted window')
    }
    const renderer = this.renderer
    if (renderer === undefined || renderer.isDestroyed()) return
    if (renderer.isDevToolsOpened()) renderer.closeDevTools()
    else renderer.openDevTools({ mode: 'detach', activate: true })
  }

  /**
   * Hand one launch folder to the mounted Host page.
   *
   * The delivery script resolves immediately in both directions, so a page that
   * has not yet installed the client seam parks the folder instead of keeping
   * the main process waiting on a renderer promise.
   * @param path - absolute folder already admitted by native policy.
   * @returns how the page took the folder, or `'unavailable'` when no renderer
   *   could take it.
   */
  async openWorkspacePath(path: string): Promise<DesktopOpenWorkspaceDelivery | 'unavailable'> {
    const renderer = this.renderer
    if (this.released || renderer === undefined || renderer.isDestroyed()) return 'unavailable'
    const delivery: unknown = await renderer.executeJavaScript(desktopOpenWorkspaceScript(path))
    return delivery === 'delivered' || delivery === 'pending' ? delivery : 'unavailable'
  }

  notifyAttention(notification: DesktopNotification): void {
    const window = this.window
    if (window === undefined || window.isDestroyed() || window.isFocused()) return

    this.attentionCount += 1
    if (this.options.platform.platform === 'win32') window.flashFrame(true)
    else app.setBadgeCount(this.attentionCount)

    if (!Notification.isSupported()) return
    const nativeNotification = new Notification(notification)
    nativeNotification.once('click', () => { this.show() })
    nativeNotification.show()
  }

  async showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
    const window = this.window
    return window === undefined || window.isDestroyed()
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options)
  }

  async showMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    const window = this.window
    return window === undefined || window.isDestroyed()
      ? await showDesktopMessageBox(options)
      : await showDesktopMessageBox(options, window)
  }

  async showSaveDialog(options: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> {
    const window = this.window
    return window === undefined || window.isDestroyed()
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(window, options)
  }

  refreshTrayMenu(): void {
    this.compatibilityShell?.refresh()
    if (this.tray === undefined) return
    this.tray.setContextMenu(Menu.buildFromTemplate(this.options.buildTrayTemplate()))
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.clearReplacementExit()
    this.surfaceWatchdog.stop()
    this.rendererRecovery.stop()
    this.options.stopRendererBootMonitoring()
    this.platformLogin.close()

    const window = this.window
    const tray = this.tray
    this.clearAttention()
    this.flushWindowState?.()
    this.window = undefined
    this.tray = undefined
    this.prepareFullscreenReveal = undefined
    this.flushWindowState = undefined
    if (window === undefined) return

    this.cleanupListeners?.()
    this.cleanupListeners = undefined
    this.compatibilityShell?.dispose()
    this.compatibilityShell = undefined
    this.renderer = undefined
    tray?.destroy()
    if (!window.isDestroyed()) window.destroy()
  }

  private clearAttention(): void {
    if (this.attentionCount === 0) return
    this.attentionCount = 0
    if (this.options.platform.platform === 'win32') {
      const window = this.window
      if (window !== undefined && !window.isDestroyed()) window.flashFrame(false)
    } else {
      app.setBadgeCount(0)
    }
  }
}
