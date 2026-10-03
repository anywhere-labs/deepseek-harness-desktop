import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  beginDesktopSetupWizard,
  desktopSetupWizardPending,
  desktopSetupAccountPending,
  dismissDesktopSetupAccount,
  clearDesktopSetupWizardState,
  completeOrSkipDesktopSetupWizard,
  desktopSetupWizardProfileHash,
  desktopSetupWizardRequired,
  desktopSetupWizardStateConstants,
  desktopSetupWizardStatePath,
  readDesktopSetupWizardState,
  type DesktopSetupWizardOutcome,
  type DesktopSetupWizardVersions,
} from '../src/setup-wizard-state.ts'

const temporaryDirectories: string[] = []

it('resumes the account choice after completion, independently for each Profile', async () => {
  const root = temporaryDirectory('dsh-account-setup-')
  const first = join(root, 'first'), second = join(root, 'second')
  expect(desktopSetupAccountPending(root, first)).toBe(false)
  await recordSetup(root, first, 'completed')
  expect(desktopSetupAccountPending(root, first)).toBe(true)
  expect(desktopSetupAccountPending(root, second)).toBe(false)
  await recordSetup(root, second, 'skipped')
  expect(desktopSetupAccountPending(root, second)).toBe(false)
  dismissDesktopSetupAccount(root, first)
  expect(desktopSetupAccountPending(root, first)).toBe(false)
  expect(readDesktopSetupWizardState(root, first)?.outcome).toBe('completed')
  await recordSetup(root, first, 'completed')
  await clearDesktopSetupWizardState(root, first)
  expect(desktopSetupAccountPending(root, first)).toBe(false)
})
const RECORDED_AT = '2026-08-28T04:05:06.789Z'
const CURRENT_VERSIONS: DesktopSetupWizardVersions = Object.freeze({
  desktopVersion: '2.0.3',
  dshVersion: '0.1.1-rc.2',
  setupRevision: desktopSetupWizardStateConstants.setupRevision,
})

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), label))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function recordSetup(
  userData: string,
  profile: string,
  outcome: DesktopSetupWizardOutcome,
  versions: DesktopSetupWizardVersions = CURRENT_VERSIONS,
) {
  return completeOrSkipDesktopSetupWizard(userData, profile, outcome, versions, RECORDED_AT)
}

function writeState(userData: string, profile: string, value: unknown): string {
  const path = desktopSetupWizardStatePath(userData, profile)
  mkdirSync(join(userData, 'profile-setup', desktopSetupWizardProfileHash(profile)), {
    recursive: true,
    mode: 0o700,
  })
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  return path
}

