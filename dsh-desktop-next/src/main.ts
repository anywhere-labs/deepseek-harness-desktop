/** Official Desktop transport with a Host-independent native shell. */
import { installDesktopShortcuts } from './keyboard.ts'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, Notification, protocol, safeStorage, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { appRequestHeaders, forwardWebRequest, serveWebDocument } from './web-document.ts'
import { installAppDownloads } from './app-downloads.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import { NEXT_PACKAGE, parseFeatures, profileName } from './profiles.ts'
import { APP_URL, IPC, SHELL_URL } from './ipc.ts'
import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'
import { preferredDesktopLocale, resolveDesktopLocale } from './menu-locale.ts'
import { NativeLocaleStore } from './native-locale.ts'
import { NextDesktopRuntime } from './desktop-runtime.ts'
import { probeSystemProxy, type DesktopSystemProxyProbe } from './system-proxy.ts'
import { DEFAULT_PROFILE, NATIVE_ACCESS_HEADER, type DesktopCommand, type DesktopState, type DesktopSettingsPage } from './desktop-contract.ts'
import { portsChanged, parsePreferences } from './desktop-preferences.ts'
import { NativeDesktop, applyWindowMaterial } from './native-desktop.ts'
import { desktopLanAddresses } from './lan-addresses.ts'
import { createLanHttpsCertificate, lanHttpsCertificateDiagnostic } from './lan-https-certificate.ts'
import { desktopTerminalStateDirectory, openDesktopTerminal } from './desktop-terminal.ts'
import { bundledPnpmEntry, createPackageRunner } from './extensions.ts'
import { applyDesktopPackageAgePolicy } from './pnpm-policy.ts'
import { auxiliaryWindowChromeOptions, auxiliaryWindowHasCustomFrame } from '../../dsh-plugin-desktop-beta/src/auxiliary-window-options.ts'
import { cleanupDisposableTree } from '../../dsh-plugin-desktop-beta/src/disposable-tree.ts'
import { atomicJson, privateDirectory } from './private-files.ts'
import { windowMaterial } from './window-material.ts'
import { ONBOARDING_ARGUMENT, RECOVERY_ARGUMENT, SAFE_ARGUMENT, relaunchApp, relaunchArguments } from './relaunch.ts'
import { createNativePermissions, installMediaPermissions } from './electron-permissions.ts'
import { defaultDataDirectory, readDataDirectory, validateDataDirectory } from './data-directory.ts'
import { maskSecrets } from './mask-secrets.ts'
import { DesktopBrowserGuests } from './browser-guests.ts'
import { PlatformLoginWindow } from './platform-login-window.ts'
import { NextUpdates } from './updates.ts'
import { createArtifactRequest } from './update-transport.ts'
import { NextUpdateInstaller } from './update-installer.ts'
import { updateLabel } from './update-state.ts'

// Inherit the package policy across the Host and every runtime child process.
applyDesktopPackageAgePolicy(process.env)

const root = dirname(NEXT_PACKAGE)
const defaultHome = resolve(process.env.DSH_DESKTOP_NEXT_HOME ?? defaultDataDirectory())
// The location preference stays at its former Next-owned anchor so previously
// chosen custom directories survive a change to the default home.
const locationRoot = process.env.DSH_DESKTOP_NEXT_HOME ? defaultHome
  : app.isPackaged ? join(app.getPath('appData'), 'DSH NEXT', 'home') : join(root, '.desktop-next', 'home')
const locationFile = join(locationRoot, 'desktop-next-location.json')
const dataLocation = readDataDirectory(defaultHome, locationRoot)
const home = dataLocation.home
const normalElectronData = join(home, 'electron-user-data')
privateDirectory(normalElectronData)
app.setName('DSH NEXT')
// Keep one application owner across normal and safe launches, before switching
// Chromium storage to the disposable environment.
app.setPath('userData', normalElectronData)
const ownsInstance = claimDesktopSingleInstance(app, openMain)
const safeModeRequested = process.argv.includes(SAFE_ARGUMENT)
const safeElectronData = join(normalElectronData, 'safe-mode')
if (ownsInstance) {
  if (safeModeRequested) {
    cleanupDisposableTree(safeElectronData)
    privateDirectory(safeElectronData)
  } else {
    try { cleanupDisposableTree(safeElectronData) }
    catch (error) { console.error('Next Safe Mode state cleanup failed', error) }
  }
}
const electronData = ownsInstance && safeModeRequested ? safeElectronData : normalElectronData
const nativeLocale = new NativeLocaleStore(safeModeRequested ? electronData : home)
app.setPath('userData', electronData)
app.setPath('sessionData', electronData)
protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }])

