/** Crash-recoverable write-ahead log for one Desktop-managed plugin install. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertDesktopProfileName } from './profile-manager.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const STATE_VERSION = 1
const STATE_DIRECTORY_NAME = 'plugin-install-recovery'
const STATE_FILENAME = 'state.json'
const BACKUP_DIRECTORY_NAME = 'backups'
const STATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
const MAX_STATE_BYTES = 64 * 1024
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024
const MAX_WORKSPACE_BYTES = 1024 * 1024
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/u

/** Environment hand-off used by the built-in terminal to find Desktop's fixed recovery WAL. */
export const DESKTOP_INSTALL_RECOVERY_STATE_ENV = 'DSH_DESKTOP_INSTALL_RECOVERY_STATE_PATH'

/** Files whose pre-install bytes are sufficient to restore one profile's declarative state. */
export const DESKTOP_INSTALL_RECOVERY_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
] as const

export type DesktopInstallRecoveryFilename = typeof DESKTOP_INSTALL_RECOVERY_FILES[number]

const FILE_LIMITS: Record<DesktopInstallRecoveryFilename, number> = {
  'package.json': MAX_PACKAGE_MANIFEST_BYTES,
  'pnpm-lock.yaml': MAX_LOCKFILE_BYTES,
  'pnpm-workspace.yaml': MAX_WORKSPACE_BYTES,
}

export type DesktopInstallRecoveryPhase =
  | 'prepared'
  | 'awaiting-restart'
  | 'verifying'
  | 'recovery-pending'
  | 'retry-requested'
  | 'verified'
  | 'rolled-back'
  | 'manual-recovery-required'

export type DesktopInstallRecoveryFailureReason =
  | 'install-failed'
  | 'interrupted-install'
  | 'startup-failed'
  | 'startup-unconfirmed'
  | 'renderer-failed'
  | 'renderer-timeout'
  | 'recovery-failed'

/** Hash-only description of one file state. Profile contents never enter the WAL. */
export type DesktopInstallRecoveryFileImage =
  | { readonly present: false }
  | {
      readonly present: true
      readonly sha256: string
      readonly size: number
      readonly mode: number
      /** Safe leaf name below this transaction's private backup directory. */
      readonly backupFile?: string
    }

/** Pre-install backup and optional sealed post-install identity for one allowlisted file. */
export interface DesktopInstallRecoveryFileRecord {
  readonly name: DesktopInstallRecoveryFilename
  readonly before: DesktopInstallRecoveryFileImage
  readonly after?: DesktopInstallRecoveryFileImage
}

/** Safe transaction metadata persisted outside the DSH profile. */
export interface DesktopInstallRecoveryTransaction {
  readonly version: 1
  readonly transactionId: string
  readonly profileName: string
  /** Hash of the absolute profile directory; the path itself is never persisted. */
  readonly profileIdentity: string
  readonly packageName: string
  readonly packageVersion: string
  readonly receiptId: string
  readonly createdByGeneration: string
  readonly createdAt: string
  readonly phase: DesktopInstallRecoveryPhase
  readonly files: readonly DesktopInstallRecoveryFileRecord[]
  readonly sealedAt?: string
  readonly verifyingGeneration?: string
  readonly verificationStartedAt?: string
  readonly verifiedAt?: string
  readonly restoredAt?: string
  /** Set only after the healthy post-rollback generation showed its native summary. */
  readonly rollbackNotifiedAt?: string
  readonly failureReason?: DesktopInstallRecoveryFailureReason
  readonly mismatchedFiles?: readonly DesktopInstallRecoveryFilename[]
}

export interface BeginDesktopInstallRecoveryInput {
  readonly packageName: string
  readonly packageVersion: string
  /** Host-generated before the package operation so every crash window can reconcile the receipt. */
  readonly receiptId: string
}

export interface DesktopInstallRecoveryStoreOptions {
  /** Absolute Desktop-private WAL path, normally returned by {@link desktopInstallRecoveryStatePath}. */
  readonly statePath: string
  readonly profileName: string
  readonly profileDir: string
  /** Opaque identity minted once for the current Electron main generation. */
  readonly generationId: string
  readonly now?: () => number
}