describe('Desktop Setup Wizard state', () => {
  it('resumes an interrupted live-client setup and clears pending on completion or reset', async () => {
    const userData = temporaryDirectory('dsh-setup-pending-user-')
    const profile = temporaryDirectory('dsh-setup-pending-profile-')
    expect(desktopSetupWizardPending(userData, profile)).toBe(false)
    await beginDesktopSetupWizard(userData, profile)
    expect(desktopSetupWizardPending(userData, profile)).toBe(true)
    expect(desktopSetupWizardRequired(readDesktopSetupWizardState(userData, profile), CURRENT_VERSIONS)).toBe(true)
    await recordSetup(userData, profile, 'completed')
    expect(desktopSetupWizardPending(userData, profile)).toBe(false)
    expect(desktopSetupWizardRequired(readDesktopSetupWizardState(userData, profile), CURRENT_VERSIONS)).toBe(false)
    await clearDesktopSetupWizardState(userData, profile)
    await beginDesktopSetupWizard(userData, profile)
    await clearDesktopSetupWizardState(userData, profile)
    expect(desktopSetupWizardPending(userData, profile)).toBe(false)
  })

  it('isolates explicit completion and skip markers by sha256(Profile directory)', async () => {
    const userData = temporaryDirectory('dsh-setup-state-user-')
    const profiles = temporaryDirectory('dsh-setup-state-profiles-')
    const work = join(profiles, 'work')
    const personal = join(profiles, 'personal')
    mkdirSync(work)
    mkdirSync(personal)

    const expectedHash = createHash('sha256').update(resolve(work)).digest('hex')
    expect(desktopSetupWizardProfileHash(work)).toBe(expectedHash)
    expect(desktopSetupWizardStatePath(userData, work)).toBe(
      join(userData, 'profile-setup', expectedHash, 'state.json'),
    )
    expect(readDesktopSetupWizardState(userData, work)).toBeUndefined()

    await expect(recordSetup(userData, work, 'completed')).resolves.toEqual({
      version: 2,
      profileHash: expectedHash,
      outcome: 'completed',
      ...CURRENT_VERSIONS,
      recordedAt: RECORDED_AT,
    })
    await recordSetup(userData, personal, 'skipped')

    expect(readDesktopSetupWizardState(userData, work)?.outcome).toBe('completed')
    expect(readDesktopSetupWizardState(userData, personal)?.outcome).toBe('skipped')

    await clearDesktopSetupWizardState(userData, work)
    expect(readDesktopSetupWizardState(userData, work)).toBeUndefined()
    expect(readDesktopSetupWizardState(userData, personal)?.outcome).toBe('skipped')
  })

  it('writes one private atomic marker without leftover lock or temp files', async () => {
    const userData = temporaryDirectory('dsh-setup-state-user-')
    const profile = temporaryDirectory('dsh-setup-state-profile-')

    await recordSetup(userData, profile, 'completed')
    const statePath = desktopSetupWizardStatePath(userData, profile)
    const directory = join(userData, 'profile-setup', desktopSetupWizardProfileHash(profile))

    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      version: 2,
      profileHash: desktopSetupWizardProfileHash(profile),
      outcome: 'completed',
      ...CURRENT_VERSIONS,
      recordedAt: RECORDED_AT,
    })
    expect(readdirSync(directory)).toEqual(['state.json', 'state.json.account'])
    if (process.platform !== 'win32') {
      expect(statSync(join(userData, 'profile-setup')).mode & 0o777).toBe(0o700)
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(statePath).mode & 0o777).toBe(0o600)
    }
  })

  it('honors legacy V1 decisions and permits explicit V2 recording', async () => {
    const userData = temporaryDirectory('dsh-setup-state-user-')
    const profile = temporaryDirectory('dsh-setup-state-profile-')
    const profileHash = desktopSetupWizardProfileHash(profile)
    writeState(userData, profile, {
      version: 1,
      profileHash,
      outcome: 'skipped',
    })

    const legacy = readDesktopSetupWizardState(userData, profile)
    expect(legacy).toEqual({ version: 1, profileHash, outcome: 'skipped' })
    expect(desktopSetupWizardRequired(legacy, CURRENT_VERSIONS)).toBe(false)

    await recordSetup(userData, profile, 'completed')
    expect(readDesktopSetupWizardState(userData, profile)).toEqual({
      version: 2,
      profileHash,
      outcome: 'completed',
      ...CURRENT_VERSIONS,
      recordedAt: RECORDED_AT,
    })
  })

  it('does not repeat Setup for Desktop, DSH, or Wizard revision changes', async () => {
    const userData = temporaryDirectory('dsh-setup-state-user-')
    const profile = temporaryDirectory('dsh-setup-state-profile-')
    await recordSetup(userData, profile, 'completed')
    const state = readDesktopSetupWizardState(userData, profile)

    expect(desktopSetupWizardRequired(undefined, CURRENT_VERSIONS)).toBe(true)
    expect(desktopSetupWizardRequired(state, CURRENT_VERSIONS)).toBe(false)
    expect(desktopSetupWizardRequired(state, {
      ...CURRENT_VERSIONS,
      desktopVersion: '2.0.4',
    })).toBe(false)
    expect(desktopSetupWizardRequired(state, {
      ...CURRENT_VERSIONS,
      dshVersion: '0.1.2-alpha.2',
    })).toBe(false)
    expect(desktopSetupWizardRequired(state, {
      ...CURRENT_VERSIONS,
      setupRevision: CURRENT_VERSIONS.setupRevision + 1,
    })).toBe(false)

    expect(desktopSetupWizardRequired(state, {
      ...CURRENT_VERSIONS,
      desktopVersion: '2.0.2',
    })).toBe(false)
    expect(desktopSetupWizardRequired(state, {
      ...CURRENT_VERSIONS,
      dshVersion: '0.1.1-rc.1',
    })).toBe(false)
    expect(desktopSetupWizardRequired(state, {
      ...CURRENT_VERSIONS,
      desktopVersion: '2.0.4',
      dshVersion: '0.1.1-rc.1',
    })).toBe(false)
  })

  it.each(['completed', 'skipped'] as const)('keeps %s decisions across Stable/Beta switches in either direction', async outcome => {
    const userData = temporaryDirectory('dsh-setup-state-user-')
    const profile = temporaryDirectory('dsh-setup-state-profile-')
    for (const desktopVersion of ['2.0.5', '2.0.6-beta.1']) {
      const state = await recordSetup(userData, profile, outcome, { ...CURRENT_VERSIONS, desktopVersion })
      for (const nextVersion of ['2.0.4', '2.0.6', '2.0.7-beta.1']) {
        expect(desktopSetupWizardRequired(state, { ...CURRENT_VERSIONS, desktopVersion: nextVersion })).toBe(false)
      }
      expect(readDesktopSetupWizardState(userData, profile)).toEqual(state)
    }
  })

  it('strictly rejects malformed V2 version evidence and write inputs', async () => {
    const userData = temporaryDirectory('dsh-setup-state-user-')
    const profile = temporaryDirectory('dsh-setup-state-profile-')
    const valid = {
      version: 2,
      profileHash: desktopSetupWizardProfileHash(profile),
      outcome: 'completed',
      ...CURRENT_VERSIONS,
      recordedAt: RECORDED_AT,
    }

    writeState(userData, profile, { ...valid, desktopVersion: 'v2.0.3' })
    expect(() => readDesktopSetupWizardState(userData, profile)).toThrow('desktopVersion')
    writeState(userData, profile, { ...valid, dshVersion: '0.1' })
    expect(() => readDesktopSetupWizardState(userData, profile)).toThrow('dshVersion')
    writeState(userData, profile, { ...valid, setupRevision: 0 })
    expect(() => readDesktopSetupWizardState(userData, profile)).toThrow('setupRevision')
    writeState(userData, profile, { ...valid, recordedAt: '2026-08-28' })
    expect(() => readDesktopSetupWizardState(userData, profile)).toThrow('recordedAt')
    writeState(userData, profile, { ...valid, extra: true })
    expect(() => readDesktopSetupWizardState(userData, profile)).toThrow('unexpected fields')

    await expect(recordSetup(userData, profile, 'completed', {
      ...CURRENT_VERSIONS,
      dshVersion: 'invalid',
    })).rejects.toThrow('invalid Setup Wizard versions')
  })

  it('records Setup after an interrupted older run stranded lock and temp siblings', async () => {
    const userData = temporaryDirectory('dsh-setup-state-user-')
    const profile = temporaryDirectory('dsh-setup-state-profile-')
    const statePath = desktopSetupWizardStatePath(userData, profile)
    const directory = join(userData, 'profile-setup', desktopSetupWizardProfileHash(profile))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(`${statePath}.lock`, '12345\n', { mode: 0o600 })
    writeFileSync(`${statePath}.interrupted.tmp`, '', { mode: 0o600 })

    await expect(recordSetup(userData, profile, 'skipped')).resolves.toMatchObject({
      outcome: 'skipped',
    })
    expect(readDesktopSetupWizardState(userData, profile)?.outcome).toBe('skipped')
    expect(readdirSync(directory).sort()).toEqual([
      'state.json',
      'state.json.interrupted.tmp',
      'state.json.lock',
    ])
  })

  it('rejects corrupted, oversized, and mismatched markers', async () => {
    const userData = temporaryDirectory('dsh-setup-state-user-')
    const profile = temporaryDirectory('dsh-setup-state-profile-')
    const statePath = desktopSetupWizardStatePath(userData, profile)
    mkdirSync(join(userData, 'profile-setup', desktopSetupWizardProfileHash(profile)), {
      recursive: true,
      mode: 0o700,
    })

    writeFileSync(statePath, '{not-json}\n', { mode: 0o600 })
    expect(() => readDesktopSetupWizardState(userData, profile)).toThrow('valid JSON')
    await expect(recordSetup(userData, profile, 'completed')).rejects.toThrow('valid JSON')

    writeFileSync(statePath, `${JSON.stringify({
      version: 1,
      profileHash: '0'.repeat(64),
      outcome: 'completed',
    })}\n`, { mode: 0o600 })
    expect(() => readDesktopSetupWizardState(userData, profile)).toThrow('identity does not match')

    writeFileSync(statePath, 'x'.repeat(desktopSetupWizardStateConstants.maxBytes + 1), { mode: 0o600 })
    expect(() => readDesktopSetupWizardState(userData, profile)).toThrow('exceeds')
    await expect(clearDesktopSetupWizardState(userData, profile)).rejects.toThrow('exceeds')
  })

  it('rejects marker bytes that are not valid UTF-8', () => {
    const userData = temporaryDirectory('dsh-setup-state-user-')
    const profile = temporaryDirectory('dsh-setup-state-profile-')
    const statePath = desktopSetupWizardStatePath(userData, profile)
    mkdirSync(join(userData, 'profile-setup', desktopSetupWizardProfileHash(profile)), {
      recursive: true,
      mode: 0o700,
    })
    writeFileSync(statePath, Buffer.from([0xff]), { mode: 0o600 })

    expect(() => readDesktopSetupWizardState(userData, profile)).toThrow('valid UTF-8')
  })

  it.runIf(process.platform !== 'win32')('rejects public marker and state-directory permissions', async () => {
    const userData = temporaryDirectory('dsh-setup-state-user-')
    const profile = temporaryDirectory('dsh-setup-state-profile-')
    await recordSetup(userData, profile, 'completed')
    const statePath = desktopSetupWizardStatePath(userData, profile)

    chmodSync(statePath, 0o644)
    expect(() => readDesktopSetupWizardState(userData, profile)).toThrow('permissions must be 600')
    await expect(clearDesktopSetupWizardState(userData, profile)).rejects.toThrow('permissions must be 600')

    chmodSync(statePath, 0o600)
    chmodSync(join(userData, 'profile-setup'), 0o755)
    expect(() => readDesktopSetupWizardState(userData, profile)).toThrow('permissions must be 700')
  })

  it('never follows a marker symlink for read, replacement, or clear', async () => {
    const userData = temporaryDirectory('dsh-setup-state-user-')
    const profile = temporaryDirectory('dsh-setup-state-profile-')
    const outside = join(temporaryDirectory('dsh-setup-state-outside-'), 'outside.json')
    const statePath = desktopSetupWizardStatePath(userData, profile)
    mkdirSync(join(userData, 'profile-setup', desktopSetupWizardProfileHash(profile)), {
      recursive: true,
      mode: 0o700,
    })
    writeFileSync(outside, 'outside\n', { mode: 0o600 })
    symlinkSync(outside, statePath)

    expect(() => readDesktopSetupWizardState(userData, profile)).toThrow('regular file')
    await expect(recordSetup(userData, profile, 'completed')).rejects.toThrow('regular file')
    await expect(clearDesktopSetupWizardState(userData, profile)).rejects.toThrow('regular file')
    expect(readFileSync(outside, 'utf8')).toBe('outside\n')
  })
})