let mainWindow: BrowserWindow | undefined
// Storage partitions outlive individual windows, so the guest owner is process-scoped.
let desktopShortcuts: ReturnType<typeof installDesktopShortcuts> | undefined
const browserGuests = new DesktopBrowserGuests(() => runtime.auth ? [new URL(runtime.auth.url).origin] : [])
let shellWindow: BrowserWindow | undefined
let recoveryRunner: ReturnType<typeof createPackageRunner> | undefined
let replacingWindow = false
let diagnosticsFile: string | undefined
let recoveryNotice: NonNullable<DesktopState['recovery']>['notice']
let recoveryStopping: Promise<void> | undefined
let recoveryRequest: Promise<void> | undefined
let pendingSettings: DesktopSettingsPage | undefined
let quitting = false
let onboarding = false
let onboardingSurfaceActive = false
let onboardingComputerUse = false
let relaunch: string[] | undefined
let installingUpdate = false
let systemProxy: DesktopSystemProxyProbe = {}
let windowsLanguage = 'en'
const require = createRequire(NEXT_PACKAGE)
const webRoot = dirname(require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html'))
const version = (JSON.parse(readFileSync(NEXT_PACKAGE, 'utf8')) as { version: string }).version
const t = (zh: string, en: string): string => windowsLanguage.toLowerCase().startsWith('zh') ? zh : en
const runtime = new NextDesktopRuntime({
  home, root, executable: process.execPath, addresses: () => [...desktopLanAddresses()], systemProxy: () => systemProxy,
  ...(safeModeRequested ? { stateHome: electronData } : {}),
  certificate: async addresses => {
    try {
      return await createLanHttpsCertificate(electronData, addresses, {
        available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        seal: bytes => safeStorage.encryptString(Buffer.from(bytes).toString('utf8')),
        open: bytes => Buffer.from(safeStorage.decryptString(Buffer.from(bytes)), 'utf8'),
      })
    } catch (error) {
      runtime.diagnostics.append(lanHttpsCertificateDiagnostic(error), 'warn')
      throw error
    }
  },
  onFailure: () => { if (app.isReady()) openControls('recovery') },
  onChange: () => { if (app.isReady()) native.refresh() },
  onRestart: () => run({ type: 'restart' }),
  onTerminal: () => run({ type: 'terminal' }),
  onNotification: notification => native.notify(notification),
  onPlatformLogin: (request) => {
    if (quitting || !app.isReady()) return
    if (request.action === 'close') {
      platformLogin.close()
      if (request.focus) openMain()
      return
    }
    const url = platformLoginUrl(request.url)
    // A system browser reaches the Host's loopback callback only while browser access is on;
    // otherwise the built-in window replays the callback with the native credentials.
    if (runtime.state().browserUrl !== null) {
      void shell.openExternal(url).catch(error => runtime.diagnostics.append(String(error), 'warn'))
    } else platformLogin.open(url)
  },
  onPermission: async (action, permission) => {
    if (quitting) throw new Error('Desktop is shutting down')
    const snapshot = permissions.query(permission)
    // Host calls reveal the permission dialog on every platform; only a user click there may prompt
    // the OS. Platforms without an OS request or settings shortcut still receive the dialog, which
    // reports the current status, because silence would leave the request without any visible answer.
    if (action === 'open-settings' || action === 'request' && snapshot.status !== 'granted') {
      openSettings('permissions')
    }
    return snapshot
  },
})
const platformLogin = new PlatformLoginWindow({
  BrowserWindow, session: partition => session.fromPartition(partition), host: () => runtime.auth,
  parent: () => mainWindow, title: () => t('登录 DeepSeek', 'Sign in to DeepSeek'), dark: () => nativeTheme.shouldUseDarkColors,
  warn: error => runtime.diagnostics.append(String(error), 'warn'),
})
const native = new NativeDesktop({ root, language: () => windowsLanguage, state, window: () => mainWindow,
  show: openMain, run, warn: error => runtime.diagnostics.append(String(error), 'warn') })
const permissions = createNativePermissions()
const updateInstaller = new NextUpdateInstaller({ platform: process.platform, executable: process.execPath,
  log: error => runtime.diagnostics.append(String(error), 'warn') })
const updates = new NextUpdates({ version, platform: process.platform, packaged: app.isPackaged, userData: electronData,
  request: (url, init) => net.fetch(url, { ...init, credentials: 'omit' }),
  artifactRequest: createArtifactRequest(),
  changed: () => { if (app.isReady() && !quitting) native.refresh() },
  log: error => runtime.diagnostics.append(String(error), 'warn'),
  prepare: (path, nextVersion, directory, signal) => updateInstaller.prepare(path, nextVersion, directory, signal),
  install: async () => {
    runtime.busy = true; native.refresh()
    try {
      await updateInstaller.stage()
      if (!quitting) { installingUpdate = true; app.quit() }
    } finally { runtime.busy = false; if (!quitting) native.refresh() }
  },
})

function state(): DesktopState {
  let recovery: DesktopState['recovery']
  try {
    recovery = { bundles: [], checkpoints: runtime.recovery.checkpoints(runtime.selected),
      profileDirectory: runtime.profiles.directory(runtime.selected), usingDefaultDirectory: home === defaultHome, diagnosticsFile, notice: recoveryNotice }
    try { recovery.bundles = runtime.recovery.bundles(runtime.selected) } catch (error) { recovery.error = String(error) }
  } catch (error) {
    recovery = { bundles: [], checkpoints: [], profileDirectory: join(home, 'profiles', runtime.selected),
      usingDefaultDirectory: home === defaultHome, error: String(error), diagnosticsFile, notice: recoveryNotice }
  }
  return { ...runtime.state(), recovery, onboarding, ...(onboarding ? { onboardingComputerUse } : {}), platform: process.platform, version, updates: updates.snapshot(),
    trayAvailable: native.available, notificationsAvailable: Notification.isSupported() }
}
function run(value: DesktopCommand): void { void command(value, 'native').catch(error => runtime.report(error)) }

function assertSender(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, owner: BrowserWindow | undefined, origin: string): void {
  if (!owner || owner.isDestroyed() || event.sender !== owner.webContents
    || event.senderFrame !== owner.webContents.mainFrame || !event.senderFrame.url.startsWith(origin)) throw new Error('Rejected Next IPC sender')
}
function assertDesktopSender(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): void {
  if (event.sender === mainWindow?.webContents) assertSender(event, mainWindow, APP_URL)
  else assertSender(event, shellWindow, 'dsh-app://shell/')
}
/**
 * Carry the effective palette into the Platform login page, as upstream Desktop does.
 * `system` resolves through `nativeTheme.shouldUseDarkColors`, which follows the theme
 * source preload-theme.ts publishes.
 * @param authorizeUrl - authorization URL already validated by host-process.ts.
 * @returns the URL carrying `theme=light` or `theme=dark`.
 */
function platformLoginUrl(authorizeUrl: string): string {
  const url = new URL(authorizeUrl)
  url.searchParams.set('theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  return url.href
}
function show(window: BrowserWindow): void {
  if (quitting || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show(); window.focus()
}

function createWindow(preload: string, primary = false): BrowserWindow {
  const window = new BrowserWindow({ width: 1280, height: 840, minWidth: 800, minHeight: 580,
    show: false, title: 'DSH NEXT',
    ...(process.platform !== 'darwin' ? { icon: join(root, 'build', process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png') } : {}),
    ...(!primary ? auxiliaryWindowChromeOptions() : {}),
    ...(process.platform === 'win32' && primary ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { height: WINDOWS_TITLEBAR_HEIGHT, color: nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb',
        symbolColor: nativeTheme.shouldUseDarkColors ? '#f9fafb' : '#0f1115' },
    } : {}),
    ...(process.platform === 'darwin' && primary ? {
      titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 },
      vibrancy: runtime.preferences.macosMaterial === 'transparent' ? 'sidebar' as const : undefined,
      visualEffectState: 'active' as const, backgroundColor: '#00000000',
    } : {}),
    // `webviewTag` only on the application document: every attachment is still refused unless
    // `DesktopBrowserGuests` issued the lease, and the guest itself never gets the tag.
    webPreferences: { preload: join(root, 'lib', preload), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: primary },
  })
  window.once('ready-to-show', () => show(window))
  if (primary) {
    applyWindowMaterial(window, runtime.preferences)
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === ',' && (input.control || input.meta) && !input.alt) { event.preventDefault(); openControls() }
    })
    window.on('close', event => {
      if (!quitting && runtime.preferences.closeToTray && native.available) { event.preventDefault(); window.hide() }
      else if (!quitting) { event.preventDefault(); app.quit() }
    })
  }
  const openExternal = (url: string): void => {
    try { if (['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)) void shell.openExternal(url).catch(error => runtime.report(error)) } catch { /* Ignore malformed external links. */ }
  }
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(primary ? APP_URL : SHELL_URL)) { event.preventDefault(); openExternal(url) }
  })
  window.webContents.on('will-redirect', (event, url) => { if (!url.startsWith(primary ? APP_URL : SHELL_URL)) event.preventDefault() })
  return window
}

function openSettings(page: DesktopSettingsPage = 'general'): void {
  if (quitting) return
  if (runtime.recoveryMode || runtime.state().phase === 'error') { openControls('recovery'); return }
  pendingSettings = page
  openMain()
  mainWindow?.webContents.send(IPC.settingsOpen)
}

function openControls(page: 'general' | 'profiles' | 'create-profile' | 'tools' | 'recovery' | 'permissions' = 'general'): void {
  if (quitting) return
  if (page === 'general' || page === 'tools' || page === 'permissions') { openSettings(page === 'permissions' ? 'permissions' : 'general'); return }
  if (page === 'recovery' && !runtime.safeMode && !runtime.recoveryMode) {
    runtime.recoveryMode = true
    onboarding = false
    // Destroy bypasses the normal close-to-tray/app-quit handler.
    const previousMain = mainWindow
    mainWindow = undefined
    replacingWindow = true
    try { previousMain?.destroy() } finally { replacingWindow = false }
    const stopping = runtime.backend.stop().finally(() => {
      if (recoveryStopping === stopping) recoveryStopping = undefined
    })
    recoveryStopping = stopping
    void stopping.catch(error => runtime.diagnostics.append(String(error), 'error'))
    native.refresh()
  }
  const locale = nativeLocale.resolve(runtime.selected, windowsLanguage)
  windowsLanguage = locale
  const url = `${SHELL_URL}?locale=${locale}&platform=${process.platform}&frame=${auxiliaryWindowHasCustomFrame()}#${page}`
  const resize = (window: BrowserWindow): void => {
    const creating = page === 'create-profile'
    window.setResizable(!creating)
    window.setMinimumSize(creating ? 420 : 680, creating ? 330 : 560)
    window.setSize(creating ? 480 : 850, creating ? 360 : 800)
  }
  if (shellWindow && !shellWindow.isDestroyed()) {
    resize(shellWindow)
    void shellWindow.loadURL(url).catch(error => runtime.diagnostics.append(String(error), 'error'))
    show(shellWindow); return
  }
  shellWindow = createWindow('preload-shell.cjs')
  resize(shellWindow)
  shellWindow.on('closed', () => { shellWindow = undefined })
  void shellWindow.loadURL(url).catch(error => runtime.diagnostics.append(String(error), 'error'))
}
function openMain(): void {
  if (quitting) return
  if (runtime.recoveryMode || runtime.state().phase === 'error') { openControls('recovery'); return }
  if (mainWindow && !mainWindow.isDestroyed()) { show(mainWindow); return }
  mainWindow = createWindow('preload-app.cjs', true)
  const owner = mainWindow
  // The guest owner installs its own navigation, crash and destruction release paths.
  browserGuests.bind(owner, (guest, name) => desktopShortcuts!.attachGuest(owner, guest, name))
  desktopShortcuts!.attach(owner)
  mainWindow.on('closed', () => { mainWindow = undefined; onboardingSurfaceActive = false })
  mainWindow.webContents.on('render-process-gone', (_event, details) => { if (!quitting) runtime.report(new Error(`Renderer: ${details.reason}`)) })
  mainWindow.webContents.on('preload-error', (_event, _path, error) => runtime.report(error))
  // The Host log otherwise misses client slot failures: the renderer can retire
  // an entry (and its portalled dialog) without crashing the Electron process.
  mainWindow.webContents.on('console-message', (event, _level, legacyMessage) => {
    // Electron versions differ: older runtimes pass the message as the third
    // argument, newer ones put it on the event. Never assume either exists.
    const message = typeof legacyMessage === 'string' ? legacyMessage : event?.message
    if (typeof message !== 'string') return
    if (!message.includes('[next-ui-diagnostic]') && !message.includes('slot entry crashed')
      && !message.includes('client-modules:') && !message.includes('slot factory occurrence crashed')) return
    runtime.diagnostics.append(maskSecrets(message.slice(0, 2048)), 'warn')
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, message, _url, isMain) => {
    if (isMain && code !== -3 && !quitting && mainWindow === owner && !owner.isDestroyed()) runtime.report(new Error(message))
  })
  void loadMainDocument(owner).catch(error => runtime.report(error))
}
/** Cancelled or retired window navigations are not Host failures. */
async function loadMainDocument(owner: BrowserWindow): Promise<void> {
  try { await owner.loadURL(APP_URL) } catch (error) {
    if (quitting || owner.isDestroyed() || mainWindow !== owner) return
    const failure = error as { code?: string; errno?: number }
    if (failure?.code === 'ERR_ABORTED' || failure?.errno === -3) return
    throw error
  }
}

async function reloadMain(): Promise<void> {
  onboardingSurfaceActive = false
  const existing = mainWindow
  openMain()
  // A newly created window already started its first navigation in openMain().
  if (existing && existing === mainWindow && !existing.isDestroyed()) await loadMainDocument(existing)
}

/**
 * Raise the window a modal dialog must belong to, and return it as its owner.
 *
 * Electron's `dialog.*` overloads that take no `BrowserWindow` open an unowned
 * top-level window. On Windows that window disables nothing and is ordered
 * against every other top-level window, so one click on the app sends the
 * prompt behind it leaving no taskbar hint and no visual trace. Every recovery
 * action waits on `confirmed()` before it touches a single file, so an occluded
 * prompt is indistinguishable from an action that hung forever: no file change,
 * no diagnostic line, no error, and no timeout to end it. Owning the dialog
 * makes it window-modal, which is what the recovery UI's own busy state already
 * promises the user.
 *
 * Recovery, safe mode and onboarding all run in `shellWindow` while
 * `mainWindow` is destroyed, and `shellWindow` is only open while the user is
 * looking at it, so preferring it puts the prompt on the surface that raised it.
 *
 * @returns the owning window, or `undefined` when no window is alive and an
 *   unowned dialog is the only thing left.
 */
function raiseDialogOwner(): BrowserWindow | undefined {
  for (const window of [shellWindow, mainWindow]) {
    if (window === undefined || window.isDestroyed()) continue
    show(window)
    return window
  }
  return undefined
}

async function confirmed(message: string, detail = t('将停止当前 Host，正在运行的任务会被中断。', 'This stops the current Host and interrupts running tasks.')): Promise<boolean> {
  const owner = raiseDialogOwner()
  const options = { type: 'question' as const, title: 'DSH NEXT', message, detail,
    buttons: [t('继续', 'Continue'), t('取消', 'Cancel')], defaultId: 1, cancelId: 1 }
  const result = await (owner === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(owner, options))
  return result.response === 0 && !quitting
}
async function openPath(path: string): Promise<void> { const error = await shell.openPath(path); if (error) throw new Error(error) }

async function command(value: unknown, source: 'app' | 'shell' | 'native' = 'app'): Promise<void> {
  if (!value || typeof value !== 'object' || !('type' in value)) throw new Error('Invalid Next command')
  const input = value as Record<string, unknown>
  const type = input.type
  if (typeof type !== 'string') throw new Error('Invalid Next command')
  // Match Stable's restartRequest lifetime: share an in-flight request and
  // release it after success, cancellation or failure so recovery can retry.
  if (['safe-mode', 'normal-mode', 'recover', 'restart', 'rollback', 'repair-global', 'restart-app', 'restart-recovery'].includes(type)) {
    if (recoveryRequest !== undefined) return recoveryRequest
    const request = performCommand(input, type, source).finally(() => {
      if (recoveryRequest === request) recoveryRequest = undefined
    })
    recoveryRequest = request
    return request
  }
  return performCommand(input, type, source)
}

async function performCommand(input: Record<string, unknown>, type: string, source: 'app' | 'shell' | 'native'): Promise<void> {
  if (type === 'controls') {
    if (input.page !== undefined && (typeof input.page !== 'string' || !['general', 'profiles', 'create-profile', 'tools', 'recovery', 'permissions'].includes(input.page))) throw new Error('Invalid controls page')
    openControls(input.page as Parameters<typeof openControls>[0]); return
  }
  if (type === 'close-controls') { shellWindow?.close(); return }
  if (type === 'quit') { app.quit(); return }
  if (['check-updates', 'download-update', 'install-update'].includes(type)) {
    if (quitting || runtime.busy) return
    if (type === 'check-updates') {
      void updates.check().then(async () => {
        if (source !== 'native' || quitting) return
        const snapshot = updates.snapshot()
        if (snapshot.phase === 'available' && snapshot.installable) {
          const choice = await dialog.showMessageBox({ type: 'info', title: 'DSH NEXT',
            message: updateLabel(snapshot, windowsLanguage), buttons: [t('下载更新', 'Download update'), t('稍后', 'Later')], defaultId: 0, cancelId: 1,
            detail: t('下载完成后可一键安装并重启。', 'When the download finishes, choose Install and restart.') })
          if (choice.response === 0 && !quitting) void updates.download()
        } else await dialog.showMessageBox({ type: 'info', title: 'DSH NEXT', message: updateLabel(snapshot, windowsLanguage) })
      }).catch(error => runtime.diagnostics.append(String(error), 'warn'))
    } else if (type === 'download-update') void updates.download()
    else {
      if (updates.snapshot().phase !== 'ready') return
      void updates.install()
    }
    return
  }
  if (runtime.busy || quitting) throw new Error(t('另一项操作正在进行，请稍候。', 'Another operation is in progress.'))
  runtime.busy = true; native.refresh()
  try {
    if (type === 'onboarding-complete' || type === 'onboarding-skip') {
      if (!onboarding || runtime.safeMode || runtime.recoveryMode || input.profile !== runtime.selected) throw new Error('Onboarding is unavailable for this Profile')
      await runtime.restart(() => {
        runtime.profiles.finishOnboarding(runtime.selected, type === 'onboarding-complete'
          ? { features: input.features, computerUse: input.computerUse } : undefined)
        onboarding = false
      })
      await reloadMain()
      return
    }
    if (type === 'restart-onboarding') {
      if (onboarding) { openMain(); return }
      if (runtime.safeMode || runtime.recoveryMode) throw new Error('Onboarding is unavailable in safe or recovery mode')
      if (!await confirmed(t('重新打开设置向导？', 'Reopen the setup wizard?'),
        t('应用将重启，并带入当前 Profile 的设置。正在运行的任务会中断。', 'The app will restart with your current Profile settings selected. Running tasks will be interrupted.'))) return
      relaunch = relaunchArguments(process.argv.slice(1), false, false, true)
      app.quit()
      return
    }
    if (type === 'restart-app' || type === 'restart-recovery') {
      if (!await confirmed(type === 'restart-recovery'
        ? t('重启应用并进入恢复模式？', 'Restart the application in recovery mode?')
        : t('现在重启 DSH NEXT？', 'Restart DSH NEXT now?'), type === 'restart-recovery'
        ? t('应用将先打开恢复助手，暂不加载当前 Profile 和插件。正在运行的任务会中断。', 'The recovery assistant will open before loading the current Profile and plugins. Running tasks will be interrupted.')
        : undefined)) return
      relaunch = relaunchArguments(process.argv.slice(1), type === 'restart-recovery', runtime.safeMode)
      app.quit()
      return
    }
    if (type === 'create') { runtime.profiles.create(profileName(input.name)); return }
    if (type === 'delete') {
      const name = profileName(input.name)
      if (name === runtime.selected || name === DEFAULT_PROFILE) throw new Error(t('不能移除当前或默认 Profile。', 'Cannot remove the active or default Profile.'))
      if (await confirmed(t(`移除 Profile「${name}」？`, `Remove Profile “${name}”?`), t('其文件将移入恢复备份目录。共享的会话和设置会保留。', 'Its files move to recovery backups. Shared sessions and settings are retained.'))) runtime.recovery.removeProfile(name, runtime.selected)
      return
    }
    if (type === 'reload') {
      if (runtime.recoveryMode) { openMain(); return }
      await reloadMain(); return
    }
    if (type === 'devtools') { openMain(); (runtime.recoveryMode ? shellWindow : mainWindow)!.webContents.toggleDevTools(); return }
    if (type === 'recovery-action') {
      await recoveryAction(input)
      return
    }
    if (type === 'terminal') {
      const target = runtime.terminalTarget(source === 'shell')
      openDesktopTerminal({ platform: process.platform, appExecutable: process.execPath, dshBootstrapPath: join(root, 'lib', 'desktop-cli.js'),
        pnpmBinPath: bundledPnpmEntry(NEXT_PACKAGE), electronVersion: process.versions.electron, ...target,
        productVersion: version, stateDir: desktopTerminalStateDirectory(join(target.homeDir, 'electron-user-data'), target.profileName),
        spawn, onLaunchError: error => runtime.report(error) })
      return
    }
    if (type === 'open-home') { await openPath(home); return }
    if (type === 'open-profile') { await openPath(runtime.profiles.directory(runtime.selected)); return }
    if (type === 'open-logs') { runtime.diagnostics.flush(); await openPath(dirname(runtime.diagnostics.file)); return }
    if (type === 'open-backups') { privateDirectory(runtime.recovery.directory); await openPath(runtime.recovery.directory); return }
    if (type === 'open-browser' || type === 'open-lan') { await shell.openExternal(runtime.browserLink(type === 'open-lan')); return }
    if (type === 'copy-browser' || type === 'copy-lan') { clipboard.writeText(runtime.browserLink(type === 'copy-lan')); return }
    if (type === 'open-browser-url' || type === 'copy-browser-url') {
      const url = runtime.resolveBrowserLink(input.url)
      if (type === 'copy-browser-url') clipboard.writeText(url)
      else await shell.openExternal(url)
      return
    }
    if (type === 'export-ca' || type === 'diagnostics') {
      const certificate = runtime.lan?.caCertificate
      if (type === 'export-ca' && !certificate) throw new Error('LAN certificate is unavailable')
      const owner = raiseDialogOwner()
      const options = { title: type === 'export-ca' ? t('导出局域网 CA 证书', 'Export LAN CA certificate') : t('导出诊断（分享前请检查内容）', 'Export diagnostics (review before sharing)'),
        defaultPath: type === 'export-ca' ? 'dsh-desktop-next-ca.crt' : `dsh-desktop-next-diagnostics-${Date.now()}.json`,
        filters: [{ name: type === 'export-ca' ? 'CA certificate' : 'Diagnostics', extensions: [type === 'export-ca' ? 'crt' : 'json'] }] }
      const result = await (owner === undefined ? dialog.showSaveDialog(options) : dialog.showSaveDialog(owner, options))
      if (!result.canceled && result.filePath && !quitting) {
        await writeFile(result.filePath, type === 'export-ca' ? certificate! : runtime.diagnostics.export(state()), { mode: 0o600 })
        if (type === 'diagnostics') diagnosticsFile = result.filePath
      }
      return
    }
    if (type === 'preferences') {
      if (runtime.safeMode) throw new Error(t('安全模式使用固定的桌面设置。', 'Safe Mode uses fixed desktop settings.'))
      const preferences = parsePreferences(input.preferences)
      if (portsChanged(runtime.preferences, preferences)) {
        if (!await confirmed(t('应用访问设置并重启 Host？', 'Apply access settings and restart the Host?'), preferences.browserAccess && preferences.networkExposure === 'lan'
          ? t('开启后，同一网络中的设备可通过 HTTPS 访问。登录链接可授予访问权限，请仅与可信设备共享。正在运行的任务会被中断。', 'Devices on your network can connect over HTTPS. Login links grant access; share only with trusted devices. Running tasks will be interrupted.')
          : undefined)) return
        await runtime.restart(() => runtime.writePreferences(preferences))
        if (mainWindow) await loadMainDocument(mainWindow)
      } else {
        if (preferences.browserAccess && preferences.networkExposure === 'lan'
          && (!runtime.preferences.browserAccess || runtime.preferences.networkExposure !== 'lan')
          && !await confirmed(t('允许局域网 HTTPS 访问？', 'Allow LAN access over HTTPS?'),
            t('同一网络中的设备可以连接。请仅向可信设备分享登录链接，并在设备上核对和信任 CA 证书。', 'Devices on your local network can connect. Share login links only with trusted devices, and verify and trust the CA certificate on each device.'))) return
        await runtime.applyPreferences(preferences)
      }
      if (mainWindow) applyWindowMaterial(mainWindow, preferences)
      return
    }
    if (!['switch', 'features', 'restart', 'recover', 'safe-mode', 'normal-mode', 'rollback', 'repair-global'].includes(String(type))) throw new Error('Invalid Next command')
    const next = type === 'switch' ? profileName(input.name) : runtime.selected
    if (type === 'switch' && next === runtime.selected && !runtime.safeMode && !runtime.recoveryMode && runtime.backend.state.phase === 'ready') return
    if (type === 'switch' && !runtime.profiles.selectable(next)) throw new Error('Profile is unavailable for Desktop Next')
    const features = type === 'features' ? parseFeatures(input.features) : undefined
    if (type === 'rollback' && !runtime.recovery.latest(next)) throw new Error(t('尚无成功启动的配置备份。', 'No successful-start configuration is available.'))
    const messages: Record<string, string> = {
      switch: t(`切换到 Profile「${next}」并重启应用？`, `Switch to Profile “${next}” and restart the application?`),
      recover: t('备份并修复当前 Profile？将禁用第三方插件、远控和市场。', 'Back up and repair this Profile? Third-party plugins, remote control and Market will be disabled.'),
      'repair-global': t('备份并停用全局补丁？这会影响所有 Next Profile。', 'Back up and disable the global patch? This affects every Next Profile.'),
      rollback: t('恢复最近成功启动的 Profile 配置？当前配置会先备份。', 'Restore the last successful-start Profile configuration? The current configuration will be backed up first.'),
      'safe-mode': t('在独立的临时环境中进入安全模式？原有数据和配置会保留。', 'Enter safe mode in a separate temporary environment? Existing data and configuration are preserved.'),
      'normal-mode': t('退出安全模式并重启原 Profile？', 'Exit Safe Mode and restart the original Profile?'),
    }
    if (!await confirmed(messages[String(type)] ?? t('重启工作环境以应用更改？', 'Restart the environment to apply this change?'))) return
    if (type === 'switch') {
      runtime.profiles.select(next)
      relaunch = relaunchArguments(process.argv.slice(1), false, false)
      app.quit()
      return
    }
    if (type === 'safe-mode' || type === 'normal-mode') {
      // Like Beta, mode changes cross an application relaunch boundary. The
      // existing quit owner hides windows and confirms Host exit before relaunch.
      if (type === 'safe-mode' && runtime.safeMode) return
      await recoveryStopping
      await runtime.backend.stop()
      relaunch = relaunchArguments(process.argv.slice(1), false, type === 'safe-mode')
      app.quit()
      return
    }
    // Recovery actions can always bypass first-run setup to repair or inspect a Profile.
    onboarding = false
    await recoveryStopping
    const change = async (): Promise<void> => {
      if (type === 'recover') await runtime.profiles.recover(next)
      if (type === 'rollback') await restoreCheckpoint()
      if (type === 'repair-global') runtime.recovery.repairGlobalPatch()
      if (features) runtime.profiles.setFeatures(next, features)
    }
    if (runtime.safeMode) {
      await runtime.backend.stop()
      await change()
      relaunch = relaunchArguments(process.argv.slice(1), false, type === 'restart')
      app.quit()
      return
    }
    await runtime.restart(change)
    await reloadMain()
    if (!runtime.safeMode && mainWindow) shellWindow?.close()
  } catch (error) {
    if (type === 'recovery-action' || onboarding && (type === 'onboarding-complete' || type === 'onboarding-skip')) runtime.diagnostics.append(String(error), 'error')
    else runtime.report(error)
    throw error
  } finally { runtime.busy = false; native.refresh() }
}

async function restoreCheckpoint(id?: string): Promise<void> {
  await runtime.recovery.restore(runtime.selected, id)
  // A checkpoint holds configuration only, so the restored manifest deliberately disagrees with the
  // lockfile until this install reconciles them. pnpm refuses that reconciliation whenever it treats
  // the environment as CI, which would make recovery fail exactly where it is needed.
  try { await runRecoveryPlugin(['install', '--no-frozen-lockfile']) } catch (error) {
    throw new Error(t('配置已恢复，但插件依赖安装失败。请检查以下错误并重试恢复：', 'Configuration was restored, but plugin dependencies could not be installed. Check the error and retry recovery:') + '\n' + String(error))
  }
  recoveryNotice = { tone: 'success', title: t('检查点已恢复', 'Checkpoint restored'),
    body: runtime.safeMode
      ? t('配置和所需插件依赖已恢复。请点击“退出安全模式并重启”使恢复生效。', 'Configuration and required plugin dependencies have been restored. Choose “Exit Safe Mode and Restart” to apply them.')
      : t('配置和所需插件依赖已恢复。请点击“退出并重启”使恢复生效。', 'Configuration and required plugin dependencies have been restored. Choose “Quit and restart” to apply them.') }
  runtime.diagnostics.append(`Recovered checkpoint ${id} for ${runtime.selected}`)
}

/** Reconcile dependencies through the same official CLI for recovery install and removal. */
async function runRecoveryPlugin(args: readonly string[]): Promise<void> {
  const directory = runtime.profiles.directory(runtime.selected)
  const runner = recoveryRunner = createPackageRunner({ command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }, directory)
  let output = ''
  try {
    const operation = runner.runPlugin(args, directory, AbortSignal.timeout(120_000))
    const append = (chunk: unknown): void => {
      output = (output + String(chunk)).slice(-16_384)
      runtime.diagnostics.hostChunk(String(chunk))
    }
    operation.stdout.on('data', append)
    operation.stderr.on('data', append)
    const result = await operation.done
    if (result.exitCode !== 0) throw new Error(maskSecrets(`Plugin ${args[0]} failed (exit ${result.exitCode}): ${output}`))
  } finally { await runner.dispose(); if (recoveryRunner === runner) recoveryRunner = undefined }
}

async function recoveryAction(input: Record<string, unknown>): Promise<void> {
  if (!runtime.recoveryMode && !runtime.safeMode) throw new Error('Open recovery before changing its configuration')
  const action = input.action
  recoveryNotice = undefined
  if (action === 'restart') {
    if (!await confirmed(runtime.safeMode ? t('退出安全模式并重启？', 'Exit Safe Mode and restart?') : t('现在重启 DSH NEXT？', 'Restart DSH NEXT now?'),
      runtime.safeMode
        ? t('应用将返回原 Profile，并移除临时环境。临时数据不会保留，正在运行的任务会中断。', 'The app will return to the original Profile and remove the temporary environment. Temporary data will not be kept, and running tasks will be interrupted.')
        : t('应用将退出恢复助手，重新启动原 Profile。', 'The app will leave the recovery assistant and restart the original Profile.'))) return
    relaunch = relaunchArguments(process.argv.slice(1), false, false)
    app.quit()
    return
  }
  const directory = runtime.profiles.directory(runtime.selected)
  const files: Record<string, string> = {
    'open-settings-document': join(home, 'settings.yaml'),
    'open-profile-patch': join(directory, 'cordis.patch.yml'),
    'open-profile-manifest': join(directory, 'package.json'),
  }
  if (typeof action !== 'string') throw new Error('Invalid recovery action')
  if (Object.hasOwn(files, action)) { await openPath(files[action]!); return }
  if (action === 'show-diagnostics') {
    if (!diagnosticsFile) throw new Error('No exported diagnostics')
    shell.showItemInFolder(diagnosticsFile); return
  }
  if (action === 'open-checkpoint' || action === 'preview-checkpoint') {
    const checkpoint = runtime.recovery.checkpoints(runtime.selected).find(item => item.id === input.id)
    if (!checkpoint) throw new Error('Recovery checkpoint is no longer available')
    if (action === 'open-checkpoint') { await openPath(checkpoint.directory); return }
    if (!await confirmed(t('还原所选配置备份？', 'Restore the selected configuration backup?'),
      t(`备份时间：${checkpoint.created}。当前配置会先备份，然后恢复配置并安装所需插件依赖。共享数据不会回滚。`, `Saved: ${checkpoint.created}. Current configuration will be backed up, then the saved configuration and required plugin dependencies will be restored. Shared data is not rolled back.`))) return
    await recoveryStopping
    if (!runtime.safeMode) await runtime.backend.stop()
    await restoreCheckpoint(checkpoint.id)
    return
  }
  if (action === 'preview-disable' || action === 'preview-enable') {
    const enable = action === 'preview-enable'
    const bundle = runtime.recovery.bundles(runtime.selected).find(item => item.bundleId === input.id)
    if (!bundle || bundle.toggle !== (enable ? 'enable' : 'disable')
      || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(bundle.packageName)) throw new Error('This plugin cannot be changed')
    if (!await confirmed(
      enable ? t(`启用插件「${bundle.packageName}」？`, `Enable “${bundle.packageName}”?`)
        : t(`禁用插件「${bundle.packageName}」？`, `Disable “${bundle.packageName}”?`),
      enable ? t('下次启动时会重新加载此插件。', 'The plugin will load again on the next start.')
        : t('不会删除任何内容：插件、版本声明和配置都会保留，只是下次启动时不再加载。随时可以重新启用。',
          'Nothing is deleted: the plugin, its version declaration and its configuration all stay. It simply will not load on the next start, and you can enable it again at any time.'))) return
    await recoveryStopping
    if (!runtime.safeMode) await runtime.backend.stop()
    await runtime.recovery.setBundleSelected(runtime.selected, bundle.packageName, enable)
    recoveryNotice = { tone: 'success', title: bundle.packageName, body: enable
      ? t('插件已重新启用。请点击“退出并重启”使其生效。', 'The plugin is enabled again. Choose “Quit and restart” to apply it.')
      : t('插件已禁用，安装内容仍然保留。请点击“退出并重启”使其生效。', 'The plugin is disabled and still installed. Choose “Quit and restart” to apply it.') }
    runtime.diagnostics.append(`${enable ? 'Enabled' : 'Disabled'} bundle for ${runtime.selected}`)
    return
  }
  if (action === 'preview-uninstall') {
    const bundle = runtime.recovery.bundles(runtime.selected).find(item => item.bundleId === input.id)
    if (!bundle || bundle.action !== 'uninstall' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(bundle.packageName)) throw new Error('This bundle cannot be uninstalled')
    if (!await confirmed(t(`卸载插件「${bundle.packageName}」？`, `Uninstall “${bundle.packageName}”?`),
      t('先备份当前 Profile 配置，然后卸载所选插件。', 'Back up the Profile configuration, then uninstall the selected plugin.'))) return
    await recoveryStopping
    if (!runtime.safeMode) await runtime.backend.stop()
    runtime.recovery.backup(runtime.selected, 'before-plugin-uninstall')
    await runRecoveryPlugin(['remove', bundle.packageName])
    return
  }
  if (action === 'begin-change-data-directory' || action === 'restore-default-data-directory') {
    const owner = action === 'begin-change-data-directory' ? raiseDialogOwner() : undefined
    const choice = action !== 'begin-change-data-directory' ? undefined
      : await (owner === undefined
        ? dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
        : dialog.showOpenDialog(owner, { properties: ['openDirectory', 'createDirectory'] }))
    if (choice?.canceled) return
    const target = action === 'restore-default-data-directory' ? defaultHome : choice?.filePaths[0]
    if (!target || !isAbsolute(target)) return
    const destination = validateDataDirectory(target, home, defaultHome)
    if (destination === home) return
    if (!await confirmed(t('切换数据目录并重启？', 'Change data directory and restart?'),
      t(`新目录：${destination}。原目录的数据会保留，不会自动迁移。`, `New directory: ${destination}. Existing data remains in its original directory and is not moved.`))) return
    atomicJson(locationFile, { home: destination })
    relaunch = relaunchArguments(process.argv.slice(1), false, false)
    app.quit(); return
  }
  if (action === 'factory-reset') {
    if (!await confirmed(t('重置当前数据目录并重启？', 'Reset the current data directory and restart?'),
      t('Profile、会话、设置和凭据将移入 recovery 备份目录，应用将重新初始化。', 'Profiles, sessions, settings and credentials will move to a recovery backup. The app will initialize again.'))) return
    await recoveryStopping
    await runtime.backend.stop()
    runtime.diagnostics.flush()
    runtime.recovery.factoryReset()
    relaunch = relaunchArguments(process.argv.slice(1), false, false)
    app.quit(); return
  }
  throw new Error('Unknown recovery action')
}

async function main(): Promise<void> {
  await app.whenReady()
  if (quitting) return
  let inputRevision = 0
  let inputBlocked = false
  desktopShortcuts = installDesktopShortcuts(() => mainWindow, app.getPath('userData'),
    process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux', () => {}, () => {
      const blocked = runtime.recoveryMode || onboardingSurfaceActive
      if (blocked !== inputBlocked) { inputBlocked = blocked; inputRevision++ }
      return { revision: inputRevision, blocked }
    })
  app.once('will-quit', () => { desktopShortcuts?.dispose() })
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(join(root, 'build', 'app-icon-mac.png'))
  // Recovery can open without a Host; Chromium's app locale may differ from the OS language.
  windowsLanguage = preferredDesktopLocale([...app.getPreferredSystemLanguages(), app.getLocale()])
  // Read once, before anything can start a Host: a proxy client's "system proxy" switch sets no
  // environment variable, and only Chromium can evaluate it (PAC/WPAD included). Changing the
  // proxy takes effect on the next application start.
  systemProxy = await probeSystemProxy(session.defaultSession)
  protocol.handle('dsh-app', async request => {
    const url = new URL(request.url)
    if (url.hostname === 'shell') {
      const response = await serveWebDocument(request, join(root, 'lib/native-ui'), false)
      response.headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'none'")
      return response
    }
    if (url.hostname !== 'app') return new Response(null, { status: 404 })
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/')
      || ['/favicon.svg', '/manifest.webmanifest'].includes(url.pathname)) return serveWebDocument(request, webRoot)
    const auth = runtime.auth
    if (!runtime.backend.host || !auth) return new Response(null, { status: 503 })
    return forwardWebRequest(request, auth.url, auth.cookie, auth.token)
  })
  ipcMain.handle(IPC.boot, async event => {
    assertSender(event, mainWindow, APP_URL)
    await runtime.startup
    if (!runtime.backend.host || !runtime.auth) throw new Error('Next Host is unavailable')
    return { injections: await runtime.injections(), streamBaseUrl: new URL(runtime.auth.url).origin }
  })
  ipcMain.handle(IPC.failed, (event, message: unknown) => {
    assertSender(event, mainWindow, APP_URL)
    if (typeof message !== 'string') throw new Error('Invalid boot error')
    runtime.report(new Error(message.slice(0, 4096)))
  })
  ipcMain.handle(IPC.state, event => { assertDesktopSender(event); return state() })
  ipcMain.handle('dsh-desktop:setup-onboarding', async (event, request: unknown) => {
    assertSender(event, mainWindow, APP_URL)
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid setup request')
    const value = request as { action?: unknown; profile?: unknown; selection?: unknown; active?: unknown }
    if (value.action === 'active') {
      if (typeof value.active !== 'boolean') throw new Error('Invalid onboarding state')
      onboardingSurfaceActive = value.active
      return
    }
    if (value.action === 'read') {
      if (runtime.safeMode || runtime.recoveryMode) return null
      const features = runtime.profiles.features(runtime.selected)
      return { required: onboarding, edition: 'next', profile: runtime.selected,
        accountPending: !onboarding && runtime.profiles.accountSetupPending(runtime.selected),
        computerUse: runtime.profiles.computerUseEnabled(runtime.selected),
        input: { appVersion: version, profileName: runtime.selected, platform: process.platform,
          mode: 'compatibility', macosMaterial: 'off', windowsMaterial: 'off', openBrowser: false, networkExposure: 'loopback',
          market: features.market ? 'community-market' : features.dshMarket ? 'dsh-market' : 'disabled', aaEnabled: features.remoteControl,
          notifications: { enabled: true, notifyOnTurnCompletion: true, notifyOnTurnFailure: true, notifyOnJobCompletion: false, notifyOnJobFailure: false, notifyOnScheduleCompletion: true, notifyOnScheduleFailure: true } } }
    }
    if (value.action === 'dismiss-account') {
      if (onboarding || value.profile !== runtime.selected || runtime.safeMode || runtime.recoveryMode) throw new Error('Account setup is unavailable')
      runtime.profiles.dismissAccountSetup(runtime.selected)
      return
    }
    if (value.action !== 'finish' || !onboarding || value.profile !== runtime.selected || runtime.safeMode || runtime.recoveryMode) throw new Error('Setup is unavailable')
    if (value.selection === undefined) return command({ type: 'onboarding-skip', profile: value.profile })
    const choice = value.selection as Record<string, unknown>
    if (!choice || typeof choice !== 'object' || !['disabled', 'community-market', 'dsh-market'].includes(String(choice.market))
      || typeof choice.aaEnabled !== 'boolean' || typeof choice.computerUse !== 'boolean') throw new Error('Invalid setup choices')
    return command({ type: 'onboarding-complete', profile: value.profile, computerUse: choice.computerUse,
      features: { market: choice.market === 'community-market', dshMarket: choice.market === 'dsh-market', remoteControl: choice.aaEnabled } })
  })
  ipcMain.handle(IPC.settingsTake, event => {
    assertSender(event, mainWindow, APP_URL)
    const page = pendingSettings
    pendingSettings = undefined
    return page
  })
  ipcMain.handle(IPC.browserLinks, event => { assertDesktopSender(event); return runtime.browserLinks() })
  ipcMain.handle(IPC.browserAcquire, (event, workspace: unknown) => {
    assertSender(event, mainWindow, APP_URL)
    if (quitting) throw new Error('Desktop browser is unavailable')
    return browserGuests.acquire(event.sender, workspace)
  })
  ipcMain.handle(IPC.browserRelease, (event, lease: unknown) => {
    assertSender(event, mainWindow, APP_URL)
    return browserGuests.release(event.sender, lease)
  })
  ipcMain.handle(IPC.permissionQuery, (event, permission: unknown) => { assertDesktopSender(event); return permissions.query(permission) })
  const permissionGesture = async (event: IpcMainInvokeEvent): Promise<void> => {
    assertDesktopSender(event)
    if (!event.sender.isFocused() || !await event.sender.executeJavaScript('navigator.userActivation.isActive')) {
      throw new Error('Desktop permission requests require a focused window and user gesture')
    }
    assertDesktopSender(event)
  }
  ipcMain.handle(IPC.permissionRequest, async (event, permission: unknown) => {
    await permissionGesture(event); return permissions.request(permission)
  })
  ipcMain.handle(IPC.permissionSettings, async (event, permission: unknown) => {
    await permissionGesture(event); await permissions.openSettings(permission)
  })
  installMediaPermissions(session.defaultSession, {
    window: () => mainWindow, language: () => windowsLanguage, warn: error => runtime.diagnostics.append(String(error), 'warn'),
  })
  installAppDownloads(session.defaultSession, {
    window: () => mainWindow, language: () => windowsLanguage, downloads: () => app.getPath('downloads'),
    warn: error => runtime.diagnostics.append(String(error), 'warn'),
    // The same gate as renderer fetches; the marker is supplied here because the download bypassed webRequest.
    forward: async url => {
      const auth = runtime.auth
      if (!runtime.backend.host || !auth) return new Response(null, { status: 503 })
      return forwardWebRequest(new Request(url, { headers: { [NATIVE_ACCESS_HEADER]: auth.token } }), auth.url, auth.cookie, auth.token)
    },
  })
  ipcMain.handle(IPC.material, event => { assertSender(event, mainWindow, APP_URL); return windowMaterial(runtime.preferences) })
  ipcMain.handle(IPC.command, (event, value: unknown) => { assertDesktopSender(event); return command(value, event.sender === shellWindow?.webContents ? 'shell' : 'app') })
  let picking: Promise<string | null> | undefined
  ipcMain.handle(IPC.directory, event => {
    assertSender(event, mainWindow, APP_URL)
    const window = mainWindow!
    show(window)
    picking ??= dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
      .then(result => result.canceled ? null : result.filePaths[0] ?? null).finally(() => { picking = undefined })
    return picking
  })
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const auth = runtime.auth
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined
    const requestHeaders = appRequestHeaders(details, owner, auth?.token)
    const target = new URL(details.url)
    if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1'
      || !auth || details.webContentsId !== owner?.id) return callback({ requestHeaders })
    const host = new URL(auth.url)
    if (target.host !== host.host) return callback({ requestHeaders })
    const headers = Object.fromEntries(Object.entries(requestHeaders).map(([key, value]) => [key.toLowerCase(), value]))
    if (headers.origin !== 'dsh-app://app') return callback({ cancel: true })
    callback({ requestHeaders: { ...headers, origin: host.origin, cookie: auth.cookie, [NATIVE_ACCESS_HEADER]: auth.token, 'sec-fetch-site': 'same-origin' } })
  })
  ipcMain.on(IPC.nativeThemeSet, (event, source: unknown) => {
    try { assertSender(event, mainWindow, APP_URL) } catch { return }
    if (source === 'light' || source === 'dark' || source === 'system') nativeTheme.themeSource = source
  })
  ipcMain.on(IPC.locale, (event, language: unknown) => {
    try { assertSender(event, mainWindow, APP_URL) } catch { return }
    if (typeof language !== 'string' || !/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/u.test(language)) return
    if (!runtime.safeMode) {
      try { nativeLocale.remember(runtime.selected, language) } catch (error) { runtime.diagnostics.append(String(error), 'warn') }
    }
    if (language === windowsLanguage) return
    windowsLanguage = language
    native.refresh()
  })
  ipcMain.handle(IPC.localeRead, event => {
    assertSender(event, mainWindow, APP_URL)
    return { languages: [...app.getPreferredSystemLanguages(), app.getLocale()], preference: null }
  })
  nativeTheme.on('updated', () => { if (mainWindow && !mainWindow.isDestroyed()) applyWindowMaterial(mainWindow, runtime.preferences) })
  runtime.safeMode = safeModeRequested
  runtime.recoveryMode = process.argv.includes(RECOVERY_ARGUMENT)
  runtime.initialize()
  if (dataLocation.error && !runtime.safeMode) { runtime.recoveryMode = true; runtime.report(dataLocation.error) }
  if (!runtime.safeMode && !runtime.recoveryMode) {
    try {
      runtime.profiles.ensure(runtime.selected)
      onboarding = process.argv.includes(ONBOARDING_ARGUMENT) || runtime.profiles.onboardingRequired(runtime.selected)
      if (onboarding) onboardingComputerUse = runtime.profiles.computerUseEnabled(runtime.selected)
    } catch (error) {
      onboarding = false
      runtime.recoveryMode = true
      runtime.report(error)
    }
  }
  native.createTray()
  updates.start()
  Menu.setApplicationMenu(process.platform === 'win32' ? null : Menu.buildFromTemplate([
    { label: 'DSH NEXT', submenu: native.items() }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
  if (process.platform === 'win32') {
    ipcMain.handle(IPC.windowsMenu, (event, name: unknown, x: unknown, y: unknown) => {
      assertSender(event, mainWindow, APP_URL)
      if ((name !== 'application' && name !== 'edit') || typeof x !== 'number' || typeof y !== 'number'
        || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100_000 || y > 100_000) throw new Error('Invalid native menu request')
      const window = mainWindow!
      const messages = resolveDesktopLocale(windowsLanguage).messages
      const editItem = (label: string, keyCode: string, modifiers: Array<'control'>, accelerator?: string): MenuItemConstructorOptions => ({
        label, accelerator, click: () => {
          window.webContents.focus()
          desktopShortcuts!.sendEditingKey(keyCode, modifiers)
        },
      })
      const items: MenuItemConstructorOptions[] = name === 'application' ? native.items() : [
        editItem(messages.undo, 'Z', ['control'], 'Ctrl+Z'), editItem(messages.redo, 'Y', ['control'], 'Ctrl+Y'),
        { type: 'separator' }, editItem(messages.cut, 'X', ['control'], 'Ctrl+X'), editItem(messages.copy, 'C', ['control'], 'Ctrl+C'),
        editItem(messages.paste, 'V', ['control'], 'Ctrl+V'), editItem(messages.delete, 'Delete', []),
        { type: 'separator' }, editItem(messages.selectAll, 'A', ['control'], 'Ctrl+A'),
      ]
      const zoom = window.webContents.getZoomFactor()
      return new Promise<void>(resolvePopup => { Menu.buildFromTemplate(items).popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom), callback: resolvePopup }) })
    })
    ipcMain.on(IPC.windowsAppearance, (event, language: unknown, color: unknown, symbolColor: unknown) => {
      try { assertSender(event, mainWindow, APP_URL) } catch { return }
      // Caption paint can run before the official locale service initializes;
      // IPC.locale is the only renderer authority for the application language.
      const validColor = (value: unknown): value is string => typeof value === 'string' && /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu.test(value)
      if (validColor(color) && validColor(symbolColor)) mainWindow!.setTitleBarOverlay({ color, symbolColor })
    })
  }
  if (runtime.recoveryMode) openControls('recovery')
  else { void runtime.start().catch(() => {}); openMain() }
  app.on('activate', openMain)
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !native.available && !replacingWindow) app.quit() })
}

