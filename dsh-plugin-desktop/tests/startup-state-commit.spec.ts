import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_INSTALL_RECOVERY_FILES,
  DesktopInstallRecoveryStore,
  desktopInstallRecoveryStatePath,
} from '../src/install-recovery.ts'
import {
  beginDesktopProfileStartup,
  markDesktopProfileFailed,
  readDesktopProfileState,
  selectDesktopProfile,
} from '../src/profile-manager.ts'
import { DesktopStartupStateCommit } from '../src/startup-state-commit.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-startup-state-commit-'))
  roots.push(root)
  return root
}

function writeWebProfile(home: string, name: string): string {
  const profileDir = join(home, 'profiles', name)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      },
    },
  }) + '\n')
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\n')
  return profileDir
}

function recoveryStore(
  userDataDir: string,
  profileName: string,
  profileDir: string,
  generationId: string,
): DesktopInstallRecoveryStore {
  return new DesktopInstallRecoveryStore({
    statePath: desktopInstallRecoveryStatePath(userDataDir),
    profileName,
    profileDir,
    generationId,
    now: () => 1_800_000_000_000,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Desktop startup state commit ownership', () => {
  it('promotes the healthy Profile and clears its verified install WAL', async () => {
    const root = temporaryRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'user-data')
    const profileStatePath = join(userDataDir, 'profile-selection', 'state.json')
    const profileDir = writeWebProfile(home, 'work')
    selectDesktopProfile(profileStatePath, home, 'work')
    const profile = beginDesktopProfileStartup(profileStatePath, home)
    const origin = recoveryStore(userDataDir, 'work', profileDir, 'generation-0001')
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    for (const name of DESKTOP_INSTALL_RECOVERY_FILES) {
      writeFileSync(join(profileDir, name), `${name}: post-install\n`)
    }
    await origin.seal(prepared.transactionId)
    const restarted = recoveryStore(userDataDir, 'work', profileDir, 'generation-0002')
    const claim = await restarted.claim()
    expect(claim.action).toBe('verify')
    const quiesceForRecovery = vi.fn(async () => true)
    const logger = { error: vi.fn<(message: string) => void>() }
    const commit = new DesktopStartupStateCommit({
      profile,
      profileStatePath,
      installRecovery: restarted,
      quiesceForRecovery,
      logger,
    })
    commit.observeInstallRecoveryClaim(claim)

    await commit.commitHealthy()

    expect(readDesktopProfileState(profileStatePath)).toEqual({
      version: 1,
      active: 'work',
      lastKnownGood: 'work',
    })
    expect(existsSync(desktopInstallRecoveryStatePath(userDataDir))).toBe(false)
    expect(quiesceForRecovery).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('quiesces the Host before recording a protected install failure', async () => {
    const root = temporaryRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'user-data')
    const profileStatePath = join(userDataDir, 'profile-selection', 'state.json')
    const profileDir = writeWebProfile(home, 'work')
    selectDesktopProfile(profileStatePath, home, 'work')
    const profile = beginDesktopProfileStartup(profileStatePath, home)
    const origin = recoveryStore(userDataDir, 'work', profileDir, 'generation-0001')
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    for (const name of DESKTOP_INSTALL_RECOVERY_FILES) {
      writeFileSync(join(profileDir, name), `${name}: post-install\n`)
    }
    await origin.seal(prepared.transactionId)
    const restarted = recoveryStore(userDataDir, 'work', profileDir, 'generation-0002')
    const claim = await restarted.claim()
    expect(claim.action).toBe('verify')
    const events: string[] = []
    const recordFailure = restarted.recordFailure.bind(restarted)
    vi.spyOn(restarted, 'recordFailure').mockImplementation(async (...args) => {
      events.push('record-failure')
      return await recordFailure(...args)
    })
    const logger = { error: vi.fn<(message: string) => void>() }
    const commit = new DesktopStartupStateCommit({
      profile,
      profileStatePath,
      installRecovery: restarted,
      quiesceForRecovery: async () => {
        events.push('quiesce-host')
        return true
      },
      logger,
    })
    commit.observeInstallRecoveryClaim(claim)

    const result = await commit.commitFailure({
      appReady: true,
      stage: 'renderer-startup',
      failureReason: 'renderer-failed',
    })

    expect(result).toEqual({
      route: 'protected-install-recovery',
      recoveryActionsSafe: true,
    })
    expect(events).toEqual(['quiesce-host', 'record-failure'])
    expect(logger.error).toHaveBeenCalledWith(
      `dsh-plugin-desktop: plugin install plugin-a (${prepared.transactionId}) requires recovery after renderer-failed`,
    )
    expect(await restarted.read()).toMatchObject({
      transactionId: prepared.transactionId,
      phase: 'recovery-pending',
      failureReason: 'renderer-failed',
    })
    expect(readDesktopProfileState(profileStatePath)).toEqual({
      version: 1,
      active: 'work',
      lastKnownGood: 'desktop',
    })
  })

  it('commits a failed candidate Profile back to last-known-good without install recovery', async () => {
    const root = temporaryRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'user-data')
    const profileStatePath = join(userDataDir, 'profile-selection', 'state.json')
    const profileDir = writeWebProfile(home, 'work')
    selectDesktopProfile(profileStatePath, home, 'work')
    const profile = beginDesktopProfileStartup(profileStatePath, home)
    const events: string[] = []
    const commit = new DesktopStartupStateCommit({
      profile,
      profileStatePath,
      installRecovery: recoveryStore(userDataDir, 'work', profileDir, 'generation-0001'),
      quiesceForRecovery: async () => {
        events.push('quiesce-host')
        return true
      },
      logger: { error: vi.fn<(message: string) => void>() },
    })

    const result = await commit.commitFailure({
      appReady: true,
      stage: 'host-boot',
      failureReason: 'startup-failed',
    })

    expect(result).toEqual({
      route: 'last-known-good',
      recoveryActionsSafe: true,
      reopenLastKnownGood: 'desktop',
    })
    expect(events).toEqual(['quiesce-host'])
    expect(readDesktopProfileState(profileStatePath)).toEqual({
      version: 1,
      active: 'desktop',
      lastKnownGood: 'desktop',
    })
    expect(existsSync(desktopInstallRecoveryStatePath(userDataDir))).toBe(false)
  })

  it('does not mutate recovery state when the Host cannot quiesce', async () => {
    const root = temporaryRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'user-data')
    const profileStatePath = join(userDataDir, 'profile-selection', 'state.json')
    const profileDir = writeWebProfile(home, 'work')
    selectDesktopProfile(profileStatePath, home, 'work')
    const profile = beginDesktopProfileStartup(profileStatePath, home)
    const origin = recoveryStore(userDataDir, 'work', profileDir, 'generation-0001')
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    for (const name of DESKTOP_INSTALL_RECOVERY_FILES) {
      writeFileSync(join(profileDir, name), `${name}: post-install\n`)
    }
    await origin.seal(prepared.transactionId)
    const restarted = recoveryStore(userDataDir, 'work', profileDir, 'generation-0002')
    const claim = await restarted.claim()
    expect(claim.action).toBe('verify')
    const recordFailure = vi.spyOn(restarted, 'recordFailure')
    const commit = new DesktopStartupStateCommit({
      profile,
      profileStatePath,
      installRecovery: restarted,
      quiesceForRecovery: async () => false,
      logger: { error: vi.fn<(message: string) => void>() },
    })
    commit.observeInstallRecoveryClaim(claim)

    const result = await commit.commitFailure({
      appReady: true,
      stage: 'renderer-startup',
      failureReason: 'renderer-timeout',
    })

    expect(result).toEqual({
      route: 'protected-install-recovery',
      recoveryActionsSafe: false,
    })
    expect(recordFailure).not.toHaveBeenCalled()
    expect(await restarted.read()).toMatchObject({
      transactionId: prepared.transactionId,
      phase: 'verifying',
    })
    expect(readDesktopProfileState(profileStatePath)).toEqual({
      version: 1,
      active: 'work',
      lastKnownGood: 'desktop',
    })
  })

  it('never downgrades a verified install when Profile promotion later fails', async () => {
    const root = temporaryRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'user-data')
    const profileStatePath = join(userDataDir, 'profile-selection', 'state.json')
    const profileDir = writeWebProfile(home, 'work')
    selectDesktopProfile(profileStatePath, home, 'work')
    const profile = beginDesktopProfileStartup(profileStatePath, home)
    const origin = recoveryStore(userDataDir, 'work', profileDir, 'generation-0001')
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    for (const name of DESKTOP_INSTALL_RECOVERY_FILES) {
      writeFileSync(join(profileDir, name), `${name}: post-install\n`)
    }
    await origin.seal(prepared.transactionId)
    const restarted = recoveryStore(userDataDir, 'work', profileDir, 'generation-0002')
    const claim = await restarted.claim()
    expect(claim.action).toBe('verify')
    const recordFailure = vi.spyOn(restarted, 'recordFailure')
    const commit = new DesktopStartupStateCommit({
      profile,
      profileStatePath,
      installRecovery: restarted,
      quiesceForRecovery: async () => true,
      logger: { error: vi.fn<(message: string) => void>() },
    })
    commit.observeInstallRecoveryClaim(claim)
    markDesktopProfileFailed(profileStatePath, 'work')

    await expect(commit.commitHealthy()).rejects.toThrow('cannot confirm inactive profile')
    expect(await restarted.read()).toMatchObject({
      transactionId: prepared.transactionId,
      phase: 'verified',
    })

    const result = await commit.commitFailure({
      appReady: true,
      stage: 'health-commit',
      failureReason: 'startup-failed',
    })

    expect(result).toEqual({
      route: 'last-known-good',
      recoveryActionsSafe: true,
    })
    expect(recordFailure).not.toHaveBeenCalled()
    expect(await restarted.read()).toMatchObject({
      transactionId: prepared.transactionId,
      phase: 'verified',
    })
  })

  it('keeps a healthy Profile when verified WAL cleanup fails', async () => {
    const root = temporaryRoot()
    const home = join(root, 'home')
    const userDataDir = join(root, 'user-data')
    const profileStatePath = join(userDataDir, 'profile-selection', 'state.json')
    const profileDir = writeWebProfile(home, 'work')
    selectDesktopProfile(profileStatePath, home, 'work')
    const profile = beginDesktopProfileStartup(profileStatePath, home)
    const origin = recoveryStore(userDataDir, 'work', profileDir, 'generation-0001')
    const prepared = await origin.begin({
      packageName: 'plugin-a',
      packageVersion: '1.0.0',
      receiptId: 'receipt-0001',
    })
    for (const name of DESKTOP_INSTALL_RECOVERY_FILES) {
      writeFileSync(join(profileDir, name), `${name}: post-install\n`)
    }
    await origin.seal(prepared.transactionId)
    const restarted = recoveryStore(userDataDir, 'work', profileDir, 'generation-0002')
    const claim = await restarted.claim()
    expect(claim.action).toBe('verify')
    vi.spyOn(restarted, 'clear').mockRejectedValue(new Error('cleanup unavailable'))
    const logger = { error: vi.fn<(message: string) => void>() }
    const commit = new DesktopStartupStateCommit({
      profile,
      profileStatePath,
      installRecovery: restarted,
      quiesceForRecovery: async () => true,
      logger,
    })
    commit.observeInstallRecoveryClaim(claim)

    await expect(commit.commitHealthy()).resolves.toBeUndefined()

    expect(readDesktopProfileState(profileStatePath)).toEqual({
      version: 1,
      active: 'work',
      lastKnownGood: 'work',
    })
    expect(await restarted.read()).toMatchObject({
      transactionId: prepared.transactionId,
      phase: 'verified',
    })
    expect(logger.error).toHaveBeenCalledWith(
      'dsh-plugin-desktop: failed to clear verified plugin install recovery state: cleanup unavailable',
    )
  })
})
