/** Pre-Host recovery-window authority over one immutable Desktop generation. */

import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { writeDegradedBundles } from './degraded-mode.ts'
import type { RestoreResult } from './profile-checkpoint.ts'
import { repairPlans, type DesktopRepairPlan } from './repair-plans.ts'
import {
  runRepairSelfCheck,
  type RepairSelfCheckItem,
  type RepairSelfCheckReport,
} from './repair-self-check.ts'
import {
  DesktopPluginsError,
  disableDesktopProfileBundle,
  readDesktopProfileBundleInventory,
  type DesktopPluginStateBootstrap,
  type DesktopProfileManifestBundle,
} from './desktop-plugins.ts'
import type {
  DesktopInstallRecoveryFailureReason,
  DesktopInstallRecoveryPhase,
  DesktopInstallRecoveryRestoreResult,
  DesktopInstallRecoveryTransaction,
} from './install-recovery.ts'
import { analyzeDiagnostics } from './diagnostic-analyzer.ts'
import { runTierOneAnalysis } from './ai-diagnostic-analyzer.ts'
import { assertDesktopProfileName } from './profile-manager.ts'
import type { DesktopStartupRecoveryAiAnalysis } from './startup-recovery-window.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const PREVIEW_TTL_MS = 5 * 60 * 1000
const MAX_PREVIEWS = 256
const MAX_MANAGED_PACKAGES = 1024
const BUNDLE_ID_PATTERN = /^bundle_[A-Za-z0-9_-]{32}$/u
const DISABLE_PREVIEW_ID_PATTERN = /^disable_[A-Za-z0-9_-]{43}$/u
const ROLLBACK_PREVIEW_ID_PATTERN = /^rollback_[A-Za-z0-9_-]{43}$/u
const RETRY_PREVIEW_ID_PATTERN = /^retry_[A-Za-z0-9_-]{43}$/u
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/u
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const REPAIR_PLAN_IDS = new Set(['A', 'B', 'C', 'D'])

/** Repair plan identifiers offered by the native recovery window. */
export type DesktopStartupRecoveryRepairPlanId = 'A' | 'B' | 'C' | 'D'

/** Renderer-safe result of a user-approved repair plan. */
export interface DesktopStartupRecoveryRepairResult {
  readonly planId: DesktopStartupRecoveryRepairPlanId
  readonly status: 'acknowledged' | 'degraded' | 'restored' | 'already-attempted'
  readonly message: string
  /** Read-only post-repair verification report, always present. */
  readonly selfCheck: RepairSelfCheckReport
}

/** Fixed launcher identity checked before every read and again before mutation. */
export interface DesktopStartupRecoveryGeneration {
  readonly profileName: string
  readonly generationId: string
}

/** Minimal recovery journal reader; its paths and file images never cross this boundary. */
export interface DesktopStartupRecoveryJournalReader {
  read(): Promise<DesktopInstallRecoveryTransaction | undefined>
  restore(
    transactionId: string,
    failureReason: DesktopInstallRecoveryFailureReason,
  ): Promise<DesktopInstallRecoveryRestoreResult>
  requestRetry(transactionId: string): Promise<DesktopInstallRecoveryTransaction>
}

/** Safe owner/action decision made by the main-process controller. */
export interface DesktopStartupRecoveryBundle {
  readonly bundleId: string
  readonly packageName: string
  readonly status: 'active' | 'disabled'
  readonly owner: 'core' | 'managed' | 'external'
  readonly action: 'disable' | null
}

/** Safe projection of an active-profile install journal. */
export interface DesktopStartupRecoveryPendingInstall {
  /** Opaque transaction identity; never a receipt, path, or command. */
  readonly recoveryId: string
  readonly packageName: string
  readonly packageVersion: string
  readonly phase: DesktopInstallRecoveryPhase
  /** Informational until the durable retry transition is wired by the launcher. */
  readonly rollbackAvailable: boolean
  /** Whether one explicit next-generation verification attempt can be granted. */
  readonly retryAvailable: boolean
}

/** Complete data needed to render a recovery window without filesystem access. */
export interface DesktopStartupRecoverySnapshot {
  readonly profileName: string
  readonly bundles: readonly DesktopStartupRecoveryBundle[]
  readonly pendingInstall?: DesktopStartupRecoveryPendingInstall
}

