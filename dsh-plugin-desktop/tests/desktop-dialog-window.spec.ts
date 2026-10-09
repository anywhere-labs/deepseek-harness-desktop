import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const windows: BrowserWindow[] = []
  class BrowserWindow {
    readonly onceListeners = new Map<string, Listener>()
    readonly listeners = new Map<string, Listener>()
    readonly webListeners = new Map<string, Listener>()
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, listener: Listener) => { this.webListeners.set(event, listener) }),
    }
    accessibleTitle = ''
    readonly isDestroyed = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn()
    readonly removeMenu = vi.fn()
    readonly destroy = vi.fn()
    private bounds: Electron.Rectangle
    readonly getBounds = vi.fn(() => ({ ...this.bounds }))
    readonly setBounds = vi.fn((bounds: Electron.Rectangle) => { this.bounds = { ...bounds } })
    readonly setPosition = vi.fn((x: number, y: number) => { this.bounds = { ...this.bounds, x, y } })
    readonly setContentSize = vi.fn((width: number, height: number) => {
      // Model native/invisible chrome so the test distinguishes content size
      // from outer bounds instead of accidentally treating them as identical.
      this.bounds = { ...this.bounds, width: width + 8, height: height + 12 }
    })
    readonly loadFile = vi.fn(async () => {})
    readonly once = vi.fn((event: string, listener: Listener) => { this.onceListeners.set(event, listener) })
    readonly on = vi.fn((event: string, listener: Listener) => { this.listeners.set(event, listener) })
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      this.bounds = {
        x: options.x ?? 0,
        y: options.y ?? 0,
        width: options.width ?? 800,
        height: options.height ?? 600,
      }
      windows.push(this)
    }
  }
  return {
    app: { isHidden: vi.fn(() => false), show: vi.fn() },
    BrowserWindow,
    windows,
    screen: {
      getDisplayMatching: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
    },
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  screen: electron.screen,
}))

import {
  DesktopDialogWindow,
  desktopDialogPosition,
  desktopDialogPreferredHeight,
  parseDesktopDialogResponse,
} from '../src/desktop-dialog-window.ts'

describe('desktopDialogPosition', () => {
  it('centers over the parent window on the parent display', () => {
    expect(desktopDialogPosition(
      { x: 2500, y: 300, width: 800, height: 600 },
      { width: 480, height: 300 },
      { x: 1920, y: 0, width: 1920, height: 1032 },
    )).toEqual({ x: 2660, y: 450 })
  })

  it('clamps into the work area when the parent sits near an edge', () => {
    expect(desktopDialogPosition(
      { x: 1700, y: 0, width: 800, height: 600 },
      { width: 480, height: 300 },
      { x: 0, y: 0, width: 1920, height: 1032 },
    )).toEqual({ x: 1440, y: 150 })
  })

  it('pins to the work-area origin when the dialog exceeds the display', () => {
    expect(desktopDialogPosition(
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 480, height: 300 },
      { x: 0, y: 0, width: 400, height: 300 },
    )).toEqual({ x: 0, y: 0 })
  })
})

