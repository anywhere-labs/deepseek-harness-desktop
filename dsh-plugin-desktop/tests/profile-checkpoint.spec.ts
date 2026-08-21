import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DesktopProfileCheckpoint,
  type ProfileCheckpointOptions,
} from '../src/profile-checkpoint.ts'

const roots: string[] = []

function fixture(options: Partial<ProfileCheckpointOptions> = {}): {
  root: string
  profile: string
  userData: string
  checkpoint: DesktopProfileCheckpoint
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-checkpoint-'))
  roots.push(root)
  const profile = join(root, 'profile')
  const userData = join(root, 'user-data')
  mkdirSync(profile)
  mkdirSync(userData)
  writeFileSync(join(profile, 'package.json'), '{"name":"healthy"}\n')
  writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), 'patch: []\n')
  const checkpoint = new DesktopProfileCheckpoint({
    userDataDir: userData,
    profileDir: profile,
    profileIdentity: 'profile-identity',
    profileName: 'work',
    provider: 'dsh-market',
    ...options,
  })
  return { root, profile, userData, checkpoint }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Desktop profile health checkpoint', () => {
  it('captures required files and records an absent optional market state', () => {
    const target = fixture()
    const result = target.checkpoint.captureHealthy()
    expect(result.snapshotExists).toBe(true)
    expect(result.manifest.files).toEqual(expect.arrayContaining([
      { name: '.dsh-market/state.json', present: false },
    ]))
    expect(target.checkpoint.inspectRestore()).toMatchObject({
      snapshotExists: true,
      currentDiffers: false,
      restoreAttempted: false,
    })
  })

  it('requires package.json while recording absent declarative files', () => {
    const target = fixture()
    unlinkSync(join(target.profile, 'package.json'))
    expect(() => target.checkpoint.captureHealthy()).toThrow('package.json is unavailable')

    const missingLock = fixture()
    unlinkSync(join(missingLock.profile, 'pnpm-lock.yaml'))
    expect(() => missingLock.checkpoint.captureHealthy()).not.toThrow()

    const optional = fixture()
    expect(() => optional.checkpoint.captureHealthy()).not.toThrow()
  })

  it('rejects a symlink and an oversized allowlisted file', () => {
    const symlink = fixture()
    unlinkSync(join(symlink.profile, 'cordis.patch.yml'))
    writeFileSync(join(symlink.root, 'outside.yml'), 'outside\n')
    symlinkSync(join(symlink.root, 'outside.yml'), join(symlink.profile, 'cordis.patch.yml'))
    expect(() => symlink.checkpoint.captureHealthy()).toThrow('regular file')

    const oversized = fixture({ maxFileBytes: { 'package.json': 4 } })
    expect(() => oversized.checkpoint.captureHealthy()).toThrow('too large')
  })

  it('publishes a complete atomic snapshot and deduplicates an unchanged healthy boot', () => {
    const target = fixture()
    const first = target.checkpoint.captureHealthy()
    const second = target.checkpoint.captureHealthy()
    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(true)
    expect(readdirSync(join(target.userData, 'health-snapshots'))).toHaveLength(1)
    expect(readdirSync(target.checkpoint.snapshotDirectory)).not.toEqual(expect.arrayContaining([
      expect.stringContaining('.tmp'),
      expect.stringContaining('.staging'),
    ]))
    if (process.platform !== 'win32') {
      expect(lstatSync(join(target.checkpoint.snapshotDirectory, 'manifest.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('restores drift, removes files absent from the healthy image, and marks one failed generation', () => {
    const target = fixture()
    target.checkpoint.captureHealthy()
    writeFileSync(join(target.profile, 'package.json'), '{"name":"broken"}\n')
    mkdirSync(join(target.profile, '.dsh-market'))
    writeFileSync(join(target.profile, '.dsh-market', 'state.json'), '{}\n', { flag: 'w' })
    const inspection = target.checkpoint.inspectRestore()
    expect(inspection.currentDiffers).toBe(true)
    expect(inspection.changedFiles).toContain('package.json')
    expect(inspection.changedFiles).toContain('.dsh-market/state.json')

    const restored = target.checkpoint.restoreLatest('generation-1')
    expect(restored.status).toBe('restored')
    expect(restored.changedFiles).toContain('package.json')
    expect(readFileSync(join(target.profile, 'package.json'), 'utf8')).toBe('{"name":"healthy"}\n')
    expect(existsSync(join(target.profile, '.dsh-market', 'state.json'))).toBe(false)
    expect(target.checkpoint.inspectRestore()).toMatchObject({
      currentDiffers: false,
      restoreAttempted: true,
      failureGeneration: 'generation-1',
    })
    const repeated = target.checkpoint.restoreLatest('generation-1')
    expect(repeated.status).toBe('already-attempted')
    target.checkpoint.captureHealthy()
    expect(target.checkpoint.inspectRestore().restoreAttempted).toBe(false)
  })
})