export type DesktopInstallRecoveryClaim =
  | { readonly action: 'none' }
  | {
      readonly action: 'deferred'
      readonly reason: 'origin-generation' | 'profile-mismatch'
      readonly transaction: DesktopInstallRecoveryTransaction
    }
  | { readonly action: 'verify'; readonly transaction: DesktopInstallRecoveryTransaction }
  | {
      readonly action: 'prompt'
      readonly reason: 'interrupted-install' | 'startup-unconfirmed'
      readonly transaction: DesktopInstallRecoveryTransaction
    }
  | { readonly action: 'terminal'; readonly transaction: DesktopInstallRecoveryTransaction }

export type DesktopInstallRecoveryRestoreResult =
  | { readonly status: 'restored'; readonly transaction: DesktopInstallRecoveryTransaction }
  | { readonly status: 'already-restored'; readonly transaction: DesktopInstallRecoveryTransaction }
  | {
      readonly status: 'manual-recovery-required'
      readonly transaction: DesktopInstallRecoveryTransaction
      readonly mismatchedFiles: readonly DesktopInstallRecoveryFilename[]
    }

interface ReadFileImage {
  readonly metadata: DesktopInstallRecoveryFileImage
  readonly bytes?: Buffer
}

function isENOENT(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function timestamp(now: () => number): string {
  return new Date(now()).toISOString()
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function profileIdentity(profileDir: string): string {
  return sha256(resolve(profileDir))
}

function assertAbsoluteFile(label: string, value: string): string {
  if (!isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${BIN_NAME}: ${label} must be an absolute path without NUL`)
  }
  return resolve(value)
}

function assertOpaqueId(label: string, value: string): void {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`${BIN_NAME}: invalid plugin install recovery ${label}`)
  }
}

function assertPackageVersion(value: string): void {
  if (value.length < 1 || value.length > 128 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${BIN_NAME}: invalid plugin install recovery package version`)
  }
}

function sameImage(left: DesktopInstallRecoveryFileImage, right: DesktopInstallRecoveryFileImage): boolean {
  return left.present === right.present
    && (!left.present || right.present
      && left.sha256 === right.sha256
      && left.size === right.size
      && left.mode === right.mode)
}

function isFilename(value: unknown): value is DesktopInstallRecoveryFilename {
  return typeof value === 'string'
    && (DESKTOP_INSTALL_RECOVERY_FILES as readonly string[]).includes(value)
}

function validImage(
  value: unknown,
  filename: DesktopInstallRecoveryFilename,
  before: boolean,
): value is DesktopInstallRecoveryFileImage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const image = value as Record<string, unknown>
  if (image.present === false) return Object.keys(image).length === 1
  if (image.present !== true
    || typeof image.sha256 !== 'string'
    || !HASH_PATTERN.test(image.sha256)
    || !Number.isSafeInteger(image.size)
    || (image.size as number) < 0
    || (image.size as number) > FILE_LIMITS[filename]
    || !Number.isSafeInteger(image.mode)
    || (image.mode as number) < 0
    || (image.mode as number) > 0o777) return false
  const expectedBackup = `${filename}.before`
  if (before) return image.backupFile === expectedBackup && Object.keys(image).length === 5
  return image.backupFile === undefined && Object.keys(image).length === 4
}

function validFileRecord(value: unknown, expectedName: DesktopInstallRecoveryFilename): value is DesktopInstallRecoveryFileRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const file = value as Record<string, unknown>
  if (file.name !== expectedName || !validImage(file.before, expectedName, true)) return false
  if (file.after !== undefined && !validImage(file.after, expectedName, false)) return false
  return Object.keys(file).every(key => key === 'name' || key === 'before' || key === 'after')
}

function validFileRecords(value: unknown): value is readonly DesktopInstallRecoveryFileRecord[] {
  return Array.isArray(value)
    && value.length === DESKTOP_INSTALL_RECOVERY_FILES.length
    && DESKTOP_INSTALL_RECOVERY_FILES.every((name, index) => validFileRecord(value[index], name))
}