/** One-shot confirmation over one exact external bundle in this generation. */
export interface DesktopStartupRecoveryDisablePreview {
  readonly previewId: string
  readonly packageName: string
  readonly expiresAt: string
}

/** Successful persistent disable, applied when Desktop starts a new generation. */
export interface DesktopStartupRecoveryDisableResult {
  readonly action: 'disable'
  readonly packageName: string
}

/** One-shot confirmation over one exact recovery transaction. */
export interface DesktopStartupRecoveryInstallPreview {
  readonly previewId: string
  readonly packageName: string
  readonly packageVersion: string
  readonly action: 'rollback' | 'retry'
  readonly expiresAt: string
}

/** Safe recovery result returned to the native recovery window. */
export type DesktopStartupRecoveryInstallResult =
  | {
      readonly action: 'rollback'
      readonly packageName: string
      readonly status: 'restored' | 'already-restored'
    }
  | {
      readonly action: 'rollback'
      readonly packageName: string
      readonly status: 'manual-recovery-required'
      readonly mismatchedFiles: readonly string[]
    }
  | {
      readonly action: 'retry'
      readonly packageName: string
      readonly status: 'retry-requested'
    }

export type DesktopStartupRecoveryControllerErrorCode =
  | 'already-disabled'
  | 'generation-changed'
  | 'immutable-target'
  | 'invalid-target'
  | 'operation-failed'
  | 'operation-in-progress'
  | 'preview-expired'
  | 'state-unavailable'

/** Error with a renderer-safe code and message. */
export class DesktopStartupRecoveryControllerError extends Error {
  constructor(readonly code: DesktopStartupRecoveryControllerErrorCode, message: string) {
    super(message)
    this.name = 'DesktopStartupRecoveryControllerError'
  }
}

export interface DesktopStartupRecoveryControllerOptions {
  /** Fixed profile and Desktop-private plugin state paths. */
  readonly pluginState: DesktopPluginStateBootstrap
  /** Opaque identity minted once by the Electron main generation. */
  readonly generationId: string
  /** Re-read the launcher's current selection; no renderer value is trusted. */
  readonly currentGeneration: () => DesktopStartupRecoveryGeneration
  /** Optional display-only package names backed by exact-valid managed receipts. */
  readonly managedPackageNames?: () => readonly string[] | Promise<readonly string[]>
  /** Recovery WAL already bound by its store to the active profile directory. */
  readonly installRecovery: DesktopStartupRecoveryJournalReader
  /**
   * Durable degraded-mode state path committed by plan A. Optional until the
   * main process wires it at the recovery-window close loop; absent here means
   * degraded commits fail closed as state-unavailable.
   */
  readonly degradedStatePath?: string
  /** Injectable clock used only by focused headless tests. */
  readonly now?: () => number
  /** Launcher-provided failure stack analyzed by the offline AI diagnosis. */
  readonly failureStack?: string
  /** Restore the latest healthy snapshot for plan D; absent means plan D fails closed. */
  readonly restoreLatest?: () => Promise<RestoreResult>
  /** Injectable read-only self-check probes; defaults to a module-resolution probe. */
  readonly selfCheckItems?: () => Promise<ReadonlyArray<RepairSelfCheckItem>>
}

interface DisablePreviewRecord {
  readonly previewId: string
  readonly bundleId: string
  readonly packageName: string
  readonly profileName: string
  readonly generationId: string
  readonly expiresAt: number
}

interface InstallPreviewRecord {
  readonly previewId: string
  readonly recoveryId: string
  readonly packageName: string
  readonly packageVersion: string
  readonly phase: DesktopInstallRecoveryPhase
  readonly profileName: string
  readonly generationId: string
  readonly action: 'rollback' | 'retry'
  readonly expiresAt: number
}

function safePackageName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 214
    && PACKAGE_NAME_PATTERN.test(value)
}

function rollbackAvailable(phase: DesktopInstallRecoveryPhase): boolean {
  return phase === 'prepared'
    || phase === 'awaiting-restart'
    || phase === 'verifying'
    || phase === 'recovery-pending'
}

