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
  clearDesktopProfilePreferences,
  desktopProfilePreferencesFromSettings,
  desktopProfilePreferencesConstants,
  desktopProfilePreferencesProfileHash,
  desktopProfilePreferencesStatePath,
  readDesktopProfilePreferences,
  writeDesktopProfilePreferences,
  type DesktopProfilePreferences,
} from '../src/profile-preferences.ts'

const temporaryDirectories: string[] = []
const RECORDED_AT = '2026-08-28T06:07:08.901Z'
const PREFERENCES: DesktopProfilePreferences = Object.freeze({
  aaEnabled: false,
  mode: 'compatibility',
  openBrowser: true,
  networkExposure: 'lan',
  notifications: Object.freeze({
    enabled: true,
    notifyOnTurnCompletion: true,
    notifyOnTurnFailure: false,
    notifyOnJobCompletion: false,
    notifyOnJobFailure: true,
    notifyOnScheduleCompletion: true,
    notifyOnScheduleFailure: true,
  }),
  market: 'community-market',
})

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), label))
  temporaryDirectories.push(directory)
  return directory
}

function stateDirectory(userData: string, profile: string): string {
  return join(
    userData,
    desktopProfilePreferencesConstants.rootDirectory,
    desktopProfilePreferencesProfileHash(profile),
  )
}

