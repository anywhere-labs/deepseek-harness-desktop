import { installSessionWindowMenu } from './session-window-menu.tsx'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SESSION_WINDOW_BRIDGE, SESSION_WINDOW_TARGET, SESSION_WINDOW_UI, validSessionWindowId, type SessionWindowBridge } from '../session-window-contract.ts'

interface DragEnd {
  screenX: number
  screenY: number
  clientX: number
  clientY: number
  dataTransfer: { dropEffect: string } | null
}

interface SessionWindowUi {
  label: string
  canOpen(id: string): boolean
  open(id: string): void
  start(id: string): boolean
  end(id: string, event: DragEnd): boolean
}

declare global {
  interface Window {
    [SESSION_WINDOW_BRIDGE]?: SessionWindowBridge
    [SESSION_WINDOW_TARGET]?: string | null
    [SESSION_WINDOW_UI]?: SessionWindowUi
  }
}

/** An explicit cancel or an accepted drop can never tear a session out. */
export function isExternalSessionDrop(event: DragEnd, state: { cancelled: boolean; dropped: boolean }, viewport: { width: number; height: number }): boolean {
  return !state.cancelled && !state.dropped && event.dataTransfer?.dropEffect === 'none'
    && Number.isFinite(event.screenX) && Number.isFinite(event.screenY)
    // Chromium reports an empty position when a native drag is cancelled.
    && !(event.screenX === 0 && event.screenY === 0)
    && (event.clientX < 0 || event.clientY < 0 || event.clientX >= viewport.width || event.clientY >= viewport.height)
}

/** Install the common, desktop-only menu/drag entry. Upstream owns the actual menu and reorder. */
export function installSessionWindowUi(options: {
  canOpen(id: string): boolean
  open(id: string, source: 'menu' | 'drag'): Promise<void>
  label: string
  prepareDrag?(id: string): void
  cancelDrag?(id: string): void
}, target: Window = window): () => void {
  let drag: { id: string; cancelled: boolean; dropped: boolean; detached: boolean } | undefined
  const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && drag) drag.cancelled = true }
  const single = (): boolean => target.document.querySelectorAll('[data-dsh-bulk-selected="true"]').length <= 1
  const canOpen = (id: string): boolean => validSessionWindowId(id) && single() && options.canOpen(id)
  const open = (id: string, source: 'menu' | 'drag'): void => {
    if (canOpen(id)) void options.open(id, source).catch(error => { console.error('Session window:', error) })
  }
  // The conversation surface is an accepted drop target, so Chromium need not
  // play its rejected-drop return animation before opening the new window.
  const outsideSidebar = (event: DragEvent): boolean => event.target instanceof Element
    && event.target !== target.document.documentElement && event.target !== target.document.body
    && !event.target.closest('[class*="_sidebarCol"], .dshDesktopSidebarSurface, [role="tree"]')
  const dragover = (event: DragEvent): void => {
    if (!drag || drag.cancelled || !canOpen(drag.id) || !outsideSidebar(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  }
  const drop = (event: DragEvent): void => {
    if (!drag) return
    drag.dropped = true
    if (drag.cancelled || !canOpen(drag.id) || !outsideSidebar(event)) return
    event.preventDefault()
    event.stopPropagation()
    drag.detached = true
    open(drag.id, 'drag')
  }
  const bridge: SessionWindowUi = {
    label: options.label, canOpen,
    open: id => { open(id, 'menu') },
    start: id => {
      if (!canOpen(id)) return false
      if (drag) options.cancelDrag?.(drag.id)
      drag = { id, cancelled: false, dropped: false, detached: false }
      options.prepareDrag?.(id)
      return true
    },
    end: (id, event) => {
      const state = drag
      drag = undefined
      if (!state || state.id !== id) return false
      if (state.detached) return true
      const external = isExternalSessionDrop(event, state, { width: target.innerWidth, height: target.innerHeight })
      if (external && canOpen(id)) open(id, 'drag')
      else options.cancelDrag?.(id)
      // Cancel also consumes the upstream end callback's last-hover fallback.
      return external || state.cancelled || (!state.dropped && event.dataTransfer?.dropEffect === 'none')
    },
  }
  target[SESSION_WINDOW_UI] = bridge
  target.document.addEventListener('keydown', escape, true)
  target.document.addEventListener('dragover', dragover, true)
  target.document.addEventListener('drop', drop, true)
  return () => {
    if (drag) options.cancelDrag?.(drag.id)
    target.document.removeEventListener('keydown', escape, true)
    target.document.removeEventListener('dragover', dragover, true)
    target.document.removeEventListener('drop', drop, true)
    if (target[SESSION_WINDOW_UI] === bridge) delete target[SESSION_WINDOW_UI]
  }
}

/** Navigate only after the existing Host lists are ready; never create a replacement Session. */
export function applySessionWindows(ctx: Context): void {
  const bridge = window[SESSION_WINDOW_BRIDGE]
  if (!bridge) return
  ctx.inject(['workspaces', 'uiWorkspace'], scope => {
    const sessionId = window[SESSION_WINDOW_TARGET]
    const available = (id: string): boolean => {
      const sessions = scope.sessions.list.getSnapshot()
      const summary = Object.values(sessions.byId).find(session => session.id === id)
      return sessions.phase === 'ready' && summary !== undefined && !summary.blank
        && !scope.workspaces.list.getSnapshot().archivedSessionIds.some(archived => archived === id)
    }
    if (!sessionId) {
      scope.effect(() => installSessionWindowUi({
        canOpen: available,
        label: scope.locale.getSnapshot().active.startsWith('zh') ? '新窗口打开' : 'Open in new window',
        open: (id, source) => bridge.open({ sessionId: id, source }),
        prepareDrag: id => { void bridge.open({ sessionId: id, source: 'prepare-drag' }).catch(() => {}) },
        cancelDrag: id => { void bridge.open({ sessionId: id, source: 'cancel-drag' }).catch(() => {}) },
      }), 'desktop: session window entry points')
      installSessionWindowMenu(scope)
      return
    }
    scope.effect(() => {
      let opened = false
      const update = (): void => {
        const sessions = scope.sessions.list.getSnapshot()
        if (sessions.phase !== 'ready' || scope.workspaces.list.getSnapshot().phase !== 'ready') return
        if (!opened && available(sessionId)) {
          opened = true
          // Obtain the branded id from the authoritative list, not from a cast of the URL.
          scope.uiWorkspace.openSession(Object.values(sessions.byId).find(session => session.id === sessionId)!.id)
        }
        const summary = Object.values(sessions.byId).find(session => session.id === sessionId)
        bridge.ready(summary?.title || '会话不可用')
        document.body.dataset.dshSessionUnavailable = available(sessionId) ? 'false' : 'true'
      }
      const offSessions = scope.sessions.list.subscribe(update)
      const offWorkspaces = scope.workspaces.list.subscribe(update)
      update()
      return () => { offSessions(); offWorkspaces(); delete document.body.dataset.dshSessionUnavailable }
    }, 'desktop: session window navigation')
  })
}
