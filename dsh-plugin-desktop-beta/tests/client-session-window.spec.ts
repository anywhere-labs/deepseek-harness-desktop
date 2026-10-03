// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSessionWindowUi, isExternalSessionDrop } from '../src/client/session-window.ts'
import { SESSION_WINDOW_UI } from '../src/session-window-contract.ts'

vi.mock('../src/client/session-window-menu.tsx', () => ({ installSessionWindowMenu: vi.fn() }))

const external = { screenX: 1600, screenY: 400, clientX: 1400, clientY: 200, dataTransfer: { dropEffect: 'none' } }
const viewport = { width: 1000, height: 800 }
const state = { cancelled: false, dropped: false }
const disposers: (() => void)[] = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.innerHTML = '' })

function install() {
  const open = vi.fn(async () => {})
  disposers.push(installSessionWindowUi({ canOpen: id => id !== 'archived', open, label: '新窗口打开' }))
  return { open, bridge: window[SESSION_WINDOW_UI]! }
}

describe('session window entry points', () => {
  it('opens the clicked id without changing the current conversation', () => {
    const { open, bridge } = install()
    bridge.open('session-a')
    expect(open).toHaveBeenCalledExactlyOnceWith('session-a', 'menu')
  })
  it('rejects unavailable sessions and multiple selections', () => {
    const { open, bridge } = install()
    bridge.open('archived')
    document.body.innerHTML = '<div data-dsh-bulk-selected="true"></div><div data-dsh-bulk-selected="true"></div>'
    expect(bridge.canOpen('a')).toBe(false)
    expect(bridge.start('a')).toBe(false)
    bridge.open('a')
    expect(open).not.toHaveBeenCalled()
  })
  it('opens one window on external release and consumes the reorder fallback', () => {
    const { open, bridge } = install()
    bridge.start('a')
    expect(bridge.end('a', external)).toBe(true)
    bridge.end('a', external)
    expect(open).toHaveBeenCalledExactlyOnceWith('a', 'drag')
  })
  it('cancels on Escape without opening or committing the old hover marker', () => {
    const { open, bridge } = install()
    bridge.start('a')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(bridge.end('a', external)).toBe(true)
    expect(open).not.toHaveBeenCalled()
  })
  it('preserves an accepted in-window drop and ignores foreign drags', () => {
    const { open, bridge } = install()
    expect(bridge.end('a', external)).toBe(false)
    bridge.start('a')
    document.dispatchEvent(new Event('drop'))
    expect(bridge.end('a', external)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
  it('opens immediately on a conversation-area drop and never commits a sidebar reorder', () => {
    const { open, bridge } = install()
    document.body.innerHTML = '<main><div id="content"></div></main>'
    const content = document.getElementById('content')!
    bridge.start('a')
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    content.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    const dropped = new Event('drop', { bubbles: true, cancelable: true })
    content.dispatchEvent(dropped)
    expect(dropped.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledExactlyOnceWith('a', 'drag')
    expect(bridge.end('a', { ...external, clientX: 500, dataTransfer: { dropEffect: 'move' } })).toBe(true)
    expect(open).toHaveBeenCalledOnce()
  })
  it('keeps workspace moves and external file drops on their original handlers', () => {
    const { open, bridge } = install()
    document.body.innerHTML = '<aside class="dshDesktopSidebarSurface"><div id="row"></div></aside><main id="content"></main>'
    const content = document.getElementById('content')!
    const fileDrop = new Event('drop', { bubbles: true, cancelable: true })
    content.dispatchEvent(fileDrop)
    expect(fileDrop.defaultPrevented).toBe(false)
    bridge.start('a')
    const rowDrop = new Event('drop', { bubbles: true, cancelable: true })
    document.getElementById('row')!.dispatchEvent(rowDrop)
    expect(rowDrop.defaultPrevented).toBe(false)
    expect(bridge.end('a', external)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
  it('prepares at drag start and releases on cancel, internal drop, or disposal', () => {
    const prepareDrag = vi.fn()
    const cancelDrag = vi.fn()
    const dispose = installSessionWindowUi({ canOpen: () => true, open: vi.fn(async () => {}), label: '', prepareDrag, cancelDrag })
    const bridge = window[SESSION_WINDOW_UI]!
    bridge.start('a')
    expect(prepareDrag).toHaveBeenCalledWith('a')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    bridge.end('a', external)
    expect(cancelDrag).toHaveBeenCalledWith('a')
    bridge.start('b')
    document.dispatchEvent(new Event('drop'))
    bridge.end('b', external)
    expect(cancelDrag).toHaveBeenCalledWith('b')
    bridge.start('c')
    dispose()
    expect(cancelDrag).toHaveBeenCalledWith('c')
  })
  it('removes its listeners and global hook on disposal', () => {
    install()
    disposers.splice(0).forEach(dispose => dispose())
    expect(window[SESSION_WINDOW_UI]).toBeUndefined()
  })
  it.each([
    [{ ...external, clientX: 300, clientY: 200 }, state],
    [{ ...external, screenX: 0, screenY: 0 }, state],
    [{ ...external, dataTransfer: { dropEffect: 'move' } }, state],
    [external, { cancelled: true, dropped: false }],
    [external, { cancelled: false, dropped: true }],
  ])('does not infer tear-out from a rejected/accepted/cancelled drag alone', (event, drag) => {
    expect(isExternalSessionDrop(event, drag, viewport)).toBe(false)
  })
  it('accepts a real release outside the client area', () => {
    expect(isExternalSessionDrop(external, state, viewport)).toBe(true)
  })
})
