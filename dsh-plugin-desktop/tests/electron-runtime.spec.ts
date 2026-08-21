import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopShellSpec } from '../src/runtime.ts'

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
  const applicationMenuTemplates: unknown[][] = []
  const menuTemplates: unknown[][] = []
  const notifications: Notification[] = []
  let zoomLevel = 0
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
    executeJavaScript: vi.fn(async (_code: string, _userGesture?: boolean) => null as string | null),
    getZoomLevel: vi.fn(() => zoomLevel),
    on: vi.fn(),
    off: vi.fn(),
    setZoomLevel: vi.fn((level: number) => { zoomLevel = level }),
    setWindowOpenHandler: vi.fn(),
  }
  const nativeTheme = { themeSource: 'system' }

  class BrowserWindow {
    readonly webContents = webContents
    accessibleTitle = ''

    constructor(options: unknown) {
      browserWindowOptions.push(options)
      browserWindowThemeSources.push(nativeTheme.themeSource)
      browserWindows.push(this)
    }

    readonly isDestroyed = vi.fn(() => false)
    readonly isFocused = vi.fn(() => false)
    readonly isVisible = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly flashFrame = vi.fn()
    readonly restore = vi.fn()
    readonly show = vi.fn()
    readonly hide = vi.fn()
    readonly focus = vi.fn()
    readonly on = browserWindowOn
    readonly off = browserWindowOff
    readonly once = vi.fn()
    readonly destroy = vi.fn()
    readonly loadURL = loadURL
    readonly removeMenu = vi.fn()
    readonly setBackgroundMaterial = vi.fn()
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
    browserWindowOptions,
    browserWindowThemeSources,
    browserWindows,
    browserWindowOff,
    browserWindowOn,
    loadURL,
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
    shell: {
      openExternal: vi.fn(async () => {}),
      openPath: vi.fn(async () => ''),
      showItemInFolder: vi.fn(),
    },
    templateIcon,
    Tray,
    trays,
    webContents,
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  dialog: electron.dialog,
  Menu: electron.Menu,
  nativeImage: electron.nativeImage,
  nativeTheme: electron.nativeTheme,
  net: electron.net,
  Notification: electron.Notification,
  shell: electron.shell,
  Tray: electron.Tray,
}))