function safePendingInstall(
  transaction: DesktopInstallRecoveryTransaction | undefined,
  profileName: string,
): DesktopStartupRecoveryPendingInstall | undefined {
  if (transaction === undefined
    || transaction.profileName !== profileName
    || transaction.phase === 'verified'
    || transaction.phase === 'rolled-back') return undefined
  if (!OPAQUE_ID_PATTERN.test(transaction.transactionId)
    || !safePackageName(transaction.packageName)
    || transaction.packageVersion.length < 1
    || transaction.packageVersion.length > 128
    || /[\0\r\n]/u.test(transaction.packageVersion)) {
    throw new DesktopStartupRecoveryControllerError(
      'state-unavailable',
      'The pending plugin recovery state is invalid.',
    )
  }
  return {
    recoveryId: transaction.transactionId,
    packageName: transaction.packageName,
    packageVersion: transaction.packageVersion,
    phase: transaction.phase,
    rollbackAvailable: rollbackAvailable(transaction.phase),
    retryAvailable: transaction.phase === 'recovery-pending',
  }
}

/**
 * Generation-bound, UI-independent recovery controller. It parses only the
 * active profile manifest, never resolves a plugin or parses its bundle patch.
 */
export class DesktopStartupRecoveryController {
  private readonly profileName: string
  private readonly generationId: string
  private readonly now: () => number
  private readonly packageBundleIds = new Map<string, string>()
  private readonly bundlePackages = new Map<string, string>()
  private readonly disablePreviews = new Map<string, DisablePreviewRecord>()
  private readonly installPreviews = new Map<string, InstallPreviewRecord>()
  private operationActive = false
  private disposed = false
  private readonly aiAbort = new AbortController()

  constructor(private readonly options: DesktopStartupRecoveryControllerOptions) {
    assertDesktopProfileName(options.pluginState.profileName)
    if (!OPAQUE_ID_PATTERN.test(options.generationId)) {
      throw new Error(`${BIN_NAME}: invalid startup recovery generation id`)
    }
    for (const [label, value] of [
      ['Harness home', options.pluginState.homeDir],
      ['plugin state path', options.pluginState.statePath],
    ] as const) {
      if (!isAbsolute(value) || value.includes('\0')) {
        throw new Error(`${BIN_NAME}: startup recovery ${label} must be an absolute path without NUL`)
      }
    }
    this.profileName = options.pluginState.profileName
    this.generationId = options.generationId
    this.now = options.now ?? Date.now
  }

  /** Read a safe, profile-scoped projection for the native recovery window. */
  async snapshot(): Promise<DesktopStartupRecoverySnapshot> {
    this.assertCurrentGeneration()
    try {
      const inventory = readDesktopProfileBundleInventory(this.options.pluginState)
      const managed = await this.readManagedPackages()
      const transaction = await this.options.installRecovery.read()
      this.assertCurrentGeneration()
      return {
        profileName: this.profileName,
        bundles: this.projectBundles(inventory, managed),
        ...(() => {
          const pendingInstall = safePendingInstall(transaction, this.profileName)
          return pendingInstall === undefined ? {} : { pendingInstall }
        })(),
      }
    } catch (cause) {
      if (cause instanceof DesktopStartupRecoveryControllerError) throw cause
      throw new DesktopStartupRecoveryControllerError(
        'state-unavailable',
        'Desktop recovery state is unavailable.',
      )
    }
  }

  /** Validate one current external bundle and mint a one-shot confirmation. */
  async previewDisable(bundleId: string): Promise<DesktopStartupRecoveryDisablePreview> {
    this.assertCurrentGeneration()
    if (!BUNDLE_ID_PATTERN.test(bundleId)) throw this.invalidTarget()
    try {
      const packageName = this.bundlePackages.get(bundleId)
      if (packageName === undefined) throw this.invalidTarget()
      const inventory = readDesktopProfileBundleInventory(this.options.pluginState)
      this.assertCurrentGeneration()
      this.assertMutableActive(inventory, packageName)
      this.prunePreviews()
      if (this.disablePreviews.size >= MAX_PREVIEWS) {
        const oldest = this.disablePreviews.keys().next().value as string | undefined
        if (oldest !== undefined) this.disablePreviews.delete(oldest)
      }
      const previewId = `disable_${randomBytes(32).toString('base64url')}`
      const expiresAt = this.now() + PREVIEW_TTL_MS
      this.disablePreviews.set(previewId, {
        previewId,
        bundleId,
        packageName,
        profileName: this.profileName,
        generationId: this.generationId,
        expiresAt,
      })
      return { previewId, packageName, expiresAt: new Date(expiresAt).toISOString() }
    } catch (cause) {
      throw this.safeReadError(cause)
    }
  }

