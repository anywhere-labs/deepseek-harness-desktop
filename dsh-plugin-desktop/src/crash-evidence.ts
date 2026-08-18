import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Minimal Electron crash reporter surface used before the app is ready. */
export interface DesktopCrashReporter {
  start(options: {
    readonly productName: string
    readonly uploadToServer: false
    readonly globalExtra: Record<string, string>
  }): void
}

export interface DesktopCrashMetadata {
  readonly productName: string
  readonly version: string
  readonly platform: string
  readonly arch: string
}

/** Start local-only Crashpad collection for native main and child process failures. */
export function startDesktopCrashReporting(
  reporter: DesktopCrashReporter,
  metadata: DesktopCrashMetadata,
): void {
  reporter.start({
    productName: metadata.productName,
    uploadToServer: false,
    globalExtra: {
      appVersion: metadata.version,
      platform: metadata.platform,
      arch: metadata.arch,
    },
  })
}

/** Identity persisted while one desktop process is active. */
export interface DesktopRunRecord {
  readonly startedAt: string
  readonly pid: number
  readonly version: string
}

export interface UnreadableDesktopRun {
  readonly unreadable: true
}

/** Active run marker and evidence recovered from the previous launch. */
export interface DesktopRun {
  readonly previousRun: DesktopRunRecord | UnreadableDesktopRun | undefined
  /** Remove this process's active marker before a controlled exit. */
  markClean(): void
}

function readPreviousRun(statePath: string): DesktopRunRecord | UnreadableDesktopRun | undefined {
  if (!existsSync(statePath)) return undefined
  try {
    const value: unknown = JSON.parse(readFileSync(statePath, 'utf8'))
    if (typeof value !== 'object' || value === null) return { unreadable: true }
    const record = value as Partial<DesktopRunRecord>
    if (typeof record.startedAt !== 'string'
      || typeof record.pid !== 'number'
      || typeof record.version !== 'string') return { unreadable: true }
    return { startedAt: record.startedAt, pid: record.pid, version: record.version }
  } catch (cause) {
    if (cause instanceof SyntaxError) return { unreadable: true }
    throw cause
  }
}

/** Persist this launch and return a marker left behind by an unclean exit. */
export function beginDesktopRun(statePath: string, currentRun: DesktopRunRecord): DesktopRun {
  const previousRun = readPreviousRun(statePath)
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(currentRun)}\n`, 'utf8')
  let clean = false
  return {
    previousRun,
    markClean() {
      if (clean) return
      clean = true
      unlinkSync(statePath)
    },
  }
}
