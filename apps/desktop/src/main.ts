/** Electron application shell for the loopback DeepSeek Harness Web Host. */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  type Event,
  type MenuItemConstructorOptions,
} from 'electron'
import { createHostSupervisor, spawnDshWeb, type HostSupervisor } from './host-supervisor.ts'
import { resolveDesktopEnvironment } from './shell-environment.ts'
import { redactDesktopDiagnostic } from './startup-diagnostics.ts'
import { createDesktopStartupLogger, type DesktopStartupLogger } from './startup-log.ts'
import {
  DesktopStartupCancelledError,
  startRecoverableDesktopHost,
  type DesktopHostMode,
  type DesktopRecoveryChoice,
  type DesktopRecoveryRequest,
} from './startup-controller.ts'
import { createDesktopLifecycle, type DesktopLifecycle } from './window-lifecycle.ts'

const APP_NAME = 'DeepSeek Harness'
const WINDOW_WIDTH = 1440
const WINDOW_HEIGHT = 920
const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(DESKTOP_DIR, '../..')

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let host: HostSupervisor | undefined
let lifecycle: DesktopLifecycle | undefined
let hostOrigin: string | undefined
let bootQuitPromise: Promise<void> | undefined
let quitReleased = false
let startupDialogOwner: BrowserWindow | undefined
let safeMode = false
let startupLogger: DesktopStartupLogger | undefined
const bootAbort = new AbortController()

/** Resolve artifacts from the checkout in development and resourcesPath when packaged. */
function hostPaths(): { nodeExecutable: string; cliEntry: string; cwd: string; electronRunAsNode: boolean } {
  if (!app.isPackaged) {
    return {
      nodeExecutable: process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? 'node',
      cliEntry: join(REPOSITORY_ROOT, 'apps/cli/lib/bin.js'),
      cwd: process.cwd(),
      electronRunAsNode: false,
    }
  }
  return {
    nodeExecutable: process.execPath,
    cliEntry: join(process.resourcesPath, 'host/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    cwd: app.getPath('home'),
    electronRunAsNode: true,
  }
}

function assertHostArtifacts(paths: ReturnType<typeof hostPaths>): void {
  if (paths.nodeExecutable.includes('/') && !existsSync(paths.nodeExecutable)) {
    throw new Error(`desktop Node runtime is missing: ${paths.nodeExecutable}`)
  }
  if (!existsSync(paths.cliEntry)) {
    throw new Error(app.isPackaged
      ? `desktop Host entry is missing from the application: ${paths.cliEntry}; reinstall ${APP_NAME}`
      : `desktop Host entry is missing: ${paths.cliEntry}; run pnpm run build first`)
  }
}

/** Load the app-local tray template, with an empty fallback for incomplete staging. */
function trayImage(): Electron.NativeImage {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'desktop-resources/trayTemplate.png')]
    : [join(DESKTOP_DIR, 'resources/trayTemplate.png')]
  const path = candidates.find(candidate => existsSync(candidate))
  const image = path === undefined ? nativeImage.createEmpty() : nativeImage.createFromPath(path)
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

function isExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function hasOrigin(raw: string, expected: string): boolean {
  try {
    return new URL(raw).origin === expected
  } catch {
    return false
  }
}

/** Install navigation and permission policy before the first renderer loads. */
function hardenSession(): void {
  const desktopSession = session.defaultSession
  desktopSession.setPermissionCheckHandler(() => false)
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false) })
}

async function createMainWindow(): Promise<BrowserWindow> {
  const origin = hostOrigin
  if (origin === undefined) throw new Error('desktop Host is not ready')
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    frame: process.platform === 'win32',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : {
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#7f858f',
        height: 44,
      },
    }),
    ...(process.platform === 'darwin' ? {
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar' as const,
      visualEffectState: 'followWindow' as const,
    } : {}),
    ...(process.platform === 'win32' ? {
      backgroundMaterial: 'acrylic' as const,
      hasShadow: true,
      roundedCorners: true,
      thickFrame: true,
    } : {
      transparent: true,
      backgroundColor: '#00000000',
    }),
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  mainWindow = window
  window.on('close', (event) => { lifecycle?.onWindowClose(event) })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (hasOrigin(url, origin)) return
    event.preventDefault()
    if (isExternalUrl(url)) void shell.openExternal(url)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const rendererUrl = new URL(origin)
  rendererUrl.searchParams.set('dsh-desktop-platform', process.platform)
  await window.loadURL(rendererUrl.href)
  if (!lifecycle?.isQuitting) window.show()
  return window
}

