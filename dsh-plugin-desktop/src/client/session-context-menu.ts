/** Vertical gap applied by the shared Menu primitive to a bottom-side anchor. */
const MENU_ANCHOR_GAP = 4

export interface DesktopSessionContextMenuPoint {
  readonly x: number
  readonly y: number
}

export interface DesktopSessionContextMenuEvent {
  readonly clientX: number
  readonly clientY: number
  preventDefault(): void
  stopPropagation(): void
}

export type DesktopSessionContextMenuBridge = (
  event: DesktopSessionContextMenuEvent,
  blank: boolean,
) => DesktopSessionContextMenuPoint | undefined

export interface DesktopSessionContextMenuWindow {
  __DSH_DESKTOP_SESSION_CONTEXT_MENU__?: DesktopSessionContextMenuBridge
}

declare global {
  interface Window extends DesktopSessionContextMenuWindow {}
}

/** Convert one native context-menu event into the shared Menu's point anchor. */
export function resolveDesktopSessionContextMenu(
  event: DesktopSessionContextMenuEvent,
  blank: boolean,
): DesktopSessionContextMenuPoint | undefined {
  event.preventDefault()
  event.stopPropagation()
  if (blank) return undefined
  return { x: event.clientX, y: event.clientY - MENU_ANCHOR_GAP }
}

/** Install the Desktop-only bridge consumed by the version-pinned workspace UI patch. */
export function installDesktopSessionContextMenuBridge(
  target: DesktopSessionContextMenuWindow = window,
): () => void {
  const previous = target.__DSH_DESKTOP_SESSION_CONTEXT_MENU__
  target.__DSH_DESKTOP_SESSION_CONTEXT_MENU__ = resolveDesktopSessionContextMenu
  return () => {
    if (previous === undefined) delete target.__DSH_DESKTOP_SESSION_CONTEXT_MENU__
    else target.__DSH_DESKTOP_SESSION_CONTEXT_MENU__ = previous
  }
}