  /** Consume one confirmation and persist the disable after lock-time revalidation. */
  async executeDisable(previewId: string): Promise<DesktopStartupRecoveryDisableResult> {
    this.assertCurrentGeneration()
    if (!DISABLE_PREVIEW_ID_PATTERN.test(previewId)) throw this.expiredPreview()
    if (this.operationActive) {
      throw new DesktopStartupRecoveryControllerError(
        'operation-in-progress',
        'Another Desktop recovery operation is already running.',
      )
    }
    const preview = this.disablePreviews.get(previewId)
    this.disablePreviews.delete(previewId)
    if (preview === undefined
      || preview.expiresAt <= this.now()
      || preview.profileName !== this.profileName
      || preview.generationId !== this.generationId) throw this.expiredPreview()
    this.operationActive = true
    try {
      await this.authorizeDisable(preview.packageName)
      const result = await disableDesktopProfileBundle(
        this.options.pluginState,
        preview.packageName,
        async () => { await this.authorizeDisable(preview.packageName) },
      )
      if (result.packageName !== preview.packageName) {
        throw new DesktopStartupRecoveryControllerError(
          'operation-failed',
          'The Desktop plugin change returned an invalid result.',
        )
      }
      return { action: 'disable', packageName: result.packageName }
    } catch (cause) {
      throw this.safeMutationError(cause)
    } finally {
      this.operationActive = false
    }
  }

  /** Validate one pending transaction and mint a rollback confirmation. */
  async previewRollback(recoveryId: string): Promise<DesktopStartupRecoveryInstallPreview> {
    return await this.previewInstallAction(recoveryId, 'rollback')
  }

  /** Validate one pending transaction and mint a single-retry confirmation. */
  async previewRetry(recoveryId: string): Promise<DesktopStartupRecoveryInstallPreview> {
    return await this.previewInstallAction(recoveryId, 'retry')
  }

  /** Consume one exact recovery confirmation after re-reading the durable WAL. */
  async executeInstallAction(previewId: string): Promise<DesktopStartupRecoveryInstallResult> {
    this.assertCurrentGeneration()
    const action = ROLLBACK_PREVIEW_ID_PATTERN.test(previewId)
      ? 'rollback'
      : RETRY_PREVIEW_ID_PATTERN.test(previewId)
        ? 'retry'
        : undefined
    if (action === undefined) throw this.expiredPreview()
    if (this.operationActive) {
      throw new DesktopStartupRecoveryControllerError(
        'operation-in-progress',
        'Another Desktop recovery operation is already running.',
      )
    }
    const preview = this.installPreviews.get(previewId)
    this.installPreviews.delete(previewId)
    if (preview === undefined
      || preview.action !== action
      || preview.expiresAt <= this.now()
      || preview.profileName !== this.profileName
      || preview.generationId !== this.generationId) throw this.expiredPreview()
    this.operationActive = true
    try {
      const transaction = await this.requirePendingTransaction(preview.recoveryId)
      if (transaction.phase !== preview.phase
        || transaction.packageName !== preview.packageName
        || transaction.packageVersion !== preview.packageVersion) throw this.expiredPreview()
      if (action === 'retry') {
        if (transaction.phase !== 'recovery-pending') throw this.expiredPreview()
        const requested = await this.options.installRecovery.requestRetry(transaction.transactionId)
        if (requested.phase !== 'retry-requested') {
          throw new DesktopStartupRecoveryControllerError(
            'operation-failed',
            'The Desktop retry request returned an invalid state.',
          )
        }
        return { action, packageName: transaction.packageName, status: 'retry-requested' }
      }
      if (!rollbackAvailable(transaction.phase)) throw this.expiredPreview()
      const result = await this.options.installRecovery.restore(
        transaction.transactionId,
        transaction.failureReason ?? 'startup-failed',
      )
      if (result.status === 'manual-recovery-required') {
        return {
          action,
          packageName: transaction.packageName,
          status: result.status,
          mismatchedFiles: [...result.mismatchedFiles],
        }
      }
      return { action, packageName: transaction.packageName, status: result.status }
    } catch (cause) {
      if (cause instanceof DesktopStartupRecoveryControllerError) throw cause
      throw new DesktopStartupRecoveryControllerError(
        'operation-failed',
        'Unable to apply the Desktop recovery operation.',
      )
    } finally {
      this.operationActive = false
    }
  }

