import { readFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopShellSpec } from '../src/runtime.ts'
import { desktopTrayLabel } from '../src/tray-locale.ts'
import { DESKTOP_FRAME_HEIGHT } from '../src/window-chrome.ts'

const terminal = vi.hoisted(() => ({ open: vi.fn() }))
const diagnostics = vi.hoisted(() => ({ export: vi.fn() }))
const updater = vi.hoisted(() => ({
  download: vi.fn(),
  filename: vi.fn(),
  pending: vi.fn(),
  record: vi.fn(),
  resolve: vi.fn(),
}))
const childProcess = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Listener[]>()
  const child = {
    once: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return child
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, (listeners.get(event) ?? []).filter(candidate => candidate !== listener))
      return child
    }),
    unref: vi.fn(),
  }
  return {
    child,
    emit(event: string, ...args: unknown[]) {
      const current = [...(listeners.get(event) ?? [])]
      listeners.delete(event)
      for (const listener of current) listener(...args)
    },
    reset() { listeners.clear() },
    spawn: vi.fn(() => child),
  }
})

const MAIN_WINDOW_STATE_PATH = '/tmp/dsh-desktop-user-data/main-window-state.json'
const PRODUCT_VERSION = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { readonly version: string }).version

function clearMainWindowState(): void {
  try {
    unlinkSync(MAIN_WINDOW_STATE_PATH)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}

vi.mock('../src/desktop-terminal.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/desktop-terminal.ts')>(),
  openDesktopTerminal: terminal.open,
}))

vi.mock('../src/diagnostic-export.ts', () => ({
  exportDesktopDiagnostics: diagnostics.export,
}))


vi.mock('../src/update-download.ts', () => ({
  desktopUpdateFilename: updater.filename,
  downloadDesktopUpdate: updater.download,
  pendingDesktopUpdateArtifact: updater.pending,
  recordDesktopUpdateArtifact: updater.record,
  resolveDesktopUpdateArtifact: updater.resolve,
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: childProcess.spawn,
}))

const electron = vi.hoisted(() => {
  const browserWindowOptions: unknown[] = []
  const browserWindowThemeSources: string[] = []
  const browserWindows: BrowserWindow[] = []
  const browserWindowOn = vi.fn()
  const browserWindowOff = vi.fn()
  const loadURL = vi.fn(async (_url: string) => {})
  const webRequest = { onBeforeSendHeaders: vi.fn() }
  const sessionFetch = vi.fn()
  const applicationMenuTemplates: unknown[][] = []
  const menuTemplates: unknown[][] = []
  const notifications: Notification[] = []
  let zoomLevel = 0
  let devToolsOpened = false
  const dialog = {
    showErrorBox: vi.fn(),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined as string | undefined })),
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  }
  const appIcon = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(),
  }
  const templateIcon = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(),
  }
  const blueIcon = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(),
  }
  const webContents = {
    id: 73,
    session: { fetch: sessionFetch, webRequest, setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() },
    closeDevTools: vi.fn(() => { devToolsOpened = false }),
    executeJavaScript: vi.fn(async (_code: string, _userGesture?: boolean) => null as unknown),
    getZoomLevel: vi.fn(() => zoomLevel),
    isDevToolsOpened: vi.fn(() => devToolsOpened),
    on: vi.fn(),
    off: vi.fn(),
    openDevTools: vi.fn(() => { devToolsOpened = true }),
    reloadIgnoringCache: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
    isLoadingMainFrame: vi.fn(() => false),
    setZoomLevel: vi.fn((level: number) => { zoomLevel = level }),
    setWindowOpenHandler: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    ipc: { handle: vi.fn(), removeHandler: vi.fn() },
    mainFrame: { url: 'http://127.0.0.1:41234/' },
    loadURL,
  }
  const chromeWebContents = {
    reloadIgnoringCache: vi.fn(),
    on: vi.fn(), off: vi.fn(),
    isDestroyed: vi.fn(() => false),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    ipc: { handle: vi.fn(), removeHandler: vi.fn() },
    loadFile: vi.fn(async () => {}),
    close: vi.fn(),
  }
  const contentViews: WebContentsView[] = []
  class WebContentsView {
    readonly webContents: typeof webContents | typeof chromeWebContents
    readonly setBounds = vi.fn()
    readonly setBackgroundColor = vi.fn()
    constructor(readonly options: unknown) {
      this.webContents = (options as { webPreferences: { partition: string } }).webPreferences.partition === 'dsh-desktop-compatibility-chrome'
        ? chromeWebContents : webContents
      contentViews.push(this)
    }
  }
  const nativeTheme = {
    themeSource: 'system',
    get shouldUseDarkColors() { return this.themeSource === 'dark' },
  }

  class BrowserWindow {
    readonly webContents: typeof webContents | typeof chromeWebContents
    readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    readonly getContentSize = vi.fn(() => [1280, 840])
    readonly loadFile = vi.fn(async () => {})
    accessibleTitle = ''

    constructor(options: unknown) {
      this.webContents = (options as { webPreferences?: { partition?: string } }).webPreferences?.partition === 'dsh-desktop-compatibility-host'
        ? chromeWebContents : webContents
      browserWindowOptions.push(options)
      browserWindowThemeSources.push(nativeTheme.themeSource)
      browserWindows.push(this)
    }

    readonly isDestroyed = vi.fn(() => false)
    readonly isFocused = vi.fn(() => false)
    readonly isVisible = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly isFullScreen = vi.fn(() => false)
    readonly getNormalBounds = vi.fn(() => ({ x: 120, y: 80, width: 1280, height: 840 }))
    readonly flashFrame = vi.fn()
    readonly restore = vi.fn()
    readonly show = vi.fn()
    readonly hide = vi.fn()
    readonly minimize = vi.fn()
    readonly focus = vi.fn()
    readonly on = browserWindowOn
    readonly off = browserWindowOff
    readonly once = vi.fn()
    readonly destroy = vi.fn()
    readonly loadURL = loadURL
    readonly removeMenu = vi.fn()
    readonly setBackgroundMaterial = vi.fn()
    readonly setFullScreen = vi.fn()
  }

  class Tray {
    readonly image: unknown
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly on = vi.fn()
    readonly off = vi.fn()
    readonly destroy = vi.fn()

    constructor(image: unknown) {
      this.image = image
      trays.push(this)
    }
  }

  class Notification {
    static readonly isSupported = vi.fn(() => true)
    readonly once = vi.fn()
    readonly show = vi.fn()

    constructor(readonly options: unknown) {
      notifications.push(this)
    }
  }

  const trays: Tray[] = []
  const createFromPath = vi.fn((path: string) => {
    if (path.endsWith('app-icon.png')) return appIcon
    if (path.endsWith('tray-iconTemplate.png')) return templateIcon
    if (path.endsWith('tray-icon-blue.png')) return blueIcon
    throw new Error(`unexpected image path ${path}`)
  })

  return {
    app: {
      dock: { setIcon: vi.fn() },
      getLocale: vi.fn(() => 'en-US'),
      getPreferredSystemLanguages: vi.fn(() => ['en-US']),
      getPath: vi.fn((name: string) => {
        if (name === 'crashDumps') return '/tmp/dsh-desktop-user-data/Crashpad'
        if (name === 'downloads') return '/tmp/Downloads'
        return '/tmp/dsh-desktop-user-data'
      }),
      getVersion: vi.fn(() => '43.4.0'),
      isPackaged: false,
      isHidden: vi.fn(() => false),
      show: vi.fn(),
      setBadgeCount: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    },
    appIcon,
    applicationMenuTemplates,
    blueIcon,
    BrowserWindow,
    WebContentsView,
    contentViews,
    chromeWebContents,
    browserWindowOptions,
    browserWindowThemeSources,
    browserWindows,
    browserWindowOff,
    browserWindowOn,
    loadURL,
    sessionFetch,
    dialog,
    Menu: {
      buildFromTemplate: vi.fn((template: unknown[]) => {
        const first = template[0] as { label?: unknown, submenu?: unknown } | undefined
        if (first?.label === 'DSH Desktop' && Array.isArray(first.submenu)) {
          applicationMenuTemplates.push(template)
        } else {
          menuTemplates.push(template)
        }
        return { template }
      }),
      setApplicationMenu: vi.fn(),
    },
    menuTemplates,
    nativeImage: { createFromPath },
    nativeTheme,
    net: { fetch: vi.fn() },
    Notification,
    notifications,
    resetZoomLevel: () => { zoomLevel = 0 },
    resetDevTools: () => { devToolsOpened = false },
    screen: {
      getDisplayMatching: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
    },
    desktopCapturer: { getSources: vi.fn(async () => []) },
    systemPreferences: {
      getMediaAccessStatus: vi.fn(() => 'not-determined'),
      askForMediaAccess: vi.fn(async () => true),
      isTrustedAccessibilityClient: vi.fn(() => false),
    },
    shell: {
      openExternal: vi.fn(async () => {}),
      openPath: vi.fn(async () => ''),
      showItemInFolder: vi.fn(),
    },
    templateIcon,
    Tray,
    trays,
    webContents,
    webRequest,
  }
})

vi.mock('../src/desktop-dialog-window.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/desktop-dialog-window.ts')>(),
  showDesktopMessageBox: async (options: Electron.MessageBoxOptions, parent?: unknown) => {
    const showMessageBox = electron.dialog.showMessageBox as (...args: unknown[]) => Promise<{
      response: number
      checkboxChecked: boolean
    }>
    return parent === undefined
      ? await showMessageBox(options)
      : await showMessageBox(parent, options)
  },
}))

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  WebContentsView: electron.WebContentsView,
  dialog: electron.dialog,
  desktopCapturer: electron.desktopCapturer,
  systemPreferences: electron.systemPreferences,
  Menu: electron.Menu,
  nativeImage: electron.nativeImage,
  nativeTheme: electron.nativeTheme,
  net: electron.net,
  Notification: electron.Notification,
  screen: electron.screen,
  shell: electron.shell,
  Tray: electron.Tray,
}))

const spec: DesktopShellSpec = {
  mode: 'compatibility',
  macosMaterial: 'transparent',
  windowsMaterial: 'off',
  material: 'off',
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
  url: 'http://127.0.0.1:43120/',
  authenticationUrl: 'http://127.0.0.1:43120/?token=test-token',
  rendererAccessHeader: {
    name: 'x-dsh-desktop-renderer',
    value: Buffer.alloc(32, 9).toString('base64url'),
  },
  productName: 'DSH Desktop',
  windowTitle: 'DeepSeek Harness Desktop',
  iconPath: '/tmp/app-icon.png',
  trayIcons: {
    templatePath: '/tmp/tray-iconTemplate.png',
    bluePath: '/tmp/tray-icon-blue.png',
  },
  readLocalePreference: vi.fn(() => undefined),
  readThemeSource: vi.fn(() => 'system' as const),
  requestQuit: () => {},
  requestModeChange: vi.fn(async () => {}),
}

