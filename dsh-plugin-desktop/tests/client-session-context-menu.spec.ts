import { describe, expect, it, vi } from 'vitest'
import {
  installDesktopSessionContextMenuBridge,
  resolveDesktopSessionContextMenu,
  type DesktopSessionContextMenuWindow,
} from '../src/client/session-context-menu.ts'

function contextEvent(x = 120, y = 240) {
  return {
    clientX: x,
    clientY: y,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
}

describe('desktop session context menu bridge', () => {
  it('suppresses the native menu and compensates the primitive menu gap', () => {
    const event = contextEvent()

    expect(resolveDesktopSessionContextMenu(event, false)).toEqual({ x: 120, y: 236 })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('suppresses the native menu without opening actions for a blank session', () => {
    const event = contextEvent()

    expect(resolveDesktopSessionContextMenu(event, true)).toBeUndefined()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('installs and restores the window bridge consumed by the workspace patch', () => {
    const previous = vi.fn()
    const target = { __DSH_DESKTOP_SESSION_CONTEXT_MENU__: previous } as DesktopSessionContextMenuWindow

    const dispose = installDesktopSessionContextMenuBridge(target)
    expect(target.__DSH_DESKTOP_SESSION_CONTEXT_MENU__).not.toBe(previous)
    expect(target.__DSH_DESKTOP_SESSION_CONTEXT_MENU__?.(contextEvent(20, 40), false)).toEqual({ x: 20, y: 36 })
    dispose()
    expect(target.__DSH_DESKTOP_SESSION_CONTEXT_MENU__).toBe(previous)
  })
})