function parseTransaction(value: unknown): DesktopInstallRecoveryTransaction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('state must be an object')
  const state = value as Record<string, unknown>
  const phases: readonly DesktopInstallRecoveryPhase[] = [
    'prepared',
    'awaiting-restart',
    'verifying',
    'recovery-pending',
    'retry-requested',
    'verified',
    'rolled-back',
    'manual-recovery-required',
  ]
  if (state.version !== STATE_VERSION
    || typeof state.transactionId !== 'string'
    || !OPAQUE_ID_PATTERN.test(state.transactionId)
    || typeof state.profileName !== 'string'
    || typeof state.profileIdentity !== 'string'
    || !HASH_PATTERN.test(state.profileIdentity)
    || typeof state.packageName !== 'string'
    || !PACKAGE_NAME_PATTERN.test(state.packageName)
    || typeof state.packageVersion !== 'string'
    || state.packageVersion.length < 1
    || state.packageVersion.length > 128
    || /[\0\r\n]/u.test(state.packageVersion)
    || typeof state.receiptId !== 'string'
    || !OPAQUE_ID_PATTERN.test(state.receiptId)
    || typeof state.createdByGeneration !== 'string'
    || !OPAQUE_ID_PATTERN.test(state.createdByGeneration)
    || typeof state.createdAt !== 'string'
    || Number.isNaN(Date.parse(state.createdAt))
    || typeof state.phase !== 'string'
    || !phases.includes(state.phase as DesktopInstallRecoveryPhase)
    || !validFileRecords(state.files)) {
    throw new Error('state fields are invalid')
  }
  assertDesktopProfileName(state.profileName)
  const optionalDates = [
    'sealedAt',
    'verificationStartedAt',
    'verifiedAt',
    'restoredAt',
    'rollbackNotifiedAt',
  ] as const
  for (const key of optionalDates) {
    const date = state[key]
    if (date !== undefined && (typeof date !== 'string' || Number.isNaN(Date.parse(date)))) {
      throw new Error(`state ${key} is invalid`)
    }
  }
  if (state.verifyingGeneration !== undefined
    && (typeof state.verifyingGeneration !== 'string' || !OPAQUE_ID_PATTERN.test(state.verifyingGeneration))) {
    throw new Error('state verifyingGeneration is invalid')
  }
  const reasons: readonly DesktopInstallRecoveryFailureReason[] = [
    'install-failed',
    'interrupted-install',
    'startup-failed',
    'startup-unconfirmed',
    'renderer-failed',
    'renderer-timeout',
    'recovery-failed',
  ]
  if (state.failureReason !== undefined
    && (typeof state.failureReason !== 'string'
      || !reasons.includes(state.failureReason as DesktopInstallRecoveryFailureReason))) {
    throw new Error('state failureReason is invalid')
  }
  if (state.mismatchedFiles !== undefined && (
    !Array.isArray(state.mismatchedFiles)
    || state.mismatchedFiles.length > DESKTOP_INSTALL_RECOVERY_FILES.length
    || !state.mismatchedFiles.every(isFilename)
    || new Set(state.mismatchedFiles).size !== state.mismatchedFiles.length
  )) throw new Error('state mismatchedFiles are invalid')
  return state as unknown as DesktopInstallRecoveryTransaction
}

/** Resolve the fixed Desktop-private state file, with an explicit terminal-only environment hand-off. */
export function desktopInstallRecoveryStatePath(
  userDataDir: string,
  environment?: NodeJS.ProcessEnv,
): string {
  const configured = environment?.[DESKTOP_INSTALL_RECOVERY_STATE_ENV]
  if (configured !== undefined) {
    const statePath = assertAbsoluteFile('plugin install recovery environment state path', configured)
    if (basename(statePath) !== STATE_FILENAME || basename(dirname(statePath)) !== STATE_DIRECTORY_NAME) {
      throw new Error(`${BIN_NAME}: plugin install recovery environment state path must use the fixed private directory`)
    }
    return statePath
  }
  const userData = assertAbsoluteFile('user data directory', userDataDir)
  return join(userData, STATE_DIRECTORY_NAME, STATE_FILENAME)
}

/** Durable metadata and private preimages for one active profile generation. */
export class DesktopInstallRecoveryStore {
  readonly statePath: string
  readonly profileName: string
  readonly profileDir: string
  readonly generationId: string
  private readonly now: () => number

