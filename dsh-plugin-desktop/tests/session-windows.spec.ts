import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import type { DesktopShellSpec } from '../src/runtime.ts'
import type { ElectronPlatformStrategy } from '../src/electron-platform.ts'
import { SessionWindows } from '../src/session-windows.ts'
import { parseSessionWindowRequest, sessionWindowUrl } from '../src/session-window-contract.ts'

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(async () => {}), unregister: vi.fn(), register: vi.fn(), windows: [] as unknown[], load: vi.fn(async () => {}), cursor: { x: 1500, y: 400 } }))
vi.mock('../src/renderer-authentication.ts', () => ({ authenticateRendererSession: mocks.authenticate, installRendererAccessHeader: mocks.register }))
vi.mock('../src/window-options.ts', () => ({ desktopWindowOptions: () => ({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }) }))
vi.mock('electron', () => ({
  BrowserWindow: class extends EventEmitter {
    destroyed = false
    show = vi.fn()
    focus = vi.fn()
    restore = vi.fn()
    isMinimized = () => true
    isVisible = () => false
    isDestroyed = () => this.destroyed
    setTitle = vi.fn()
    getBounds = () => ({ x: 0, y: 0, width: 1000, height: 800 })
    setBounds = vi.fn()
    webContents = Object.assign(new EventEmitter(), {
      ipc: new EventEmitter(), mainFrame: { url: 'http://localhost:1234' },
      setBackgroundThrottling: vi.fn(), setWindowOpenHandler: vi.fn(), loadURL: mocks.load,
    })
    constructor(readonly options: unknown) { super(); mocks.windows.push(this) }
    destroy() { this.destroyed = true; this.emit('closed') }
  },
  nativeImage: { createFromPath: () => ({}) },
  screen: {
    getCursorScreenPoint: () => mocks.cursor,
    getDisplayNearestPoint: () => ({ workArea: { x: 1000, y: 0, width: 1200, height: 900 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }),
  },
  shell: { openExternal: vi.fn(async () => {}) }, dialog: { showMessageBox: vi.fn(async () => ({})) },
}))

function create() {
  const handle = vi.fn()
  const renderer = { ipc: { handle, removeHandler: vi.fn() }, mainFrame: { url: 'http://localhost:1234' }, isDestroyed: () => false } as unknown as WebContents
  const main = { getBounds: () => ({ x: 50, y: 50, width: 1000, height: 800 }), isDestroyed: () => false } as unknown as BrowserWindow
  const manager = new SessionWindows({ renderer, main, log: vi.fn(), preloadPath: '/preload', platform: { platform: 'darwin' } as ElectronPlatformStrategy, spec: { url: 'http://localhost:1234/?dsh-desktop-mode=compatibility', iconPath: '/icon', productName: 'DSH' } as DesktopShellSpec })
  return { manager, renderer, handle }
}

beforeEach(() => { vi.clearAllMocks(); mocks.windows.length = 0; mocks.register.mockReturnValue(mocks.unregister) })

describe('session native windows', () => {
  it('deduplicates simultaneous opens and keeps different ids independent', async () => {
    const { manager } = create()
    await Promise.all([manager.open('a', 'menu'), manager.open('a', 'menu')])
    expect(mocks.windows).toHaveLength(1)
    await manager.open('b', 'drag')
    expect(mocks.windows).toHaveLength(2)
    const child = mocks.windows[1] as { options: { x: number; y: number; width: number; height: number } }
    expect(child.options.x + child.options.width).toBeLessThanOrEqual(2200)
    expect(child.options.y + child.options.height).toBeLessThanOrEqual(900)
    manager.dispose()
    expect(mocks.unregister).toHaveBeenCalledTimes(2)
  })
  it('closing a child releases only its registration and allows reopening', async () => {
    const { manager } = create()
    await manager.open('a', 'menu')
    await manager.open('b', 'menu')
    ;(mocks.windows[0] as BrowserWindow).destroy()
    expect(mocks.unregister).toHaveBeenCalledTimes(1)
    await manager.open('a', 'menu')
    expect(mocks.windows).toHaveLength(3)
    manager.dispose()
  })
  it('cleans a failed load and permits retry', async () => {
    const { manager } = create()
    mocks.load.mockRejectedValueOnce(new Error('offline'))
    await expect(manager.open('a', 'menu')).rejects.toThrow('offline')
    expect(mocks.unregister).toHaveBeenCalledOnce()
    await manager.open('a', 'menu')
    expect(mocks.windows).toHaveLength(2)
    manager.dispose()
  })
  it('disposes a window while its page load is pending', async () => {
    const { manager } = create()
    let finish!: () => void
    mocks.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = manager.open('a', 'menu')
    manager.dispose()
    finish()
    await pending
    expect((mocks.windows[0] as BrowserWindow).isDestroyed()).toBe(true)
    expect(mocks.unregister).toHaveBeenCalledOnce()
    expect(mocks.authenticate).not.toHaveBeenCalled()
  })
  it('rejects foreign renderer and subframe IPC', async () => {
    const { manager, renderer, handle } = create()
    const action = handle.mock.calls[0]![1] as (event: object, value: unknown) => Promise<void>
    await expect(action({ sender: {}, senderFrame: renderer.mainFrame }, { sessionId: 'a', source: 'menu' })).rejects.toThrow('Untrusted')
    await expect(action({ sender: renderer, senderFrame: { url: 'http://localhost:1234' } }, { sessionId: 'a', source: 'menu' })).rejects.toThrow('Untrusted')
    expect(mocks.windows).toHaveLength(0)
    manager.dispose()
  })
  it('prepares during drag, stays hidden when ready, then reuses the loaded window on release', async () => {
    const { manager, renderer, handle } = create()
    const action = handle.mock.calls[0]![1] as (event: object, value: unknown) => Promise<void>
    const event = { sender: renderer, senderFrame: renderer.mainFrame }
    await action(event, { sessionId: 'a', source: 'prepare-drag' })
    const child = mocks.windows[0] as BrowserWindow
    child.webContents.ipc.emit('dsh-desktop:session-window:ready', { senderFrame: child.webContents.mainFrame }, 'A')
    expect(child.show).not.toHaveBeenCalled()
    await action(event, { sessionId: 'a', source: 'drag' })
    expect(mocks.windows).toHaveLength(1)
    expect(mocks.load).toHaveBeenCalledOnce()
    expect(child.show).toHaveBeenCalledOnce()
    expect(child.setBounds).toHaveBeenCalledOnce()
    manager.dispose()
  })
  it('accepts a completed content-area drag without rechecking a later cursor position', async () => {
    const { manager, renderer, handle } = create()
    const action = handle.mock.calls[0]![1] as (event: object, value: unknown) => Promise<void>
    const event = { sender: renderer, senderFrame: renderer.mainFrame }
    const previous = { ...mocks.cursor }
    mocks.cursor.x = 100
    mocks.cursor.y = 100
    try {
      await action(event, { sessionId: 'a', source: 'drag' })
      expect(mocks.windows).toHaveLength(1)
      const child = mocks.windows[0] as BrowserWindow
      child.webContents.ipc.emit('dsh-desktop:session-window:ready', { senderFrame: child.webContents.mainFrame }, 'A')
      expect(child.show).toHaveBeenCalledOnce()
      // Title/status updates must not reveal a window the user has minimized.
      child.webContents.ipc.emit('dsh-desktop:session-window:ready', { senderFrame: child.webContents.mainFrame }, 'Renamed A')
      expect(child.show).toHaveBeenCalledOnce()
    } finally {
      Object.assign(mocks.cursor, previous)
      manager.dispose()
    }
  })
  it('cancels a prepared window without closing an already opened session', async () => {
    const { manager, renderer, handle } = create()
    const action = handle.mock.calls[0]![1] as (event: object, value: unknown) => Promise<void>
    const event = { sender: renderer, senderFrame: renderer.mainFrame }
    await action(event, { sessionId: 'a', source: 'prepare-drag' })
    await action(event, { sessionId: 'a', source: 'cancel-drag' })
    expect((mocks.windows[0] as BrowserWindow).isDestroyed()).toBe(true)
    await manager.open('a', 'menu')
    await action(event, { sessionId: 'a', source: 'prepare-drag' })
    await action(event, { sessionId: 'a', source: 'cancel-drag' })
    expect((mocks.windows[1] as BrowserWindow).isDestroyed()).toBe(false)
    manager.dispose()
  })
  it('encodes the id without allowing it to choose the renderer origin', () => {
    const url = new URL(sessionWindowUrl('http://localhost:1234/?mode=compatibility', 'id&other=value'))
    expect(url.origin).toBe('http://localhost:1234')
    expect(url.searchParams.get('dsh-desktop-session')).toBe('id&other=value')
    expect(url.searchParams.has('other')).toBe(false)
    expect(() => parseSessionWindowRequest({ sessionId: '', source: 'menu' })).toThrow()
    expect(() => parseSessionWindowRequest({ sessionId: 'a', source: 'remote' })).toThrow()
  })
})
