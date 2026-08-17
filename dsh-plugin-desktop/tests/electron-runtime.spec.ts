import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopShellSpec } from '../src/runtime.ts'

const terminal = vi.hoisted(() => ({ open: vi.fn() }))
const updater = vi.hoisted(() => ({ download: vi.fn() }))
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

vi.mock('../src/update-download.ts', () => ({
  downloadDesktopUpdate: updater.download,
}))

vi.mock('node:child_process', () => ({ spawn: childProcess.spawn }))

const electron = vi.hoisted(() => {
  const browserWindowOptions: unknown[] = []
  const browserWindowThemeSources: string[] = []
  const browserWindows: BrowserWindow[] = []
  const browserWindowOn = vi.fn()
  const browserWindowOff = vi.fn()
  const loadURL = vi.fn(async (_url: string) => {})
  const menuTemplates: unknown[][] = []
  const notifications: Notification[] = []
  const dialog = {
    showErrorBox: vi.fn(),
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
    on: vi.fn(),
    off: vi.fn(),
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
    readonly isMinimized = vi.fn(() => false)
    readonly restore = vi.fn()
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly on = browserWindowOn
    readonly off = browserWindowOff
    readonly once = vi.fn()
    readonly destroy = vi.fn()
    readonly loadURL = loadURL
    readonly removeMenu = vi.fn()
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
      getPath: vi.fn(() => '/tmp/dsh-desktop-user-data'),
      getVersion: vi.fn(() => '43.4.0'),
      isPackaged: false,
      on: vi.fn(),
      off: vi.fn(),
    },
    appIcon,
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
        menuTemplates.push(template)
        return {}
      }),
    },
    menuTemplates,
    nativeImage: { createFromPath },
    nativeTheme,
    net: { fetch: vi.fn() },
    Notification,
    notifications,
    shell: {
      openExternal: vi.fn(async () => {}),
      openPath: vi.fn(async () => ''),
    },
    templateIcon,
    Tray,
    trays,
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
  readThemeSource: vi.fn(() => 'system' as const),
  requestQuit: () => {},
  requestModeChange: vi.fn(async () => {}),
}

describe('Electron compatibility runtime', () => {
  beforeEach(() => {
    electron.app.isPackaged = false
    electron.browserWindowOptions.length = 0
    electron.browserWindowThemeSources.length = 0
    electron.browserWindows.length = 0
    electron.trays.length = 0
    electron.menuTemplates.length = 0
    electron.notifications.length = 0
    childProcess.reset()
    vi.clearAllMocks()
    updater.download.mockReset()
    electron.loadURL.mockReset()
    electron.loadURL.mockResolvedValue(undefined)
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    electron.shell.openPath.mockResolvedValue('')
    electron.nativeTheme.themeSource = 'system'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the native macOS frame, Dock icon, and template tray image', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
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
    expect(electron.trays[0]?.image).toBe(electron.blueIcon)
    expect(electron.templateIcon.setTemplateImage).not.toHaveBeenCalled()

    await release()
    expect(electron.trays[0]?.off).toHaveBeenCalledWith('click', expect.any(Function))
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
      runtime.configureTerminal({
        profileName: 'desktop',
        profileDir: '/tmp/dsh-home/profiles/desktop',
        homeDir: '/tmp/dsh-home',
      })

      runtime.openTerminal()

      expect(terminal.open).toHaveBeenCalledWith(expect.objectContaining({
        platform: 'darwin',
        appExecutable: process.execPath,
        electronVersion: '43.4.0',
        profileName: 'desktop',
        productVersion: '2.0.1',
        profileDir: '/tmp/dsh-home/profiles/desktop',
        homeDir: '/tmp/dsh-home',
        spawn: expect.any(Function),
        onLaunchError: expect.any(Function),
      }))
      const terminalOptions = terminal.open.mock.calls[0]?.[0]
      expect(terminalOptions.dshBootstrapPath.endsWith(join('src', 'desktop-cli.js'))).toBe(true)
      expect(terminalOptions.pnpmBinPath.endsWith(join('node_modules', 'pnpm', 'bin', 'pnpm.mjs'))).toBe(true)
      expect(dirname(terminalOptions.stateDir)).toBe(join('/tmp/dsh-desktop-user-data', 'cli'))
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
    const report = {
      status: 'failed' as const,
      plugins: ['dsh-vision-router'],
      error: 'keyed slot "tool.call.toolview" already has an entry for key "vision_crop" at priority 0',
    }

    runtime.reportRendererBoot(report)
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

  it('commits a healthy renderer without showing recovery', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)

    runtime.reportRendererBoot({ status: 'healthy' })

    expect(onRendererBoot).toHaveBeenCalledWith({ status: 'healthy' })
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
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
      runtime.configureTerminal({
        profileName: 'desktop',
        profileDir: 'C:\\Users\\Example\\.dsh\\profiles\\desktop',
        homeDir: 'C:\\Users\\Example\\.dsh',
      })

      runtime.reportRendererBoot({ status: 'failed', plugins: ['dsh-vision-router'] })
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

    runtime.reportRendererBoot({ status: 'failed', plugins: ['dsh-vision-router'] })
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
      currentVersion: '2.0.1',
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
    await runtime.updates.downloadAndOpen('2.1.0', controller.signal)
    expect(updater.download).toHaveBeenCalledWith({
      platform: 'darwin',
      version: '2.1.0',
      userDataPath: '/tmp/dsh-desktop-user-data',
      request: expect.any(Function),
      signal: controller.signal,
    })
    expect(electron.shell.openPath).toHaveBeenCalledWith('/tmp/DSH-Desktop-2.1.0-mac.dmg')
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
    expect(requestQuit).toHaveBeenCalledWith(0)
  })

  it('does not exit when the downloaded Windows installer fails to spawn', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    updater.download.mockResolvedValueOnce('C:\\Updates\\DSH-Desktop-2.1.0-windows.exe')
    const requestQuit = vi.fn()
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.schedule({ ...spec, requestQuit })

    const pending = runtime.updates.downloadAndOpen('2.1.0', new AbortController().signal)
    await vi.waitFor(() => { expect(childProcess.spawn).toHaveBeenCalledOnce() })
    childProcess.emit('error', new Error('blocked'))

    await expect(pending).rejects.toThrow('blocked')
    expect(childProcess.child.unref).not.toHaveBeenCalled()
    expect(requestQuit).not.toHaveBeenCalled()
  })

  it('keeps a downloaded Windows installer idle when installation is deferred', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    updater.download.mockResolvedValueOnce('C:\\Updates\\DSH-Desktop-2.1.0-windows.exe')
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})

    await runtime.updates.downloadAndOpen('2.1.0', new AbortController().signal)

    expect(childProcess.spawn).not.toHaveBeenCalled()
  })

  it('rejects a macOS handoff when the operating system cannot open the DMG', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    updater.download.mockResolvedValueOnce('/tmp/DSH-Desktop-2.1.0-mac.dmg')
    electron.shell.openPath.mockResolvedValueOnce('Launch Services rejected the image')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})

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

    await expect(runtime.mountScheduled()).rejects.toThrow('renderer unavailable')
    expect(electron.nativeTheme.themeSource).toBe('dark')
    await expect(release()).rejects.toThrow('renderer unavailable')
    expect(electron.nativeTheme.themeSource).toBe('light')
  })
})
