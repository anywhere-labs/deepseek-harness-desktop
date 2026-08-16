/** Add the target installation capability to generated Electron Updater metadata. */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Installation capability published with one target artifact. */
export type PublishedUpdateMode = 'automatic' | 'manual'

/**
 * Record whether clients may install the target release in-process.
 * @param path - Generated latest YAML metadata path.
 * @param mode - Verified installation capability of the target artifact.
 */
export function markDesktopUpdateMetadata(path: string, mode: PublishedUpdateMode): void {
  const source = readFileSync(path, 'utf8')
  const line = `desktopUpdateMode: ${mode}`
  const next = /^desktopUpdateMode:[ \t]*\S+[ \t]*$/m.test(source)
    ? source.replace(/^desktopUpdateMode:[ \t]*\S+[ \t]*$/m, line)
    : `${source.trimEnd()}\n${line}\n`
  writeFileSync(path, next, 'utf8')
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2]
  const mode = process.argv[3]
  if (path === undefined || (mode !== 'automatic' && mode !== 'manual')) {
    console.error('usage: mark-update-metadata.ts <latest.yml> <automatic|manual>')
    process.exitCode = 1
  } else {
    try {
      markDesktopUpdateMetadata(resolve(path), mode)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