function writeRawState(userData: string, profile: string, value: unknown): string {
  const path = desktopProfilePreferencesStatePath(userData, profile)
  mkdirSync(stateDirectory(userData, profile), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  return path
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Desktop Profile preferences', () => {
  it('toggles AA after reloading durable state without leaking state metadata into the update', async () => {
    const userData = temporaryDirectory('dsh-aa-toggle-')
    const profile = temporaryDirectory('dsh-aa-profile-')
    await writeDesktopProfilePreferences(userData, profile, PREFERENCES)
    for (const enabled of [true, false, true]) {
      const stored = readDesktopProfilePreferences(userData, profile)!
      expect(stored).toHaveProperty('profileHash')
      expect(stored).toHaveProperty('version')
      expect(stored).toHaveProperty('recordedAt')
      const update = desktopProfilePreferencesFromSettings(stored, stored.notifications, stored.market, enabled)
      await writeDesktopProfilePreferences(userData, profile, update)
      expect(readDesktopProfilePreferences(userData, profile)).toMatchObject({
        ...PREFERENCES, aaEnabled: enabled,
      })
    }
  })

  it('defaults legacy preferences to AA off and keeps choices isolated across Profiles', async () => {
    const userData = temporaryDirectory('dsh-aa-preferences-')
    const work = temporaryDirectory('dsh-aa-work-')
    const other = temporaryDirectory('dsh-aa-other-')
    const { aaEnabled: _aa, ...legacy } = PREFERENCES
    writeRawState(userData, work, { ...legacy, version: 1,
      profileHash: desktopProfilePreferencesProfileHash(work), recordedAt: RECORDED_AT })
    expect(readDesktopProfilePreferences(userData, work)?.aaEnabled).toBe(false)
    writeRawState(userData, work, { ...legacy, version: 1, aaEnabled: null,
      profileHash: desktopProfilePreferencesProfileHash(work), recordedAt: RECORDED_AT })
    expect(() => readDesktopProfilePreferences(userData, work)).toThrow('aaEnabled')
    writeRawState(userData, work, { ...legacy, version: 1,
      profileHash: desktopProfilePreferencesProfileHash(work), recordedAt: RECORDED_AT })
    await writeDesktopProfilePreferences(userData, work, { ...PREFERENCES, aaEnabled: true })
    await writeDesktopProfilePreferences(userData, other, PREFERENCES)
    expect(readDesktopProfilePreferences(userData, work)?.aaEnabled).toBe(true)
    expect(readDesktopProfilePreferences(userData, other)?.aaEnabled).toBe(false)
    await expect(writeDesktopProfilePreferences(userData, work, { ...PREFERENCES,
      aaEnabled: 'true' as unknown as boolean })).rejects.toThrow('aaEnabled')
  })

  it('reads saved five-switch notification preferences with schedule switches enabled', () => {
    const userData = temporaryDirectory('dsh-schedule-preferences-')
    const profile = temporaryDirectory('dsh-schedule-profile-')
    const { notifyOnScheduleCompletion: _completion, notifyOnScheduleFailure: _failure, ...notifications } = PREFERENCES.notifications
    writeRawState(userData, profile, { ...PREFERENCES, notifications, version: 1,
      profileHash: desktopProfilePreferencesProfileHash(profile), recordedAt: RECORDED_AT })
    expect(readDesktopProfilePreferences(userData, profile)?.notifications).toEqual({
      ...notifications, notifyOnScheduleCompletion: true, notifyOnScheduleFailure: true,
    })
  })

  it('isolates strict state by sha256(Profile directory)', async () => {
    const userData = temporaryDirectory('dsh-profile-preferences-user-')
    const profiles = temporaryDirectory('dsh-profile-preferences-profiles-')
    const work = join(profiles, 'work')
    const personal = join(profiles, 'personal')
    mkdirSync(work)
    mkdirSync(personal)

    const workHash = createHash('sha256').update(resolve(work)).digest('hex')
    expect(desktopProfilePreferencesProfileHash(work)).toBe(workHash)
    expect(desktopProfilePreferencesStatePath(userData, work)).toBe(
      join(userData, 'profile-preferences', workHash, 'state.json'),
    )
    expect(readDesktopProfilePreferences(userData, work)).toBeUndefined()

    await expect(writeDesktopProfilePreferences(userData, work, PREFERENCES, RECORDED_AT))
      .resolves.toEqual({
        version: 1,
        profileHash: workHash,
        ...PREFERENCES,
        recordedAt: RECORDED_AT,
      })
    await writeDesktopProfilePreferences(userData, personal, {
      ...PREFERENCES,
      openBrowser: false,
      networkExposure: 'loopback',
      market: 'disabled',
    }, RECORDED_AT)

    expect(readDesktopProfilePreferences(userData, work)?.market).toBe('community-market')
    expect(readDesktopProfilePreferences(userData, personal)?.market).toBe('disabled')

    await clearDesktopProfilePreferences(userData, work)
    expect(readDesktopProfilePreferences(userData, work)).toBeUndefined()
    expect(readDesktopProfilePreferences(userData, personal)?.market).toBe('disabled')
  })

  it('writes one private atomic state file with exactly the V1 fields', async () => {
    const userData = temporaryDirectory('dsh-profile-preferences-user-')
    const profile = temporaryDirectory('dsh-profile-preferences-profile-')
    const expected = await writeDesktopProfilePreferences(userData, profile, PREFERENCES, RECORDED_AT)
    const path = desktopProfilePreferencesStatePath(userData, profile)
    const directory = stateDirectory(userData, profile)

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(expected)
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object).sort()).toEqual([
      'aaEnabled',
      'market',
      'mode',
      'networkExposure',
      'notifications',
      'openBrowser',
      'profileHash',
      'recordedAt',
      'version',
    ])
    expect(readdirSync(directory)).toEqual(['state.json'])
    if (process.platform !== 'win32') {
      expect(statSync(join(userData, 'profile-preferences')).mode & 0o777).toBe(0o700)
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  it('strictly validates writes and keeps invalid updates off disk', async () => {
    const userData = temporaryDirectory('dsh-profile-preferences-user-')
    const profile = temporaryDirectory('dsh-profile-preferences-profile-')

    await expect(writeDesktopProfilePreferences(userData, profile, {
      ...PREFERENCES,
      extra: true,
    } as DesktopProfilePreferences, RECORDED_AT)).rejects.toThrow('exactly the supported fields')
    await expect(writeDesktopProfilePreferences(userData, profile, {
      ...PREFERENCES,
      mode: 'advanced',
    }, RECORDED_AT)).rejects.toThrow('openBrowser requires compatibility mode')
    await expect(writeDesktopProfilePreferences(userData, profile, {
      ...PREFERENCES,
      openBrowser: false,
    }, RECORDED_AT)).rejects.toThrow('LAN exposure requires openBrowser')
    await expect(writeDesktopProfilePreferences(userData, profile, {
      ...PREFERENCES,
      notifications: {
        ...PREFERENCES.notifications,
        extra: true,
      } as DesktopProfilePreferences['notifications'],
    }, RECORDED_AT)).rejects.toThrow('supported boolean fields')
    await expect(writeDesktopProfilePreferences(userData, profile, PREFERENCES, '2026-08-28'))
      .rejects.toThrow('recordedAt')

    expect(readDesktopProfilePreferences(userData, profile)).toBeUndefined()
  })

  it('rejects malformed, mismatched, and oversized existing state', async () => {
    const userData = temporaryDirectory('dsh-profile-preferences-user-')
    const profile = temporaryDirectory('dsh-profile-preferences-profile-')
    const path = desktopProfilePreferencesStatePath(userData, profile)
    mkdirSync(stateDirectory(userData, profile), { recursive: true, mode: 0o700 })

    writeFileSync(path, '{not-json}\n', { mode: 0o600 })
    expect(() => readDesktopProfilePreferences(userData, profile)).toThrow('valid JSON')
    await expect(writeDesktopProfilePreferences(userData, profile, PREFERENCES, RECORDED_AT))
      .rejects.toThrow('valid JSON')

    writeRawState(userData, profile, {
      version: 1,
      profileHash: '0'.repeat(64),
      ...PREFERENCES,
      recordedAt: RECORDED_AT,
    })
    expect(() => readDesktopProfilePreferences(userData, profile)).toThrow('identity does not match')

    writeRawState(userData, profile, {
      version: 1,
      profileHash: desktopProfilePreferencesProfileHash(profile),
      ...PREFERENCES,
      recordedAt: RECORDED_AT,
      extra: true,
    })
    expect(() => readDesktopProfilePreferences(userData, profile)).toThrow('exactly the version-one fields')

    writeFileSync(path, 'x'.repeat(desktopProfilePreferencesConstants.maxBytes + 1), { mode: 0o600 })
    expect(() => readDesktopProfilePreferences(userData, profile)).toThrow('exceeds')
    await expect(clearDesktopProfilePreferences(userData, profile)).rejects.toThrow('exceeds')
  })

  it('rejects state bytes that are not valid UTF-8', () => {
    const userData = temporaryDirectory('dsh-profile-preferences-user-')
    const profile = temporaryDirectory('dsh-profile-preferences-profile-')
    const path = desktopProfilePreferencesStatePath(userData, profile)
    mkdirSync(stateDirectory(userData, profile), { recursive: true, mode: 0o700 })
    writeFileSync(path, Buffer.from([0xff]), { mode: 0o600 })

    expect(() => readDesktopProfilePreferences(userData, profile)).toThrow('valid UTF-8')
  })

  it.runIf(process.platform !== 'win32')('rejects public state and directory permissions', async () => {
    const userData = temporaryDirectory('dsh-profile-preferences-user-')
    const profile = temporaryDirectory('dsh-profile-preferences-profile-')
    await writeDesktopProfilePreferences(userData, profile, PREFERENCES, RECORDED_AT)
    const path = desktopProfilePreferencesStatePath(userData, profile)

    chmodSync(path, 0o644)
    expect(() => readDesktopProfilePreferences(userData, profile)).toThrow('permissions must be 600')
    await expect(clearDesktopProfilePreferences(userData, profile)).rejects.toThrow('permissions must be 600')

    chmodSync(path, 0o600)
    chmodSync(join(userData, 'profile-preferences'), 0o755)
    expect(() => readDesktopProfilePreferences(userData, profile)).toThrow('permissions must be 700')
  })

  it('never follows a state symlink for read, replacement, or clear', async () => {
    const userData = temporaryDirectory('dsh-profile-preferences-user-')
    const profile = temporaryDirectory('dsh-profile-preferences-profile-')
    const outside = join(temporaryDirectory('dsh-profile-preferences-outside-'), 'outside.json')
    const path = desktopProfilePreferencesStatePath(userData, profile)
    mkdirSync(stateDirectory(userData, profile), { recursive: true, mode: 0o700 })
    writeFileSync(outside, 'outside\n', { mode: 0o600 })
    symlinkSync(outside, path)

    expect(() => readDesktopProfilePreferences(userData, profile)).toThrow('regular file')
    await expect(writeDesktopProfilePreferences(userData, profile, PREFERENCES, RECORDED_AT))
      .rejects.toThrow('regular file')
    await expect(clearDesktopProfilePreferences(userData, profile)).rejects.toThrow('regular file')
    expect(readFileSync(outside, 'utf8')).toBe('outside\n')
  })
})
