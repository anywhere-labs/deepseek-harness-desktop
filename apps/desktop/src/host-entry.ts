/** Resolve the Node CLI entry launched by the desktop Host supervisor. */

import { resolve } from 'node:path'

/**
 * Select the built-in Host entry unless deployment configures another path.
 * @param builtinEntry - Checkout or packaged DSH CLI entry.
 * @param configuredEntry - Optional Node-compatible CLI entry path.
 * @returns The absolute configured path or the built-in entry.
 */
export function resolveHostEntry(builtinEntry: string, configuredEntry: string | undefined): string {
  return configuredEntry === undefined ? builtinEntry : resolve(configuredEntry)
}