describe('DesktopDialogWindow', () => {
  beforeEach(() => {
    electron.windows.length = 0
    vi.clearAllMocks()
  })

  it('accepts only bounded local response navigation', () => {
    expect(parseDesktopDialogResponse('dsh-desktop-dialog://response?id=1', 2)).toBe(1)
    expect(parseDesktopDialogResponse('dsh-desktop-dialog://response?id=2', 2)).toBeUndefined()
    expect(parseDesktopDialogResponse('dsh-desktop-dialog://response?id=-1', 2)).toBeUndefined()
    expect(parseDesktopDialogResponse('dsh-desktop-dialog://response?id=1&command=bad', 2)).toBeUndefined()
    expect(parseDesktopDialogResponse('https://response/?id=1', 2)).toBeUndefined()
  })

  it('does not add the legacy action-row offset on Windows', () => {
    expect(desktopDialogPreferredHeight(134, 'win32')).toBe(134)
    expect(desktopDialogPreferredHeight(134, 'darwin')).toBe(166)
  })

  it('creates a frameless parented modal shadcn window centered on the parent', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const parent = new electron.BrowserWindow({})
    const dialog = new DesktopDialogWindow({
      type: 'question',
      title: 'Restart DSH Desktop',
      message: 'Restart now?',
      detail: 'Running operations may be interrupted.',
      buttons: ['Restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    }, parent as unknown as Electron.BrowserWindow)
    const result = dialog.run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(2) })
    const window = electron.windows[1]
    // 480x300 dialog centered over the 800x600 parent at the work-area origin.
    expect(window?.options).toEqual(expect.objectContaining({
      parent,
      modal: true,
      frame: false,
      closable: false,
      resizable: false,
      x: 160,
      y: 150,
      height: 300,
      useContentSize: true,
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        enablePreferredSizeMode: true,
      }),
    }))
    expect(window?.options).not.toHaveProperty('minHeight')
    expect(window?.options).not.toHaveProperty('maxHeight')
    expect(window?.options).not.toHaveProperty('titleBarStyle')
    expect(window?.loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]native-ui[\\/]desktop-dialog\.html$/u),
      expect.objectContaining({ query: expect.objectContaining({ platform: process.platform, frame: 'false' }) }),
    )
    const navigate = window?.webListeners.get('will-navigate')
    window?.onceListeners.get('ready-to-show')?.()
    expect(window?.show).not.toHaveBeenCalled()
    const preferredSize = window?.webListeners.get('preferred-size-changed')
    preferredSize?.({}, { width: 492, height: 134 })
    expect(window?.setContentSize).not.toHaveBeenCalled()
    window?.webListeners.get('did-finish-load')?.()
    expect(window?.setContentSize).toHaveBeenCalledWith(480, 134, false)
    expect(window?.setBounds).not.toHaveBeenCalled()
    // The reveal re-centers with the final preferred bounds before showing.
    expect(window?.setPosition).toHaveBeenCalledWith(160, 150)
    expect(window?.show).toHaveBeenCalledOnce()
    const event = { preventDefault: vi.fn() }
    navigate?.(event, 'dsh-desktop-dialog://response?id=0')

    await expect(result).resolves.toEqual({ response: 0 })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window?.destroy).toHaveBeenCalledOnce()
  })

  it('uses a larger scrollable presentation for detailed recovery failures', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const parent = new electron.BrowserWindow({})
    const result = new DesktopDialogWindow({
      type: 'error',
      title: 'Rollback failed',
      message: 'Profile dependencies could not be rebuilt.',
      detail: 'Exit code: 1\n\nstderr:\nERR_PNPM_OUTDATED_LOCKFILE',
      buttons: ['Close'],
      defaultId: 0,
      cancelId: 0,
      presentation: 'diagnostic',
    }, parent as unknown as Electron.BrowserWindow).run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(2) })
    const window = electron.windows[1]
    expect(window?.options).toEqual(expect.objectContaining({
      width: 680,
      height: 460,
      minWidth: 560,
      maxWidth: 860,
      parent,
      modal: true,
      frame: false,
    }))
    const loadCalls = window?.loadFile.mock.calls as unknown as readonly [
      string,
      { readonly query: { readonly state?: string } },
    ][] | undefined
    const query = loadCalls?.[0]?.[1].query
    expect(JSON.parse(Buffer.from(query?.state ?? '', 'base64url').toString('utf8'))).toMatchObject({
      presentation: 'diagnostic',
      detail: expect.stringContaining('ERR_PNPM_OUTDATED_LOCKFILE'),
    })
    window?.onceListeners.get('ready-to-show')?.()
    window?.webListeners.get('preferred-size-changed')?.({}, { width: 680, height: 390 })
    window?.webListeners.get('did-finish-load')?.()
    expect(window?.setContentSize).toHaveBeenCalledWith(680, 390, false)
    window?.webListeners.get('will-navigate')?.(
      { preventDefault: vi.fn() },
      'dsh-desktop-dialog://response?id=0',
    )
    await expect(result).resolves.toEqual({ response: 0 })
  })

  it('sizes the macOS Profile compatibility notice to its content without extra height', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const result = new DesktopDialogWindow({
      type: 'warning',
      title: 'Profile compatibility warning',
      message: 'Current Profile “work” was used by DSH Desktop Beta.',
      detail: 'Previous DSH: 0.1.2-alpha.5\nCurrent DSH: 0.1.1-rc.2',
      advisory: 'Warning: DSH version differences may make plugins unavailable.',
      presentation: 'profile-compatibility',
      buttons: ['Switch Profile', 'Use Anyway', 'Quit'],
      defaultId: 0,
      cancelId: 2,
    }).run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(1) })
    const window = electron.windows[0]
    const loadCalls = window?.loadFile.mock.calls as unknown as readonly [
      string,
      { readonly query: { readonly state?: string } },
    ][] | undefined
    const state = JSON.parse(Buffer.from(loadCalls?.[0]?.[1].query.state ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    expect(state).toMatchObject({
      presentation: 'profile-compatibility',
      advisory: 'Warning: DSH version differences may make plugins unavailable.',
    })
    // A standalone dialog has no parent to center on and must not reposition.
    expect(window?.options).not.toHaveProperty('x')
    expect(window?.options).not.toHaveProperty('y')
    window?.webListeners.get('preferred-size-changed')?.({}, { width: 480, height: 320 })
    window?.webListeners.get('did-finish-load')?.()
    expect(window?.setContentSize).toHaveBeenCalledWith(480, 320, false)
    expect(window?.setPosition).not.toHaveBeenCalled()
    window?.webListeners.get('will-navigate')?.(
      { preventDefault: vi.fn() },
      'dsh-desktop-dialog://response?id=2',
    )
    await expect(result).resolves.toEqual({ response: 2 })
  })

  it('maps window close to the configured cancel response', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const result = new DesktopDialogWindow({
      title: 'Confirm',
      message: 'Continue?',
      buttons: ['Continue', 'Cancel'],
      cancelId: 1,
    }).run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(1) })
    expect(electron.windows[0]?.options).toEqual(expect.objectContaining({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 12 },
    }))
    expect(electron.windows[0]?.options).not.toHaveProperty('minHeight')
    expect(electron.windows[0]?.loadFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ query: expect.objectContaining({ frame: 'true' }) }),
    )
    electron.windows[0]?.listeners.get('closed')?.()
    await expect(result).resolves.toEqual({ response: 1 })
  })
})
