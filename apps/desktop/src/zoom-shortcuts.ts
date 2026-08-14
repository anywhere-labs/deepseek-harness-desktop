/** Keyboard zoom behavior owned by the Electron desktop shell. */

const DEFAULT_ZOOM_LEVEL = 0
const MIN_ZOOM_LEVEL = -3
const MAX_ZOOM_LEVEL = 6

/** Keyboard input fields used by the desktop zoom handler. */
export interface DesktopZoomInput {
  /** Input lifecycle phase. */
  readonly type: string
  /** Layout-resolved key value. */
  readonly key: string
  /** Whether Control is held. */
  readonly control: boolean
  /** Whether Command or another Meta key is held. */
  readonly meta: boolean
  /** Whether Alt is held. */
  readonly alt: boolean
}

/** Preventable native input event used by Electron. */
export interface DesktopZoomEvent {
  /** Stop Chromium from applying its separate zoom behavior. */
  preventDefault(): void
}

/** Zoom operations exposed by Electron WebContents. */
export interface DesktopZoomTarget {
  /** Return the current Chromium zoom level. */
  getZoomLevel(): number
  /** Apply a Chromium zoom level. */
  setZoomLevel(level: number): void
}

type ZoomCommand = 'in' | 'out' | 'reset'

function resolveZoomCommand(input: DesktopZoomInput): ZoomCommand | undefined {
  if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return undefined
  if (input.key === '+' || input.key === '=') return 'in'
  if (input.key === '-' || input.key === '_') return 'out'
  if (input.key === '0') return 'reset'
  return undefined
}

function clampZoomLevel(level: number): number {
  return Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, level))
}

/**
 * Apply a desktop zoom shortcut and suppress Chromium's unbounded default.
 * @param event - Native keyboard event that can suppress the default action.
 * @param input - Electron keyboard input fields.
 * @param target - WebContents zoom operations.
 * @returns Whether the input was a desktop zoom shortcut.
 */
export function handleDesktopZoomShortcut(
  event: DesktopZoomEvent,
  input: DesktopZoomInput,
  target: DesktopZoomTarget,
): boolean {
  const command = resolveZoomCommand(input)
  if (command === undefined) return false

  event.preventDefault()
  const current = target.getZoomLevel()
  const next = command === 'reset'
    ? DEFAULT_ZOOM_LEVEL
    : clampZoomLevel(current + (command === 'in' ? 1 : -1))
  if (next !== current) target.setZoomLevel(next)
  return true
}

/**
 * Clear origin-persisted Chromium zoom when a desktop window loads.
 * @param target - WebContents zoom operations.
 */
export function resetDesktopZoom(target: DesktopZoomTarget): void {
  target.setZoomLevel(DEFAULT_ZOOM_LEVEL)
}
