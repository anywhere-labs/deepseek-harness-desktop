/** Minimal JSONL diagnostics for desktop startup phases. */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Fields accepted by the startup log; raw environment and Host output are excluded. */
export interface DesktopStartupLogEntry {
  readonly event: string
  readonly mode?: 'normal' | 'safe'
  readonly reason?: string
  readonly elapsedMs?: number
}

/** Handle for best-effort structured startup diagnostics. */
export interface DesktopStartupLogger {
  /** Append one event without affecting application startup on a logging failure. */
  write(entry: DesktopStartupLogEntry): void
}

/**
 * Create a daily JSONL startup logger in Electron's application log directory.
 * @param directory - App-specific log directory.
 * @param version - Desktop application version.
 * @param platform - Runtime platform.
 * @returns A best-effort logger that never throws to lifecycle callers.
 */
export function createDesktopStartupLogger(directory: string, version: string, platform: NodeJS.Platform): DesktopStartupLogger {
  const date = new Date().toISOString().slice(0, 10)
  const filename = join(directory, `desktop-startup-${date}.jsonl`)
  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    // A read-only log location cannot block the application.
  }
  return {
    write(entry) {
      try {
        appendFileSync(filename, `${JSON.stringify({
          timestamp: new Date().toISOString(),
          version,
          platform,
          ...entry,
        })}\n`, { encoding: 'utf8', mode: 0o600 })
      } catch {
        // Startup diagnostics are best-effort and carry no application state.
      }
    },
  }
}
