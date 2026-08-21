import { app } from 'electron'
import type { BrowserWindow } from 'electron'

/**
 * Return whether an activation event needs to bring the application forward.
 *
 * macOS emits activation events while a visible window is already in front of
 * the user.  Treating every activation as a reveal would steal focus from the
 * application the user just selected, so callers should use this guard for
 * app-level activation events and reserve revealApplication for explicit UI
 * actions such as a tray click or a ready-to-show event.
 */
export function applicationNeedsReveal(
  window: Pick<BrowserWindow, 'isMinimized' | 'isVisible'>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return window.isMinimized()
    || !window.isVisible()
    || platform === 'darwin' && app.isHidden()
}

/** Reveal a native window, restoring the macOS application before the window. */
export function revealApplication(
  window: Pick<BrowserWindow, 'isMinimized' | 'show' | 'restore' | 'focus'>,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'darwin' && app.isHidden()) app.show()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
