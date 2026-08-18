import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { disableDesktopProfileBundle } from '../src/desktop-plugins.ts'
import type {
  DesktopInstallRecoveryPhase,
  DesktopInstallRecoveryRestoreResult,
  DesktopInstallRecoveryTransaction,
} from '../src/install-recovery.ts'
import {
  DesktopStartupRecoveryController,
  DesktopStartupRecoveryControllerError,
  type DesktopStartupRecoveryControllerOptions,
} from '../src/startup-recovery-controller.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-startup-recovery-'))
  roots.push(root)
  return root
}

function writeManifest(root: string, bundles: readonly string[]): string {
  const path = join(root, 'dsh-home', 'profiles', 'desktop', 'package.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({
    name: 'dsh-profile-desktop',
    dsh: { profile: { bundles } },
  }, undefined, 2)}\n`)
  return path
}

function installBrokenPatch(root: string, packageName: string): void {
  const packageDir = join(root, 'dsh-home', 'profiles', 'desktop', 'node_modules', packageName)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: packageName,
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })}\n`)
  writeFileSync(join(packageDir, 'cordis.patch.yml'), '- insert:\n    - this is: [not valid YAML\n')
}

function transaction(
  phase: DesktopInstallRecoveryPhase = 'verifying',
  profileName = 'desktop',
): DesktopInstallRecoveryTransaction {
  return {
    version: 1,
    transactionId: 'recovery-transaction-0001',
    profileName,
    profileIdentity: 'a'.repeat(64),
    packageName: 'managed-plugin',
    packageVersion: '1.2.3',
    receiptId: 'private-receipt-0001',
    createdByGeneration: 'old-generation-0001',
    createdAt: '2026-08-18T00:00:00.000Z',
    phase,
    files: [],
    verifyingGeneration: 'current-generation-0001',
    verificationStartedAt: '2026-08-18T00:01:00.000Z',
  }
}

interface Harness {
  readonly controller: DesktopStartupRecoveryController
  readonly generation: { profileName: string; generationId: string }
  readonly statePath: string
  readonly manifestPath: string
}

