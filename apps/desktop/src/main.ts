/** Electron application shell for the loopback DeepSeek Harness Web Host. */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
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
import { createDesktopLifecycle, type DesktopLifecycle } from './window-lifecycle.ts'
import { loadSettings, pinRuntime, resolvePinnedRuntime, saveSettings } from './runtime-manager/settings.ts'
import { listInstalledRuntimes, resolveRuntime, type RuntimePaths } from './runtime-manager/versions.ts'
import { loadValidatedRuntimes, type ValidatedRuntimes } from './runtime-manager/validated.ts'
import { readFileSync } from 'node:fs'

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
let currentRuntimeVersion: string | undefined

/** Resolve artifacts from the checkout in development and resourcesPath when packaged. */
function hostPaths(): { nodeExecutable: string; cliEntry: string; cwd: string; electronRunAsNode: boolean } {
  if (!app.isPackaged) {
    return {
      nodeExecutable: process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? 'node',
      cliEntry: join(REPOSITORY_ROOT, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
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

/** The bundled runtime version = the pin in the shipped runtime manifest. */
function bundledRuntimeVersion(): string {
  const manifestPath = app.isPackaged
    ? join(process.resourcesPath, 'host/package.json')
    : join(REPOSITORY_ROOT, 'apps/desktop/runtime/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  const version = manifest.dependencies?.['@deepseek-ai/dsh']
  if (typeof version !== 'string' || version === '') throw new Error('bundled runtime manifest has no @deepseek-ai/dsh pin')
  return version
}

/** The validated-runtimes matrix shipped with this shell release. */
function validatedRuntimes(): ValidatedRuntimes {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'desktop-resources/validated-runtimes.json')
    : join(DESKTOP_DIR, 'runtime/validated-runtimes.json')
  return loadValidatedRuntimes(path)
}

function assertHostArtifacts(paths: ReturnType<typeof hostPaths>): void {
  if (paths.nodeExecutable.includes('/') && !existsSync(paths.nodeExecutable)) {
    throw new Error(`desktop Node runtime is missing: ${paths.nodeExecutable}`)
  }
  if (!existsSync(paths.cliEntry)) {
    throw new Error(`desktop Host entry is missing: ${paths.cliEntry}; run pnpm run build first`)
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
  tray.setToolTip(APP_NAME)
  const template: MenuItemConstructorOptions[] = [
    { label: '打开主窗口', click: () => { void lifecycle?.showWindow() } },
    ...runtimeMenu(),
    { type: 'separator' },
    { label: '退出', click: () => { void requestAppQuit() } },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
  tray.on('click', () => { void lifecycle?.showWindow() })
}

/** Runtime switcher: pin a version (bundled or managed) and relaunch with it. */
function switchRuntime(version: string | undefined): void {
  const userDataDir = app.getPath('userData')
  saveSettings(userDataDir, pinRuntime(loadSettings(userDataDir), version))
  app.relaunch()
  releaseAppQuit()
}

function runtimeMenu(): MenuItemConstructorOptions[] {
  const userDataDir = app.getPath('userData')
  
  let matrix: ValidatedRuntimes
  try {
    matrix = validatedRuntimes()
  } catch {
    matrix = { validated: [], recommended: '' }
  }
  const bundled = bundledRuntimeVersion()
  const installed = listInstalledRuntimes(userDataDir, { version: bundled, paths: hostPaths() })
  const current = currentRuntimeVersion ?? bundled

  const items: MenuItemConstructorOptions[] = [
    { label: '运行时', enabled: false },
  ]
  for (const runtime of installed) {
    const marks = [
      runtime.version === current ? '✓' : '',
      runtime.bundled ? '(内置)' : '',
      matrix.validated.includes(runtime.version) ? '' : '(未验证)',
    ].filter(Boolean).join(' ')
    items.push({
      label: `${runtime.version} ${marks}`.trim(),
      enabled: runtime.version !== current,
      click: () => { switchRuntime(runtime.version === bundled ? undefined : runtime.version) },
    })
  }
  if (matrix.recommended !== '' && !installed.some(runtime => runtime.version === matrix.recommended)) {
    items.push({ label: `安装推荐版本 ${matrix.recommended}`, enabled: false })
  }
  if (current !== bundled && !installed.some(runtime => runtime.version === current)) {
    items.push({ label: `当前 ${current} 缺失,已回退内置`, enabled: false })
  }
  return items
}

function releaseAppQuit(): void {
  quitReleased = true
  tray?.destroy()
  tray = undefined
  app.quit()
}

/** Join explicit quit requests even while the Host or window is still starting. */
function requestAppQuit(): Promise<void> {
  if (lifecycle !== undefined) return lifecycle.requestQuit()
  bootQuitPromise ??= (host?.shutdown() ?? Promise.resolve()).catch((error: unknown) => {
    console.error('desktop shutdown failed:', error)
  }).then(() => {
    releaseAppQuit()
  })
  return bootQuitPromise
}

async function boot(): Promise<void> {
  if (bootQuitPromise !== undefined) return
  const userDataDir = app.getPath('userData')
  const homeDir = app.getPath('home')
  const settings = loadSettings(userDataDir)
  const bundled = { version: bundledRuntimeVersion(), paths: hostPaths() }
  const pinned = resolvePinnedRuntime(settings, homeDir)
  const runtime = resolveRuntime(userDataDir, pinned, bundled, homeDir)
  currentRuntimeVersion = runtime.version
  if (pinned !== undefined && runtime.version !== pinned) {
    console.warn(`desktop runtime pin ${pinned} is not installed — falling back to bundled ${runtime.version}`)
  }
  const paths: RuntimePaths = runtime.paths
  assertHostArtifacts(paths)
  host = createHostSupervisor({
    spawnHost: () => spawnDshWeb({
      ...paths,
      env: {
        ...process.env,
        DSH_DESKTOP: '1',
      },
    }),
    log: chunk => process.stderr.write(chunk),
    onUnexpectedExit: ({ code, signal }) => {
      console.error(`desktop Host exited unexpectedly (code ${String(code)}, signal ${String(signal)})`)
      void requestAppQuit()
    },
  })
  hostOrigin = await host.start()
  hardenSession()
  lifecycle = createDesktopLifecycle({
    getWindow: () => mainWindow,
    createWindow: createMainWindow,
    disposeHost: async () => { await host?.shutdown() },
    quit: releaseAppQuit,
    reportError: (error) => { console.error('desktop shutdown failed:', error) },
  })
  createTray()
  await lifecycle.showWindow()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { void lifecycle?.showWindow() })
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
    console.error('desktop startup failed:', error)
    if (bootQuitPromise === undefined) {
      await dialog.showMessageBox({
        type: 'error',
        title: `${APP_NAME} failed to start`,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    await requestAppQuit()
  })
}
