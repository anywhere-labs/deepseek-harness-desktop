/**
 * A small, profile-scoped last-known-good checkpoint for Desktop startup.
 *
 * This module deliberately only restores the declarative profile files. It
 * does not run pnpm and it never copies `node_modules` (or any other hot
 * runtime state).
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const BIN_NAME = 'dsh-plugin-desktop'
const VERSION = 1
const SNAPSHOT_ROOT = 'health-snapshots'
const LATEST_DIRECTORY = 'latest'
const MANIFEST_FILENAME = 'manifest.json'
const MARKER_FILENAME = 'restore-marker.json'
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700
const CHECK_POSIX_MODE = process.platform !== 'win32'
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,256}$/u

/** Files that can be checkpointed. The market state is optional. */
export const DESKTOP_PROFILE_CHECKPOINT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  '.dsh-market/state.json',
] as const

export type DesktopProfileCheckpointFilename = typeof DESKTOP_PROFILE_CHECKPOINT_FILES[number]

const FILE_LIMITS: Record<DesktopProfileCheckpointFilename, number> = {
  'package.json': 1 * 1024 * 1024,
  'pnpm-lock.yaml': 32 * 1024 * 1024,
  'pnpm-workspace.yaml': 1 * 1024 * 1024,
  'cordis.patch.yml': 1 * 1024 * 1024,
  '.dsh-market/state.json': 1 * 1024 * 1024,
}

export interface ProfileCheckpointOptions {
  /** Electron's userData directory. */
  readonly userDataDir?: string
  /** Alias accepted by callers that use the Electron name. */
  readonly userData?: string
  /** Absolute profile directory. */
  readonly profileDir?: string
  /** Alias accepted by profile services. */
  readonly profilePath?: string
  /** Stable identity supplied by the profile owner. */
  readonly profileIdentity?: string
  /** Human-readable profile name persisted in the manifest. */
  readonly profileName?: string
  /** Market/provider identity persisted in the manifest. */
  readonly provider?: string
  /** Override per-file limits in tests or an embedding product. */
  readonly maxFileBytes?: Partial<Record<DesktopProfileCheckpointFilename, number>>
  /** Clock injection for deterministic tests. */
  readonly now?: () => number
}

export interface ProfileCheckpointFileRecord {
  readonly name: DesktopProfileCheckpointFilename
  readonly present: boolean
  readonly sha256?: string
  readonly size?: number
  readonly mode?: number
}

export interface ProfileCheckpointManifest {
  readonly version: 1
  readonly snapshotId: string
  readonly capturedAt: string
  readonly profileIdentity: string
  readonly profileName: string
  readonly provider: string
  readonly files: readonly ProfileCheckpointFileRecord[]
}

export interface CaptureHealthyResult {
  readonly snapshotExists: true
  readonly deduplicated: boolean
  readonly snapshotDirectory: string
  readonly manifest: ProfileCheckpointManifest
}

export interface RestoreInspection {
  readonly snapshotExists: boolean
  readonly currentDiffers: boolean
  readonly restoreAttempted: boolean
  readonly failureGeneration?: string
  readonly changedFiles: readonly DesktopProfileCheckpointFilename[]
  readonly manifest?: ProfileCheckpointManifest
}

export type RestoreResult =
  | {
      readonly status: 'restored'
      readonly changedFiles: readonly DesktopProfileCheckpointFilename[]
      readonly snapshotDirectory: string
      readonly failureGeneration: string
    }
  | {
      readonly status: 'already-attempted'
      readonly changedFiles: readonly DesktopProfileCheckpointFilename[]
      readonly snapshotDirectory: string
      readonly failureGeneration: string
    }

interface RestoreMarker {
  readonly version: 1
  readonly failureGeneration: string
  readonly attemptedAt: string
}

interface FileImage {
  readonly present: boolean
  readonly sha256?: string
  readonly size?: number
  readonly mode?: number
}

function fail(message: string): never {
  throw new Error(`${BIN_NAME}: ${message}`)
}

function assertAbsolute(label: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value) || value.includes('\0')) {
    fail(`${label} must be an absolute path without NUL`)
  }
  return resolve(value)
}

function assertIdentifier(label: string, value: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || value.includes('\\')) {
    fail(`invalid ${label}`)
  }
  return value
}

