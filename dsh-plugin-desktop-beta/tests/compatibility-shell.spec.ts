import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COMPATIBILITY_CHROME_CHANNEL } from '../src/compatibility-chrome-contract.ts'
import { CompatibilityShell, type CompatibilityShellActions } from '../src/compatibility-shell.ts'
import type { DesktopShellSpec } from '../src/runtime.ts'

const electron = vi.hoisted(() => ({
  content: {
    close: vi.fn(), focus: vi.fn(), isDestroyed: vi.fn(() => false), invalidate: vi.fn(),
  },
  chrome: null as unknown as {
    on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; ipc: { handle: ReturnType<typeof vi.fn>; removeHandler: ReturnType<typeof vi.fn> };
    mainFrame: { url: string }; isDestroyed: ReturnType<typeof vi.fn>; setWindowOpenHandler: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; loadFile: ReturnType<typeof vi.fn>;
    invalidate: ReturnType<typeof vi.fn>;
  },
}))
vi.mock('electron', () => ({
  WebContentsView: class {
    readonly webContents: typeof electron.content | typeof electron.chrome
    readonly setBounds = vi.fn()
    readonly setBackgroundColor = vi.fn()
    constructor(readonly options: { webPreferences: { partition: string } }) {
      this.webContents = options.webPreferences.partition === 'dsh-desktop-compatibility-chrome' ? electron.chrome : electron.content
    }
  },
}))

function fixture(platform: 'darwin' | 'win32' = 'darwin', mode: 'compatibility' | 'extended' = 'compatibility', material: DesktopShellSpec['material'] = 'off') {
  const ipc = { handle: vi.fn(), removeHandler: vi.fn() }
  const webContents = Object.assign(new EventEmitter(), {
    ipc,
    mainFrame: { url: '' },
    isDestroyed: vi.fn(() => false),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    invalidate: vi.fn(),
    loadFile: vi.fn(async (path: string) => { webContents.mainFrame.url = pathToFileURL(path).href }),
  })
  electron.chrome = webContents as unknown as typeof electron.chrome
  const window = Object.assign(new EventEmitter(), {
    webContents,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentSize: vi.fn(() => [1280, 840]),
    isMinimized: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    loadFile: vi.fn(async (path: string) => { webContents.mainFrame.url = pathToFileURL(path).href }),
  })
  const actions: CompatibilityShellActions = {
    locale: () => 'en', version: '2.0.3',
    openTerminal: vi.fn(), restart: vi.fn(async () => {}), restartToRecovery: vi.fn(async () => {}),
    reload: vi.fn(), developerTools: vi.fn(),
    checkForUpdates: vi.fn(async () => {}),
    exportDiagnostics: vi.fn(async () => {}),
  }
  const spec = { mode, material, requestModeChange: vi.fn(async () => {}) } as unknown as DesktopShellSpec
  const shell = new CompatibilityShell(window as unknown as BrowserWindow, spec, platform, '/desktop/preload.cjs', actions)
  const handler = ipc.handle.mock.calls[0]?.[1] as (event: unknown, command: unknown) => unknown
  const event = () => ({ sender: webContents, senderFrame: webContents.mainFrame })
  return { shell, window, webContents, ipc, handler, event, actions, spec }
}