  constructor(options: DesktopInstallRecoveryStoreOptions) {
    this.statePath = assertAbsoluteFile('plugin install recovery state path', options.statePath)
    if (basename(this.statePath) !== STATE_FILENAME) {
      throw new Error(`${BIN_NAME}: plugin install recovery state path must end in ${STATE_FILENAME}`)
    }
    if (basename(dirname(this.statePath)) !== STATE_DIRECTORY_NAME) {
      throw new Error(`${BIN_NAME}: plugin install recovery state path must use the fixed private directory`)
    }
    assertDesktopProfileName(options.profileName)
    this.profileName = options.profileName
    this.profileDir = assertAbsoluteFile('plugin install recovery profile directory', options.profileDir)
    assertOpaqueId('generation id', options.generationId)
    this.generationId = options.generationId
    this.now = options.now ?? Date.now
  }

  /** Read and validate the current WAL without changing its phase. */
  async read(): Promise<DesktopInstallRecoveryTransaction | undefined> {
    await this.ensurePrivateDirectory(dirname(this.statePath))
    let info
    try { info = await lstat(this.statePath) }
    catch (cause) {
      if (isENOENT(cause)) return undefined
      throw cause
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`${BIN_NAME}: plugin install recovery state must be a regular file`)
    }
    if (info.size > MAX_STATE_BYTES) {
      throw new Error(`${BIN_NAME}: plugin install recovery state is too large`)
    }
    await chmod(this.statePath, STATE_FILE_MODE)
    try {
      return parseTransaction(JSON.parse(await readFile(this.statePath, 'utf8')) as unknown)
    } catch (cause) {
      throw new Error(
        `${BIN_NAME}: invalid plugin install recovery state: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }

  /** Publish a pre-install WAL only after all allowlisted preimages are private and complete. */
  async begin(input: BeginDesktopInstallRecoveryInput): Promise<DesktopInstallRecoveryTransaction> {
    return await this.withMutationLock(async () => await this.beginLocked(input))
  }

  private async beginLocked(input: BeginDesktopInstallRecoveryInput): Promise<DesktopInstallRecoveryTransaction> {
    if (!PACKAGE_NAME_PATTERN.test(input.packageName)) {
      throw new Error(`${BIN_NAME}: invalid plugin install recovery package name`)
    }
    assertPackageVersion(input.packageVersion)
    assertOpaqueId('receipt id', input.receiptId)
    if (await this.read() !== undefined) {
      throw new Error(`${BIN_NAME}: another plugin install recovery transaction is pending`)
    }
    await this.assertProfileDirectory()
    const transactionId = randomUUID()
    const backupDir = this.backupDirectory(transactionId)
    await this.ensureNewPrivateDirectory(backupDir)
    const files: DesktopInstallRecoveryFileRecord[] = []
    try {
      for (const name of DESKTOP_INSTALL_RECOVERY_FILES) {
        const image = await this.readProfileFile(name)
        if (name === 'package.json' && !image.metadata.present) {
          throw new Error(`${BIN_NAME}: active profile package.json is unavailable`)
        }
        let before: DesktopInstallRecoveryFileImage = image.metadata
        if (image.metadata.present) {
          const backupFile = `${name}.before`
          const text = image.bytes!.toString('utf8')
          if (!Buffer.from(text, 'utf8').equals(image.bytes!)) {
            throw new Error(`${BIN_NAME}: plugin install recovery only accepts UTF-8 profile files`)
          }
          await writeFileAtomic(join(backupDir, backupFile), text, {
            mode: STATE_FILE_MODE,
            dirMode: PRIVATE_DIRECTORY_MODE,
          })
          before = { ...image.metadata, backupFile }
        }
        files.push({ name, before })
      }
      const state: DesktopInstallRecoveryTransaction = {
        version: STATE_VERSION,
        transactionId,
        profileName: this.profileName,
        profileIdentity: profileIdentity(this.profileDir),
        packageName: input.packageName,
        packageVersion: input.packageVersion,
        receiptId: input.receiptId,
        createdByGeneration: this.generationId,
        createdAt: timestamp(this.now),
        phase: 'prepared',
        files,
      }
      await this.writeState(state)
      return state
    } catch (cause) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => {})
      throw cause
    }
  }

  /** Seal exact post-install hashes before exposing success or a restart grant. */
  async seal(transactionId: string): Promise<DesktopInstallRecoveryTransaction> {
    return await this.withMutationLock(async () => await this.sealLocked(transactionId))
  }

  private async sealLocked(transactionId: string): Promise<DesktopInstallRecoveryTransaction> {
    const state = await this.requireTransaction(transactionId)
    this.assertBound(state)
    if (state.phase === 'awaiting-restart') return state
    if (state.phase !== 'prepared' || state.createdByGeneration !== this.generationId) {
      throw new Error(`${BIN_NAME}: plugin install recovery transaction cannot be sealed in phase ${state.phase}`)
    }
    const next = await this.capturePostImage(state, true)
    await this.writeState(next)
    return next
  }

  /**
   * Admit the just-finished command's partial image, then restore it atomically.
   * This is only valid in the generation that began the still-exclusive install.
   */
  async restoreCurrentInstall(
    transactionId: string,
    failureReason: DesktopInstallRecoveryFailureReason,
  ): Promise<DesktopInstallRecoveryRestoreResult> {
    return await this.withMutationLock(async () => {
      const state = await this.requireTransaction(transactionId)
      this.assertBound(state)
      if (state.phase === 'prepared') {
        if (state.createdByGeneration !== this.generationId) {
          throw new Error(`${BIN_NAME}: plugin install recovery belongs to another generation`)
        }
        await this.writeState(await this.capturePostImage(state, false))
      }
      return await this.restoreLocked(transactionId, failureReason)
    })
  }

  private async capturePostImage(
    state: DesktopInstallRecoveryTransaction,
    requireManifest: boolean,
  ): Promise<DesktopInstallRecoveryTransaction> {
    const files: DesktopInstallRecoveryFileRecord[] = []
    for (const file of state.files) {
      const after = (await this.readProfileFile(file.name)).metadata
      if (requireManifest && file.name === 'package.json' && !after.present) {
        throw new Error(`${BIN_NAME}: installed profile package.json is unavailable`)
      }
      files.push({ ...file, after })
    }
    const next: DesktopInstallRecoveryTransaction = {
      ...state,
      phase: 'awaiting-restart',
      files,
      sealedAt: timestamp(this.now),
    }
    return next
  }

  /** Claim startup verification, or persist an interrupted generation for native recovery UI. */
  async claim(): Promise<DesktopInstallRecoveryClaim> {
    return await this.withMutationLock(async () => await this.claimLocked())
  }

  private async claimLocked(): Promise<DesktopInstallRecoveryClaim> {
    const state = await this.read()
    if (state === undefined) return { action: 'none' }
    if (!this.matchesCurrentProfile(state)) {
      return { action: 'deferred', reason: 'profile-mismatch', transaction: state }
    }
    if (state.phase === 'verified' || state.phase === 'rolled-back' || state.phase === 'manual-recovery-required') {
      return { action: 'terminal', transaction: state }
    }
    if (state.createdByGeneration === this.generationId && state.phase !== 'verifying') {
      return { action: 'deferred', reason: 'origin-generation', transaction: state }
    }
    if (state.phase === 'awaiting-restart') {
      const next = this.verifyingState(state)
      await this.writeState(next)
      return { action: 'verify', transaction: next }
    }
    if (state.phase === 'prepared') {
      const next = this.recoveryPendingState(state, 'interrupted-install')
      await this.writeState(next)
      return { action: 'prompt', reason: 'interrupted-install', transaction: next }
    }
    if (state.phase === 'recovery-pending') {
      return {
        action: 'prompt',
        reason: state.failureReason === 'interrupted-install'
          ? 'interrupted-install'
          : 'startup-unconfirmed',
        transaction: state,
      }
    }
    if (state.phase === 'retry-requested') {
      if (state.verifyingGeneration === this.generationId) {
        return { action: 'deferred', reason: 'origin-generation', transaction: state }
      }
      const next = this.verifyingState(state)
      await this.writeState(next)
      return { action: 'verify', transaction: next }
    }
    if (state.verifyingGeneration === this.generationId) {
      return { action: 'verify', transaction: state }
    }
    const next = this.recoveryPendingState(state, 'startup-unconfirmed')
    await this.writeState(next)
    return { action: 'prompt', reason: 'startup-unconfirmed', transaction: next }
  }

  /** Persist one failed verifying generation before showing native recovery choices. */
  async recordFailure(
    transactionId: string,
    failureReason: DesktopInstallRecoveryFailureReason,
  ): Promise<DesktopInstallRecoveryTransaction> {
    return await this.withMutationLock(async () => {
      const state = await this.requireTransaction(transactionId)
      this.assertBound(state)
      if (state.phase === 'recovery-pending') return state
      if (state.phase !== 'verifying' || state.verifyingGeneration !== this.generationId) {
        throw new Error(`${BIN_NAME}: plugin install recovery transaction is not verifying in this generation`)
      }
      const next = this.recoveryPendingState(state, failureReason)
      await this.writeState(next)
      return next
    })
  }

  /** Persist one explicit retry grant for consumption by exactly the next generation. */
  async requestRetry(transactionId: string): Promise<DesktopInstallRecoveryTransaction> {
    return await this.withMutationLock(async () => {
      const state = await this.requireTransaction(transactionId)
      this.assertBound(state)
      if (state.phase !== 'recovery-pending') {
        throw new Error(`${BIN_NAME}: plugin install recovery transaction is not awaiting a recovery choice`)
      }
      const next: DesktopInstallRecoveryTransaction = {
        ...state,
        phase: 'retry-requested',
        verifyingGeneration: this.generationId,
      }
      await this.writeState(next)
      return next
    })
  }

  /** Commit that the claimed profile reached a healthy Renderer generation. */
  async markHealthy(transactionId: string): Promise<DesktopInstallRecoveryTransaction> {
    return await this.withMutationLock(async () => await this.markHealthyLocked(transactionId))
  }

  /** Persist that the healthy Desktop generation explained a completed rollback to the user. */
  async markRollbackNotified(transactionId: string): Promise<DesktopInstallRecoveryTransaction> {
    return await this.withMutationLock(async () => {
      const state = await this.requireTransaction(transactionId)
      this.assertBound(state)
      if (state.phase !== 'rolled-back') {
        throw new Error(`${BIN_NAME}: only a rolled-back plugin install can be marked notified`)
      }
      if (state.rollbackNotifiedAt !== undefined) return state
      const next: DesktopInstallRecoveryTransaction = {
        ...state,
        rollbackNotifiedAt: timestamp(this.now),
      }
      await this.writeState(next)
      return next
    })
  }

  private async markHealthyLocked(transactionId: string): Promise<DesktopInstallRecoveryTransaction> {
    const state = await this.requireTransaction(transactionId)
    this.assertBound(state)
    if (state.phase === 'verified') return state
    if (state.phase !== 'verifying' || state.verifyingGeneration !== this.generationId) {
      throw new Error(`${BIN_NAME}: plugin install recovery transaction is not verifying in this generation`)
    }
    const next: DesktopInstallRecoveryTransaction = {
      ...state,
      phase: 'verified',
      verifiedAt: timestamp(this.now),
    }
    await this.writeState(next)
    return next
  }

  /** Restore exact preimages only when every current file is still a known pre- or post-image. */
  async restore(
    transactionId: string,
    failureReason: DesktopInstallRecoveryFailureReason,
  ): Promise<DesktopInstallRecoveryRestoreResult> {
    return await this.withMutationLock(
      async () => await this.restoreLocked(transactionId, failureReason),
    )
  }

  private async restoreLocked(
    transactionId: string,
    failureReason: DesktopInstallRecoveryFailureReason,
  ): Promise<DesktopInstallRecoveryRestoreResult> {
    const state = await this.requireTransaction(transactionId)
    this.assertBound(state)
    if (state.phase === 'rolled-back') return { status: 'already-restored', transaction: state }
    if (state.phase === 'manual-recovery-required') {
      return {
        status: 'manual-recovery-required',
        transaction: state,
        mismatchedFiles: state.mismatchedFiles ?? [],
      }
    }
    if (state.phase === 'verified') {
      throw new Error(`${BIN_NAME}: verified plugin install recovery transaction cannot be restored`)
    }
    const current = new Map<DesktopInstallRecoveryFilename, ReadFileImage>()
    const mismatchedFiles: DesktopInstallRecoveryFilename[] = []
    for (const file of state.files) {
      const image = await this.readProfileFile(file.name)
      current.set(file.name, image)
      const matchesBefore = sameImage(image.metadata, file.before)
      const matchesAfter = file.after !== undefined && sameImage(image.metadata, file.after)
      if (!matchesBefore && !matchesAfter) mismatchedFiles.push(file.name)
    }
    if (mismatchedFiles.length > 0) {
      const transaction = await this.markManualState(state, failureReason, mismatchedFiles)
      return { status: 'manual-recovery-required', transaction, mismatchedFiles }
    }

    // Validate every backup before the first replacement, so a corrupt backup
    // never causes a knowingly partial rollback. A later filesystem failure is
    // resumable because both the pre- and post-images remain admitted.
    const backups = new Map<DesktopInstallRecoveryFilename, Buffer>()
    for (const file of state.files) {
      if (!file.before.present) continue
      const backup = await this.readBackup(state.transactionId, file)
      backups.set(file.name, backup)
    }
    for (const file of state.files) {
      const image = current.get(file.name)
      if (image === undefined || sameImage(image.metadata, file.before)) continue
      const target = join(this.profileDir, file.name)
      if (!file.before.present) {
        await unlink(target)
      } else {
        await writeFileAtomic(target, backups.get(file.name)!.toString('utf8'), {
          mode: file.before.mode,
        })
      }
    }
    for (const file of state.files) {
      if (!sameImage((await this.readProfileFile(file.name)).metadata, file.before)) {
        throw new Error(`${BIN_NAME}: plugin install recovery did not restore ${file.name}`)
      }
    }
    const transaction: DesktopInstallRecoveryTransaction = {
      ...state,
      phase: 'rolled-back',
      restoredAt: timestamp(this.now),
      failureReason,
      mismatchedFiles: [],
    }
    await this.writeState(transaction)
    return { status: 'restored', transaction }
  }

  /** Preserve evidence while preventing automatic writes after a non-file recovery failure. */
  async markManualRecoveryRequired(
    transactionId: string,
    failureReason: DesktopInstallRecoveryFailureReason,
  ): Promise<DesktopInstallRecoveryTransaction> {
    return await this.withMutationLock(
      async () => await this.markManualRecoveryRequiredLocked(transactionId, failureReason),
    )
  }

  private async markManualRecoveryRequiredLocked(
    transactionId: string,
    failureReason: DesktopInstallRecoveryFailureReason,
  ): Promise<DesktopInstallRecoveryTransaction> {
    const state = await this.requireTransaction(transactionId)
    this.assertBound(state)
    if (state.phase === 'verified' || state.phase === 'rolled-back') {
      throw new Error(`${BIN_NAME}: terminal plugin install recovery transaction cannot require manual recovery`)
    }
    if (state.phase === 'manual-recovery-required') return state
    return await this.markManualState(state, failureReason, [])
  }

  /** Remove terminal WAL metadata and private preimages after its external obligations are complete. */
  async clear(transactionId: string): Promise<void> {
    await this.withMutationLock(async () => await this.clearLocked(transactionId))
  }

  private async clearLocked(transactionId: string): Promise<void> {
    const state = await this.requireTransaction(transactionId)
    this.assertBound(state)
    if (state.phase !== 'verified' && state.phase !== 'rolled-back') {
      throw new Error(`${BIN_NAME}: non-terminal plugin install recovery transaction cannot be cleared`)
    }
    await unlink(this.statePath)
    await rm(this.backupDirectory(transactionId), { recursive: true, force: true })
  }

  private verifyingState(state: DesktopInstallRecoveryTransaction): DesktopInstallRecoveryTransaction {
    const { failureReason, ...active } = state
    void failureReason
    return {
      ...active,
      phase: 'verifying',
      verifyingGeneration: this.generationId,
      verificationStartedAt: timestamp(this.now),
    }
  }

  private recoveryPendingState(
    state: DesktopInstallRecoveryTransaction,
    failureReason: DesktopInstallRecoveryFailureReason,
  ): DesktopInstallRecoveryTransaction {
    return {
      ...state,
      phase: 'recovery-pending',
      failureReason,
    }
  }

  private async markManualState(
    state: DesktopInstallRecoveryTransaction,
    failureReason: DesktopInstallRecoveryFailureReason,
    mismatchedFiles: readonly DesktopInstallRecoveryFilename[],
  ): Promise<DesktopInstallRecoveryTransaction> {
    const next: DesktopInstallRecoveryTransaction = {
      ...state,
      phase: 'manual-recovery-required',
      failureReason,
      mismatchedFiles: [...mismatchedFiles],
    }
    await this.writeState(next)
    return next
  }

  private matchesCurrentProfile(state: DesktopInstallRecoveryTransaction): boolean {
    return state.profileName === this.profileName
      && state.profileIdentity === profileIdentity(this.profileDir)
  }

  private assertBound(state: DesktopInstallRecoveryTransaction): void {
    if (!this.matchesCurrentProfile(state)) {
      throw new Error(`${BIN_NAME}: plugin install recovery transaction belongs to another profile`)
    }
  }

  private async requireTransaction(transactionId: string): Promise<DesktopInstallRecoveryTransaction> {
    assertOpaqueId('transaction id', transactionId)
    const state = await this.read()
    if (state === undefined || state.transactionId !== transactionId) {
      throw new Error(`${BIN_NAME}: plugin install recovery transaction is unavailable`)
    }
    return state
  }

  private backupDirectory(transactionId: string): string {
    return join(dirname(this.statePath), BACKUP_DIRECTORY_NAME, transactionId)
  }

  private async writeState(state: DesktopInstallRecoveryTransaction): Promise<void> {
    // Round-trip our own value through the disk parser before publishing it.
    parseTransaction(state)
    const rendered = `${JSON.stringify(state, undefined, 2)}\n`
    if (Buffer.byteLength(rendered, 'utf8') > MAX_STATE_BYTES) {
      throw new Error(`${BIN_NAME}: plugin install recovery state is too large`)
    }
    await this.ensurePrivateDirectory(dirname(this.statePath))
    await writeFileAtomic(this.statePath, rendered, {
      mode: STATE_FILE_MODE,
      dirMode: PRIVATE_DIRECTORY_MODE,
    })
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensurePrivateDirectory(dirname(this.statePath))
    return await withFileLock(this.statePath, operation)
  }

  private async assertProfileDirectory(): Promise<void> {
    const info = await lstat(this.profileDir)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${BIN_NAME}: plugin install recovery profile directory must be a real directory`)
    }
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${BIN_NAME}: plugin install recovery directory must be a real directory`)
    }
    await chmod(path, PRIVATE_DIRECTORY_MODE)
  }

  private async ensureNewPrivateDirectory(path: string): Promise<void> {
    await this.ensurePrivateDirectory(dirname(path))
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE })
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${BIN_NAME}: plugin install recovery backup directory must be a real directory`)
    }
    await chmod(path, PRIVATE_DIRECTORY_MODE)
  }

  private async readProfileFile(name: DesktopInstallRecoveryFilename): Promise<ReadFileImage> {
    return await this.readBoundedRegularFile(join(this.profileDir, name), FILE_LIMITS[name], false)
  }

  private async readBackup(
    transactionId: string,
    file: DesktopInstallRecoveryFileRecord,
  ): Promise<Buffer> {
    if (!file.before.present || file.before.backupFile !== `${file.name}.before`) {
      throw new Error(`${BIN_NAME}: plugin install recovery backup metadata is invalid`)
    }
    const backup = await this.readBoundedRegularFile(
      join(this.backupDirectory(transactionId), file.before.backupFile),
      FILE_LIMITS[file.name],
      true,
    )
    if (!backup.metadata.present
      || backup.metadata.sha256 !== file.before.sha256
      || backup.metadata.size !== file.before.size) {
      throw new Error(`${BIN_NAME}: plugin install recovery backup for ${file.name} is invalid`)
    }
    return backup.bytes!
  }

  private async readBoundedRegularFile(path: string, limit: number, required: boolean): Promise<ReadFileImage> {
    let pathInfo
    try { pathInfo = await lstat(path) }
    catch (cause) {
      if (isENOENT(cause) && !required) return { metadata: { present: false } }
      throw cause
    }
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
      throw new Error(`${BIN_NAME}: plugin install recovery only accepts regular files`)
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = await handle.stat()
      if (!info.isFile() || info.size > limit) {
        throw new Error(info.size > limit
          ? `${BIN_NAME}: plugin install recovery file is too large`
          : `${BIN_NAME}: plugin install recovery only accepts regular files`)
      }
      const bytes = await handle.readFile()
      if (bytes.byteLength > limit) throw new Error(`${BIN_NAME}: plugin install recovery file is too large`)
      return {
        metadata: {
          present: true,
          sha256: sha256(bytes),
          size: bytes.byteLength,
          mode: info.mode & 0o777,
        },
        bytes,
      }
    } finally {
      await handle?.close()
    }
  }
}