function assertProfileName(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255
    || value.includes('/') || value.includes('\\') || /[\0\r\n]/u.test(value)) {
    fail('invalid profile name')
  }
  return value
}

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isENOENT(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Require a real, non-symlink directory and return its canonical path. */
function realDirectory(label: string, path: string): string {
  const absolute = assertAbsolute(label, path)
  let item
  try {
    item = lstatSync(absolute)
  } catch (cause) {
    fail(`${label} is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!item.isDirectory() || item.isSymbolicLink()) fail(`${label} must be a real directory`)
  // `realpathSync` confirms the directory is reachable. Do not compare its
  // spelling with the input: macOS commonly exposes /var through /private/var
  // even when neither of the caller-owned directory entries is a symlink.
  realpathSync(absolute)
  return absolute
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE })
  const item = lstatSync(path)
  if (!item.isDirectory() || item.isSymbolicLink()) fail(`checkpoint directory is not a real directory: ${path}`)
  // chmod is intentional: an existing directory may have inherited a wider mode.
  if (CHECK_POSIX_MODE && (item.mode & 0o777) !== DIRECTORY_MODE) {
    // The caller owns this private directory; narrowing it is safe and avoids
    // exposing a checkpoint through a permissive umask/previous installation.
    chmodSync(path, DIRECTORY_MODE)
  }
}

function writeDurable(path: string, bytes: Uint8Array, mode = FILE_MODE): void {
  ensureDirectory(dirname(path))
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', mode)
    writeSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    // A directory fsync is supported on Unix. Windows may reject opening a
    // directory, but the rename itself remains atomic and durable enough for
    // the supported filesystem there.
    try {
      const directoryFd = openSync(dirname(path), 'r')
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    } catch { /* platform/filesystem without directory fsync */ }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* already renamed */ }
  }
}

function readJson(path: string): unknown {
  const item = lstatSync(path)
  if (!item.isFile() || item.isSymbolicLink() || (CHECK_POSIX_MODE && (item.mode & 0o777) !== FILE_MODE)) {
    fail(`checkpoint file has unsafe type or mode: ${path}`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function fileEqual(left: FileImage, right: FileImage): boolean {
  return left.present === right.present && (!left.present
    || left.sha256 === right.sha256 && left.size === right.size && left.mode === right.mode)
}

function filePath(root: string, name: DesktopProfileCheckpointFilename): string {
  const path = join(root, ...name.split('/'))
  const expected = resolve(root, ...name.split('/'))
  if (path !== expected || relative(root, path).startsWith('..')) fail('checkpoint filename escaped its root')
  return path
}

function assertProfileFileParent(profileDir: string, name: DesktopProfileCheckpointFilename): void {
  const parent = dirname(filePath(profileDir, name))
  try {
    const item = lstatSync(parent)
    if (item.isSymbolicLink() || !item.isDirectory()) fail(`profile checkpoint parent must be a real directory: ${name}`)
    realpathSync(parent)
  } catch (cause) {
    if (!isENOENT(cause)) throw cause
  }
}

/** Profile-scoped latest healthy snapshot manager. */
export class DesktopProfileCheckpoint {
  readonly userDataDir: string
  readonly profileDir: string
  readonly profileIdentity: string
  readonly profileName: string
  readonly provider: string
  readonly snapshotDirectory: string

  private readonly limits: Record<DesktopProfileCheckpointFilename, number>
  private readonly now: () => number

  constructor(options: ProfileCheckpointOptions) {
    const userData = options.userDataDir ?? options.userData
    const profile = options.profileDir ?? options.profilePath
    if (userData === undefined || profile === undefined) fail('userDataDir and profileDir are required')
    this.userDataDir = realDirectory('userDataDir', userData)
    this.profileDir = realDirectory('profileDir', profile)
    this.profileIdentity = assertIdentifier('profile identity', options.profileIdentity ?? hash(this.profileDir))
    this.profileName = assertProfileName(options.profileName ?? 'desktop')
    this.provider = assertIdentifier('provider', options.provider ?? 'unknown')
    this.now = options.now ?? Date.now
    this.limits = { ...FILE_LIMITS, ...(options.maxFileBytes ?? {}) }
    for (const name of DESKTOP_PROFILE_CHECKPOINT_FILES) {
      if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] < 0) fail(`invalid size limit for ${name}`)
    }
    const profileKey = hash(this.profileIdentity)
    const root = join(this.userDataDir, SNAPSHOT_ROOT)
    ensureDirectory(root)
    this.snapshotDirectory = join(root, profileKey, LATEST_DIRECTORY)
  }

  /** Capture the current healthy declarative profile state. */
  captureHealthy(): CaptureHealthyResult {
    this.recoverOrphanedLatest()
    ensureDirectory(dirname(this.snapshotDirectory))
    const current = this.readCurrentImages(true)
    const existing = this.readSnapshot(false)
    if (existing !== undefined && existing.manifest.profileIdentity === this.profileIdentity
      && existing.manifest.profileName === this.profileName && existing.manifest.provider === this.provider
      && existing.manifest.files.every((record, index) => fileEqual(record, current[index]!))) {
      // A successful generation starts a fresh recovery window. Retaining a
      // previous failed-generation marker would make inspectRestore report a
      // stale attempt and could incorrectly suppress the next failure.
      try { unlinkSync(join(existing.directory, MARKER_FILENAME)) } catch (cause) {
        if (!isENOENT(cause)) throw cause
      }
      return { snapshotExists: true, deduplicated: true, snapshotDirectory: this.snapshotDirectory, manifest: existing.manifest }
    }

    const snapshotId = randomUUID()
    const staging = join(dirname(this.snapshotDirectory), `.staging-${process.pid}-${snapshotId}`)
    ensureDirectory(staging)
    try {
      const records: ProfileCheckpointFileRecord[] = []
      for (let index = 0; index < DESKTOP_PROFILE_CHECKPOINT_FILES.length; index += 1) {
        const name = DESKTOP_PROFILE_CHECKPOINT_FILES[index]!
        const image = current[index]!
        records.push({ name, ...image })
        if (image.present) {
          const source = filePath(this.profileDir, name)
          const destination = filePath(staging, name)
          ensureDirectory(dirname(destination))
          const bytes = readFileSync(source)
          writeDurable(destination, bytes)
        }
      }
      const manifest: ProfileCheckpointManifest = {
        version: VERSION,
        snapshotId,
        capturedAt: new Date(this.now()).toISOString(),
        profileIdentity: this.profileIdentity,
        profileName: this.profileName,
        provider: this.provider,
        files: records,
      }
      writeDurable(join(staging, MANIFEST_FILENAME), Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'))
      if (existsSync(this.snapshotDirectory)) {
        const old = `${this.snapshotDirectory}.old-${randomUUID()}`
        renameSync(this.snapshotDirectory, old)
        try { renameSync(staging, this.snapshotDirectory) } catch (cause) {
          renameSync(old, this.snapshotDirectory)
          throw cause
        }
        rmSync(old, { recursive: true, force: true })
      } else {
        renameSync(staging, this.snapshotDirectory)
      }
      return { snapshotExists: true, deduplicated: false, snapshotDirectory: this.snapshotDirectory, manifest }
    } catch (cause) {
      rmSync(staging, { recursive: true, force: true })
      throw cause
    }
  }

  /** Inspect drift without changing either the profile or the checkpoint. */
  inspectRestore(failureGeneration?: string): RestoreInspection {
    this.recoverOrphanedLatest()
    const requestedGeneration = failureGeneration === undefined
      ? undefined
      : assertIdentifier('failure generation', failureGeneration)
    const snapshot = this.readSnapshot(false)
    if (snapshot === undefined) return { snapshotExists: false, currentDiffers: false, restoreAttempted: false, changedFiles: [] }
    const current = this.readCurrentImages(false)
    const changedFiles = DESKTOP_PROFILE_CHECKPOINT_FILES.filter((_, index) => !fileEqual(snapshot.manifest.files[index]!, current[index]!))
    const marker = this.readMarker(snapshot.directory)
    return {
      snapshotExists: true,
      currentDiffers: changedFiles.length > 0,
      restoreAttempted: marker !== undefined
        && (requestedGeneration === undefined || marker.failureGeneration === requestedGeneration),
      ...(marker === undefined ? {} : { failureGeneration: marker.failureGeneration }),
      changedFiles,
      manifest: snapshot.manifest,
    }
  }

  /** Restore the latest complete snapshot once for one failed startup generation. */
  restoreLatest(failureGeneration: string): RestoreResult {
    this.recoverOrphanedLatest()
    const generation = assertIdentifier('failure generation', failureGeneration)
    const snapshot = this.readSnapshot(true)
    if (snapshot === undefined) fail('no healthy profile checkpoint exists')
    const current = this.readCurrentImages(false)
    const changedFiles = DESKTOP_PROFILE_CHECKPOINT_FILES.filter((_, index) => !fileEqual(snapshot.manifest.files[index]!, current[index]!))
    const marker = this.readMarker(snapshot.directory)
    if (marker?.failureGeneration === generation) {
      return { status: 'already-attempted', changedFiles, snapshotDirectory: this.snapshotDirectory, failureGeneration: generation }
    }

    // Mark before touching the profile. If the process crashes during restore,
    // a retrying startup cannot loop forever; an explicit user request can use
    // a fresh generation token.
    writeDurable(join(snapshot.directory, MARKER_FILENAME), Buffer.from(`${JSON.stringify({
      version: VERSION,
      failureGeneration: generation,
      attemptedAt: new Date(this.now()).toISOString(),
    } satisfies RestoreMarker)}\n`, 'utf8'))
    for (let index = 0; index < DESKTOP_PROFILE_CHECKPOINT_FILES.length; index += 1) {
      const name = DESKTOP_PROFILE_CHECKPOINT_FILES[index]!
      const record = snapshot.manifest.files[index]!
      assertProfileFileParent(this.profileDir, name)
      const target = filePath(this.profileDir, name)
      if (record.present) {
        const backup = filePath(snapshot.directory, name)
        const bytes = readFileSync(backup)
        // The complete-backup validation already checked this, but verify at
        // the point of use as well in case the filesystem changed in between.
        if (hash(bytes) !== record.sha256 || bytes.byteLength !== record.size) fail(`checkpoint changed during restore: ${name}`)
        writeDurable(target, bytes, record.mode)
      } else {
        try {
          const item = lstatSync(target)
          if (item.isSymbolicLink() || !item.isFile()) fail(`cannot remove unsafe profile entry: ${name}`)
          unlinkSync(target)
        } catch (cause) {
          if (!isENOENT(cause)) throw cause
        }
      }
    }
    return { status: 'restored', changedFiles, snapshotDirectory: this.snapshotDirectory, failureGeneration: generation }
  }

  private readCurrentImages(requirePackage: boolean): FileImage[] {
    return DESKTOP_PROFILE_CHECKPOINT_FILES.map(name => {
      assertProfileFileParent(this.profileDir, name)
      const path = filePath(this.profileDir, name)
      let item
      try { item = lstatSync(path) } catch (cause) {
        if (isENOENT(cause)) {
          if (requirePackage && name === 'package.json') fail('healthy profile package.json is unavailable')
          return { present: false }
        }
        throw cause
      }
      if (item.isSymbolicLink() || !item.isFile()) fail(`profile checkpoint entry must be a regular file: ${name}`)
      const size = item.size
      if (size > this.limits[name]) fail(`profile checkpoint file is too large: ${name}`)
      const bytes = readFileSync(path)
      return { present: true, sha256: hash(bytes), size: bytes.byteLength, mode: item.mode & 0o777 }
    })
  }

  /** Recover the previous generation if a process died between directory renames. */
  private recoverOrphanedLatest(): void {
    if (existsSync(this.snapshotDirectory)) return
    const parent = dirname(this.snapshotDirectory)
    let candidates: string[]
    try {
      candidates = readdirSync(parent).filter(name => name.startsWith(`${LATEST_DIRECTORY}.old-`)).sort().reverse()
    } catch (cause) {
      if (isENOENT(cause)) return
      throw cause
    }
    for (const name of candidates) {
      const candidate = join(parent, name)
      try {
        const item = lstatSync(candidate)
        if (!item.isDirectory() || item.isSymbolicLink()
          || (CHECK_POSIX_MODE && (item.mode & 0o777) !== DIRECTORY_MODE)) continue
        renameSync(candidate, this.snapshotDirectory)
        return
      } catch (cause) {
        if (!isENOENT(cause)) throw cause
      }
    }
  }

  private readMarker(directory: string): RestoreMarker | undefined {
    const path = join(directory, MARKER_FILENAME)
    try {
      const value = readJson(path)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('restore marker is invalid')
      const marker = value as Record<string, unknown>
      if (marker.version !== VERSION || typeof marker.failureGeneration !== 'string'
        || !ID_PATTERN.test(marker.failureGeneration) || typeof marker.attemptedAt !== 'string') fail('restore marker is invalid')
      return marker as unknown as RestoreMarker
    } catch (cause) {
      if (isENOENT(cause)) return undefined
      throw cause
    }
  }

  private readSnapshot(requireComplete: boolean): { readonly directory: string; readonly manifest: ProfileCheckpointManifest } | undefined {
    try {
      const directoryItem = lstatSync(this.snapshotDirectory)
      if (!directoryItem.isDirectory() || directoryItem.isSymbolicLink()
        || (CHECK_POSIX_MODE && (directoryItem.mode & 0o777) !== DIRECTORY_MODE)) {
        fail('latest checkpoint directory has unsafe type or mode')
      }
      const value = readJson(join(this.snapshotDirectory, MANIFEST_FILENAME))
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('checkpoint manifest is invalid')
      const object = value as Record<string, unknown>
      const files = object.files
      if (object.version !== VERSION || typeof object.snapshotId !== 'string' || !ID_PATTERN.test(object.snapshotId)
        || typeof object.capturedAt !== 'string' || object.profileIdentity !== this.profileIdentity
        || object.profileName !== this.profileName || object.provider !== this.provider
        || !Array.isArray(files) || files.length !== DESKTOP_PROFILE_CHECKPOINT_FILES.length) fail('checkpoint manifest is invalid')
      for (let index = 0; index < DESKTOP_PROFILE_CHECKPOINT_FILES.length; index += 1) {
        const record = files[index]
        const expected = DESKTOP_PROFILE_CHECKPOINT_FILES[index]!
        if (record === null || typeof record !== 'object' || Array.isArray(record)) fail('checkpoint manifest is invalid')
        const item = record as Record<string, unknown>
        if (item.name !== expected || typeof item.present !== 'boolean') fail('checkpoint manifest is invalid')
        if (item.present && (typeof item.sha256 !== 'string' || !HASH_PATTERN.test(item.sha256)
          || !Number.isSafeInteger(item.size) || (item.size as number) < 0 || (item.size as number) > this.limits[expected]
          || !Number.isSafeInteger(item.mode) || (item.mode as number) < 0 || (item.mode as number) > 0o777)) fail('checkpoint manifest is invalid')
        const backup = filePath(this.snapshotDirectory, expected)
        if (item.present) {
          const backupItem = lstatSync(backup)
          if (!backupItem.isFile() || backupItem.isSymbolicLink()
            || (CHECK_POSIX_MODE && (backupItem.mode & 0o777) !== FILE_MODE)) fail(`checkpoint backup is unsafe: ${expected}`)
          const bytes = readFileSync(backup)
          if (bytes.byteLength !== item.size || hash(bytes) !== item.sha256) fail(`checkpoint backup is incomplete: ${expected}`)
        } else if (existsSync(backup)) {
          fail(`checkpoint contains an unexpected backup: ${expected}`)
        }
      }
      if (requireComplete && !files.some((record: Record<string, unknown>) => record.present === true)) {
        fail('checkpoint contains no restorable files')
      }
      return { directory: this.snapshotDirectory, manifest: value as unknown as ProfileCheckpointManifest }
    } catch (cause) {
      if (isENOENT(cause)) {
        try {
          lstatSync(this.snapshotDirectory)
        } catch (directoryCause) {
          if (isENOENT(directoryCause)) return undefined
        }
      }
      throw cause
    }
  }
}

/** Factory spelling used by profile services. */
export function createDesktopProfileCheckpoint(options: ProfileCheckpointOptions): DesktopProfileCheckpoint {
  return new DesktopProfileCheckpoint(options)
}

/** Remove the latest health checkpoint for one profile without touching others. */
export function clearDesktopProfileCheckpoint(userDataDir: string, profileDir: string): void {
  const userData = realDirectory('userDataDir', userDataDir)
  const profile = assertAbsolute('profileDir', profileDir)
  const profileIdentity = hash(profile)
  const snapshotDirectory = join(userData, SNAPSHOT_ROOT, hash(profileIdentity), LATEST_DIRECTORY)
  let item
  try {
    item = lstatSync(snapshotDirectory)
  } catch (cause) {
    if (isENOENT(cause)) return
    throw cause
  }
  if (item.isSymbolicLink() || !item.isDirectory()) {
    fail('profile checkpoint latest directory has unsafe type')
  }
  rmSync(snapshotDirectory, { recursive: true, force: false })
}

/** Compatibility aliases for embedders that call this a health checkpoint. */
export { DesktopProfileCheckpoint as HealthProfileCheckpoint, DesktopProfileCheckpoint as ProfileHealthCheckpoint }