function createHarness(
  root: string,
  options: {
    bundles?: readonly string[]
    managedPackageNames?: DesktopStartupRecoveryControllerOptions['managedPackageNames']
    pending?: DesktopInstallRecoveryTransaction
    installRecovery?: DesktopStartupRecoveryControllerOptions['installRecovery']
    now?: () => number
  } = {},
): Harness {
  const bundles = options.bundles ?? [
    '@deepseek-ai/dsh-base',
    'dsh-plugin-desktop',
    'managed-plugin',
    'external-plugin',
    'external-plugin',
  ]
  const manifestPath = writeManifest(root, bundles)
  const statePath = join(root, 'user-data', 'plugin-management', 'state.json')
  const generation = {
    profileName: 'desktop',
    generationId: 'current-generation-0001',
  }
  const controller = new DesktopStartupRecoveryController({
    pluginState: {
      profileName: 'desktop',
      homeDir: join(root, 'dsh-home'),
      statePath,
    },
    generationId: generation.generationId,
    currentGeneration: () => generation,
    managedPackageNames: options.managedPackageNames ?? (() => ['managed-plugin']),
    installRecovery: options.installRecovery ?? {
      read: async () => options.pending,
      restore: async () => { throw new Error('restore not configured') },
      requestRetry: async () => { throw new Error('retry not configured') },
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { controller, generation, statePath, manifestPath }
}

function errorCode(cause: unknown): string | undefined {
  return cause instanceof DesktopStartupRecoveryControllerError ? cause.code : undefined
}

describe('pre-Host Desktop startup recovery controller', () => {
  it('uses a manifest-only inventory and exports no recovery paths, receipts, hashes, or generation ids', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root, { pending: transaction() })
    installBrokenPatch(root, 'external-plugin')

    const first = await harness.controller.snapshot()
    const second = await harness.controller.snapshot()
    expect(first.bundles).toHaveLength(4)
    expect(first.bundles.find(item => item.packageName === '@deepseek-ai/dsh-base')).toEqual(
      expect.objectContaining({ owner: 'core', action: null, status: 'active' }),
    )
    expect(first.bundles.find(item => item.packageName === 'dsh-plugin-desktop')).toEqual(
      expect.objectContaining({ owner: 'core', action: null, status: 'active' }),
    )
    expect(first.bundles.find(item => item.packageName === 'managed-plugin')).toEqual(
      expect.objectContaining({ owner: 'managed', action: 'disable', status: 'active' }),
    )
    expect(first.bundles.find(item => item.packageName === 'external-plugin')).toEqual(
      expect.objectContaining({ owner: 'external', action: 'disable', status: 'active' }),
    )
    expect(second.bundles.find(item => item.packageName === 'external-plugin')?.bundleId)
      .toBe(first.bundles.find(item => item.packageName === 'external-plugin')?.bundleId)
    expect(first.pendingInstall).toEqual({
      recoveryId: 'recovery-transaction-0001',
      packageName: 'managed-plugin',
      packageVersion: '1.2.3',
      phase: 'verifying',
      rollbackAvailable: true,
      retryAvailable: false,
    })

    const exported = JSON.stringify(first)
    expect(exported).not.toContain(root)
    expect(exported).not.toContain('private-receipt')
    expect(exported).not.toContain('old-generation')
    expect(exported).not.toContain('current-generation')
    expect(exported).not.toContain('a'.repeat(64))
    expect(exported).not.toContain('cordis.patch.yml')
  })

  it('disables an external bundle with a one-shot preview even when its patch cannot parse', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    installBrokenPatch(root, 'external-plugin')
    const manifestBefore = readFileSync(harness.manifestPath, 'utf8')
    const target = (await harness.controller.snapshot()).bundles
      .find(item => item.packageName === 'external-plugin')
    if (target === undefined) throw new Error('missing external bundle')

    const preview = await harness.controller.previewDisable(target.bundleId)
    expect(preview).toEqual(expect.objectContaining({
      previewId: expect.stringMatching(/^disable_[A-Za-z0-9_-]{43}$/u),
      packageName: 'external-plugin',
    }))
    await expect(harness.controller.executeDisable(preview.previewId)).resolves.toEqual({
      action: 'disable',
      packageName: 'external-plugin',
    })
    await expect(harness.controller.executeDisable(preview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'preview-expired',
    )

    expect(readFileSync(harness.manifestPath, 'utf8')).toBe(manifestBefore)
    expect(JSON.parse(readFileSync(harness.statePath, 'utf8'))).toEqual({
      version: 1,
      profiles: [{ profileName: 'desktop', disabledBundles: ['external-plugin'] }],
    })
    expect((await harness.controller.snapshot()).bundles
      .find(item => item.packageName === 'external-plugin')).toEqual(
      expect.objectContaining({ status: 'disabled', action: null }),
    )
  })

  it('never previews core bundles, permits managed recovery disables, and treats receipt lookup as display-only', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    const snapshot = await harness.controller.snapshot()
    const core = snapshot.bundles.find(item => item.packageName === '@deepseek-ai/dsh-base')
    const managed = snapshot.bundles.find(item => item.packageName === 'managed-plugin')
    const external = snapshot.bundles.find(item => item.packageName === 'external-plugin')
    if (core === undefined || managed === undefined || external === undefined) {
      throw new Error('missing recovery inventory target')
    }

    await expect(harness.controller.previewDisable(core.bundleId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'immutable-target',
    )
    await expect(harness.controller.previewDisable(managed.bundleId)).resolves.toEqual(
      expect.objectContaining({ packageName: 'managed-plugin' }),
    )

    const unavailableRoot = temporaryRoot()
    const unavailable = createHarness(unavailableRoot, {
      managedPackageNames: () => { throw new Error(`receipt path: ${unavailableRoot}`) },
    })
    const fallback = await unavailable.controller.snapshot()
    expect(fallback.bundles.find(item => item.packageName === 'managed-plugin')).toEqual(
      expect.objectContaining({ owner: 'external', action: 'disable' }),
    )
    expect(JSON.stringify(fallback)).not.toContain(unavailableRoot)
  })

  it('revalidates the direct manifest while holding the disable-state lock', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    await expect(disableDesktopProfileBundle(
      {
        profileName: 'desktop',
        homeDir: join(root, 'dsh-home'),
        statePath: harness.statePath,
      },
      'external-plugin',
      () => { writeManifest(root, ['@deepseek-ai/dsh-base']) },
    )).rejects.toMatchObject({ code: 'invalid-target' })
    expect(existsSync(harness.statePath)).toBe(false)
  })

  it('rejects a preview after the launcher changes profile or generation', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    const external = (await harness.controller.snapshot()).bundles
      .find(item => item.packageName === 'external-plugin')
    if (external === undefined) throw new Error('missing external bundle')
    const preview = await harness.controller.previewDisable(external.bundleId)

    harness.generation.profileName = 'another-profile'
    await expect(harness.controller.executeDisable(preview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'generation-changed',
    )
    expect(existsSync(harness.statePath)).toBe(false)
  })

  it('rolls back an exact pending transaction with a one-shot preview', async () => {
    const root = temporaryRoot()
    let pending: DesktopInstallRecoveryTransaction | undefined = {
      ...transaction('recovery-pending'),
      failureReason: 'renderer-failed',
    }
    const restoreCalls: Array<{ transactionId: string; reason: string }> = []
    const harness = createHarness(root, {
      installRecovery: {
        read: async () => pending,
        restore: async (transactionId, reason) => {
          restoreCalls.push({ transactionId, reason })
          if (pending === undefined) throw new Error('missing pending transaction')
          const restored: DesktopInstallRecoveryTransaction = {
            ...pending,
            phase: 'rolled-back',
            restoredAt: '2026-08-18T00:02:00.000Z',
          }
          pending = restored
          return { status: 'restored', transaction: restored }
        },
        requestRetry: async () => { throw new Error('retry not expected') },
      },
    })

    const snapshot = await harness.controller.snapshot()
    expect(snapshot.pendingInstall).toEqual(expect.objectContaining({
      phase: 'recovery-pending',
      rollbackAvailable: true,
      retryAvailable: true,
    }))
    const recoveryId = snapshot.pendingInstall?.recoveryId
    if (recoveryId === undefined) throw new Error('missing recovery transaction')
    const preview = await harness.controller.previewRollback(recoveryId)
    expect(preview).toEqual(expect.objectContaining({
      previewId: expect.stringMatching(/^rollback_[A-Za-z0-9_-]{43}$/u),
      packageName: 'managed-plugin',
      packageVersion: '1.2.3',
      action: 'rollback',
    }))
    await expect(harness.controller.executeInstallAction(preview.previewId)).resolves.toEqual({
      action: 'rollback',
      packageName: 'managed-plugin',
      status: 'restored',
    })
    await expect(harness.controller.executeInstallAction(preview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'preview-expired',
    )
    expect(restoreCalls).toEqual([{
      transactionId: 'recovery-transaction-0001',
      reason: 'renderer-failed',
    }])
    expect((await harness.controller.snapshot()).pendingInstall).toBeUndefined()
  })

  it('grants one explicit retry and closes rollback and retry gates afterward', async () => {
    const root = temporaryRoot()
    let pending: DesktopInstallRecoveryTransaction | undefined = transaction('recovery-pending')
    const retryCalls: string[] = []
    const harness = createHarness(root, {
      installRecovery: {
        read: async () => pending,
        restore: async () => { throw new Error('restore not expected') },
        requestRetry: async (transactionId) => {
          retryCalls.push(transactionId)
          if (pending === undefined) throw new Error('missing pending transaction')
          const requested: DesktopInstallRecoveryTransaction = {
            ...pending,
            phase: 'retry-requested',
          }
          pending = requested
          return requested
        },
      },
    })

    const recoveryId = (await harness.controller.snapshot()).pendingInstall?.recoveryId
    if (recoveryId === undefined) throw new Error('missing recovery transaction')
    const preview = await harness.controller.previewRetry(recoveryId)
    expect(preview).toEqual(expect.objectContaining({
      previewId: expect.stringMatching(/^retry_[A-Za-z0-9_-]{43}$/u),
      action: 'retry',
    }))
    await expect(harness.controller.executeInstallAction(preview.previewId)).resolves.toEqual({
      action: 'retry',
      packageName: 'managed-plugin',
      status: 'retry-requested',
    })
    await expect(harness.controller.executeInstallAction(preview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'preview-expired',
    )
    expect(retryCalls).toEqual(['recovery-transaction-0001'])
    expect((await harness.controller.snapshot()).pendingInstall).toEqual(expect.objectContaining({
      phase: 'retry-requested',
      rollbackAvailable: false,
      retryAvailable: false,
    }))
    await expect(harness.controller.previewRollback(recoveryId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'invalid-target',
    )
    await expect(harness.controller.previewRetry(recoveryId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'invalid-target',
    )
  })

  it('rejects install confirmations after generation or durable phase changes', async () => {
    const generationRoot = temporaryRoot()
    const generationHarness = createHarness(generationRoot, {
      pending: transaction('recovery-pending'),
    })
    const generationRecoveryId = (await generationHarness.controller.snapshot())
      .pendingInstall?.recoveryId
    if (generationRecoveryId === undefined) throw new Error('missing recovery transaction')
    const generationPreview = await generationHarness.controller.previewRollback(generationRecoveryId)
    generationHarness.generation.generationId = 'next-generation-0002'
    await expect(
      generationHarness.controller.executeInstallAction(generationPreview.previewId),
    ).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'generation-changed',
    )

    const phaseRoot = temporaryRoot()
    let pending: DesktopInstallRecoveryTransaction | undefined = transaction('recovery-pending')
    let restoreCalls = 0
    const phaseHarness = createHarness(phaseRoot, {
      installRecovery: {
        read: async () => pending,
        restore: async (): Promise<DesktopInstallRecoveryRestoreResult> => {
          restoreCalls += 1
          throw new Error('restore must not run after a phase change')
        },
        requestRetry: async () => { throw new Error('retry not expected') },
      },
    })
    const phaseRecoveryId = (await phaseHarness.controller.snapshot()).pendingInstall?.recoveryId
    if (phaseRecoveryId === undefined) throw new Error('missing recovery transaction')
    const phasePreview = await phaseHarness.controller.previewRollback(phaseRecoveryId)
    pending = { ...pending, phase: 'retry-requested' }
    await expect(phaseHarness.controller.executeInstallAction(phasePreview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'preview-expired',
    )
    await expect(phaseHarness.controller.executeInstallAction(phasePreview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'preview-expired',
    )
    expect(restoreCalls).toBe(0)
  })

  it('exposes manual recovery as terminal and never offers another mutation', async () => {
    const root = temporaryRoot()
    let pending: DesktopInstallRecoveryTransaction | undefined = transaction('recovery-pending')
    let restoreCalls = 0
    const harness = createHarness(root, {
      installRecovery: {
        read: async () => pending,
        restore: async () => {
          restoreCalls += 1
          if (pending === undefined) throw new Error('missing pending transaction')
          const manual: DesktopInstallRecoveryTransaction = {
            ...pending,
            phase: 'manual-recovery-required',
            failureReason: 'recovery-failed',
            mismatchedFiles: ['package.json'],
          }
          pending = manual
          return {
            status: 'manual-recovery-required',
            transaction: manual,
            mismatchedFiles: ['package.json'],
          }
        },
        requestRetry: async () => { throw new Error('retry not expected') },
      },
    })

    const recoveryId = (await harness.controller.snapshot()).pendingInstall?.recoveryId
    if (recoveryId === undefined) throw new Error('missing recovery transaction')
    const preview = await harness.controller.previewRollback(recoveryId)
    await expect(harness.controller.executeInstallAction(preview.previewId)).resolves.toEqual({
      action: 'rollback',
      packageName: 'managed-plugin',
      status: 'manual-recovery-required',
      mismatchedFiles: ['package.json'],
    })
    expect(restoreCalls).toBe(1)
    expect((await harness.controller.snapshot()).pendingInstall).toEqual({
      recoveryId: 'recovery-transaction-0001',
      packageName: 'managed-plugin',
      packageVersion: '1.2.3',
      phase: 'manual-recovery-required',
      rollbackAvailable: false,
      retryAvailable: false,
    })
    await expect(harness.controller.previewRollback(recoveryId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'invalid-target',
    )
    await expect(harness.controller.previewRetry(recoveryId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'invalid-target',
    )
    expect(restoreCalls).toBe(1)
  })

  it('fails closed with a safe error for an invalid manifest and hides other-profile or terminal journals', async () => {
    const root = temporaryRoot()
    const invalid = createHarness(root, { bundles: ['../pathlike-plugin'] })
    await expect(invalid.controller.snapshot()).rejects.toMatchObject({
      code: 'state-unavailable',
      message: 'Desktop recovery state is unavailable.',
    })

    const otherRoot = temporaryRoot()
    const other = createHarness(otherRoot, { pending: transaction('verifying', 'another-profile') })
    expect((await other.controller.snapshot()).pendingInstall).toBeUndefined()
    const terminalRoot = temporaryRoot()
    const terminal = createHarness(terminalRoot, { pending: transaction('rolled-back') })
    expect((await terminal.controller.snapshot()).pendingInstall).toBeUndefined()
  })
})
