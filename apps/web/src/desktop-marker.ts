// macOS and Windows render their own title bar under the native frame, so the
// page supplies drag regions and titlebar inset. Linux keeps the standard
// system title bar and caption buttons, so it needs no desktop presentation.
const DESKTOP_PLATFORMS = new Set(['darwin', 'win32'])

/**
 * Apply the presentation-only Electron marker before the client tree mounts.
 * @param locationHref - renderer document URL supplied by the desktop shell.
 * @param root - document root that owns platform presentation selectors.
 */
export function applyDesktopPresentationMarker(locationHref: string, root: HTMLElement): void {
  const platform = new URL(locationHref).searchParams.get('dsh-desktop-platform')
  if (platform === null || !DESKTOP_PLATFORMS.has(platform)) return
  root.dataset.dshDesktop = 'true'
  root.dataset.dshDesktopPlatform = platform
}