const spec: DesktopShellSpec = {
  mode: 'compatibility',
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
  url: 'http://127.0.0.1:43120/',
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
    electron.app.isPackaged = false
    electron.browserWindowOptions.length = 0
    electron.browserWindowThemeSources.length = 0
    electron.browserWindows.length = 0
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
    electron.app.getPreferredSystemLanguages.mockReturnValue(['en-US'])
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    electron.shell.openPath.mockResolvedValue('')
    electron.nativeTheme.themeSource = 'system'
    electron.resetZoomLevel()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses the native macOS frame, Dock icon, and template tray image', async () => {
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
      webPreferences: {
        preload: expect.stringMatching(/preload\.cjs$/),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    }))
    expect(options).not.toHaveProperty('autoHideMenuBar')
    for (const option of [
      'frame',
      'titleBarStyle',
      'titleBarOverlay',
      'trafficLightPosition',
      'transparent',
      'vibrancy',
      'visualEffectState',
      'backgroundMaterial',
      'roundedCorners',
      'thickFrame',
    ]) {
      expect(options).not.toHaveProperty(option)
    }
    expect(electron.browserWindows[0]?.accessibleTitle).toBe('DeepSeek Harness Desktop')
    expect(spec.readThemeSource).not.toHaveBeenCalled()
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
      expect.objectContaining({ label: 'Switch to Advanced Mode', enabled: true }),
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
    expect(runtime.updates.canDownload).toBe(false)
    await expect(runtime.pickDirectory()).rejects.toThrow('native workspace picker is unavailable on linux')
    expect(electron.app.dock.setIcon).not.toHaveBeenCalled()
    expect(electron.Menu.setApplicationMenu).not.toHaveBeenCalled()
    expect(electron.browserWindows[0]?.removeMenu).not.toHaveBeenCalled()
    expect(electron.menuTemplates[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Switch to Advanced Mode', enabled: false }),
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

  it('blocks unsupported workspace volumes without returning a risky path', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const query = vi.fn(() => ({ root: 'E:\\', fileSystem: 'EXFAT', driveType: 2 }))
    const logger = { error: vi.fn(), errorCause: vi.fn() }
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
    const logger = { error: vi.fn(), errorCause: vi.fn() }
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

  it('logs renderer crashes with the Windows exception code', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const logger = { error: vi.fn(), errorCause: vi.fn() }
    const runtime = new ElectronDesktopRuntime(async () => {}, undefined, logger)
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const gone = electron.browserWindows[0]?.webContents.on.mock.calls
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
    const logger = { error: vi.fn(), errorCause: vi.fn() }
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot, logger)
    const release = runtime.schedule(spec)
    const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })
    await runtime.mountScheduled()

    const gone = electron.browserWindows[0]?.webContents.on.mock.calls
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

    const failed = electron.browserWindows[0]?.webContents.on.mock.calls
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
    const gone = electron.browserWindows[0]?.webContents.on.mock.calls
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

    const gone = electron.browserWindows[0]?.webContents.on.mock.calls
      .find(([event]) => event === 'render-process-gone')?.[1]
    gone({}, { reason: 'crashed', exitCode: 9 })

    expect(onRendererBoot).toHaveBeenCalledOnce()
    expect(onRendererBoot).toHaveBeenCalledWith({ status: 'healthy' })
    expect(runtime.rendererBootFailureReason).toBeUndefined()
    await release()
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
        '切换到高级模式',
        '退出',
      ]))

    runtime.setLocalePreference('en')
    expect(runtime.locale).toBe('en')
    expect((electron.menuTemplates.at(-1) as Array<{ label?: string }>).map(item => item.label))
      .toEqual(expect.arrayContaining([
        'Open DSH Desktop',
        'Switch to Advanced Mode',
        'Quit',
      ]))

    electron.app.getLocale.mockReturnValueOnce('zh-CN')
    runtime.setLocalePreference(undefined)
    expect(runtime.locale).toBe('zh')
    expect((electron.menuTemplates.at(-1) as Array<{ label?: string }>).map(item => item.label))
      .toEqual(expect.arrayContaining([
        '打开 DSH Desktop',
        '切换到高级模式',
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

    const navigate = electron.browserWindows[0]?.webContents.on.mock.calls
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
    const logger = { error: vi.fn(), errorCause: vi.fn() }
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

    window?.isMinimized.mockReturnValueOnce(true)
    ready()
    activate()
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
    expect(window?.show).toHaveBeenCalledOnce()
    expect(window?.focus).toHaveBeenCalledOnce()

    window?.isFocused.mockReturnValue(true)
    runtime.notifyAttention({ title: 'Ignored', body: 'Focused window' })
    expect(electron.notifications).toHaveLength(2)

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
    didBecomeActive()
    expect(electron.app.show).toHaveBeenCalledOnce()
    expect(electron.app.show.mock.invocationCallOrder[0]).toBeLessThan(window?.show.mock.invocationCallOrder[0] ?? Infinity)
    expect(window?.focus).toHaveBeenCalledOnce()

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

  it('persists the opposite mode when its tray command is clicked', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const requestModeChange = vi.fn(async () => {})
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule({ ...spec, requestModeChange })

    await runtime.mountScheduled()
    const item = (electron.menuTemplates[0] as Array<{ label?: string, click?: () => void }>)
      .find(candidate => candidate.label === 'Switch to Advanced Mode')
    expect(item).toBeDefined()
    item?.click?.()
    await vi.waitFor(() => { expect(requestModeChange).toHaveBeenCalledWith('advanced') })

    await release()
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
      'Open DSH Desktop', undefined,
      'Earlier Tool', 'Later Tool', undefined,
      'Check for Updates…', undefined,
      'Switch to Advanced Mode', undefined,
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
        productVersion: '2.0.2',
        profileDir: expect.stringMatching(/profiles[\\/]+desktop$/u),
        homeDir: expect.stringContaining('dsh-desktop-user-data'),
        installRecoveryStatePath: expect.stringMatching(/[\\/]plugin-install-recovery[\\/]state\.json$/u),
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
        appVersion: '2.0.2',
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
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Unable to Export Diagnostics',
      'disk is full',
    )
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
      expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
        'Unable to Open DSH Terminal',
        'cannot create launcher',
      )

      terminal.open.mockImplementationOnce((options: { onLaunchError: (cause: Error) => void }) => {
        options.onLaunchError(new Error('launcher exited with code 1'))
      })
      runtime.openTerminal()
      expect(electron.dialog.showErrorBox).toHaveBeenLastCalledWith(
        'Unable to Open DSH Terminal',
        'launcher exited with code 1',
      )
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
      title: 'Plugin Recovery',
      message: 'DSH Desktop could not load all plugins.',
      detail: expect.stringContaining('dsh-vision-router'),
      buttons: ['Open DSH Terminal', 'Restart DSH Desktop', 'Dismiss'],
    }))
    const recoveryCalls = electron.dialog.showMessageBox.mock.calls as unknown as Array<[{ detail?: string }]>
    expect(recoveryCalls[0]?.[0].detail).toContain('vision_crop')
  })

  it('logs the renderer boot failure details for diagnostics', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const logger = { error: vi.fn(), errorCause: vi.fn() }
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

  it('uses Electron networking and confirmation-gated macOS update handoff', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const response = Response.json({ version: '2.1.0' })
    electron.net.fetch.mockResolvedValueOnce(response)
    updater.download.mockResolvedValueOnce('/tmp/DSH-Desktop-2.1.0-mac.dmg')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})

    await expect(runtime.updates.request('https://www.dshdesktop.cn/api/desktop/version', { method: 'GET' }))
      .resolves.toBe(response)
    expect(runtime.updates).toMatchObject({
      isPackaged: false,
      canDownload: false,
      currentVersion: '2.0.2',
      statePath: join('/tmp/dsh-desktop-user-data', 'updates', 'state.json'),
    })
    electron.app.isPackaged = true
    expect(runtime.updates).toMatchObject({ isPackaged: true, canDownload: true })

    await runtime.updates.showManualCheckResult({
      status: 'up-to-date',
      currentVersion: '2.0.0',
      latestVersion: '2.0.0',
    })
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'DSH Desktop Is Up to Date',
      detail: 'Installed version: 2.0.0',
      buttons: ['OK'],
    }))

    await runtime.updates.showManualCheckResult(null)
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Unable to Check for Updates',
      buttons: ['OK'],
    }))

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
    expect(electron.dialog.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: join('/tmp/Downloads', 'DSH-Desktop-2.1.0-mac.dmg'),
      filters: [{ name: 'Disk Image', extensions: ['dmg'] }],
    }))
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
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'DSH Desktop Update Downloaded',
      buttons: ['OK'],
    }))

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
    expect(notification?.once).not.toHaveBeenCalled()
  })

  it('starts the downloaded Windows installer before requesting orderly exit', async () => {
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
    const logger = { error: vi.fn(), errorCause: vi.fn() }
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

    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Remove Update Installer',
      detail: expect.stringContaining(artifact.path),
      buttons: ['Delete Installer', 'Keep Installer'],
    }))
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
    const release = runtime.schedule({ ...spec, mode: 'advanced', readThemeSource })

    runtime.setThemeSource('system')
    expect(electron.nativeTheme.themeSource).toBe('light')
    await runtime.mountScheduled()

    expect(readThemeSource).toHaveBeenCalledOnce()
    expect(electron.browserWindowThemeSources).toEqual(['dark'])
    expect(electron.nativeTheme.themeSource).toBe('dark')
    expect(electron.browserWindowOptions[0]).toEqual(expect.objectContaining({
      titleBarStyle: 'hiddenInset',
      transparent: true,
      vibrancy: 'sidebar',
    }))
    expect(electron.menuTemplates[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Switch to Compatibility Mode', enabled: true }),
    ]))

    runtime.setThemeSource('system')
    expect(electron.nativeTheme.themeSource).toBe('system')
    await release()
    expect(electron.nativeTheme.themeSource).toBe('light')
    runtime.setThemeSource('dark')
    expect(electron.nativeTheme.themeSource).toBe('light')
  })

  it('refreshes the Windows Mica backdrop after a live advanced theme change', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.nativeTheme.themeSource = 'light'
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule({
      ...spec,
      mode: 'advanced',
      readThemeSource: () => 'light',
    })

    runtime.setThemeSource('dark')
    expect(electron.nativeTheme.themeSource).toBe('light')
    await runtime.mountScheduled()

    const window = electron.browserWindows[0]
    runtime.setThemeSource('dark')

    expect(electron.nativeTheme.themeSource).toBe('dark')
    expect(window?.setBackgroundMaterial).toHaveBeenCalledOnce()
    expect(window?.setBackgroundMaterial).toHaveBeenCalledWith('mica')

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
      readThemeSource: () => 'dark',
    })
    const rendererBoot = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })

    await expect(Promise.all([
      runtime.mountScheduled(),
      rendererBoot,
    ])).rejects.toThrow('renderer unavailable')
    expect(electron.nativeTheme.themeSource).toBe('dark')
    await expect(release()).rejects.toThrow('renderer unavailable')
    expect(electron.nativeTheme.themeSource).toBe('light')
  })
})