describe('isolated compatibility shell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['darwin', 'extended', 'transparent', true],
    ['win32', 'extended', 'off', false],
    ['darwin', 'extended', 'off', false],
    ['darwin', 'compatibility', 'transparent', false],
  ] as const)('preserves the content material boundary for %s %s %s', (platform, mode, material, transparent) => {
    const { shell } = fixture(platform, mode, material)
    if (transparent) expect(shell.content.setBackgroundColor).toHaveBeenCalledExactlyOnceWith('#00000000')
    else expect(shell.content.setBackgroundColor).not.toHaveBeenCalled()
    shell.dispose()
  })

  it.each(['compatibility', 'extended'] as const)('isolates %s chrome with native bounds outside the content document', async mode => {
    const { shell, window, webContents, handler, event } = fixture('darwin', mode)
    await shell.load()
    expect(handler(event(), 'state')).toMatchObject({ mode })
    expect(webContents.loadFile).toHaveBeenCalledWith(expect.stringMatching(/native-ui\/compatibility-chrome\.html$/))
    expect(window.contentView.addChildView).toHaveBeenCalledWith(shell.content)
    expect(shell.content).toMatchObject({ options: { webPreferences: {
      partition: 'persist:dsh-desktop-renderer', preload: '/desktop/preload.cjs',
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    } } })
    expect(shell.content.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 36, width: 1280, height: 804 })
    window.getContentSize.mockReturnValue([900, 640])
    window.emit('resize')
    expect(shell.content.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 36, width: 900, height: 604 })
    window.getContentSize.mockReturnValue([900, 20])
    window.emit('enter-full-screen')
    expect(shell.content.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 36, width: 900, height: 0 })
    shell.dispose()
  })

  it('rejects other renderers, child frames, navigated chrome, and arbitrary commands', async () => {
    const { shell, handler, event, webContents, actions } = fixture()
    await shell.load()
    expect(handler(event(), 'state')).toEqual({ mode: 'compatibility', locale: 'en', platform: 'darwin', version: '2.0.3', material: 'off' })
    expect(() => handler({ ...event(), sender: electron.content }, 'terminal')).toThrow('untrusted')
    expect(() => handler({ ...event(), senderFrame: { url: webContents.mainFrame.url } }, 'terminal')).toThrow('untrusted')
    expect(() => handler(event(), { command: 'terminal' })).toThrow('unsupported')
    expect(() => handler(event(), 'executeJavaScript')).toThrow('unsupported')
    webContents.mainFrame.url = 'http://127.0.0.1:43120/'
    expect(() => handler(event(), 'terminal')).toThrow('untrusted')
    expect(actions.openTerminal).not.toHaveBeenCalled()
    shell.dispose()
  })

  it('preserves the Windows content surface through minimize, blur, and restore without reloading', () => {
    const { shell, window, actions, webContents } = fixture('win32')
    // Disabling background throttling applies to the whole window, so nothing
    // is ever backgrounded and Chromium never reclaims renderer memory.
    const contentOptions = (shell.content as unknown as { options: { webPreferences: object } }).options
    expect(contentOptions.webPreferences).not.toHaveProperty('backgroundThrottling')
    vi.mocked(shell.content.setBounds).mockClear()
    window.isMinimized.mockReturnValue(true)
    window.getContentSize.mockReturnValue([0, 0])
    window.emit('resize')
    window.emit('blur')
    window.emit('hide')
    expect(electron.content.invalidate).not.toHaveBeenCalled()
    window.isMinimized.mockReturnValue(false)
    window.emit('restore') // Windows may not have published the restored size yet.
    expect(shell.content.setBounds).not.toHaveBeenCalled()
    // An unchanged bounds rect makes resize() a no-op, so a restored frame is
    // repainted explicitly rather than through a layout pass that never runs.
    expect(electron.content.invalidate).toHaveBeenCalledOnce()
    expect(webContents.invalidate).toHaveBeenCalledOnce()
    window.getContentSize.mockReturnValue([1280, 840])
    window.emit('resize')
    window.emit('show')
    expect(shell.content.setBounds).not.toHaveBeenCalled()
    expect(electron.content.invalidate).toHaveBeenCalledTimes(2)
    expect(actions.reload).not.toHaveBeenCalled()
    window.getContentSize.mockReturnValue([1000, 700])
    window.emit('restore')
    expect(shell.content.setBounds).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 36, width: 1000, height: 664 })
    expect(electron.content.invalidate).toHaveBeenCalledTimes(3)
    shell.dispose()
    expect(window.listenerCount('restore')).toBe(0)
    expect(window.listenerCount('show')).toBe(0)
  })

  it('does not repaint or lay out a minimized window', () => {
    const { shell, window, webContents } = fixture('win32')
    vi.mocked(shell.content.setBounds).mockClear()
    window.isMinimized.mockReturnValue(true)
    window.getContentSize.mockReturnValue([1000, 700])
    window.emit('restore')
    window.emit('show')
    expect(shell.content.setBounds).not.toHaveBeenCalled()
    expect(electron.content.invalidate).not.toHaveBeenCalled()
    expect(webContents.invalidate).not.toHaveBeenCalled()
    shell.dispose()
  })

  it('does not resize the page when chrome popups expand, collapse, or lose focus', async () => {
    const { shell, window, handler, event } = fixture('win32')
    await shell.load()
    vi.mocked(shell.content.setBounds).mockClear()
    handler(event(), 'expand')
    handler(event(), 'collapse')
    window.emit('blur')
    expect(shell.content.setBounds).not.toHaveBeenCalled()
    expect(shell.chromeView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1280, height: 36 })
    shell.dispose()
  })

  it('routes fixed actions without replacing the HTML menus with native menus', async () => {
    const { shell, handler, event, actions, spec } = fixture()
    await shell.load()
    await handler(event(), 'terminal')
    await handler(event(), 'check-for-updates')
    await handler(event(), 'mode-compatibility')
    expect(spec.requestModeChange).toHaveBeenCalledWith('compatibility')
    await handler(event(), 'mode-extended')
    expect(spec.requestModeChange).toHaveBeenCalledWith('extended')
    expect(actions.restart).not.toHaveBeenCalled()
    await handler(event(), 'restart')
    await handler(event(), 'restart-recovery')
    await handler(event(), 'reload')
    await handler(event(), 'developer')
    for (const action of ['openTerminal', 'checkForUpdates', 'restart', 'restartToRecovery', 'reload', 'developerTools'] as const) {
      expect(actions[action]).toHaveBeenCalledOnce()
    }
    expect(() => handler(event(), 'version')).toThrow('unsupported')
    expect(() => handler(event(), 'mode')).toThrow('unsupported')
    shell.dispose()
  })

  it('returns persistence and update failures to the original inline error UI', async () => {
    const { shell, handler, event, spec, actions } = fixture()
    await shell.load()
    vi.mocked(spec.requestModeChange).mockRejectedValueOnce(new Error('write failed'))
    await expect(handler(event(), 'mode-advanced')).rejects.toThrow('write failed')
    expect(actions.restart).not.toHaveBeenCalled()
    vi.mocked(actions.checkForUpdates).mockRejectedValueOnce(new Error('update failed'))
    await expect(handler(event(), 'check-for-updates')).rejects.toThrow('update failed')
    shell.dispose()
  })

  it('expands transparent chrome above content only while HTML popups need it', async () => {
    const { shell, handler, event, window, webContents } = fixture()
    await shell.load()
    expect(window.contentView.addChildView.mock.calls.map(([view]) => view)).toEqual([shell.content, shell.chromeView])
    expect(shell.chromeView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1280, height: 36 })
    handler(event(), 'expand')
    expect(shell.chromeView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1280, height: 840 })
    expect(shell.content.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 36, width: 1280, height: 804 })
    window.getContentSize.mockReturnValue([900, 640])
    window.emit('resize')
    expect(shell.chromeView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 900, height: 640 })
    window.emit('blur')
    expect(webContents.send).toHaveBeenCalledWith('dsh-desktop:chrome-dismiss')
    expect(shell.chromeView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 900, height: 36 })
    handler(event(), 'expand')
    webContents.emit('render-process-gone')
    expect(shell.chromeView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 900, height: 36 })
    shell.dispose()
  })

  it('blocks chrome navigation and disposes the child renderer and IPC exactly once', async () => {
    const { shell, window, webContents, ipc, handler, event } = fixture()
    await shell.load()
    for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
      const preventDefault = vi.fn()
      webContents.emit(name, { preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
    }
    shell.refresh()
    expect(webContents.send).toHaveBeenCalledOnce()
    window.emit('closed')
    shell.dispose()
    shell.refresh()
    expect(webContents.send).toHaveBeenCalledOnce()
    expect(ipc.removeHandler).toHaveBeenCalledOnce()
    expect(ipc.removeHandler).toHaveBeenCalledWith(COMPATIBILITY_CHROME_CHANNEL)
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(shell.content)
    expect(webContents.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false })
    expect(electron.content.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false })
    expect(window.listenerCount('resize')).toBe(0)
    expect(() => handler(event(), 'terminal')).toThrow('untrusted')
  })
})


it('exposes the remote-control offer only to trusted chrome and clears the dot on click', async () => {
  const { shell, actions, handler, event } = fixture()
  let seen = false
  let finish!: () => void
  actions.remoteControl = {
    read: async () => ({ enabled: false, seen }),
    open: vi.fn(() => { seen = true; return new Promise<void>(resolve => { finish = resolve }) }),
  }
  await shell.load()
  expect(handler(event(), 'state')).toMatchObject({ remoteControl: { enabled: false, seen: false } })
  expect(() => handler({ ...event(), sender: electron.content }, 'remote-control')).toThrow('untrusted')
  const pending = handler(event(), 'remote-control')
  expect(handler(event(), 'state')).toMatchObject({ remoteControl: { seen: true } })
  expect(actions.remoteControl.open).toHaveBeenCalledTimes(1)
  finish()
  await pending
  shell.dispose()
})