  /** Persist the degraded bundle set atomically and return the committed image. */
  async commitDegraded(bundles: readonly string[]): Promise<{ readonly bundles: readonly string[] }> {
    this.assertCurrentGeneration()
    if (!Array.isArray(bundles) || bundles.some(item => typeof item !== 'string')) throw this.invalidTarget()
    const degradedStatePath = this.options.degradedStatePath
    if (degradedStatePath === undefined) {
      throw new DesktopStartupRecoveryControllerError(
        'state-unavailable',
        'Desktop degraded state is unavailable.',
      )
    }
    writeDegradedBundles(degradedStatePath, bundles)
    return { bundles }
  }

  /** Enforce one user-approved repair plan id for the active generation. */
  async executeRepair(planId: string): Promise<DesktopStartupRecoveryRepairResult> {
    this.assertCurrentGeneration()
    if (!REPAIR_PLAN_IDS.has(planId as DesktopStartupRecoveryRepairPlanId)) throw this.invalidTarget()
    if (this.operationActive) {
      throw new DesktopStartupRecoveryControllerError(
        'operation-in-progress',
        'Another Desktop recovery operation is already running.',
      )
    }
    this.operationActive = true
    try {
      const degradedStatePath = this.options.degradedStatePath
      if (planId === 'A' && degradedStatePath === undefined) {
        throw new DesktopStartupRecoveryControllerError(
          'state-unavailable',
          'Degraded state is unavailable; plan A cannot be committed.',
        )
      }
      const plan = this.buildRepairPlans(degradedStatePath).find(p => p.id === planId)
      if (plan === undefined) throw this.invalidTarget()
      const outcome = await plan.apply()
      const selfCheck = await this.runSelfCheck()
      return {
        planId: planId as DesktopStartupRecoveryRepairPlanId,
        status: outcome.status,
        message: outcome.message,
        selfCheck,
      }
    } finally {
      this.operationActive = false
    }
  }

  /**
   * Run the offline AI analysis over the launcher-provided failure stack.
   * Read-only; the recovery window single-flights this via its busy overlay.
   */
  async runAiAnalysis(): Promise<DesktopStartupRecoveryAiAnalysis> {
    this.assertCurrentGeneration()
    const input = this.lastFailureStack()
    const tier1 = await runTierOneAnalysis(input, this.aiAbort.signal)
    const diagnosis = tier1 ?? analyzeDiagnostics(input)
    return { diagnosis }
  }

  /** Invalidate every generation-local target and confirmation. */
  dispose(): void {
    this.disposed = true
    this.aiAbort.abort()
    this.packageBundleIds.clear()
    this.bundlePackages.clear()
    this.disablePreviews.clear()
    this.installPreviews.clear()
  }

