// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
// React 18 act() requires the environment flag to report async work correctly.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { AdvancedFrame } from '../src/client/AdvancedFrame.tsx'
import { DesktopLayoutState } from '../src/client/layout-state.ts'
import { FilePreviewController } from '../src/client/file-preview/controller.ts'
import type { FilePreviewGateway } from '../src/client/file-preview/gateway.ts'
import { FilePreviewRegistry, type FilePreviewProvider } from '../src/client/file-preview/registry.ts'

// jsdom lacks ResizeObserver and pointer capture; stub only what the frame's
// resize plumbing needs so the spec stays headless.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  ;(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub
}
if (typeof Element.prototype.setPointerCapture === 'undefined') {
  Element.prototype.setPointerCapture = () => undefined
}
if (typeof Element.prototype.hasPointerCapture === 'undefined') {
  Element.prototype.hasPointerCapture = () => true
}

/** Minimal fake gateway; the frame never awaits it directly. */
const fakeGateway: FilePreviewGateway = {
  probe: () => Promise.resolve({ status: 'delegate' }),
  readText: () => Promise.resolve({ status: 'error', code: 'x', message: 'x', retryable: false }),
  binaryUrl: () => Promise.resolve({ status: 'error', code: 'x', message: 'x', retryable: false }),
  release: () => Promise.resolve(),
}

/** A provider that renders a stable marker for identity/mount transitions. */
const markerProvider: FilePreviewProvider = {
  id: 'marker', priority: 100, loadMode: 'text',
  supports: () => true,
  Component: () => <div data-marker="file-surface" />,
}

/** Controllable sessions-store driving the frame's useSessions selectors. */
interface SessionState {
  current: string | undefined
  byId: Record<string, { blank?: boolean }>
}
function makeSessionsController() {
  let state: SessionState = { current: undefined, byId: {} }
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const getSnapshot = (): SessionState => state
  const set = (next: SessionState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  const useSessions = <T,>(selector: (s: SessionState) => T): T => {
    const snap = useSyncExternalStore(subscribe, getSnapshot)
    return selector(snap)
  }
  return { useSessions, set }
}

function mountFrame(layout: DesktopLayoutState, controller: FilePreviewController, sessions: ReturnType<typeof makeSessionsController>) {
  const registry = new FilePreviewRegistry()
  registry.register(markerProvider)
  const renderSlot = vi.fn((_key: string, _owner: object) => <div data-slot="stable-slot" />)
  const ui = (
    <AdvancedFrame
      layout={layout}
      platform="win32"
      filePreview={controller}
      filePreviewRegistry={registry}
      renderSlot={renderSlot as never}
      useSessions={sessions.useSessions as never}
      useWorkspaces={(() => undefined) as never}
      SessionProvider={((props: never) => <div>{props as unknown as never}</div>) as never}
    />
  )
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(ui) })
  const cleanup = () => {
    act(() => { root.unmount() })
    container.remove()
  }
  return { container, cleanup }
}

function makeController(layout: DesktopLayoutState): FilePreviewController {
  return new FilePreviewController(fakeGateway, new FilePreviewRegistry(), {
    openFile: () => { layout.openFile() },
    closeFile: () => { layout.closeFile() },
    openSystemPath: () => Promise.resolve(),
    getCurrentSessionId: () => undefined,
  })
}

/** Dispatch a pointer gesture; jsdom may lack PointerEvent, so fall back to a MouseEvent. */
function pointerEvent(type: 'pointerdown' | 'pointermove', clientX: number): Event {
  // The guard keeps this headless-friendly whether or not jsdom exports PointerEvent.
  if (typeof PointerEvent !== 'undefined') return new PointerEvent(type, { bubbles: true, clientX })
  const event = document.createEvent('MouseEvent')
  event.initMouseEvent(type, true, true, window, 0, clientX, 0, 0, 0, false, false, false, false, 0, null)
  return event
}

describe('advanced-frame (client)', () => {
  it('keeps details and file nodes mounted across surface switches with hidden flipping', () => {
    const layout = new DesktopLayoutState()
    const controller = makeController(layout)
    const sessions = makeSessionsController()
    const { container, cleanup } = mountFrame(layout, controller, sessions)

    const detailsNode = container.querySelector('.dshDesktopConversationDetailsSurface')
    const fileNode = container.querySelector('.dshDesktopFilePreviewSurface')
    expect(detailsNode).toBeDefined()
    expect(fileNode).toBeDefined()

    // Closed: file surface hidden, details hidden (no surface selected at first).
    expect(fileNode?.hasAttribute('hidden')).toBe(true)
    expect(detailsNode?.hasAttribute('hidden')).toBe(true)

    // Open file: the same node flips hidden=false; it is not remounted.
    act(() => { layout.openFile() })
    expect(fileNode?.hasAttribute('hidden')).toBe(false)
    expect(container.querySelector('.dshDesktopFilePreviewSurface')).toBe(fileNode)

    // Switch to details: details hidden=false, file hidden=true.
    act(() => { layout.openDetails() })
    expect(detailsNode?.hasAttribute('hidden')).toBe(false)
    expect(container.querySelector('.dshDesktopConversationDetailsSurface')).toBe(detailsNode)
    expect(fileNode?.hasAttribute('hidden')).toBe(true)

    // Close details: details hidden again; identities retained.
    act(() => { layout.closeDetails() })
    expect(detailsNode?.hasAttribute('hidden')).toBe(true)
    expect(container.querySelector('.dshDesktopConversationDetailsSurface')).toBe(detailsNode)
    cleanup()
  })

  it('calls controller.close() when the session identity changes', () => {
    const layout = new DesktopLayoutState()
    const controller = makeController(layout)
    const closeSpy = vi.spyOn(controller, 'close')
    const sessions = makeSessionsController()
    sessions.set({ current: 'session-a', byId: { 'session-a': {} } })
    mountFrame(layout, controller, sessions)

    // Moving from a defined session to a different defined session triggers close.
    act(() => { sessions.set({ current: 'session-b', byId: { 'session-b': {} } }) })
    expect(closeSpy).toHaveBeenCalledTimes(1)

    // Moving from a defined session to none also triggers close.
    act(() => { sessions.set({ current: undefined, byId: {} }) })
    expect(closeSpy).toHaveBeenCalledTimes(2)
  })

  it('resizes via setRightWidth for the currently selected surface', () => {
    // Widen the viewport so the file surface renders above FILE_MIN and the
    // drag actually changes the preference (jsdom default is 1024).
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true })
    try {
      const layout = new DesktopLayoutState()
      const controller = makeController(layout)
      const sessions = makeSessionsController()
      const { container, cleanup } = mountFrame(layout, controller, sessions)

      act(() => { layout.openFile() })
      const fileWidth = layout.getSnapshot().fileWidth
      const handle = container.querySelector('.dshDesktopResizeHandle[data-side="details"]')
      expect(handle).toBeDefined()

      act(() => {
        handle!.dispatchEvent(pointerEvent('pointerdown', 200))
      })
      act(() => {
        handle!.dispatchEvent(pointerEvent('pointermove', 260))
      })
      // Details-side drag shrinks the width as the pointer moves right.
      expect(layout.getSnapshot().fileWidth).toBe(Math.max(360, fileWidth - 60))
      cleanup()
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
    }
  })
})