describe('Electron desktop runtime', () => {
  beforeEach(() => {
    clearMainWindowState()
    electron.app.isPackaged = false
    electron.browserWindowOptions.length = 0
    electron.browserWindowThemeSources.length = 0
    electron.browserWindows.length = 0
    electron.contentViews.length = 0
    electron.trays.length = 0
    electron.applicationMenuTemplates.length = 0
    electron.menuTemplates.length = 0
    electron.notifications.length = 0
    childProcess.reset()
    vi.clearAllMocks()
    updater.download.mockReset()
    updater.filename.mockReset()
    updater.filename.mockImplementation((platform: string, version: string) => (
      `DSH-Desktop-${version}-${platform === 'darwin' ? 'mac.dmg' : 'windows.exe'}`
    ))
    updater.pending.mockReset()
    updater.pending.mockResolvedValue(undefined)
    updater.record.mockReset()
    updater.record.mockResolvedValue(undefined)
    updater.resolve.mockReset()
    updater.resolve.mockResolvedValue(undefined)
    diagnostics.export.mockReset()
    electron.loadURL.mockReset()
    electron.loadURL.mockResolvedValue(undefined)
    electron.sessionFetch.mockReset()
    electron.sessionFetch.mockResolvedValue(new Response(null, { status: 200 }))
    electron.app.getPreferredSystemLanguages.mockReturnValue(['en-US'])
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    electron.shell.openPath.mockResolvedValue('')
    electron.nativeTheme.themeSource = 'system'
    electron.resetZoomLevel()
    electron.resetDevTools()
  })

  afterEach(() => {
    clearMainWindowState()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps session windows registered after sign-in and releases them with the Host generation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()
    runtime.platformLogin({ action: 'close', focus: false })
    expect(electron.webContents.ipc.removeHandler).not.toHaveBeenCalledWith('dsh-desktop:session-window')
    await release()
    expect(electron.webContents.ipc.removeHandler).toHaveBeenCalledWith('dsh-desktop:session-window')
  })

  it('uses the independent macOS compatibility frame, Dock icon, and template tray image', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.app.getPreferredSystemLanguages.mockReturnValue(['zh-Hans-CN', 'en-US'])
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    expect(electron.browserWindowOptions).toHaveLength(0)
    await runtime.mountScheduled()

    expect(electron.browserWindowOptions).toHaveLength(1)
    const options = electron.browserWindowOptions[0]
    expect(options).toEqual(expect.objectContaining({
      title: '',
      width: 1280,
      height: 840,
      show: false,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 12 },
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: 'dsh-desktop-compatibility-host',
      },
    }))
    expect(options).not.toHaveProperty('autoHideMenuBar')
    expect(options).not.toHaveProperty('titleBarOverlay')
    expect(electron.contentViews).toHaveLength(2)
    expect(electron.contentViews[1]?.options).toEqual({ webPreferences: {
      preload: expect.stringMatching(/\/preload\.cjs$/),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: 'persist:dsh-desktop-renderer',
    } })
    expect(electron.contentViews[1]?.setBounds).toHaveBeenCalledWith({ x: 0, y: 36, width: 1280, height: 804 })
    expect(electron.chromeWebContents.loadFile).toHaveBeenCalledWith(expect.stringMatching(/compatibility-chrome\.html$/))
    expect(electron.webContents.loadURL).toHaveBeenCalledWith(spec.url)
    expect(electron.browserWindows[0]?.webContents).not.toBe(electron.webContents)
    expect(electron.browserWindows[0]?.accessibleTitle).toBe('DeepSeek Harness Desktop')
    expect(spec.readThemeSource).toHaveBeenCalledOnce()
    expect(electron.nativeTheme.themeSource).toBe('system')
    expect(electron.browserWindows[0]?.removeMenu).not.toHaveBeenCalled()
    expect(electron.app.dock.setIcon).toHaveBeenCalledWith(electron.appIcon)
    expect(electron.applicationMenuTemplates[0]?.map(item => (item as { label?: string }).label)).toEqual([
      'DSH Desktop', '文件', '编辑', '显示', '窗口',
    ])
    expect(electron.Menu.setApplicationMenu).toHaveBeenCalledWith({
      template: electron.applicationMenuTemplates[0],
    })
    expect(electron.templateIcon.setTemplateImage).toHaveBeenCalledWith(true)
    expect(electron.trays[0]?.image).toBe(electron.templateIcon)
    expect(electron.menuTemplates[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Mode: Compatibility Mode', enabled: true }),
    ]))

    const titleListener = electron.browserWindowOn.mock.calls.find(([event]) => event === 'page-title-updated')?.[1]
    expect(titleListener).toEqual(expect.any(Function))
    const titleEvent = { preventDefault: vi.fn() }
    titleListener(titleEvent)
    expect(titleEvent.preventDefault).toHaveBeenCalledOnce()

    await release()
    expect(electron.browserWindowOff).toHaveBeenCalledWith('page-title-updated', titleListener)
    expect(electron.trays[0]?.off).toHaveBeenCalledWith('click', expect.any(Function))
  })

  it('limits setup persistence to the active renderer main frame and releases its handler', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const bridge = { read: vi.fn(async () => null), finish: vi.fn(async () => {}), dismissAccount: vi.fn(async () => {}), applyPending: vi.fn(async () => {}) }
    runtime.setupOnboarding = bridge
    const applySetupSettings = vi.fn(async () => {})
    const release = runtime.schedule({ ...spec, applySetupSettings })
    await runtime.mountScheduled()
    const handler = electron.webContents.ipc.handle.mock.calls.find(([name]) => name === 'dsh-desktop:setup-onboarding')?.[1]
    expect(handler).toBeTypeOf('function')
    const previousUrl = electron.webContents.mainFrame.url
    electron.webContents.mainFrame.url = spec.url
    const sender = { sender: electron.webContents, senderFrame: electron.webContents.mainFrame }
    await expect(handler(sender, { action: 'read' })).resolves.toBeNull()
    await expect(handler({ ...sender, senderFrame: { url: sender.senderFrame.url } }, { action: 'read' })).rejects.toThrow('Untrusted')
    await expect(handler(sender, { action: 'finish', profile: 'desktop', selection: { market: 'disabled' } })).rejects.toThrow('Invalid setup selection')
    expect(bridge.finish).not.toHaveBeenCalled()
    await handler(sender, { action: 'finish', profile: 'desktop' })
    expect(bridge.finish).toHaveBeenCalledExactlyOnceWith('desktop', undefined, expect.any(Function))
    // Setup saves through the renderer generation's own settings writer.
    const settings = { mode: 'extended' }
    await ((bridge.finish.mock.calls[0] as unknown[])[2] as (value: unknown) => Promise<void>)(settings)
    expect(applySetupSettings).toHaveBeenCalledExactlyOnceWith(settings)
    await expect(handler({ ...sender, senderFrame: { url: spec.url } }, { action: 'dismiss-account', profile: 'desktop' })).rejects.toThrow('Untrusted')
    await handler(sender, { action: 'dismiss-account', profile: 'desktop' })
    expect(bridge.dismissAccount).toHaveBeenCalledExactlyOnceWith('desktop')
    await expect(handler({ ...sender, senderFrame: { url: spec.url } }, { action: 'apply-pending', profile: 'desktop' })).rejects.toThrow('Untrusted')
    expect(bridge.applyPending).not.toHaveBeenCalled()
    await handler(sender, { action: 'apply-pending', profile: 'desktop' })
    expect(bridge.applyPending).toHaveBeenCalledExactlyOnceWith('desktop')
    await release()
    expect(electron.webContents.ipc.removeHandler).toHaveBeenCalledWith('dsh-desktop:setup-onboarding')
    await expect(handler(sender, { action: 'read' })).rejects.toThrow('Untrusted')
    electron.webContents.mainFrame.url = previousUrl
  })

  it('attaches the renderer capability to same-origin HTTP and WebSocket requests only', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    expect(electron.sessionFetch).toHaveBeenNthCalledWith(1, spec.authenticationUrl, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        [spec.rendererAccessHeader.name]: spec.rendererAccessHeader.value,
      },
    })
    expect(electron.sessionFetch).toHaveBeenCalledTimes(1)
    const registration = electron.webRequest.onBeforeSendHeaders.mock.calls
      .find(call => call.length === 2)
    expect(registration).toBeDefined()
    expect(registration?.[0]).toEqual({ urls: ['<all_urls>'] })
    expect(electron.sessionFetch.mock.invocationCallOrder[0])
      .toBeLessThan(electron.webRequest.onBeforeSendHeaders.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY)
    expect(electron.webRequest.onBeforeSendHeaders.mock.invocationCallOrder[0])
      .toBeLessThan(electron.loadURL.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY)
    const listener = registration?.[1] as (
      details: {
        id: number
        url: string
        method: string
        webContentsId?: number
        webContents?: { id: number }
        frame?: {
          detached: boolean
          origin: string
          parent: unknown
          top: { detached: boolean; origin: string } | null
        } | null
        resourceType: string
        referrer: string
        timestamp: number
        requestHeaders: Record<string, string>
      },
      callback: (response: { requestHeaders?: Record<string, string | string[]> }) => void,
    ) => void

    const assetCallback = vi.fn()
    const mainFrame = {
      detached: false,
      origin: 'http://127.0.0.1:43120',
      parent: null,
      top: null,
    }
    listener({
      id: 1,
      url: 'http://127.0.0.1:43120/assets/index.js',
      method: 'GET',
      webContentsId: 73,
      frame: mainFrame,
      resourceType: 'script',
      referrer: 'http://127.0.0.1:43120/',
      timestamp: 1,
      requestHeaders: {
        Accept: '*/*',
        'X-DSH-DESKTOP-RENDERER': 'spoofed',
      },
    }, assetCallback)
    expect(assetCallback).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: '*/*',
        [spec.rendererAccessHeader.name]: spec.rendererAccessHeader.value,
      },
    })

    const socketCallback = vi.fn()
    listener({
      id: 2,
      url: 'ws://127.0.0.1:43120/api/events.websocket',
      method: 'GET',
      webContents: { id: 73 },
      frame: mainFrame,
      resourceType: 'webSocket',
      referrer: 'http://127.0.0.1:43120/',
      timestamp: 2,
      requestHeaders: { Upgrade: 'websocket' },
    }, socketCallback)
    expect(socketCallback).toHaveBeenCalledWith({
      requestHeaders: {
        Upgrade: 'websocket',
        [spec.rendererAccessHeader.name]: spec.rendererAccessHeader.value,
      },
    })

    for (const details of [
      {
        id: 3,
        url: 'https://example.com/asset.js',
        method: 'GET',
        webContentsId: 73,
        frame: mainFrame,
        resourceType: 'script',
        referrer: 'http://127.0.0.1:43120/',
        timestamp: 3,
        requestHeaders: {
          Accept: 'text/javascript',
          [spec.rendererAccessHeader.name]: spec.rendererAccessHeader.value,
        },
      },
      {
        id: 4,
        url: 'http://127.0.0.1:43120/api/private',
        method: 'GET',
        webContentsId: 74,
        frame: mainFrame,
        resourceType: 'xhr',
        referrer: 'http://127.0.0.1:43120/',
        timestamp: 4,
        requestHeaders: {
          Accept: 'application/json',
          [spec.rendererAccessHeader.name]: spec.rendererAccessHeader.value,
        },
      },
    ]) {
      const callback = vi.fn()
      listener(details, callback)
      expect(callback).toHaveBeenCalledWith({
        requestHeaders: Object.fromEntries(
          Object.entries(details.requestHeaders)
            .filter(([name]) => name !== spec.rendererAccessHeader.name),
        ),
      })
    }

    for (const details of [
      {
        id: 5,
        url: 'http://127.0.0.1:43120/api/private',
        method: 'GET',
        resourceType: 'xhr',
        referrer: 'http://127.0.0.1:43120/',
        timestamp: 5,
        requestHeaders: {},
      },
      {
        id: 6,
        url: 'http://127.0.0.1:43120/api/private',
        method: 'GET',
        webContentsId: 73,
        frame: {
          detached: false,
          origin: 'https://untrusted.example',
          parent: mainFrame,
          top: mainFrame,
        },
        resourceType: 'xhr',
        referrer: 'https://untrusted.example/',
        timestamp: 6,
        requestHeaders: {},
      },
      {
        id: 7,
        url: 'http://127.0.0.1:43120/api/private',
        method: 'GET',
        webContentsId: 73,
        webContents: { id: 74 },
        frame: mainFrame,
        resourceType: 'xhr',
        referrer: 'http://127.0.0.1:43120/',
        timestamp: 7,
        requestHeaders: {},
      },
    ]) {
      const callback = vi.fn()
      listener(details, callback)
      expect(callback).toHaveBeenCalledWith({ requestHeaders: {} })
    }

    await release()
    expect(electron.webRequest.onBeforeSendHeaders).toHaveBeenLastCalledWith(null)
  })

  it('restores, debounces, and flushes main-window bounds across shell generations', async () => {
    vi.useFakeTimers()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { FileMainWindowStateStore } = await import('../src/main-window-state.ts')
    const store = new FileMainWindowStateStore('/tmp/dsh-desktop-user-data')
    store.write({ x: 260, y: 140, width: 1440, height: 900 })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    expect(electron.browserWindowOptions[0]).toEqual(expect.objectContaining({
      x: 260,
      y: 140,
      width: 1440,
      height: 900,
    }))
    const window = electron.browserWindows[0]
    const move = electron.browserWindowOn.mock.calls.find(([event]) => event === 'move')?.[1]
    const close = electron.browserWindowOn.mock.calls.find(([event]) => event === 'close')?.[1]
    expect(move).toEqual(expect.any(Function))
    expect(close).toEqual(expect.any(Function))

    window?.getNormalBounds.mockReturnValue({ x: 320, y: 180, width: 1500, height: 920 })
    move()
    expect(store.read()).toEqual({ x: 260, y: 140, width: 1440, height: 900 })
    await vi.advanceTimersByTimeAsync(250)
    expect(store.read()).toEqual({ x: 320, y: 180, width: 1500, height: 920 })

    window?.getNormalBounds.mockReturnValue({ x: 360, y: 220, width: 1520, height: 940 })
    close({ preventDefault: vi.fn() })
    expect(store.read()).toEqual({ x: 360, y: 220, width: 1520, height: 940 })

    await release()
    expect(electron.browserWindowOff).toHaveBeenCalledWith('move', move)
    expect(electron.browserWindowOff).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('fits stale saved bounds into the current display work area', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { FileMainWindowStateStore } = await import('../src/main-window-state.ts')
    const store = new FileMainWindowStateStore('/tmp/dsh-desktop-user-data')
    const stale = { x: 5_000, y: -2_000, width: 2_000, height: 1_400 }
    store.write(stale)
    electron.screen.getDisplayMatching.mockReturnValueOnce({
      workArea: { x: 0, y: 24, width: 1440, height: 876 },
    })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    expect(electron.screen.getDisplayMatching).toHaveBeenCalledWith(stale)
    expect(electron.browserWindowOptions[0]).toEqual(expect.objectContaining({
      x: 0,
      y: 24,
      width: 1440,
      height: 876,
    }))

    await release()
  })

  it('fails closed before renderer load when the upstream token exchange is rejected', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.sessionFetch.mockResolvedValueOnce(new Response(null, { status: 401 }))
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.schedule(spec)

    await expect(runtime.mountScheduled()).rejects.toThrow(
      'browser authentication failed with HTTP 401',
    )
    expect(electron.loadURL).not.toHaveBeenCalled()
    expect(electron.webRequest.onBeforeSendHeaders).not.toHaveBeenCalled()
    expect(electron.browserWindows[0]?.destroy).toHaveBeenCalledOnce()
  })

  it('fails closed when the authenticated redirect chain does not reach the Web root', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.sessionFetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.schedule(spec)

    await expect(runtime.mountScheduled()).rejects.toThrow(
      'browser authentication failed with HTTP 503',
    )
    expect(electron.loadURL).not.toHaveBeenCalled()
    expect(electron.webRequest.onBeforeSendHeaders).not.toHaveBeenCalled()
    expect(electron.browserWindows[0]?.destroy).toHaveBeenCalledOnce()
  })

  it('reloads the renderer and toggles Developer Tools only for a mounted generation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})

    expect(() => { runtime.reloadRenderer() }).toThrow('active shell generation')
    expect(() => { runtime.toggleDeveloperTools() }).toThrow('active shell generation')

    const release = runtime.schedule(spec)
    await runtime.mountScheduled()
    runtime.reloadRenderer()
    expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledOnce()

    runtime.toggleDeveloperTools()
    expect(electron.webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true })
    runtime.toggleDeveloperTools()
    expect(electron.webContents.closeDevTools).toHaveBeenCalledOnce()

    await release()
  })

  it('uses the Windows caption, hidden menu bar, removed menu, and fixed blue tray image', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    expect(electron.browserWindowOptions[0]).toEqual(expect.objectContaining({
      title: 'DeepSeek Harness Desktop',
      autoHideMenuBar: true,
    }))
    expect(electron.browserWindows[0]?.accessibleTitle).toBe('DeepSeek Harness Desktop')
    expect(electron.browserWindows[0]?.removeMenu).toHaveBeenCalledOnce()
    expect(electron.app.dock.setIcon).not.toHaveBeenCalled()
    expect(electron.Menu.setApplicationMenu).not.toHaveBeenCalled()
    expect(electron.trays[0]?.image).toBe(electron.blueIcon)
    expect(electron.templateIcon.setTemplateImage).not.toHaveBeenCalled()

    await release()
    expect(electron.trays[0]?.off).toHaveBeenCalledWith('click', expect.any(Function))
  })

  it('selects the restricted Linux platform adapter once for native capabilities', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    electron.app.isPackaged = true
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    expect(runtime.platform).toBe('linux')
    expect(electron.contentViews).toHaveLength(0)
    expect(runtime.updates.canDownload).toBe(false)
    await expect(runtime.pickDirectory()).rejects.toThrow('native workspace picker is unavailable on linux')
    expect(electron.app.dock.setIcon).not.toHaveBeenCalled()
    expect(electron.Menu.setApplicationMenu).not.toHaveBeenCalled()
    expect(electron.browserWindows[0]?.removeMenu).not.toHaveBeenCalled()
    expect(electron.menuTemplates[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Mode: Compatibility Mode', enabled: false }),
    ]))

    await release()
  })

  it('opens one parented Windows folder chooser and returns its selected path', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:\\Work'] })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    await expect(runtime.pickDirectory()).resolves.toBe('C:\\Work')
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(
      electron.browserWindows[0],
      {
        title: 'Select Workspace Directory',
        properties: ['openDirectory', 'dontAddToRecent'],
      },
    )

    await release()
  })

  it('routes the macOS native flow through a trusted renderer and a parented Electron dialog', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/Users/test/Work'] })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const handler = electron.webContents.ipc.handle.mock.calls
      .find(([name]) => name === 'dsh-desktop:native-directory-picker')?.[1]
    expect(handler).toEqual(expect.any(Function))
    const frame = electron.webContents.mainFrame
    const previousUrl = frame.url
    frame.url = spec.url
    try {
      await expect(handler({ sender: electron.webContents, senderFrame: frame })).resolves.toBe('/Users/test/Work')
      expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(
        electron.browserWindows[0],
        { title: 'Select Workspace Directory', properties: ['openDirectory', 'dontAddToRecent'] },
      )
      await expect(handler({ sender: electron.webContents, senderFrame: { url: spec.url } }))
        .rejects.toThrow('untrusted directory picker sender')
    } finally {
      frame.url = previousUrl
      await release()
    }
  })

  it('uses Electron media consent without the microphone workaround or permission IPC', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()
    expect(electron.webContents.ipc.handle.mock.calls.map(([name]) => name)).not.toContain('dsh-desktop:permissions')
    expect(electron.webContents.session.setPermissionCheckHandler).not.toHaveBeenCalled()
    expect(electron.webContents.session.setPermissionRequestHandler).not.toHaveBeenCalled()
    await release()
  })

  it('blocks unsupported workspace volumes without returning a risky path', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const query = vi.fn(() => ({ root: 'E:\\', fileSystem: 'EXFAT', driveType: 2 }))
    const logger = { error: vi.fn(), errorCause: vi.fn(), info: vi.fn() }
    const runtime = new ElectronDesktopRuntime(async () => {}, undefined, logger, query)

    await expect(runtime.validateDirectory('E:\\repo')).resolves.toBe(false)
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      defaultId: 0,
      cancelId: 0,
      message: expect.stringContaining('EXFAT'),
    }))
    expect(logger.error).toHaveBeenCalledWith('dsh-plugin-desktop: workspace volume decision=blocked path=E:\\repo')
  })

  it('requires explicit confirmation for a removable NTFS workspace', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const query = vi.fn(() => ({ root: 'E:\\', fileSystem: 'NTFS', driveType: 2 }))
    const logger = { error: vi.fn(), errorCause: vi.fn(), info: vi.fn() }
    const runtime = new ElectronDesktopRuntime(async () => {}, undefined, logger, query)

    await expect(runtime.validateDirectory('E:\\repo')).resolves.toBe(false)
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      defaultId: 1,
      cancelId: 1,
      buttons: ['Use This Folder', 'Choose Another Folder'],
    }))
    expect(logger.error).toHaveBeenCalledWith('dsh-plugin-desktop: workspace volume decision=cancelled path=E:\\repo')

    electron.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    await expect(runtime.validateDirectory('E:\\repo')).resolves.toBe(true)
    expect(logger.error).toHaveBeenCalledWith('dsh-plugin-desktop: workspace volume decision=confirmed path=E:\\repo')
  })

  it('offers restart first when the supervised Host is gone, and names the exit code', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const restart = vi.fn(async () => {})
    const runtime = new ElectronDesktopRuntime(restart)

    await runtime.showHostStoppedRecovery({ exitCode: 0 })

    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      buttons: ['Restart DSH Desktop', 'Open DSH Terminal', 'Dismiss'],
      defaultId: 0,
      cancelId: 2,
      detail: expect.stringContaining('0 / 0x00000000'),
    }))
    // Response 0 walks the existing restart confirmation before relaunching.
    expect(restart).toHaveBeenCalledOnce()
  })

  it('opens the terminal instead of restarting when the reader wants the logs first', async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    Object.defineProperty(process.versions, 'electron', { configurable: true, value: '43.4.0' })
    try {
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const restart = vi.fn(async () => {})
      const runtime = new ElectronDesktopRuntime(restart)
      const userDataPath = electron.app.getPath('userData')
      runtime.configureTerminal({
        profileName: 'desktop',
        profileDir: join(userDataPath, 'profiles', 'desktop'),
        homeDir: userDataPath,
      })

      await runtime.showHostStoppedRecovery({ exitCode: 3 })

      expect(terminal.open).toHaveBeenCalledOnce()
      expect(restart).not.toHaveBeenCalled()
    } finally {
      delete (process.versions as { electron?: string }).electron
    }
  })

  it('shows one Host recovery dialog no matter how many failures land on it', async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 2, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const restart = vi.fn(async () => {})
    const runtime = new ElectronDesktopRuntime(restart)

    await Promise.all([
      runtime.showHostStoppedRecovery({ exitCode: 0 }),
      runtime.showHostStoppedRecovery({ exitCode: 0 }),
      runtime.showHostStoppedRecovery({ exitCode: 0 }),
    ])

    expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(restart).not.toHaveBeenCalled()
  })

  it('stays silent about a Host exit that is part of quitting', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})

    runtime.prepareToQuit()
    await runtime.showHostStoppedRecovery({ exitCode: 0 })

    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('logs renderer crashes with the Windows exception code', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const logger = { error: vi.fn(), errorCause: vi.fn(), info: vi.fn() }
    const runtime = new ElectronDesktopRuntime(async () => {}, undefined, logger)
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const gone = electron.webContents.on.mock.calls
      .find(([event]) => event === 'render-process-gone')?.[1]
    expect(gone).toEqual(expect.any(Function))
    gone({}, { reason: 'crashed', exitCode: -1073741819 })

    expect(logger.error).toHaveBeenCalledWith(
      'dsh-plugin-desktop: renderer process gone (reason: crashed, exitCode: -1073741819 / 0xc0000005)',
    )
    await release()
  })

  it('turns a pre-health renderer crash into one handled startup failure', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn(() => true)
    const logger = { error: vi.fn(), errorCause: vi.fn(), info: vi.fn() }
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot, logger)
    const release = runtime.schedule(spec)
    const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })
    await runtime.mountScheduled()

    const gone = electron.webContents.on.mock.calls
      .find(([event]) => event === 'render-process-gone')?.[1]
    expect(gone).toEqual(expect.any(Function))
    gone({}, { reason: 'crashed', exitCode: -1073741819 })
    runtime.reportRendererBoot({ status: 'healthy' })
    await rendererBoot

    expect(runtime.rendererBootFailureReason).toBe('renderer-failed')
    expect(onRendererBoot).toHaveBeenCalledOnce()
    expect(onRendererBoot).toHaveBeenCalledWith({
      status: 'failed',
      plugins: [],
      error: 'renderer process gone (reason: crashed, exitCode: -1073741819 / 0xc0000005)',
    })
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    await release()
  })

  it('reports only a main-frame load failure while boot health is pending', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn(() => true)
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)
    const release = runtime.schedule(spec)
    const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })
    await runtime.mountScheduled()

    const failed = electron.webContents.on.mock.calls
      .find(([event]) => event === 'did-fail-load')?.[1]
    expect(failed).toEqual(expect.any(Function))
    failed({}, -105, 'NAME_NOT_RESOLVED', 'http://127.0.0.1/subresource', false)
    expect(onRendererBoot).not.toHaveBeenCalled()
    failed({}, -102, 'CONNECTION_REFUSED', spec.url, true)
    await rendererBoot

    expect(runtime.rendererBootFailureReason).toBe('renderer-failed')
    expect(onRendererBoot).toHaveBeenCalledWith({
      status: 'failed',
      plugins: [],
      error: 'renderer main frame failed to load (-102: CONNECTION_REFUSED)',
    })
    await release()
  })

  it('enforces the renderer boot deadline in the main process', async () => {
    vi.useFakeTimers()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime, RENDERER_BOOT_TIMEOUT_MS } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn(() => true)
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)
    const release = runtime.schedule(spec)
    const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })
    await runtime.mountScheduled()

    await vi.advanceTimersByTimeAsync(RENDERER_BOOT_TIMEOUT_MS)
    await rendererBoot

    expect(runtime.rendererBootFailureReason).toBe('renderer-timeout')
    expect(onRendererBoot).toHaveBeenCalledWith({
      status: 'failed',
      plugins: [],
      error: `The Renderer did not report boot health within ${String(RENDERER_BOOT_TIMEOUT_MS)}ms.`,
    })
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    await release()
  })

  it('rejects healthy Renderer evidence when the process exits before native mount completes', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let finishLoad!: () => void
    electron.loadURL.mockImplementationOnce(() => new Promise<void>((resolve) => { finishLoad = resolve }))
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const commitHealthy = vi.fn(async () => {})
    const runtime = new ElectronDesktopRuntime(async () => {}, () => true)
    const release = runtime.schedule(spec)
    const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy })
    const mounted = runtime.mountScheduled()
    await vi.waitFor(() => { expect(electron.loadURL).toHaveBeenCalledOnce() })

    runtime.reportRendererBoot({ status: 'healthy' })
    const gone = electron.webContents.on.mock.calls
      .find(([event]) => event === 'render-process-gone')?.[1]
    gone({}, { reason: 'crashed', exitCode: 9 })
    finishLoad()

    await mounted
    await expect(rendererBoot).resolves.toMatchObject({
      report: { status: 'failed', error: expect.stringContaining('renderer process gone') },
      failureReason: 'renderer-failed',
    })
    expect(commitHealthy).not.toHaveBeenCalled()
    await release()
  })

  it('does not reinterpret a renderer crash after healthy boot as install failure', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)
    const release = runtime.schedule(spec)
    const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })
    await runtime.mountScheduled()
    runtime.reportRendererBoot({ status: 'healthy' })
    await rendererBoot

    const gone = electron.webContents.on.mock.calls
      .find(([event]) => event === 'render-process-gone')?.[1]
    gone({}, { reason: 'crashed', exitCode: 9 })

    expect(onRendererBoot).toHaveBeenCalledOnce()
    expect(onRendererBoot).toHaveBeenCalledWith({ status: 'healthy' })
    expect(runtime.rendererBootFailureReason).toBeUndefined()
    await release()
  })

  describe('runtime renderer recovery', () => {
    async function mountHealthyRenderer() {
      vi.useFakeTimers()
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const restart = vi.fn(async () => {})
      const logger = { error: vi.fn(), errorCause: vi.fn(), info: vi.fn() }
      const runtime = new ElectronDesktopRuntime(restart, undefined, logger)
      const release = runtime.schedule(spec)
      const commitHealthy = vi.fn(async () => {})
      const boot = runtime.beginRendererBootMonitoring({ commitHealthy })
      await runtime.mountScheduled()
      runtime.reportRendererBoot({ status: 'healthy' })
      await boot
      const window = electron.browserWindows[0]!
      const gone = electron.webContents.on.mock.calls
        .find(([event]) => event === 'render-process-gone')?.[1]
      const loaded = electron.webContents.on.mock.calls
        .find(([event]) => event === 'did-finish-load')?.[1]
      const loadFailed = electron.webContents.on.mock.calls
        .find(([event]) => event === 'did-fail-load')?.[1]
      const healthy = () => {
        electron.chromeWebContents.on.mock.calls.find(([event]) => event === 'did-finish-load')?.[1]()
        loaded()
        runtime.reportRendererBoot({ status: 'healthy' })
      }
      const exhaust = async () => {
        gone({}, { reason: 'oom', exitCode: -536870904 })
        await vi.advanceTimersByTimeAsync(0)
        gone({}, { reason: 'oom', exitCode: -536870904 })
        await vi.advanceTimersByTimeAsync(1000)
        gone({}, { reason: 'oom', exitCode: -536870904 })
        await vi.advanceTimersByTimeAsync(3000)
        gone({}, { reason: 'oom', exitCode: -536870904 })
        await Promise.resolve()
      }
      return { runtime, release, restart, logger, window, gone, loaded, loadFailed, healthy, exhaust, commitHealthy }
    }

    it.each(['oom', 'crashed', 'abnormal-exit'] as const)('silently reloads after %s without restarting the Host or revealing a hidden window', async (reason) => {
      const { runtime, release, restart, window, gone, healthy, commitHealthy, logger } = await mountHealthyRenderer()
      const showCount = window.show.mock.calls.length
      const focusCount = window.focus.mock.calls.length
      gone({}, { reason, exitCode: -536870904 })
      gone({}, { reason, exitCode: -536870904 })
      await vi.advanceTimersByTimeAsync(0)
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledOnce()
      healthy()
      await vi.advanceTimersByTimeAsync(90_000)
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledOnce()
      expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
      expect(window.show).toHaveBeenCalledTimes(showCount)
      expect(window.focus).toHaveBeenCalledTimes(focusCount)
      expect(restart).not.toHaveBeenCalled()
      expect(commitHealthy).toHaveBeenCalledOnce()
      expect(runtime.rendererBootFailureReason).toBeUndefined()
      expect(logger.error).toHaveBeenCalledWith('dsh-plugin-desktop: automatic renderer recovery healthy')
      await release()
    })

    it('recovers a crashed renderer while preserving a minimized window', async () => {
      const { release, restart, window, gone, healthy } = await mountHealthyRenderer()
      window.isMinimized.mockReturnValue(true)
      const showCount = window.show.mock.calls.length
      const focusCount = window.focus.mock.calls.length
      gone({}, { reason: 'oom', exitCode: -536870904 })
      await vi.advanceTimersByTimeAsync(0)
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledOnce()
      healthy()

      expect(window.restore).not.toHaveBeenCalled()
      expect(window.show).toHaveBeenCalledTimes(showCount)
      expect(window.focus).toHaveBeenCalledTimes(focusCount)
      expect(restart).not.toHaveBeenCalled()
      await release()
    })

    it('recovers an isolated chrome crash and waits for both documents', async () => {
      const { runtime, release, healthy, logger } = await mountHealthyRenderer()
      const chromeGone = electron.chromeWebContents.on.mock.calls
        .filter(([event]) => event === 'render-process-gone').at(-1)?.[1]
      chromeGone({}, { reason: 'crashed', exitCode: 9 })
      await vi.advanceTimersByTimeAsync(0)
      expect(electron.chromeWebContents.reloadIgnoringCache).toHaveBeenCalledOnce()
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledOnce()
      electron.webContents.on.mock.calls.find(([event]) => event === 'did-finish-load')?.[1]()
      runtime.reportRendererBoot({ status: 'healthy' })
      expect(logger.error).not.toHaveBeenCalledWith('dsh-plugin-desktop: automatic renderer recovery healthy')
      healthy()
      expect(logger.error).toHaveBeenCalledWith('dsh-plugin-desktop: automatic renderer recovery healthy')
      await vi.advanceTimersByTimeAsync(90_000)
      expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
      expect(electron.chromeWebContents.reloadIgnoringCache).toHaveBeenCalledOnce()
      await release()
    })

    it('automatically recovers a blank live page and validates visible content after reload', async () => {
      const { runtime, release, window, healthy, logger } = await mountHealthyRenderer()
      window.isVisible.mockReturnValue(true)
      electron.webContents.executeJavaScript.mockResolvedValue(false)
      await vi.advanceTimersByTimeAsync(10_001)
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledOnce()
      expect(electron.webContents.forcefullyCrashRenderer).not.toHaveBeenCalled()
      healthy()
      expect(logger.error).not.toHaveBeenCalledWith('dsh-plugin-desktop: automatic renderer recovery healthy')
      electron.webContents.executeJavaScript.mockResolvedValue(true)
      await vi.advanceTimersByTimeAsync(5000)
      expect(logger.error).toHaveBeenCalledWith('dsh-plugin-desktop: automatic renderer recovery healthy')
      expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
      runtime.prepareToQuit()
      await release()
      electron.webContents.executeJavaScript.mockResolvedValue(null)
    })

    it('replaces a persistently unresponsive renderer and reloads once its exit lands', async () => {
      const { release, window, gone, logger } = await mountHealthyRenderer()
      window.isVisible.mockReturnValue(true)
      electron.webContents.executeJavaScript.mockImplementation(() => new Promise(() => {}))
      await vi.advanceTimersByTimeAsync(30_001)
      // forcefullyCrashRenderer() returns before the process is gone. A reload
      // issued in the same turn goes to a RenderFrameHost that is already being
      // torn down, and Chromium cancels it along with the process.
      expect(electron.webContents.forcefullyCrashRenderer).toHaveBeenCalledOnce()
      expect(electron.webContents.reloadIgnoringCache).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith(
        'dsh-plugin-desktop: terminating unresponsive renderer; the crash dump it produces is deliberate',
      )
      gone({}, { reason: 'killed', exitCode: -536870904 })
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledOnce()
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('unresponsive renderer replaced'))
      expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
      await release()
      electron.webContents.executeJavaScript.mockResolvedValue(null)
    })

    it('reloads anyway when a forced termination never reports its exit', async () => {
      const { release, window, logger } = await mountHealthyRenderer()
      window.isVisible.mockReturnValue(true)
      electron.webContents.executeJavaScript.mockImplementation(() => new Promise(() => {}))
      await vi.advanceTimersByTimeAsync(30_001)
      expect(electron.webContents.forcefullyCrashRenderer).toHaveBeenCalledOnce()
      expect(electron.webContents.reloadIgnoringCache).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledOnce()
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('reported no exit within the deadline'),
      )
      await release()
      electron.webContents.executeJavaScript.mockResolvedValue(null)
    })

    it('keeps a native reload reachable and clears an exhausted recovery through it', async () => {
      const { runtime, release, exhaust, healthy, window } = await mountHealthyRenderer()
      electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await exhaust()
      expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce()
      const reloads = electron.webContents.reloadIgnoringCache.mock.calls.length
      const item = (electron.menuTemplates.at(-1) as Array<{ label?: string, click?: () => void }>)
        .find(entry => entry.label === 'Reload Interface')
      expect(item?.click).toBeTypeOf('function')
      item!.click!()
      await vi.advanceTimersByTimeAsync(0)
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(reloads + 1)
      healthy()
      // A recovered generation must not re-arm the degraded prompt on reveal.
      window.isVisible.mockReturnValue(false)
      runtime.show()
      await vi.advanceTimersByTimeAsync(0)
      expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce()
      await release()
    })

    it('retries a failed main-frame load but ignores subframe errors and aborted navigation', async () => {
      const { release, gone, loadFailed, healthy } = await mountHealthyRenderer()
      gone({}, { reason: 'oom', exitCode: 9 })
      await vi.advanceTimersByTimeAsync(0)
      loadFailed({}, -105, 'NAME_NOT_RESOLVED', spec.url, false)
      loadFailed({}, -3, 'ABORTED', spec.url, true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledOnce()
      loadFailed({}, -102, 'CONNECTION_REFUSED', spec.url, true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(2)
      healthy()
      expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
      await release()
    })

    it('only asks for help after repeated automatic failure and permits an explicit retry', async () => {
      const { runtime, release, window, healthy, exhaust } = await mountHealthyRenderer()
      runtime.setLocalePreference('zh')
      electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await exhaust()
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(3)
      expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce()
      expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(window, expect.objectContaining({
        message: '界面未能自动恢复。',
        buttons: ['再次尝试恢复', '暂不处理'],
      }))
      await vi.advanceTimersByTimeAsync(120_000)
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(3)
      runtime.show()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(4)
      healthy()
      expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2)
      await release()
    })

    it.each(['clean-exit', 'killed'] as const)('does not recover an intentional %s', async (reason) => {
      const { release, gone } = await mountHealthyRenderer()
      gone({}, { reason, exitCode: 0 })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
      expect(electron.webContents.reloadIgnoringCache).not.toHaveBeenCalled()
      await release()
    })

    it.each(['quit', 'release', 'destroy'] as const)('cancels queued automatic recovery after %s', async (action) => {
      const { runtime, release, window, gone } = await mountHealthyRenderer()
      gone({}, { reason: 'oom', exitCode: 9 })
      if (action === 'quit') runtime.prepareToQuit()
      if (action === 'release') await release()
      if (action === 'destroy') window.isDestroyed.mockReturnValue(true)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(electron.webContents.reloadIgnoringCache).not.toHaveBeenCalled()
      expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
      await release()
    })

    it('ignores a delayed fallback confirmation after disposal and deduplicates prompts', async () => {
      const { runtime, release, gone, exhaust } = await mountHealthyRenderer()
      let answer!: (result: { response: number; checkboxChecked: boolean }) => void
      electron.dialog.showMessageBox.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
      await exhaust()
      runtime.show()
      gone({}, { reason: 'oom', exitCode: 9 })
      expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce()
      await release()
      answer({ response: 0, checkboxChecked: false })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(3)
    })

    it('logs a fallback dialog failure and permits another attempt from the tray', async () => {
      const { runtime, release, healthy, exhaust, logger } = await mountHealthyRenderer()
      electron.dialog.showMessageBox.mockRejectedValueOnce(new Error('dialog unavailable'))
      await exhaust()
      expect(logger.error).toHaveBeenCalledWith('dsh-plugin-desktop: renderer recovery failed: dialog unavailable')
      runtime.show()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(electron.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(4)
      healthy()
      await release()
    })
  })

  it('starts from the saved locale and rebuilds native tray commands when it changes', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const readLocalePreference = vi.fn(() => 'zh' as const)
    const release = runtime.schedule({ ...spec, readLocalePreference })

    await runtime.mountScheduled()
    expect(readLocalePreference).toHaveBeenCalledOnce()
    expect(runtime.locale).toBe('zh')
    expect((electron.menuTemplates.at(-1) as Array<{ label?: string }>).map(item => item.label))
      .toEqual(expect.arrayContaining([
        '打开 DSH Desktop',
        '模式：兼容模式',
        '退出',
      ]))

    runtime.setLocalePreference('en')
    expect(runtime.locale).toBe('en')
    expect((electron.menuTemplates.at(-1) as Array<{ label?: string }>).map(item => item.label))
      .toEqual(expect.arrayContaining([
        'Open DSH Desktop',
        'Mode: Compatibility Mode',
        'Quit',
      ]))

    electron.app.getLocale.mockReturnValueOnce('zh-CN')
    runtime.setLocalePreference(undefined)
    expect(runtime.locale).toBe('zh')
    expect((electron.menuTemplates.at(-1) as Array<{ label?: string }>).map(item => item.label))
      .toEqual(expect.arrayContaining([
        '打开 DSH Desktop',
        '模式：兼容模式',
        '退出',
      ]))

    await release()
  })

  it('handles desktop zoom shortcuts without relying on the native menu', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const zoomListener = electron.webContents.on.mock.calls
      .find(([event]) => event === 'before-input-event')?.[1]
    expect(zoomListener).toEqual(expect.any(Function))

    const zoomIn = { preventDefault: vi.fn() }
    zoomListener(zoomIn, { type: 'keyDown', control: true, key: '=' })
    expect(zoomIn.preventDefault).toHaveBeenCalledOnce()
    expect(electron.webContents.setZoomLevel).toHaveBeenLastCalledWith(1)

    const zoomInRelease = { preventDefault: vi.fn() }
    zoomListener(zoomInRelease, { type: 'keyUp', control: true, key: '=' })
    expect(zoomInRelease.preventDefault).not.toHaveBeenCalled()
    expect(electron.webContents.setZoomLevel).toHaveBeenCalledTimes(1)

    const zoomOut = { preventDefault: vi.fn() }
    zoomListener(zoomOut, { type: 'keyDown', control: true, key: '-' })
    expect(zoomOut.preventDefault).toHaveBeenCalledOnce()
    expect(electron.webContents.setZoomLevel).toHaveBeenLastCalledWith(0)

    const zoomReset = { preventDefault: vi.fn() }
    zoomListener(zoomReset, { type: 'keyDown', control: true, key: '0' })
    expect(zoomReset.preventDefault).toHaveBeenCalledOnce()
    expect(electron.webContents.setZoomLevel).toHaveBeenLastCalledWith(0)

    const plainPlus = { preventDefault: vi.fn() }
    zoomListener(plainPlus, { type: 'keyDown', key: '=' })
    expect(plainPlus.preventDefault).not.toHaveBeenCalled()

    await release()
    expect(electron.webContents.off).toHaveBeenCalledWith('before-input-event', zoomListener)
    expect(electron.webContents.off).toHaveBeenCalledWith(
      'render-process-gone',
      electron.webContents.on.mock.calls.find(([event]) => event === 'render-process-gone')?.[1],
    )
    expect(electron.webContents.off).toHaveBeenCalledWith(
      'did-fail-load',
      electron.webContents.on.mock.calls.find(([event]) => event === 'did-fail-load')?.[1],
    )
    expect(electron.trays[0]?.destroy).toHaveBeenCalledOnce()
    expect(electron.browserWindows[0]?.destroy).toHaveBeenCalledOnce()

    await release()
    expect(electron.trays[0]?.destroy).toHaveBeenCalledOnce()
    expect(electron.browserWindows[0]?.destroy).toHaveBeenCalledOnce()
  })

  it('does not block a sandboxed iframe from navigating to an external origin', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const navigate = electron.webContents.on.mock.calls
      .find(([event]) => event === 'will-frame-navigate')?.[1]
    expect(navigate).toEqual(expect.any(Function))

    const iframeEvent = {
      url: 'https://example.com/plugin',
      isMainFrame: false,
      preventDefault: vi.fn(),
    }
    navigate(iframeEvent)

    expect(iframeEvent.preventDefault).not.toHaveBeenCalled()

    const mainFrameEvent = {
      url: 'https://example.com/',
      isMainFrame: true,
      preventDefault: vi.fn(),
    }
    navigate(mainFrameEvent)

    expect(mainFrameEvent.preventDefault).toHaveBeenCalledOnce()

    await release()
  })

  it('keeps external window links deny-by-default with a narrow protocol allowlist', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const logger = { error: vi.fn(), errorCause: vi.fn(), info: vi.fn() }
    const runtime = new ElectronDesktopRuntime(async () => {}, undefined, logger)
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const openHandler = electron.webContents.setWindowOpenHandler.mock.calls[0]?.[0]
    expect(openHandler).toEqual(expect.any(Function))

    expect(openHandler({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' })
    expect(openHandler({ url: 'http://example.com/docs' })).toEqual({ action: 'deny' })
    expect(openHandler({ url: 'mailto:maintainers@example.com' })).toEqual({ action: 'deny' })
    await Promise.resolve()
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/docs')
    expect(electron.shell.openExternal).toHaveBeenCalledWith('http://example.com/docs')
    expect(electron.shell.openExternal).toHaveBeenCalledWith('mailto:maintainers@example.com')

    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,unsafe', 'not a URL']) {
      expect(openHandler({ url })).toEqual({ action: 'deny' })
    }
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(3)

    electron.shell.openExternal.mockRejectedValueOnce(new Error('external handler unavailable'))
    openHandler({ url: 'https://example.com/failure' })
    await Promise.resolve()
    expect(logger.error).toHaveBeenCalledWith(
      'dsh-plugin-desktop: failed to open external link: external handler unavailable',
    )

    await release()
  })

  it('protects the main-frame origin across redirects while leaving iframe redirects alone', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const redirect = electron.webContents.on.mock.calls
      .find(([event]) => event === 'will-redirect')?.[1]
    expect(redirect).toEqual(expect.any(Function))

    const sameOrigin = { preventDefault: vi.fn() }
    redirect(sameOrigin, 'http://127.0.0.1:43120/next', false, true)
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled()

    const external = { preventDefault: vi.fn() }
    redirect(external, 'https://example.com/redirect', false, true)
    expect(external.preventDefault).toHaveBeenCalledOnce()

    const malformed = { preventDefault: vi.fn() }
    redirect(malformed, 'not a URL', false, true)
    expect(malformed.preventDefault).toHaveBeenCalledOnce()

    const iframe = { preventDefault: vi.fn() }
    redirect(iframe, 'https://example.com/plugin', false, false)
    expect(iframe.preventDefault).not.toHaveBeenCalled()

    await release()
  })

  it('shows and hides one native window through ready, activation, tray, and close events', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const window = electron.browserWindows[0]
    const ready = window?.once.mock.calls.find(([event]) => event === 'ready-to-show')?.[1]
    const activate = electron.app.on.mock.calls.find(([event]) => event === 'activate')?.[1]
    const trayClick = electron.trays[0]?.on.mock.calls.find(([event]) => event === 'click')?.[1]
    const close = electron.browserWindowOn.mock.calls.find(([event]) => event === 'close')?.[1]
    expect(ready).toEqual(expect.any(Function))
    expect(activate).toEqual(expect.any(Function))
    expect(trayClick).toEqual(expect.any(Function))
    expect(close).toEqual(expect.any(Function))

    expect(window?.show).toHaveBeenCalledOnce()
    expect(window?.focus).toHaveBeenCalledOnce()

    window?.isVisible.mockReturnValue(true)
    ready()
    window?.isMinimized.mockReturnValue(true)
    activate()
    window?.isMinimized.mockReturnValue(false)
    trayClick()
    expect(window?.restore).toHaveBeenCalledOnce()
    expect(window?.show).toHaveBeenCalledTimes(3)
    expect(window?.focus).toHaveBeenCalledTimes(3)

    const closeEvent = { preventDefault: vi.fn() }
    close(closeEvent)
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(window?.hide).toHaveBeenCalledOnce()

    runtime.prepareToQuit()
    const quittingCloseEvent = { preventDefault: vi.fn() }
    close(quittingCloseEvent)
    expect(quittingCloseEvent.preventDefault).not.toHaveBeenCalled()
    expect(window?.hide).toHaveBeenCalledOnce()

    await release()
  })

  // `new Tray()` succeeds on Linux desktops that render no status area at all,
  // so hiding the window there can strand a running Host with no way back.
  it('minimizes instead of hiding when a Linux window is closed', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const window = electron.browserWindows[0]
    const close = electron.browserWindowOn.mock.calls.find(([event]) => event === 'close')?.[1]
    expect(close).toEqual(expect.any(Function))

    const closeEvent = { preventDefault: vi.fn() }
    close(closeEvent)
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(window?.minimize).toHaveBeenCalledOnce()
    expect(window?.hide).not.toHaveBeenCalled()

    // Quitting still tears the window down instead of leaving it minimized.
    runtime.prepareToQuit()
    const quittingCloseEvent = { preventDefault: vi.fn() }
    close(quittingCloseEvent)
    expect(quittingCloseEvent.preventDefault).not.toHaveBeenCalled()
    expect(window?.minimize).toHaveBeenCalledOnce()

    await release()
  })

  it('reveals the startup surface before ready-to-show and does not re-show a visible window', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const window = electron.browserWindows[0]
    const ready = window?.once.mock.calls.find(([event]) => event === 'ready-to-show')?.[1]
    expect(ready).toEqual(expect.any(Function))
    expect(window?.show).toHaveBeenCalledOnce()
    expect(window?.focus).toHaveBeenCalledOnce()

    window?.isVisible.mockReturnValue(true)
    ready()

    expect(window?.show).toHaveBeenCalledOnce()
    expect(window?.focus).toHaveBeenCalledOnce()

    await release()
  })

  it('does not restore or focus a minimized window when ready-to-show arrives late', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const window = electron.browserWindows[0]!
    const ready = window.once.mock.calls.find(([event]) => event === 'ready-to-show')?.[1]
    expect(ready).toEqual(expect.any(Function))
    window.isMinimized.mockReturnValue(true)
    const showCount = window.show.mock.calls.length
    const focusCount = window.focus.mock.calls.length
    ready()

    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).toHaveBeenCalledTimes(showCount)
    expect(window.focus).toHaveBeenCalledTimes(focusCount)
    await release()
  })

  it('does not re-show a window hidden to the tray before ready-to-show', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const window = electron.browserWindows[0]
    const ready = window?.once.mock.calls.find(([event]) => event === 'ready-to-show')?.[1]
    const close = electron.browserWindowOn.mock.calls.find(([event]) => event === 'close')?.[1]
    expect(ready).toEqual(expect.any(Function))
    expect(close).toEqual(expect.any(Function))
    expect(window?.show).toHaveBeenCalledOnce()
    expect(window?.focus).toHaveBeenCalledOnce()

    const closeEvent = { preventDefault: vi.fn() }
    close(closeEvent)
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(window?.hide).toHaveBeenCalledOnce()

    ready()

    expect(window?.show).toHaveBeenCalledOnce()
    expect(window?.focus).toHaveBeenCalledOnce()

    await release()
  })

  it('shows privacy-safe macOS attention only while unfocused and clears it on notification click', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const window = electron.browserWindows[0]
    runtime.notifyAttention({ title: 'Turn Completed', body: 'A direct user turn has finished.' })
    runtime.notifyAttention({ title: 'Background Job Completed', body: 'A background job has finished.' })

    expect(electron.app.setBadgeCount.mock.calls).toEqual([[1], [2]])
    expect(electron.notifications).toHaveLength(2)
    expect(electron.notifications[0]?.options).toEqual({
      title: 'Turn Completed',
      body: 'A direct user turn has finished.',
    })
    const click = electron.notifications[0]?.once.mock.calls.find(([event]) => event === 'click')?.[1]
    expect(click).toEqual(expect.any(Function))
    click()
    expect(electron.app.setBadgeCount).toHaveBeenLastCalledWith(0)
    expect(window?.show).toHaveBeenCalledTimes(2)
    expect(window?.focus).toHaveBeenCalledTimes(2)

    window?.isFocused.mockReturnValue(true)
    runtime.notifyAttention({ title: 'Ignored', body: 'Focused window' })
    expect(electron.notifications).toHaveLength(2)

    await release()
  })

  it('leaves macOS fullscreen before hiding and restores fullscreen when reopened', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const window = electron.browserWindows[0]
    window?.isFullScreen.mockReturnValue(true)
    const close = electron.browserWindowOn.mock.calls.find(([event]) => event === 'close')?.[1]
    expect(close).toEqual(expect.any(Function))

    const first = { preventDefault: vi.fn() }
    const second = { preventDefault: vi.fn() }
    close(first)
    close(second)

    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(second.preventDefault).toHaveBeenCalledOnce()
    expect(window?.setFullScreen).toHaveBeenCalledOnce()
    expect(window?.setFullScreen).toHaveBeenCalledWith(false)
    expect(window?.hide).not.toHaveBeenCalled()
    const leaveFullscreen = window?.once.mock.calls.find(([event]) => event === 'leave-full-screen')?.[1]
    expect(leaveFullscreen).toEqual(expect.any(Function))

    leaveFullscreen()
    expect(window?.hide).toHaveBeenCalledOnce()

    window?.isFullScreen.mockReturnValue(false)
    runtime.show()
    expect(window?.setFullScreen.mock.calls).toEqual([[false], [true]])
    expect(window?.show).toHaveBeenCalledTimes(2)
    expect(window?.focus).toHaveBeenCalledTimes(2)

    await release()
  })

  it('reveals and restores macOS fullscreen when reopened during the exit transition', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const window = electron.browserWindows[0]
    window?.isFullScreen.mockReturnValue(true)
    const close = electron.browserWindowOn.mock.calls.find(([event]) => event === 'close')?.[1]
    close({ preventDefault: vi.fn() })
    const leaveFullscreen = window?.once.mock.calls.find(([event]) => event === 'leave-full-screen')?.[1]

    runtime.show()
    window?.isFullScreen.mockReturnValue(false)
    leaveFullscreen()

    expect(window?.hide).not.toHaveBeenCalled()
    expect(window?.setFullScreen.mock.calls).toEqual([[false], [true]])
    expect(window?.show).toHaveBeenCalledTimes(2)
    expect(window?.focus).toHaveBeenCalledTimes(2)

    await release()
  })

  it('flashes the Windows taskbar and clears attention on focus and release', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const window = electron.browserWindows[0]
    const focus = electron.browserWindowOn.mock.calls.find(([event]) => event === 'focus')?.[1]
    runtime.notifyAttention({ title: 'Turn Completed', body: 'A direct user turn has finished.' })
    expect(window?.flashFrame).toHaveBeenLastCalledWith(true)
    expect(focus).toEqual(expect.any(Function))
    focus()
    expect(window?.flashFrame).toHaveBeenLastCalledWith(false)

    runtime.notifyAttention({ title: 'Background Job Failed', body: 'A background job needs attention.' })
    await release()
    expect(window?.flashFrame).toHaveBeenLastCalledWith(false)
    expect(electron.browserWindowOff).toHaveBeenCalledWith('focus', expect.any(Function))
  })

  it('restores a hidden macOS application before revealing its window without stealing focus when already visible', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const window = electron.browserWindows[0]
    const activate = electron.app.on.mock.calls.find(([event]) => event === 'activate')?.[1]
    const didBecomeActive = electron.app.on.mock.calls.find(([event]) => event === 'did-become-active')?.[1]
    expect(activate).toEqual(expect.any(Function))
    expect(didBecomeActive).toEqual(expect.any(Function))

    electron.app.isHidden.mockReturnValue(true)
    window?.isVisible.mockReturnValue(false)
    const appShowCount = electron.app.show.mock.calls.length
    const focusCountBeforeReveal = window?.focus.mock.calls.length ?? 0
    didBecomeActive()
    expect(electron.app.show).toHaveBeenCalledTimes(appShowCount + 1)
    expect((electron.app.show.mock.invocationCallOrder.at(-1) ?? Infinity))
      .toBeLessThan(window?.show.mock.invocationCallOrder.at(-1) ?? Infinity)
    expect(window?.focus).toHaveBeenCalledTimes(focusCountBeforeReveal + 1)

    electron.app.isHidden.mockReturnValue(false)
    window?.isVisible.mockReturnValue(true)
    const focusCount = window?.focus.mock.calls.length ?? 0
    activate()
    expect(window?.focus).toHaveBeenCalledTimes(focusCount)

    await release()
    expect(electron.app.off).toHaveBeenCalledWith('did-become-active', expect.any(Function))
  })

  it('releases the window and tray when post-load startup wiring fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    const beforeInteractive = vi.fn(() => {
      throw new Error('interactive wiring failed')
    })

    await expect(runtime.mountScheduled(beforeInteractive)).rejects.toThrow('interactive wiring failed')
    expect(electron.trays[0]?.destroy).toHaveBeenCalledOnce()
    expect(electron.browserWindows[0]?.destroy).toHaveBeenCalledOnce()
    expect(electron.app.off).toHaveBeenCalledWith('activate', expect.any(Function))
    expect(electron.trays[0]?.off).toHaveBeenCalledWith('click', expect.any(Function))

    await expect(release()).rejects.toThrow('interactive wiring failed')
    expect(electron.trays[0]?.destroy).toHaveBeenCalledOnce()
    expect(electron.browserWindows[0]?.destroy).toHaveBeenCalledOnce()
  })

  it('rejects an unsupported Electron platform before creating a runtime', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('aix' as NodeJS.Platform)
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')

    expect(() => new ElectronDesktopRuntime(async () => {})).toThrow(
      'dsh-plugin-desktop: unsupported Electron platform aix',
    )
    expect(electron.browserWindowOptions).toHaveLength(0)
  })

  it('does not mount a registration disposed before Host boot settles', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await release()

    await expect(runtime.mountScheduled()).rejects.toThrow(
      'the Cordis shell plugin did not register a window',
    )
    expect(electron.browserWindowOptions).toHaveLength(0)
  })

  it('keeps tray commands unavailable until the Web surface loads and startup commits', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    let finishLoad!: () => void
    electron.loadURL.mockImplementationOnce(() => new Promise<void>((resolve) => { finishLoad = resolve }))
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    const beforeInteractive = vi.fn(() => {
      expect(electron.trays).toHaveLength(1)
    })

    const mounted = runtime.mountScheduled(beforeInteractive)
    await vi.waitFor(() => { expect(electron.loadURL).toHaveBeenCalledOnce() })
    expect(electron.trays).toHaveLength(0)
    expect(beforeInteractive).not.toHaveBeenCalled()

    finishLoad()
    await mounted
    expect(beforeInteractive).toHaveBeenCalledOnce()
    expect(electron.trays).toHaveLength(1)

    await release()
  })

  describe.each(['darwin', 'win32', 'linux'] as const)('tray mode selector on %s', platform => {
    it.each([
      ['compatibility', 'en'], ['compatibility', 'zh'],
      ['extended', 'en'], ['extended', 'zh'],
      ['advanced', 'en'], ['advanced', 'zh'],
    ].filter(([mode]) => platform !== 'linux' || mode === 'compatibility') as Array<['compatibility' | 'extended' | 'advanced', 'en' | 'zh']>)('lists all modes with %s selected (%s)', async (mode, locale) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const requestModeChange = vi.fn(async () => {})
      const runtime = new ElectronDesktopRuntime(async () => {})
      const release = runtime.schedule({ ...spec, mode, requestModeChange, readLocalePreference: () => locale })
      await runtime.mountScheduled()

      const modes = ['compatibility', 'extended', 'advanced'] as const
      const labels = locale === 'zh' ? ['兼容模式', '扩展窗口', '增强模式'] : ['Compatibility Mode', 'Extended Window', 'Enhanced Mode']
      const title = locale === 'zh' ? `模式：${labels[modes.indexOf(mode)]}` : `Mode: ${labels[modes.indexOf(mode)]}`
      type Item = { label?: string, type?: string, checked?: boolean, enabled?: boolean, click?: () => void, submenu?: Item[] }
      const menu = electron.menuTemplates.at(-1) as Item[]
      const selectors = menu.filter(item => item.label === title)
      expect(selectors).toHaveLength(1)
      expect(selectors[0]?.enabled).toBe(platform !== 'linux')
      expect(selectors[0]?.click).toBeUndefined()
      const submenu = selectors[0]?.submenu
      expect(submenu).toHaveLength(3)
      expect(submenu?.map(item => item.label)).toEqual(labels)
      expect(menu.some(item => labels.includes(item.label ?? ''))).toBe(false)
      expect(submenu?.filter(item => item.checked)).toHaveLength(1)

      for (const [index, target] of modes.entries()) {
        const item = submenu?.[index]
        expect(item).toEqual(expect.objectContaining({
          type: 'radio', checked: target === mode, enabled: platform !== 'linux',
        }))
        requestModeChange.mockClear()
        item?.click?.()
        if (target === mode || platform === 'linux') {
          expect(requestModeChange).not.toHaveBeenCalled()
        } else {
          await vi.waitFor(() => { expect(requestModeChange).toHaveBeenCalledExactlyOnceWith(target) })
        }
      }
      await release()
    })
  })

  it('rebuilds ordered effect-scoped tray contributions without replacing native commands', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const later = runtime.registerTrayItem({
      group: 'tools',
      order: 20,
      label: () => 'Later Tool',
      invoke: vi.fn(),
    })
    let statusLabel = 'Check for Updates…'
    const status = runtime.registerTrayItem({
      group: 'status',
      order: 10,
      label: () => statusLabel,
      enabled: () => false,
      invoke: vi.fn(),
    })
    const earlier = runtime.registerTrayItem({
      group: 'tools',
      order: 10,
      label: () => 'Earlier Tool',
      invoke: vi.fn(),
    })
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const labels = (electron.menuTemplates.at(-1) as Array<{ label?: string }>).map(item => item.label)
    expect(labels).toEqual([
      'Open DSH Desktop', 'Reload Interface', undefined,
      'Earlier Tool', 'Later Tool', undefined,
      'Check for Updates…', undefined,
      'Mode: Compatibility Mode', undefined,
      'Quit',
    ])
    expect(electron.menuTemplates.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Check for Updates…', enabled: false }),
    ]))

    statusLabel = 'Version 2.1.0 Available'
    status.refresh()
    expect(electron.menuTemplates.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Version 2.1.0 Available', enabled: false }),
    ]))

    earlier.dispose()
    later.dispose()
    status.dispose()
    expect(electron.menuTemplates.at(-1)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Earlier Tool' }),
    ]))

    await release()
  })

  it('renders contributed radio submenus in their own profile section', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const invoke = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.registerTrayItem({
      group: 'profiles',
      order: 10,
      label: () => 'Profile: desktop',
      invoke: () => {},
      submenu: () => [{
        label: () => 'web',
        type: 'radio',
        checked: () => false,
        enabled: () => true,
        invoke,
      }],
    })
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const profile = (electron.menuTemplates.at(-1) as Array<{
      label?: string
      submenu?: Array<{ label?: string, type?: string, checked?: boolean, click?: () => void }>
    }>).find(item => item.label === 'Profile: desktop')
    expect(profile?.submenu).toEqual([
      expect.objectContaining({ label: 'web', type: 'radio', checked: false }),
    ])
    profile?.submenu?.[0]?.click?.()
    await vi.waitFor(() => { expect(invoke).toHaveBeenCalledOnce() })

    const application = (electron.applicationMenuTemplates.at(-1) as Array<{
      label?: string
      submenu?: Array<{ label?: string, submenu?: unknown }>
    }>).find(item => item.label === 'DSH Desktop')
    expect(application?.submenu).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Profile: desktop' }),
    ]))

    await release()
  })

  it('opens the active profile through the packaged terminal adapter', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    Object.defineProperty(process.versions, 'electron', {
      configurable: true,
      value: '43.4.0',
    })
    try {
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const runtime = new ElectronDesktopRuntime(async () => {})
      const userDataPath = electron.app.getPath('userData')
      runtime.configureTerminal({
        profileName: 'desktop',
        profileDir: join(userDataPath, 'profiles', 'desktop'),
        homeDir: userDataPath,
      })

      runtime.openTerminal()

      expect(terminal.open).toHaveBeenCalledWith(expect.objectContaining({
        platform: 'darwin',
        appExecutable: process.execPath,
        electronVersion: '43.4.0',
        profileName: 'desktop',
        productVersion: PRODUCT_VERSION,
        profileDir: expect.stringMatching(/profiles[\\/]+desktop$/u),
        homeDir: expect.stringContaining('dsh-desktop-user-data'),
        spawn: expect.any(Function),
        onLaunchError: expect.any(Function),
      }))
      const terminalOptions = terminal.open.mock.calls[0]?.[0]
      expect(terminalOptions.dshBootstrapPath.endsWith(join('src', 'desktop-cli.js'))).toBe(true)
      expect(terminalOptions.pnpmBinPath.endsWith(join('node_modules', 'pnpm', 'bin', 'pnpm.mjs'))).toBe(true)
      expect(dirname(terminalOptions.stateDir)).toEqual(expect.stringMatching(/[\\/]cli$/u))
      expect(basename(terminalOptions.stateDir)).toMatch(/^[a-f0-9]{64}$/u)
      expect(() => runtime.configureTerminal({
        profileName: 'desktop',
        profileDir: '/other',
        homeDir: '/other',
      })).toThrow('already configured')
    } finally {
      delete (process.versions as { electron?: string }).electron
    }
  })

  it('coalesces concurrent diagnostic exports and reveals the completed archive', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    let finishExport: ((path: string) => void) | undefined
    diagnostics.export.mockReturnValue(new Promise(resolve => { finishExport = resolve }))

    const first = runtime.exportDiagnostics()
    const second = runtime.exportDiagnostics()
    finishExport?.('C:\\Users\\Example\\diagnostics.zip')
    await Promise.all([first, second])

    expect(diagnostics.export).toHaveBeenCalledOnce()
    expect(diagnostics.export).toHaveBeenCalledWith(
      expect.stringContaining('dsh-desktop-user-data'),
      expect.objectContaining({
        appVersion: PRODUCT_VERSION,
        crashDumpsDir: expect.stringMatching(/[\\/]Crashpad$/u),
      }),
    )
    expect(electron.shell.showItemInFolder).toHaveBeenCalledOnce()
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith('C:\\Users\\Example\\diagnostics.zip')
  })

  it('does not export diagnostics when the privacy confirmation is cancelled', async () => {
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})

    await expect(runtime.exportDiagnostics()).resolves.toBeUndefined()

    expect(diagnostics.export).not.toHaveBeenCalled()
    expect(electron.shell.showItemInFolder).not.toHaveBeenCalled()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      cancelId: 1,
      defaultId: 1,
      buttons: ['Export', 'Cancel'],
      detail: expect.stringContaining('local paths, workspace IDs, and session IDs'),
    }))
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('process memory'),
    }))
  })

  it('localizes the diagnostics privacy confirmation', async () => {
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.setLocalePreference('zh')

    await runtime.exportDiagnostics()

    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      buttons: ['导出', '取消'],
      detail: expect.stringContaining('本地路径、工作区 ID 和会话 ID'),
    }))
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('进程内存'),
    }))
  })

  it('shows a native error when diagnostic export fails', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    diagnostics.export
      .mockRejectedValueOnce(new Error('disk is full'))
      .mockResolvedValueOnce('C:\\Users\\Example\\diagnostics-retry.zip')

    await expect(runtime.exportDiagnostics()).resolves.toBeUndefined()
    await expect(runtime.exportDiagnostics()).resolves.toBeUndefined()

    expect(diagnostics.export).toHaveBeenCalledTimes(2)
    expect(electron.shell.showItemInFolder)
      .toHaveBeenCalledWith('C:\\Users\\Example\\diagnostics-retry.zip')
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      title: 'Unable to Export Diagnostics',
      detail: 'disk is full',
    }))
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('failed to export diagnostics: disk is full'))
  })

  it('shows native errors for synchronous and asynchronous terminal launch failures', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    Object.defineProperty(process.versions, 'electron', {
      configurable: true,
      value: '43.4.0',
    })
    try {
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const runtime = new ElectronDesktopRuntime(async () => {})
      runtime.configureTerminal({
        profileName: 'desktop',
        profileDir: 'C:\\Users\\Example\\.dsh\\profiles\\desktop',
        homeDir: 'C:\\Users\\Example\\.dsh',
      })
      terminal.open.mockImplementationOnce(() => { throw new Error('cannot create launcher') })

      expect(() => { runtime.openTerminal() }).not.toThrow()
      await vi.waitFor(() => { expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        title: 'Unable to Open DSH Terminal',
        detail: 'cannot create launcher',
      })) })

      terminal.open.mockImplementationOnce((options: { onLaunchError: (cause: Error) => void }) => {
        options.onLaunchError(new Error('launcher exited with code 1'))
      })
      runtime.openTerminal()
      await vi.waitFor(() => { expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
        type: 'error',
        title: 'Unable to Open DSH Terminal',
        detail: 'launcher exited with code 1',
      })) })
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('failed to open terminal'))
    } finally {
      delete (process.versions as { electron?: string }).electron
    }
  })

  it('shows native recovery when the renderer Loader reports a failed plugin', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)
    const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })
    const report = {
      status: 'failed' as const,
      plugins: ['dsh-vision-router'],
      error: 'keyed slot "tool.call.toolview" already has an entry for key "vision_crop" at priority 0',
    }

    runtime.reportRendererBoot(report)
    await rendererBoot
    await vi.waitFor(() => { expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce() })
    runtime.reportRendererBoot({ status: 'healthy' })

    expect(onRendererBoot).toHaveBeenCalledWith(report)
    expect(onRendererBoot).toHaveBeenCalledOnce()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      title: 'Plugin Load Failed',
      message: 'Some plugins could not be loaded.',
      detail: expect.stringContaining('dsh-vision-router'),
      buttons: ['Open DSH Terminal', 'Restart DSH Desktop', 'Dismiss'],
    }))
    const recoveryCalls = electron.dialog.showMessageBox.mock.calls as unknown as Array<[{ detail?: string }]>
    expect(recoveryCalls[0]?.[0].detail).toContain('vision_crop')
  })

  it('logs the renderer boot failure details for diagnostics', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const logger = { error: vi.fn(), errorCause: vi.fn(), info: vi.fn() }
    const runtime = new ElectronDesktopRuntime(async () => {}, () => {}, logger)
    const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })

    runtime.reportRendererBoot({
      status: 'failed',
      plugins: ['dsh-vision-router'],
      error: 'failed to apply loader entry 07140b35 (dsh-vision-router): keyed slot "settings.plugin.item" requires options.key',
    })
    await rendererBoot

    expect(logger.error).toHaveBeenCalledWith(
      'dsh-plugin-desktop: renderer boot failed (plugins: dsh-vision-router): '
      + 'failed to apply loader entry 07140b35 (dsh-vision-router): keyed slot "settings.plugin.item" requires options.key',
    )
  })

  it('commits a healthy renderer without showing recovery', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)
    const release = runtime.schedule(spec)
    const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })
    await runtime.mountScheduled()

    runtime.reportRendererBoot({ status: 'healthy' })
    await rendererBoot

    expect(onRendererBoot).toHaveBeenCalledWith({ status: 'healthy' })
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    await release()
  })

  it('opens the active profile terminal from plugin recovery', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    Object.defineProperty(process.versions, 'electron', {
      configurable: true,
      value: '43.4.0',
    })
    try {
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const runtime = new ElectronDesktopRuntime(async () => {})
      const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })
      runtime.configureTerminal({
        profileName: 'desktop',
        profileDir: 'C:\\Users\\Example\\.dsh\\profiles\\desktop',
        homeDir: 'C:\\Users\\Example\\.dsh',
      })

      runtime.reportRendererBoot({ status: 'failed', plugins: ['dsh-vision-router'] })
      await rendererBoot
      await vi.waitFor(() => { expect(terminal.open).toHaveBeenCalledOnce() })

      expect(terminal.open).toHaveBeenCalledWith(expect.objectContaining({
        profileName: 'desktop',
        profileDir: 'C:\\Users\\Example\\.dsh\\profiles\\desktop',
      }))
    } finally {
      delete (process.versions as { electron?: string }).electron
    }
  })

  it('requests an orderly restart from plugin recovery', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const restart = vi.fn(async () => {})
    const runtime = new ElectronDesktopRuntime(restart)
    const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })

    runtime.reportRendererBoot({ status: 'failed', plugins: ['dsh-vision-router'] })
    await rendererBoot
    await vi.waitFor(() => { expect(restart).toHaveBeenCalledOnce() })
  })

  it('requires Desktop dialog confirmation before an ordinary restart', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const restart = vi.fn(async (_target?: 'recovery' | 'safe-mode') => {})
    const runtime = new ElectronDesktopRuntime(restart)

    await runtime.requestRestart()

    expect(restart).not.toHaveBeenCalled()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'question', title: 'Restart DSH Desktop', buttons: ['Restart', 'Cancel'], defaultId: 1, cancelId: 1,
    }))

    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    await runtime.requestRestart()
    expect(restart).toHaveBeenCalledOnce()
    expect(restart).toHaveBeenCalledWith(undefined)
  })

  it('requires a distinct confirmation before restarting into recovery mode', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const restart = vi.fn(async (_target?: 'recovery' | 'safe-mode') => {})
    const runtime = new ElectronDesktopRuntime(restart)

    await runtime.requestRecoveryRestart()

    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'question', title: 'Restart in Recovery Mode', buttons: ['Restart in Recovery Mode', 'Cancel'], defaultId: 1, cancelId: 1,
    }))
    expect(restart).toHaveBeenCalledOnce()
    expect(restart).toHaveBeenCalledWith('recovery')
  })

  it.each([
    { platform: 'win32', surface: 'tray' },
    { platform: 'darwin', surface: 'tray' },
    { platform: 'darwin', surface: 'application' },
  ] as const)('enters Safe Mode from the localized $platform $surface menu', async ({ platform, surface }) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const restart = vi.fn(async () => {})
    const runtime = new ElectronDesktopRuntime(restart)
    const registration = runtime.registerTrayItem({
      group: 'tools',
      order: 100,
      label: () => desktopTrayLabel(runtime.locale, 'enterSafeMode'),
      invoke: () => runtime.requestSafeModeRestart(),
    })
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    type MenuCommand = { label?: string, enabled?: boolean, click?: () => void }
    const menuItems = (): MenuCommand[] => surface === 'application'
      ? (electron.applicationMenuTemplates.at(-1)?.[0] as { submenu: MenuCommand[] }).submenu
      : electron.menuTemplates.at(-1) as MenuCommand[]
    expect(menuItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Enter Safe Mode…', enabled: true }),
    ]))

    runtime.setLocalePreference('zh')
    const command = menuItems().find(item => item.label === '进入安全模式…')
    expect(command?.click).toEqual(expect.any(Function))
    command?.click?.()

    await vi.waitFor(() => { expect(restart).toHaveBeenCalledWith('safe-mode') })
    expect(restart).toHaveBeenCalledOnce()
    expect(electron.dialog.showMessageBox.mock.calls.at(-1)?.at(-1)).toMatchObject({
      type: 'question', title: '进入安全模式？', buttons: ['重启到安全模式', '取消'], defaultId: 1, cancelId: 1,
    })

    registration.dispose()
    expect(menuItems()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '进入安全模式…' }),
    ]))
    await release()
  })

  it.each(['tray', 'application'] as const)('exits Safe Mode from the localized macOS %s menu', async surface => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const exitSafeMode = vi.fn(async () => {})
    const registration = runtime.registerTrayItem({
      group: 'status',
      order: -100,
      label: () => desktopTrayLabel(runtime.locale, 'exitSafeMode'),
      invoke: exitSafeMode,
    })
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    type MenuCommand = { label?: string, enabled?: boolean, click?: () => void }
    const menuItems = (): MenuCommand[] => surface === 'application'
      ? (electron.applicationMenuTemplates.at(-1)?.[0] as { submenu: MenuCommand[] }).submenu
      : electron.menuTemplates.at(-1) as MenuCommand[]
    expect(menuItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Exit Safe Mode and Restart…', enabled: true }),
    ]))
    expect(menuItems().some(item => item.label === 'Enter Safe Mode…')).toBe(false)

    runtime.setLocalePreference('zh')
    const command = menuItems().find(item => item.label === '退出安全模式并重启…')
    expect(command?.click).toEqual(expect.any(Function))
    command?.click?.()
    await vi.waitFor(() => { expect(exitSafeMode).toHaveBeenCalledOnce() })

    registration.dispose()
    expect(menuItems().some(item => item.label === '退出安全模式并重启…')).toBe(false)
    await release()
  })

  it('cancels, coalesces, and suppresses Safe Mode restart requests while quitting', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const restart = vi.fn(async () => {})
    const runtime = new ElectronDesktopRuntime(restart)
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await runtime.requestSafeModeRestart()
    expect(restart).not.toHaveBeenCalled()
    expect(electron.dialog.showMessageBox.mock.calls.at(-1)?.at(-1)).toMatchObject({
      title: 'Enter Safe Mode?', buttons: ['Restart in Safe Mode', 'Cancel'], defaultId: 1, cancelId: 1,
    })

    await Promise.all([
      runtime.requestSafeModeRestart(),
      runtime.requestSafeModeRestart(),
      runtime.requestRestart(),
      runtime.requestRecoveryRestart(),
    ])
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(restart).toHaveBeenCalledOnce()
    expect(restart).toHaveBeenCalledWith('safe-mode')

    runtime.prepareToQuit()
    await runtime.requestSafeModeRestart()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(restart).toHaveBeenCalledOnce()
  })

  it('allows retrying Safe Mode after preparation fails', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const restart = vi.fn(async () => {}).mockRejectedValueOnce(new Error('Safe Mode preparation failed'))
    const runtime = new ElectronDesktopRuntime(restart)

    await expect(runtime.requestSafeModeRestart()).rejects.toThrow('Safe Mode preparation failed')
    await runtime.requestSafeModeRestart()

    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(restart).toHaveBeenCalledTimes(2)
    expect(restart).toHaveBeenLastCalledWith('safe-mode')
  })

  it('uses Electron networking and confirmation-gated macOS update handoff', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const response = Response.json({ version: '2.1.0' })
    electron.net.fetch.mockResolvedValueOnce(response)
    updater.download.mockResolvedValueOnce('/tmp/DSH-Desktop-2.1.0-mac.dmg')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()
    const activeWindow = electron.browserWindows[0]

    await expect(runtime.updates.request('https://www.dshdesktop.cn/api/desktop/version', { method: 'GET' }))
      .resolves.toBe(response)
    expect(runtime.updates).toMatchObject({
      isPackaged: false,
      canDownload: false,
      currentVersion: PRODUCT_VERSION,
      statePath: join('/tmp/dsh-desktop-user-data', 'updates', 'state.json'),
    })
    electron.app.isPackaged = true
    expect(runtime.updates).toMatchObject({ isPackaged: true, canDownload: true })

    await runtime.updates.showManualCheckResult({
      status: 'up-to-date',
      currentVersion: '2.0.0',
      latestVersion: '2.0.0',
    })
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(
      activeWindow,
      expect.objectContaining({
        title: 'DSH Desktop Is Up to Date',
        detail: 'Installed version: 2.0.0',
        buttons: ['OK'],
      }),
    )

    await runtime.updates.showManualCheckResult(null)
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(
      activeWindow,
      expect.objectContaining({
        title: 'Unable to Check for Updates',
        buttons: ['OK'],
      }),
    )

    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await expect(runtime.updates.confirmDownload('2.1.0')).resolves.toBe(false)
    expect(updater.download).not.toHaveBeenCalled()

    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    await expect(runtime.updates.confirmDownload('2.1.0')).resolves.toBe(true)
    const controller = new AbortController()
    electron.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/tmp/Downloads/DSH-Desktop-2.1.0-mac.dmg',
    })
    await runtime.updates.downloadAndOpen('2.1.0', controller.signal)
    expect(electron.dialog.showSaveDialog).toHaveBeenCalledWith(
      activeWindow,
      expect.objectContaining({
        defaultPath: join('/tmp/Downloads', 'DSH-Desktop-2.1.0-mac.dmg'),
        filters: [{ name: 'Disk Image', extensions: ['dmg'] }],
      }),
    )
    expect(updater.download).toHaveBeenCalledWith({
      platform: 'darwin',
      version: '2.1.0',
      destinationPath: '/tmp/Downloads/DSH-Desktop-2.1.0-mac.dmg',
      request: expect.any(Function),
      signal: controller.signal,
    })
    expect(electron.shell.openPath).toHaveBeenCalledWith('/tmp/DSH-Desktop-2.1.0-mac.dmg')
    expect(updater.record).toHaveBeenCalledWith('/tmp/dsh-desktop-user-data', {
      platform: 'darwin',
      version: '2.1.0',
      path: '/tmp/DSH-Desktop-2.1.0-mac.dmg',
    })
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(
      activeWindow,
      expect.objectContaining({
        title: 'DSH Desktop Update Downloaded',
        buttons: ['OK'],
      }),
    )

    runtime.updates.notify({
      title: 'Profile Recovered',
      body: 'Reopened the last-known-good profile.',
    })
    const notification = electron.notifications[0]
    expect(notification?.options).toEqual({
      title: 'Profile Recovered',
      body: 'Reopened the last-known-good profile.',
    })
    expect(notification?.show).toHaveBeenCalledOnce()
    expect(notification?.once).toHaveBeenCalledWith('click', expect.any(Function))
    const click = notification?.once.mock.calls.find(([event]) => event === 'click')?.[1]
    click()
    expect(activeWindow?.show).toHaveBeenCalledTimes(2)
    expect(activeWindow?.focus).toHaveBeenCalledTimes(2)

    await release()
  })

  it('starts the downloaded Windows installer visibly before requesting orderly exit', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    updater.download.mockResolvedValueOnce('C:\\Updates\\DSH-Desktop-2.1.0-windows.exe')
    const requestQuit = vi.fn()
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.schedule({ ...spec, requestQuit })
    electron.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:\\Updates\\DSH-Desktop-2.1.0-windows.exe',
    })

    const pending = runtime.updates.downloadAndOpen('2.1.0', new AbortController().signal)
    await vi.waitFor(() => { expect(childProcess.spawn).toHaveBeenCalledOnce() })
    expect(childProcess.spawn).toHaveBeenCalledWith(
      'C:\\Updates\\DSH-Desktop-2.1.0-windows.exe',
      ['--updated', '--force-run'],
      {
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: false,
      },
    )
    expect(requestQuit).not.toHaveBeenCalled()
    childProcess.emit('spawn')
    await pending

    expect(childProcess.child.unref).toHaveBeenCalledOnce()
    expect(updater.record).toHaveBeenCalledWith('/tmp/dsh-desktop-user-data', {
      platform: 'win32',
      version: '2.1.0',
      path: 'C:\\Updates\\DSH-Desktop-2.1.0-windows.exe',
    })
    expect(requestQuit).toHaveBeenCalledWith(0)
  })

  it('does not exit when the downloaded Windows installer fails to spawn', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    updater.download.mockResolvedValueOnce('C:\\Updates\\DSH-Desktop-2.1.0-windows.exe')
    const requestQuit = vi.fn()
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.schedule({ ...spec, requestQuit })
    electron.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:\\Updates\\DSH-Desktop-2.1.0-windows.exe',
    })

    const pending = runtime.updates.downloadAndOpen('2.1.0', new AbortController().signal)
    await vi.waitFor(() => { expect(childProcess.spawn).toHaveBeenCalledOnce() })
    childProcess.emit('error', new Error('blocked'))

    await expect(pending).rejects.toThrow('blocked')
    expect(updater.record).toHaveBeenCalledWith('/tmp/dsh-desktop-user-data', {
      platform: 'win32',
      version: '2.1.0',
      path: 'C:\\Updates\\DSH-Desktop-2.1.0-windows.exe',
    })
    expect(updater.resolve).not.toHaveBeenCalled()
    expect(childProcess.child.unref).not.toHaveBeenCalled()
    expect(requestQuit).not.toHaveBeenCalled()
  })

  it('keeps a downloaded Windows installer idle when installation is deferred', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    updater.download.mockResolvedValueOnce('C:\\Updates\\DSH-Desktop-2.1.0-windows.exe')
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    electron.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:\\Updates\\DSH-Desktop-2.1.0-windows.exe',
    })

    await runtime.updates.downloadAndOpen('2.1.0', new AbortController().signal)

    expect(childProcess.spawn).not.toHaveBeenCalled()
    expect(updater.record).toHaveBeenCalledOnce()
  })

  it('continues the update handoff when cleanup tracking cannot be persisted', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    updater.download.mockResolvedValueOnce('C:\\Updates\\DSH-Desktop-2.1.0-windows.exe')
    updater.record.mockRejectedValueOnce(new Error('read-only user data'))
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    electron.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:\\Updates\\DSH-Desktop-2.1.0-windows.exe',
    })
    const logger = { error: vi.fn(), errorCause: vi.fn(), info: vi.fn() }
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {}, undefined, logger)

    await expect(runtime.updates.downloadAndOpen('2.1.0', new AbortController().signal))
      .resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith(
      'dsh-plugin-desktop: failed to remember update installer for cleanup: read-only user data',
    )
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })

  it('does not download when the update destination picker is cancelled', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})

    await runtime.updates.downloadAndOpen('2.1.0', new AbortController().signal)

    expect(electron.dialog.showSaveDialog).toHaveBeenCalledOnce()
    expect(updater.download).not.toHaveBeenCalled()
  })

  it.each([
    [0, true],
    [1, false],
  ])('resolves the post-install artifact choice response=%s remove=%s', async (response, remove) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const artifact = {
      platform: 'win32' as const,
      version: '2.0.1',
      path: 'C:\\Updates\\DSH-Desktop-2.0.1-windows.exe',
    }
    updater.pending.mockResolvedValueOnce(artifact)
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.schedule(spec)

    await runtime.mountScheduled()
    await vi.waitFor(() => { expect(updater.resolve).toHaveBeenCalledOnce() })

    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(
      electron.browserWindows[0],
      expect.objectContaining({
        title: 'Remove Update Installer',
        detail: expect.stringContaining(artifact.path),
        buttons: ['Delete Installer', 'Keep Installer'],
      }),
    )
    expect(updater.resolve).toHaveBeenCalledWith('/tmp/dsh-desktop-user-data', artifact, remove)
  })

  it('rejects a macOS handoff when the operating system cannot open the DMG', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    updater.download.mockResolvedValueOnce('/tmp/DSH-Desktop-2.1.0-mac.dmg')
    electron.shell.openPath.mockResolvedValueOnce('Launch Services rejected the image')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    electron.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/tmp/DSH-Desktop-2.1.0-mac.dmg',
    })

    await expect(runtime.updates.downloadAndOpen('2.1.0', new AbortController().signal))
      .rejects.toThrow('Launch Services rejected the image')
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('does not show macOS completion after the update generation is cancelled', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    updater.download.mockResolvedValueOnce('/tmp/DSH-Desktop-2.1.0-mac.dmg')
    let finishOpen!: (result: string) => void
    electron.shell.openPath.mockImplementationOnce(async () => new Promise<string>(resolve => {
      finishOpen = resolve
    }))
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const controller = new AbortController()
    electron.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/tmp/DSH-Desktop-2.1.0-mac.dmg',
    })

    const pending = runtime.updates.downloadAndOpen('2.1.0', controller.signal)
    await vi.waitFor(() => { expect(electron.shell.openPath).toHaveBeenCalledOnce() })
    controller.abort()
    finishOpen('')

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('uses advanced macOS material options and offers compatibility mode', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.nativeTheme.themeSource = 'light'
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const readThemeSource = vi.fn(() => 'dark' as const)
    const release = runtime.schedule({
      ...spec,
      mode: 'advanced',
      material: 'transparent',
      readThemeSource,
    })

    runtime.setThemeSource('system')
    expect(electron.nativeTheme.themeSource).toBe('light')
    await runtime.mountScheduled()

    expect(readThemeSource).toHaveBeenCalledOnce()
    expect(electron.browserWindowThemeSources).toEqual(['dark'])
    expect(electron.contentViews).toHaveLength(0)
    expect(electron.nativeTheme.themeSource).toBe('dark')
    expect(electron.browserWindowOptions[0]).toEqual(expect.objectContaining({
      titleBarStyle: 'hiddenInset',
      transparent: true,
      vibrancy: 'sidebar',
    }))
    expect(electron.menuTemplates[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Mode: Enhanced Mode', enabled: true }),
    ]))

    runtime.setThemeSource('system')
    expect(electron.nativeTheme.themeSource).toBe('system')
    await release()
    expect(electron.nativeTheme.themeSource).toBe('light')
    runtime.setThemeSource('dark')
    expect(electron.nativeTheme.themeSource).toBe('light')
  })

  it('keeps an extended Windows window opaque', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.nativeTheme.themeSource = 'light'
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule({
      ...spec,
      mode: 'extended',
      material: 'off',
      readThemeSource: () => 'dark',
    })

    await runtime.mountScheduled()

    expect(electron.browserWindowOptions[0]).toEqual(expect.objectContaining({
      backgroundColor: '#202124',
      titleBarOverlay: expect.objectContaining({ height: DESKTOP_FRAME_HEIGHT }),
    }))
    expect(electron.contentViews).toHaveLength(2)
    expect(electron.browserWindowOptions[0]).not.toHaveProperty('transparent')
    expect(electron.browserWindowOptions[0]).not.toHaveProperty('backgroundMaterial')
    expect(electron.menuTemplates[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Mode: Extended Window', enabled: true }),
    ]))

    await release()
  })

  it('never installs a native backdrop on Windows, even after a live theme change', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.nativeTheme.themeSource = 'light'
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule({
      ...spec,
      mode: 'extended',
      material: 'off',
      readThemeSource: () => 'dark',
    })

    await runtime.mountScheduled()

    expect(electron.browserWindowOptions[0]).toEqual(expect.objectContaining({
      backgroundColor: '#202124',
      roundedCorners: true,
      thickFrame: true,
    }))
    expect(electron.browserWindowOptions[0]).not.toHaveProperty('transparent')
    const window = electron.browserWindows[0]
    window?.setBackgroundMaterial.mockClear()
    runtime.setThemeSource('light')
    expect(window?.setBackgroundMaterial).not.toHaveBeenCalled()

    await release()
  })

  it('restores the preceding native appearance when advanced loading fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.nativeTheme.themeSource = 'light'
    electron.loadURL.mockRejectedValueOnce(new Error('renderer unavailable'))
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule({
      ...spec,
      mode: 'advanced',
      material: 'transparent',
      readThemeSource: () => 'dark',
    })
    const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })

    await expect(Promise.all([
      runtime.mountScheduled(),
      rendererBoot,
    ])).rejects.toThrow('renderer unavailable')
    expect(electron.nativeTheme.themeSource).toBe('dark')
    expect(electron.webRequest.onBeforeSendHeaders).toHaveBeenLastCalledWith(null)
    await expect(release()).rejects.toThrow('renderer unavailable')
    expect(electron.nativeTheme.themeSource).toBe('light')
  })
})