  private async previewInstallAction(
    recoveryId: string,
    action: 'rollback' | 'retry',
  ): Promise<DesktopStartupRecoveryInstallPreview> {
    this.assertCurrentGeneration()
    if (!OPAQUE_ID_PATTERN.test(recoveryId)) throw this.invalidTarget()
    try {
      const transaction = await this.requirePendingTransaction(recoveryId)
      if (action === 'rollback' ? !rollbackAvailable(transaction.phase) : transaction.phase !== 'recovery-pending') {
        throw this.invalidTarget()
      }
      this.prunePreviews()
      if (this.installPreviews.size >= MAX_PREVIEWS) {
        const oldest = this.installPreviews.keys().next().value as string | undefined
        if (oldest !== undefined) this.installPreviews.delete(oldest)
      }
      const previewId = `${action}_${randomBytes(32).toString('base64url')}`
      const expiresAt = this.now() + PREVIEW_TTL_MS
      this.installPreviews.set(previewId, {
        previewId,
        recoveryId,
        packageName: transaction.packageName,
        packageVersion: transaction.packageVersion,
        phase: transaction.phase,
        profileName: this.profileName,
        generationId: this.generationId,
        action,
        expiresAt,
      })
      return {
        previewId,
        packageName: transaction.packageName,
        packageVersion: transaction.packageVersion,
        action,
        expiresAt: new Date(expiresAt).toISOString(),
      }
    } catch (cause) {
      throw this.safeReadError(cause)
    }
  }

  private async requirePendingTransaction(
    recoveryId: string,
  ): Promise<DesktopInstallRecoveryTransaction> {
    this.assertCurrentGeneration()
    const transaction = await this.options.installRecovery.read()
    this.assertCurrentGeneration()
    if (transaction === undefined
      || transaction.transactionId !== recoveryId
      || transaction.profileName !== this.profileName
      || transaction.phase === 'verified'
      || transaction.phase === 'rolled-back') throw this.invalidTarget()
    return transaction
  }

  private projectBundles(
    inventory: readonly DesktopProfileManifestBundle[],
    managed: ReadonlySet<string>,
  ): readonly DesktopStartupRecoveryBundle[] {
    const activeNames = new Set(inventory.map(item => item.packageName))
    for (const [packageName, bundleId] of this.packageBundleIds) {
      if (activeNames.has(packageName)) continue
      this.packageBundleIds.delete(packageName)
      this.bundlePackages.delete(bundleId)
    }
    return inventory.map(item => {
      const bundleId = this.bundleId(item.packageName)
      const owner = !item.mutable ? 'core' : managed.has(item.packageName) ? 'managed' : 'external'
      return {
        bundleId,
        packageName: item.packageName,
        status: item.status,
        owner,
        action: item.mutable && item.status === 'active' ? 'disable' : null,
      }
    })
  }

  private bundleId(packageName: string): string {
    let bundleId = this.packageBundleIds.get(packageName)
    if (bundleId === undefined) {
      bundleId = `bundle_${randomBytes(24).toString('base64url')}`
      this.packageBundleIds.set(packageName, bundleId)
      this.bundlePackages.set(bundleId, packageName)
    }
    return bundleId
  }

  private async authorizeDisable(packageName: string): Promise<void> {
    this.assertCurrentGeneration()
    const inventory = readDesktopProfileBundleInventory(this.options.pluginState)
    this.assertCurrentGeneration()
    this.assertMutableActive(inventory, packageName)
  }

  private assertMutableActive(
    inventory: readonly DesktopProfileManifestBundle[],
    packageName: string,
  ): void {
    const target = inventory.find(item => item.packageName === packageName)
    if (target === undefined) throw this.invalidTarget()
    if (!target.mutable) {
      throw new DesktopStartupRecoveryControllerError(
        'immutable-target',
        'This Desktop bundle cannot be disabled.',
      )
    }
    if (target.status === 'disabled') {
      throw new DesktopStartupRecoveryControllerError(
        'already-disabled',
        'This Desktop bundle is already disabled.',
      )
    }
  }

  private async readManagedPackages(): Promise<ReadonlySet<string>> {
    if (this.options.managedPackageNames === undefined) return new Set()
    try {
      const names = await this.options.managedPackageNames()
      if (!Array.isArray(names)
        || names.length > MAX_MANAGED_PACKAGES
        || names.some(name => !safePackageName(name))) return new Set()
      return new Set(names)
    } catch {
      // Receipt ownership is display-only in recovery. A broken or unavailable
      // Market must never prevent a direct mutable bundle from being disabled.
      return new Set()
    }
  }

  /**
   * Identify the faulting bundle from the launcher-provided failure stack so
   * plan A degrades exactly that bundle instead of silently clearing the set.
   */
  private targetDegradedBundle(): readonly string[] {
    const match = /Cannot find module ['"]([^'"]+)['"]/u.exec(this.lastFailureStack())
    return match === null ? [] : [match[1]!]
  }

