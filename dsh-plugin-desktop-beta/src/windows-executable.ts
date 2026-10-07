/** Filesystem probe for Windows executables that a Microsoft Store alias may provide. */

import { lstatSync } from 'node:fs'

/**
 * Whether one Windows path can be handed to `CreateProcess`.
 *
 * A Microsoft Store app execution alias - the entry under
 * `%LOCALAPPDATA%\Microsoft\WindowsApps` named after a packaged executable - is
 * a reparse point into `C:\Program Files\WindowsApps`. That directory denies
 * traversal to unprivileged callers, so `existsSync` follows the reparse point,
 * hits EACCES, and reports `false` for an alias Node spawns perfectly well.
 * Probing with `existsSync` therefore rejects the only PowerShell 7 install a
 * Store-only host has, which on such a host pushed the terminal to a legacy
 * System32 copy that could not create a process at all.
 *
 * `lstatSync` opens the entry itself instead of following the reparse point,
 * which is the contract the harness `dsh-pwsh-local` resolver already relies on.
 * Node reports the alias as a symbolic link on current releases and as a plain
 * file on older ones, and `CreateProcess` resolves either shape; a real
 * directory never matches.
 *
 * @param filename - absolute candidate executable path.
 * @returns whether the entry is a runnable file or reparse point.
 */
export function windowsExecutableProbe(filename: string): boolean {
  try {
    const stat = lstatSync(filename)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}
