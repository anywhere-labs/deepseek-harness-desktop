import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

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

interface StoredDesktopRun extends DesktopRunRecord {
  readonly ownerId?: string
}

function lstatOptional(filename: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
}

function assertOwnedMarker(stats: NonNullable<ReturnType<typeof lstatSync>>): void {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
    throw new Error('dsh-plugin-desktop: active run marker is invalid')
  }
}

function readStoredRun(statePath: string): StoredDesktopRun | UnreadableDesktopRun | undefined {
  const pathStats = lstatOptional(statePath)
  if (pathStats === undefined) return undefined
  assertOwnedMarker(pathStats)
  const descriptor = openSync(statePath, constants.O_RDONLY | noFollowFlag())
  try {
    assertOwnedMarker(fstatSync(descriptor))
    const value: unknown = JSON.parse(readFileSync(descriptor, 'utf8'))
    if (typeof value !== 'object' || value === null) return { unreadable: true }
    const record = value as Partial<StoredDesktopRun>
    if (typeof record.startedAt !== 'string'
      || typeof record.pid !== 'number'
      || typeof record.version !== 'string') return { unreadable: true }
    return {
      startedAt: record.startedAt,
      pid: record.pid,
      version: record.version,
      ...(typeof record.ownerId === 'string' ? { ownerId: record.ownerId } : {}),
    }
  } catch (cause) {
    if (cause instanceof SyntaxError) return { unreadable: true }
    throw cause
  } finally {
    closeSync(descriptor)
  }
}

function unlinkTemporary(filename: string): void {
  try {
    unlinkSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}

function writeCurrentRun(statePath: string, currentRun: StoredDesktopRun): void {
  const directory = dirname(statePath)
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const directoryStats = lstatSync(directory)
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error('dsh-plugin-desktop: active run directory is invalid')
  }
  try { chmodSync(directory, PRIVATE_DIRECTORY_MODE) } catch {}

  const temporary = join(directory, `.${basename(statePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(currentRun)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    })
    try { chmodSync(temporary, PRIVATE_FILE_MODE) } catch {}
    renameSync(temporary, statePath)
  } finally {
    unlinkTemporary(temporary)
  }
}

/** Persist this launch and return a marker left behind by an unclean exit. */
export function beginDesktopRun(statePath: string, currentRun: DesktopRunRecord): DesktopRun {
  const storedPreviousRun = readStoredRun(statePath)
  const previousRun = storedPreviousRun === undefined || 'unreadable' in storedPreviousRun
    ? storedPreviousRun
    : {
        startedAt: storedPreviousRun.startedAt,
        pid: storedPreviousRun.pid,
        version: storedPreviousRun.version,
      }
  const ownerId = randomUUID()
  writeCurrentRun(statePath, { ...currentRun, ownerId })
  let clean = false
  return {
    previousRun,
    markClean() {
      if (clean) return
      const storedRun = readStoredRun(statePath)
      if (storedRun === undefined || 'unreadable' in storedRun || storedRun.ownerId !== ownerId) {
        clean = true
        return
      }
      unlinkSync(statePath)
      clean = true
    },
  }
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
}
