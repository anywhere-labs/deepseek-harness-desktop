/** Close-button decision shared by the native window close path. */

import type { DesktopCloseBehavior } from './runtime.ts'

/** What the native close handler should do with one window close event. */
export type DesktopCloseAction = 'allow' | 'hide' | 'quit'

/** Decide how one window close event should proceed. */
export function resolveCloseAction(options: {
  readonly isQuitting: boolean
  readonly closeBehavior: DesktopCloseBehavior
  readonly trayAvailable: boolean
}): DesktopCloseAction {
  if (options.isQuitting) return 'allow'
  if (options.closeBehavior === 'quit') return 'quit'
  return options.trayAvailable ? 'hide' : 'quit'
}
