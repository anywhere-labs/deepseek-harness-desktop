/** Pure close-behavior row state: initial value plus a revision-guarded adoption. */

import type { DesktopCloseBehavior } from '../runtime.ts'

/** Store state: the active close behavior plus a change guard. */
export interface CloseBehaviorRowState {
  /** Active close behavior; 'tray' until the Host section is adopted. */
  value: DesktopCloseBehavior
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Initial row state before any Host adoption. */
export const CLOSE_BEHAVIOR_ROW_INITIAL_STATE: CloseBehaviorRowState = Object.freeze({
  value: 'tray',
  revision: -1,
})

/**
 * Adopt a newer Host revision, ignoring stale writes.
 * @param state - current row state.
 * @param value - close behavior from the Host scope.
 * @param revision - Host section revision.
 * @returns the same reference when stale, otherwise the adopted state.
 */
export function adoptCloseBehaviorRowState(
  state: CloseBehaviorRowState,
  value: DesktopCloseBehavior,
  revision: number,
): CloseBehaviorRowState {
  if (revision <= state.revision) return state
  return { value, revision }
}