function createTray(): void {
  tray = new Tray(trayImage())
  tray.setToolTip(safeMode ? `${APP_NAME} — Safe Mode` : APP_NAME)
  const template: MenuItemConstructorOptions[] = [
    { label: '打开主窗口', click: () => { void lifecycle?.showWindow() } },
    { type: 'separator' },
    { label: '退出', click: () => { void requestAppQuit() } },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
  tray.on('click', () => { void lifecycle?.showWindow() })
}

function releaseAppQuit(): void {
  quitReleased = true
  tray?.destroy()
  tray = undefined
  app.quit()
}

/** Join explicit quit requests even while the Host or window is still starting. */
function requestAppQuit(): Promise<void> {
  bootAbort.abort()
  if (lifecycle !== undefined) return lifecycle.requestQuit()
  bootQuitPromise ??= (host?.shutdown() ?? Promise.resolve()).catch((error: unknown) => {
    reportDesktopError('desktop shutdown failed:', error)
  }).then(() => {
    releaseAppQuit()
  })
  return bootQuitPromise
}

function localizedCopy(): {
  continueWaiting: string
  copyDiagnostic: string
  failureDetail: string
  failureMessage: string
  openApp: string
  openConfig: string
  quit: string
  retry: string
  retrySafe: string
  safeMode: string
  safeModeDetail: string
  safeModeMessage: string
  slowDetail: string
  slowMessage: string
} {
  if (app.getLocale().toLowerCase().startsWith('zh')) {
    return {
      continueWaiting: '继续等待',
      copyDiagnostic: '复制诊断',
      failureDetail: '可以重试，或使用安全模式临时停用自定义插件配置。现有配置文件不会被修改。',
      failureMessage: 'DeepSeek Harness 启动失败',
      openApp: '进入应用',
      openConfig: '打开配置目录',
      quit: '退出',
      retry: '重试',
      retrySafe: '重试安全模式',
      safeMode: '安全模式',
      safeModeDetail: '本次运行已停用 profile 和全局自定义 patch。凭据、设置、会话和工作区数据保持不变。',
      safeModeMessage: '已进入安全模式',
      slowDetail: '某个本地插件或 MCP 服务可能仍在初始化。可以继续等待，或用安全模式启动。',
      slowMessage: 'DeepSeek Harness 启动时间较长',
    }
  }
  return {
    continueWaiting: 'Keep Waiting',
    copyDiagnostic: 'Copy Diagnostic',
    failureDetail: 'Retry, or start in Safe Mode with custom plugin patches disabled for this run. Existing files remain unchanged.',
    failureMessage: 'DeepSeek Harness failed to start',
    openApp: 'Open App',
    openConfig: 'Open Config Folder',
    quit: 'Quit',
    retry: 'Retry',
    retrySafe: 'Retry Safe Mode',
    safeMode: 'Safe Mode',
    safeModeDetail: 'Profile and global custom patches are disabled for this run. Credentials, settings, sessions, and workspaces remain available.',
    safeModeMessage: 'Safe Mode is active',
    slowDetail: 'A local plugin or MCP service may still be initializing. Keep waiting or start with custom patches disabled.',
    slowMessage: 'DeepSeek Harness is taking longer to start',
  }
}

function desktopConfigPath(environment: NodeJS.ProcessEnv): string {
  return resolve(environment.DSH_HOME ?? join(app.getPath('home'), '.dsh'), 'profiles', 'web', 'cordis.patch.yml')
}

function startupDiagnostic(request: DesktopRecoveryRequest): string {
  const error = request.error === undefined
    ? 'Host readiness pending'
    : request.error instanceof Error
      ? request.error.message
      : typeof request.error === 'string'
        ? request.error
        : 'Unknown Host startup failure'
  return redactDesktopDiagnostic([
    `DeepSeek Harness ${app.getVersion()}`,
    `platform: ${process.platform}`,
    `mode: ${request.mode}`,
    `kind: ${request.kind}`,
    error,
  ].join('\n'))
}

function reportDesktopError(label: string, error: unknown): void {
  if (!app.isPackaged) {
    console.error(label, error)
    return
  }
  const detail = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'Unknown desktop failure'
  console.error(`${label} ${redactDesktopDiagnostic(detail)}`)
}

async function showRecoveryPrompt(
  request: DesktopRecoveryRequest,
  environment: NodeJS.ProcessEnv,
): Promise<DesktopRecoveryChoice> {
  const copy = localizedCopy()
  const owner = new BrowserWindow({ show: false, skipTaskbar: true, width: 1, height: 1 })
  startupDialogOwner = owner
  try {
    for (;;) {
      type RecoveryDialogAction = DesktopRecoveryChoice | 'copy-diagnostic' | 'open-config'
      const actions: RecoveryDialogAction[] = request.kind === 'slow'
        ? ['wait', 'safe-mode', 'quit']
        : request.mode === 'normal'
          ? ['retry', 'safe-mode', 'copy-diagnostic', 'open-config', 'quit']
          : ['retry', 'copy-diagnostic', 'open-config', 'quit']
      const buttons = request.kind === 'slow'
        ? [copy.continueWaiting, copy.safeMode, copy.quit]
        : request.mode === 'normal'
          ? [copy.retry, copy.safeMode, copy.copyDiagnostic, copy.openConfig, copy.quit]
          : [copy.retrySafe, copy.copyDiagnostic, copy.openConfig, copy.quit]
      const result = await dialog.showMessageBox(owner, {
        type: request.kind === 'slow' ? 'warning' : 'error',
        title: APP_NAME,
        message: request.kind === 'slow' ? copy.slowMessage : copy.failureMessage,
        detail: request.kind === 'slow'
          ? copy.slowDetail
          : `${copy.failureDetail}\n\n${startupDiagnostic(request)}`,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        signal: request.signal,
        noLink: true,
      })
      if (request.signal.aborted) return 'dismissed'
      const action = actions[result.response] ?? 'quit'
      if (action === 'copy-diagnostic') {
        clipboard.writeText(startupDiagnostic(request))
        continue
      }
      if (action === 'open-config') {
        shell.showItemInFolder(desktopConfigPath(environment))
        continue
      }
      return action
    }
  } finally {
    if (!owner.isDestroyed()) owner.destroy()
    if (startupDialogOwner === owner) startupDialogOwner = undefined
  }
}

async function showSafeModeNotice(environment: NodeJS.ProcessEnv): Promise<void> {
  const copy = localizedCopy()
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: APP_NAME,
    message: copy.safeModeMessage,
    detail: copy.safeModeDetail,
    buttons: [copy.openApp, copy.openConfig],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (result.response === 1) shell.showItemInFolder(desktopConfigPath(environment))
}

async function boot(): Promise<void> {
  if (bootQuitPromise !== undefined) return
  const paths = hostPaths()
  assertHostArtifacts(paths)
  hardenSession()
  app.setAppLogsPath()
  startupLogger = createDesktopStartupLogger(app.getPath('logs'), app.getVersion(), process.platform)
  const bootStartedAt = Date.now()
  const environmentResolution = await resolveDesktopEnvironment({
    environment: process.env,
    home: app.getPath('home'),
    isPackaged: app.isPackaged,
    platform: process.platform,
  })
  if (environmentResolution.fallbackReason === 'capture-failed' || environmentResolution.fallbackReason === 'missing-shell') {
    console.warn(`desktop shell environment unavailable (${environmentResolution.fallbackReason}); using inherited process environment`)
  }
  startupLogger.write({
    event: 'environment-resolved',
    reason: environmentResolution.fallbackReason ?? environmentResolution.source,
    elapsedMs: Date.now() - bootStartedAt,
  })
  const started = await startRecoverableDesktopHost({
    signal: bootAbort.signal,
    createHost: (mode: DesktopHostMode) => {
      const created = createHostSupervisor({
        spawnHost: () => spawnDshWeb({
          ...paths,
          env: {
            ...environmentResolution.environment,
            DSH_DESKTOP: '1',
          },
          safeMode: mode === 'safe',
        }),
        ...(app.isPackaged ? {} : { log: (chunk: string) => process.stderr.write(chunk) }),
        onCallbackError: (error) => { reportDesktopError('desktop Host observer callback failed:', error) },
        onUnexpectedExit: ({ code, signal }) => {
          console.error(`desktop Host exited unexpectedly (code ${String(code)}, signal ${String(signal)})`)
          void requestAppQuit()
        },
      })
      host = created
      return created
    },
    prompt: request => showRecoveryPrompt(request, environmentResolution.environment),
    onState: (state) => {
      startupLogger?.write({
        event: state,
        mode: state.includes('safe') ? 'safe' : 'normal',
        elapsedMs: Date.now() - bootStartedAt,
      })
    },
    onCallbackError: (error) => { reportDesktopError('desktop startup diagnostic callback failed:', error) },
  })
  if (bootAbort.signal.aborted) return
  host = started.host
  hostOrigin = started.origin
  safeMode = started.safeMode
  lifecycle = createDesktopLifecycle({
    getWindow: () => mainWindow,
    createWindow: createMainWindow,
    disposeHost: async () => { await host?.shutdown() },
    quit: releaseAppQuit,
    reportError: (error) => { reportDesktopError('desktop shutdown failed:', error) },
  })
  createTray()
  if (safeMode) await showSafeModeNotice(environmentResolution.environment)
  await lifecycle.showWindow()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    app.focus({ steal: true })
    startupDialogOwner?.focus()
    void lifecycle?.showWindow()
  })
  app.on('activate', () => { void lifecycle?.showWindow() })
  app.on('window-all-closed', () => {
    // Tray and Host own application lifetime on every platform.
  })
  app.on('before-quit', (event: Event) => {
    if (quitReleased) return
    event.preventDefault()
    void requestAppQuit()
  })
  app.whenReady().then(boot).catch(async (error: unknown) => {
    reportDesktopError('desktop startup failed:', error)
    if (!(error instanceof DesktopStartupCancelledError) && bootQuitPromise === undefined) {
      await dialog.showMessageBox({
        type: 'error',
        title: `${APP_NAME} failed to start`,
        message: redactDesktopDiagnostic(error instanceof Error ? error.message : 'Unknown desktop startup failure'),
      })
    }
    await requestAppQuit()
  })
}
