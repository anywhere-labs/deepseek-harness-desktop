import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const windows: Array<{
    options: unknown
    loadURL: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    isDestroyed: ReturnType<typeof vi.fn>
    loadFile: ReturnType<typeof vi.fn>
    once: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    removeMenu: ReturnType<typeof vi.fn>
    webContents: Record<string, ReturnType<typeof vi.fn>>
  }> = []
  class BrowserWindow {
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      executeJavaScript: vi.fn(async () => {}),
    }
    readonly isDestroyed = vi.fn(() => false)
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly close = vi.fn()
    readonly loadFile = vi.fn(async () => {})
    readonly loadURL = vi.fn(async () => {})
    readonly once = vi.fn()
    readonly on = vi.fn()
    readonly removeMenu = vi.fn()
    accessibleTitle = ''
    constructor(readonly options: unknown) {
      windows.push(this as unknown as typeof windows[number])
    }
  }
  return { BrowserWindow, windows }
})

vi.mock('electron', () => ({ BrowserWindow: electron.BrowserWindow }))

import {
  ProfileCreateWindow,
  parseProfileCreateAction,
} from '../src/profile-create-window.ts'

describe('ProfileCreateWindow', () => {
  beforeEach(() => { electron.windows.length = 0 })

  it('parses only local submit and cancel actions', () => {
    expect(parseProfileCreateAction('dsh-profile-create://submit?name=work')).toEqual({ action: 'submit', name: 'work' })
    expect(parseProfileCreateAction('dsh-profile-create://cancel')).toEqual({ action: 'cancel' })
    expect(parseProfileCreateAction('https://example.com/submit?name=work')).toBeUndefined()
    expect(parseProfileCreateAction('dsh-profile-create://submit?name=work&command=bad')).toBeUndefined()
  })

  it('creates one isolated window and focuses it on repeated opens', () => {
    const onSubmit = vi.fn(async () => {})
    const creator = new ProfileCreateWindow({ locale: 'en', onSubmit })
    creator.open()
    creator.open()
    expect(electron.windows).toHaveLength(1)
    expect(electron.windows[0]?.show).toHaveBeenCalledOnce()
    expect(electron.windows[0]?.focus).toHaveBeenCalledOnce()
    expect(electron.windows[0]?.loadFile).toHaveBeenCalledWith(
      expect.stringContaining('/native-ui/profile-create.html'),
      { query: { locale: 'en' } },
    )
    expect(electron.windows[0]?.options).toEqual(expect.objectContaining({
      width: 480,
      height: 360,
      minWidth: 420,
      minHeight: 330,
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      }),
    }))
    expect(electron.windows[0]?.options).not.toHaveProperty('modal')
    expect(electron.windows[0]?.options).not.toHaveProperty('parent')
  })

  it('does not access destroyed web contents from the closed callback', () => {
    const creator = new ProfileCreateWindow({ locale: 'en', onSubmit: async () => {} })
    creator.open()
    const window = electron.windows[0]
    const closed = window?.on.mock.calls.find(([event]) => event === 'closed')?.[1] as (() => void) | undefined
    expect(closed).toBeTypeOf('function')
    if (window !== undefined) {
      Object.defineProperty(window, 'webContents', {
        configurable: true,
        get: () => { throw new TypeError('Object has been destroyed') },
      })
    }
    expect(() => closed?.()).not.toThrow()
  })
})
