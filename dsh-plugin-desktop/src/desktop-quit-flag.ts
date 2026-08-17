/** Flag used by the Windows installer to stop a running desktop instance. */
export const DESKTOP_QUIT_FLAG = '--quit'

/**
 * Detect the installer-owned quit request on a process argument list.
 * @param argv - Electron process or second-instance arguments.
 * @returns true when the running instance should exit instead of showing a window.
 */
export function hasDesktopQuitFlag(argv: readonly string[]): boolean {
  return argv.includes(DESKTOP_QUIT_FLAG)
}
