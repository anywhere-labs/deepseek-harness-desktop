import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES, type DesktopState } from '../src/desktop-contract.ts'
import { DesktopPreferenceStore, portsChanged, parsePreferences } from '../src/desktop-preferences.ts'
import { DesktopDiagnostics } from '../src/diagnostics.ts'
import { NextProfiles, WEB_BUNDLES } from '../src/profiles.ts'
import { NextRecovery } from '../src/recovery.ts'

const homes: string[] = []
const logs: DesktopDiagnostics[] = []
function environment() { const home = mkdtempSync(join(tmpdir(), 'next-state-')); homes.push(home); const profiles = new NextProfiles(home); profiles.ensure('desktop'); return { home, profiles, recovery: new NextRecovery(profiles) } }
afterEach(() => { for (const log of logs.splice(0)) log.flush(); for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true }) })

it('keeps desktop preferences separate from the Host and validates all IPC-controlled fields', () => {
  const { home } = environment()
  const store = new DesktopPreferenceStore(home)
  expect(store.read()).toEqual(DEFAULT_PREFERENCES)
  expect(parsePreferences({ developerLogging: true }).developerLogging).toBe(true)
  expect(() => parsePreferences({ developerLogging: 'true' })).toThrow()
  expect(parsePreferences({ notifications: true, turnCompleted: true, turnFailed: true })).toMatchObject({ scheduleCompleted: true, scheduleFailed: true })
  expect(parsePreferences({ jobCompleted: true, jobFailed: true })).toMatchObject({ jobCompleted: false, jobFailed: false })
  store.write({ ...DEFAULT_PREFERENCES, browserAccess: true, port: 3123, closeToTray: false })
  expect(new DesktopPreferenceStore(home).read()).toMatchObject({ browserAccess: true, port: 3123, closeToTray: false })
  for (const value of [{ port: -1 }, { port: '3000' }, { port: 1.1 }, { lanPort: 65536 }, { browserAccess: 'true' }, { windowsMaterial: 'invalid' }, { filename: '/tmp/escape' }]) expect(() => parsePreferences(value)).toThrow()
  expect(portsChanged({ ...DEFAULT_PREFERENCES }, { ...DEFAULT_PREFERENCES, notifications: false })).toBe(false)
  expect(portsChanged({ ...DEFAULT_PREFERENCES }, { ...DEFAULT_PREFERENCES, networkExposure: 'lan' })).toBe(false)
  expect(portsChanged({ ...DEFAULT_PREFERENCES }, { ...DEFAULT_PREFERENCES, port: 3210 })).toBe(true)
})

it('backs up a malformed manifest, repairs without deleting data, and restores the last working config', async () => {
  const { profiles, recovery, home } = environment()
  const dir = profiles.directory('desktop')
  writeFileSync(join(dir, 'cordis.patch.yml'), '# working\n[]\n')
  profiles.setFeatures('desktop', { market: true, remoteControl: true })
  const original = readFileSync(join(dir, 'package.json'), 'utf8')
  recovery.checkpoint('desktop')
  const checkpoint = recovery.latest('desktop')!
  recovery.checkpoint('desktop')
  expect(recovery.latest('desktop')).toEqual(checkpoint)
  writeFileSync(join(dir, 'package.json'), '{ broken JSON')
  writeFileSync(join(dir, 'cordis.patch.yml'), '[broken: yaml')
  writeFileSync(join(home, 'credentials.json'), 'do not change')
  writeFileSync(join(home, 'cordis.patch.yml'), 'global broken')
  const backup = await profiles.recover('desktop')
  expect(readFileSync(backup!, 'utf8')).toBe('[broken: yaml')
  expect(readFileSync(join(checkpoint.directory, 'package.json'), 'utf8')).toBe(original)
  expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh.profile.bundles).toEqual(WEB_BUNDLES)
  expect(profiles.features('desktop')).toEqual({ market: false, remoteControl: false })
  expect(readFileSync(join(home, 'credentials.json'), 'utf8')).toBe('do not change')
  expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toBe('global broken')
  await recovery.restore('desktop')
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(original)
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe('# working\n[]\n')
  expect(profiles.features('desktop')).toEqual({ market: true, remoteControl: true })
  recovery.repairGlobalPatch()
  expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
})

it('refuses corrupt backups and linked configuration before modifying original files', async () => {
  const { profiles, recovery } = environment()
  recovery.checkpoint('desktop')
  const checkpoint = recovery.latest('desktop')!
  const dir = profiles.directory('desktop')
  const original = readFileSync(join(dir, 'package.json'), 'utf8')
  writeFileSync(join(checkpoint.directory, 'package.json'), 'tampered')
  await expect(recovery.restore('desktop')).rejects.toThrow('checksum')
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(original)
  const outside = environment()
  rmSync(join(dir, 'cordis.patch.yml'))
  // Directory junctions exercise link rejection on Windows without symlink privileges.
  symlinkSync(
    process.platform === 'win32' ? outside.profiles.directory('desktop') : join(outside.profiles.directory('desktop'), 'cordis.patch.yml'),
    join(dir, 'cordis.patch.yml'),
    process.platform === 'win32' ? 'junction' : 'file',
  )
  await expect(profiles.recover('desktop')).rejects.toThrow('regular file')
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(original)
})

it('archives inactive Profiles and refuses active/default removal', () => {
  const { profiles, recovery } = environment()
  profiles.create('work')
  expect(() => recovery.removeProfile('desktop', 'work')).toThrow()
  expect(() => recovery.removeProfile('work', 'work')).toThrow()
  recovery.removeProfile('work', 'desktop')
  expect(profiles.list()).toEqual(['desktop'])
  expect(lstatSync(join(recovery.directory, 'removed-profiles')).isDirectory()).toBe(true)
})

it('exports only bounded redacted diagnostics, including secrets split across chunks', () => {
  const { home } = environment()
  const log = new DesktopDiagnostics(home); logs.push(log)
  log.hostChunk('Authorization: Bear')
  log.hostChunk('er private-token\nCookie: secret-cookie\n')
  log.append('debug information', 'debug')
  const data = log.export({ version: 'next-dev', platform: 'test', selected: 'desktop', profiles: [], unavailableProfiles: [], phase: 'error',
    safeMode: false, failure: 'token=private-token', features: { market: false, remoteControl: false }, preferences: { ...DEFAULT_PREFERENCES },
    trayAvailable: true, browserUrl: null, lan: null, busy: false, home, notificationsAvailable: true, checkpoint: null, logs: '' } satisfies DesktopState)
  expect(data).not.toContain('private-token')
  expect(data).not.toContain('secret-cookie')
  expect(data).not.toContain('debug information')
  expect(JSON.parse(data).runtime).not.toHaveProperty('home')
  log.hostChunk('x'.repeat(200_000))
  expect(log.snapshot().length).toBeLessThanOrEqual(128 * 1024)
})
