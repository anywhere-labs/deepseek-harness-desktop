/**
 * Opt-in switch that routes Desktop-owned file cleanup through the operating
 * system's recycle bin instead of hard deletion.
 *
 * The recycle bin is a machine-level behaviour (the OS trash is machine-global),
 * and the main-process diagnostic-log cleanup runs before any Profile is
 * selected, so the switch is a process environment flag rather than a
 * per-Profile preference. Set `DSH_DESKTOP_RECYCLE_BIN` to a non-empty value
 * other than `0` or `false` to enable it.
 *
 * The shared `trashItem` shape mirrors `desktop-factory-reset.ts`, which already
 * binds Electron's `shell.trashItem` for the recoverable factory reset.
 */

export const DESKTOP_RECYCLE_BIN_ENV = 'DSH_DESKTOP_RECYCLE_BIN' as const

/** Whether Desktop-owned cleanup should move files to the OS recycle bin. */
export function desktopRecycleBinEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[DESKTOP_RECYCLE_BIN_ENV]
  return value !== undefined && value !== '' && value !== '0' && value !== 'false'
}