  private lastFailureStack(): string {
    return this.options.failureStack ?? ''
  }

  private buildRepairPlans(degradedStatePath: string | undefined): ReadonlyArray<DesktopRepairPlan> {
    return repairPlans({
      degradedStatePath,
      degradedBundle: this.targetDegradedBundle(),
      restoreLatest: this.options.restoreLatest ?? (async () => { throw new Error('restore not configured') }),
    })
  }

  /** Run the injected or default read-only post-repair self-check probes. */
  private async runSelfCheck(): Promise<RepairSelfCheckReport> {
    const items = this.options.selfCheckItems ?? this.defaultSelfCheckItems.bind(this)
    return runRepairSelfCheck(await items())
  }

  /** Default probe: resolve the analysis-identified bundle; an empty target passes. */
  private defaultSelfCheckItems(): ReadonlyArray<RepairSelfCheckItem> {
    return [{
      name: 'degraded bundle resolvable',
      run: async () => {
        const target = this.targetDegradedBundle()[0] ?? ''
        if (target === '') return { ok: true, detail: 'no degraded bundle to resolve' }
        try {
          createRequire(import.meta.url).resolve(target)
          return { ok: true, detail: `resolved ${target}` }
        } catch (cause) {
          return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) }
        }
      },
    }]
  }

  private assertCurrentGeneration(): void {
    if (this.disposed) {
      throw new DesktopStartupRecoveryControllerError(
        'generation-changed',
        'This Desktop recovery generation is no longer active.',
      )
    }
    let current: DesktopStartupRecoveryGeneration
    try {
      current = this.options.currentGeneration()
      assertDesktopProfileName(current.profileName)
    } catch {
      throw new DesktopStartupRecoveryControllerError(
        'generation-changed',
        'This Desktop recovery generation is no longer active.',
      )
    }
    if (current.profileName !== this.profileName
      || current.generationId !== this.generationId
      || !OPAQUE_ID_PATTERN.test(current.generationId)) {
      throw new DesktopStartupRecoveryControllerError(
        'generation-changed',
        'This Desktop recovery generation is no longer active.',
      )
    }
  }

  private prunePreviews(): void {
    const now = this.now()
    for (const [id, preview] of this.disablePreviews) {
      if (preview.expiresAt <= now) this.disablePreviews.delete(id)
    }
    for (const [id, preview] of this.installPreviews) {
      if (preview.expiresAt <= now) this.installPreviews.delete(id)
    }
  }

  private safeReadError(cause: unknown): DesktopStartupRecoveryControllerError {
    if (cause instanceof DesktopStartupRecoveryControllerError) return cause
    if (cause instanceof DesktopPluginsError) return this.mapDesktopPluginsError(cause)
    return new DesktopStartupRecoveryControllerError(
      'state-unavailable',
      'Desktop recovery state is unavailable.',
    )
  }

  private safeMutationError(cause: unknown): DesktopStartupRecoveryControllerError {
    if (cause instanceof DesktopStartupRecoveryControllerError) return cause
    if (cause instanceof DesktopPluginsError) return this.mapDesktopPluginsError(cause)
    return new DesktopStartupRecoveryControllerError(
      'operation-failed',
      'Unable to apply the Desktop recovery operation.',
    )
  }

  private mapDesktopPluginsError(cause: DesktopPluginsError): DesktopStartupRecoveryControllerError {
    if (cause.code === 'invalid-target'
      || cause.code === 'immutable-target'
      || cause.code === 'already-disabled') {
      return new DesktopStartupRecoveryControllerError(cause.code, cause.message)
    }
    return new DesktopStartupRecoveryControllerError(
      'operation-failed',
      'Unable to apply the Desktop recovery operation.',
    )
  }

  private invalidTarget(): DesktopStartupRecoveryControllerError {
    return new DesktopStartupRecoveryControllerError(
      'invalid-target',
      'The Desktop plugin target is no longer available.',
    )
  }

  private expiredPreview(): DesktopStartupRecoveryControllerError {
    return new DesktopStartupRecoveryControllerError(
      'preview-expired',
      'The Desktop recovery confirmation expired or was already used.',
    )
  }
}