app.on('before-quit', event => {
  if (quitting || !ownsInstance) return
  event.preventDefault()
  quitting = true
  // Keep disconnection/reconnection chrome out of the quit/relaunch transition.
  for (const window of [mainWindow, shellWindow]) {
    if (window && !window.isDestroyed()) window.hide()
  }
  native.close()
  platformLogin.close()
  void Promise.all([updates.dispose(installingUpdate), (async () => { await recoveryRunner?.dispose(); await runtime.close() })()]).then(async () => {
    // A staged installer must survive until handoff; the next boot removes it.
    if (safeModeRequested && !installingUpdate) {
      // Windows may still hold Chromium files until process exit; a normal boot
      // retries the same bounded, junction-safe cleanup when those locks are gone.
      try { cleanupDisposableTree(safeElectronData) }
      catch (error) { runtime.diagnostics.append(`Safe Mode desktop state cleanup failed: ${String(error)}`, 'warn'); runtime.diagnostics.flush() }
    }
    if (installingUpdate) {
      try { await updateInstaller.launch() }
      catch (error) {
        runtime.diagnostics.append(String(error), 'error')
        dialog.showErrorBox(t('更新未能安装', 'Update could not be installed'), t('应用将重新打开，请在设置中重试更新。', 'The application will reopen. Retry the update in Settings.'))
        relaunchApp(app, relaunchArguments(process.argv.slice(1), false, false))
        app.quit()
      }
      if (process.platform === 'darwin') return
    }
    if (relaunch) relaunchApp(app, relaunch)
    app.quit()
  }, error => { console.error(error); app.exit(1) })
})
if (ownsInstance) void main().catch(error => runtime.report(error))
