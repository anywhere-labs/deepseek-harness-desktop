import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { IPC } from '../src/ipc.ts'

const ipc = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: ipc }))
import { installDesktopShortcuts } from '../src/keyboard.ts'

it('authorizes the product frame, routes native bindings, persists edits and releases listeners', async () => {
  const home = await mkdtemp(join(tmpdir(), 'next-keyboard-'))
  const mainFrame = { url: 'dsh-app://app/', parent: null, name: '' }
  const contents = Object.assign(new EventEmitter(), {
    mainFrame, focusedFrame: mainFrame, isDestroyed: () => false, isFocused: () => true,
    send: vi.fn(), setIgnoreMenuShortcuts: vi.fn(), focus: vi.fn(), sendInputEvent: vi.fn(),
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => false, isFocused: () => true, isEnabled: () => true, close: vi.fn(),
  })
  let blocked = false
  const keyboard = installDesktopShortcuts(() => window as never, home, 'macos', vi.fn(),
    () => ({ revision: Number(blocked), blocked }))
  const handler = (channel: string) => ipc.handle.mock.calls.find(call => call[0] === channel)![1]
  const event = { sender: contents, senderFrame: mainFrame }
  try {
    const definitions = [{ id: 'sidebar.left.toggle', defaults: { 'desktop:macos': { code: 'KeyB', modifiers: ['primary'] } } }]
    await expect(handler(IPC.shortcutsGet)({ ...event, sender: {} }, definitions)).rejects.toThrow('rejected sender')
    await expect(handler(IPC.shortcutsGet)({ ...event, senderFrame: { ...mainFrame } }, definitions)).rejects.toThrow('rejected sender')
    mainFrame.url = 'dsh-app://shell/'
    await expect(handler(IPC.shortcutsGet)(event, definitions)).rejects.toThrow('rejected origin')
    mainFrame.url = 'dsh-app://app/'
    const snapshot = await handler(IPC.shortcutsGet)(event, definitions)
    keyboard.attach(window as never)
    const input = { type: 'keyDown', key: 'b', code: 'KeyB', control: false, alt: false, shift: false, meta: true, isAutoRepeat: false, isComposing: false, modifiers: ['meta'] }
    const prevented = { defaultPrevented: false, preventDefault: vi.fn() }
    contents.emit('before-input-event', prevented, input)
    expect(prevented.preventDefault).toHaveBeenCalledOnce()
    expect(contents.send).toHaveBeenCalledWith(IPC.shortcutsInput, expect.objectContaining({ kind: 'keyboard', code: 'KeyB', revision: snapshot.revision }))
    blocked = true
    contents.send.mockClear()
    contents.emit('before-input-event', prevented, input)
    expect(contents.send).not.toHaveBeenCalled()
    blocked = false
    const edited = await handler(IPC.shortcutsEdit)(event, { type: 'set', id: 'sidebar.left.toggle', binding: null }, snapshot.revision)
    expect(edited.status).toBe('saved')
    expect(contents.send).toHaveBeenCalledWith(IPC.shortcutsChanged, expect.objectContaining({ document: expect.objectContaining({ profiles: { 'desktop:macos': { 'sidebar.left.toggle': null } } }) }))
    handler(IPC.shortcutsCloseWindow)(event, 'stale')
    expect(window.close).not.toHaveBeenCalled()
    handler(IPC.shortcutsRecording)(event, true)
    expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  } finally {
    keyboard.dispose()
    expect(contents.listenerCount('before-input-event')).toBe(0)
    expect(ipc.removeHandler).toHaveBeenCalledWith(IPC.shortcutsGet)
    await rm(home, { recursive: true, force: true })
  }
})
