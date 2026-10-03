import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertDesktopFactoryResetTarget,
  resetDesktopDataDirectory,
} from '../src/desktop-factory-reset.ts'
import { readDesktopProfilePreferences, writeDesktopProfilePreferences } from '../src/profile-preferences.ts'
import { completeOrSkipDesktopSetupWizard, readDesktopSetupWizardState } from '../src/setup-wizard-state.ts'
import { readDesktopMarketStateForUserData, selectDesktopMarketProvider } from '../src/desktop-market.ts'
import { readDesktopSetupWizardSettings } from '../src/setup-wizard-settings.ts'
import { readDesktopDisabledBundles } from '../src/desktop-plugins.ts'
import { clearDesktopProfileUsageHistory, desktopReleaseUserDataLocations } from '../src/profile-channel-admission.ts'

const roots: string[] = []

async function fixture(): Promise<{ readonly root: string; readonly home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-beta-factory-reset-'))
  roots.push(root)
  const home = join(root, '.dsh')
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'desktop', 'package.json'), '{}\n')
  writeFileSync(join(home, 'session.jsonl'), '{}\n')
  return { root, home }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

describe('Desktop factory reset', () => {
  it.each([false, true])('drops old preferences before Setup or skip (default directory removed: %s)', async removedDefault => {
    const { root, home } = await fixture()
    const userDataDir = join(root, 'desktop-state')
    const locations = desktopReleaseUserDataLocations(root, userDataDir)
    const profiles = ['desktop', 'work'].map(name => join(home, 'profiles', name))
    const unrelated = join(root, 'other-home', 'profiles', 'desktop')
    const versions = { desktopVersion: '2.0.6-beta.1', dshVersion: '0.1.3-alpha.2', setupRevision: 1 }
    const oldPreferences = {
      mode: 'advanced' as const,
      openBrowser: false,
      networkExposure: 'loopback' as const,
      market: 'community-market' as const,
      notifications: {
        enabled: false,
        notifyOnTurnCompletion: false,
        notifyOnTurnFailure: false,
        notifyOnJobCompletion: false,
        notifyOnJobFailure: false,
        notifyOnScheduleCompletion: false,
        notifyOnScheduleFailure: false,
      },
    }
    for (const profile of [...profiles, unrelated]) {
      mkdirSync(profile, { recursive: true })
      await writeDesktopProfilePreferences(userDataDir, profile, oldPreferences)
      await completeOrSkipDesktopSetupWizard(userDataDir, profile, 'completed', versions)
      await completeOrSkipDesktopSetupWizard(locations.other.userDataDir, profile, 'skipped', versions)
    }
    await selectDesktopMarketProvider(userDataDir, oldPreferences.market)
    const pluginStatePath = join(userDataDir, 'plugin-management', 'state.json')
    mkdirSync(join(userDataDir, 'plugin-management'), { recursive: true, mode: 0o700 })
    writeFileSync(pluginStatePath, JSON.stringify({
      version: 1,
      profiles: ['desktop', 'work', 'unrelated'].map(profileName => ({
        profileName, disabledBundles: ['third-party-plugin'],
      })),
    }), { mode: 0o600 })
    if (removedDefault) await rm(join(home, 'profiles', 'desktop'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'node_modules'))

    await resetDesktopDataDirectory({
      homeDir: home,
      userDataDir,
      protectedPaths: [root],
      trashItem: async path => { await rename(path, join(root, 'trashed-dsh')) },
      clearProfileUsageHistory: profileDir => { clearDesktopProfileUsageHistory(locations, profileDir) },
    })

    for (const profile of profiles) {
      expect(readDesktopProfilePreferences(userDataDir, profile)).toBeUndefined()
      expect(readDesktopSetupWizardState(userDataDir, profile)).toBeUndefined()
      expect(readDesktopSetupWizardState(locations.other.userDataDir, profile)).toBeUndefined()
      const settings = join(profile, 'settings.yaml')
      const defaults = readDesktopSetupWizardSettings(settings)
      expect(defaults.mode).toBe('compatibility')
      expect(defaults.notifications.enabled).toBe(true)
      await completeOrSkipDesktopSetupWizard(userDataDir, profile, 'skipped', versions)
      expect(readDesktopSetupWizardSettings(settings)).toEqual(defaults)
    }
    expect(readDesktopMarketStateForUserData(userDataDir).requested).toBe('disabled')
    expect([...readDesktopDisabledBundles(pluginStatePath, 'desktop')]).toEqual([])
    expect([...readDesktopDisabledBundles(pluginStatePath, 'work')]).toEqual([])
    expect([...readDesktopDisabledBundles(pluginStatePath, 'unrelated')]).toEqual(['third-party-plugin'])
    expect(readDesktopProfilePreferences(userDataDir, unrelated)).toMatchObject(oldPreferences)
    expect(readDesktopSetupWizardState(userDataDir, unrelated)?.outcome).toBe('completed')
    expect(readDesktopSetupWizardState(locations.other.userDataDir, unrelated)?.outcome).toBe('skipped')
  })

  it('preserves external settings when moving the data directory to trash fails', async () => {
    const { root, home } = await fixture()
    const userDataDir = join(root, 'desktop-state')
    const profile = join(home, 'profiles', 'desktop')
    await selectDesktopMarketProvider(userDataDir, 'community-market')
    await completeOrSkipDesktopSetupWizard(userDataDir, profile, 'completed', {
      desktopVersion: '2.0.6-beta.1', dshVersion: '0.1.3-alpha.2', setupRevision: 1,
    })

    await expect(resetDesktopDataDirectory({
      homeDir: home,
      userDataDir,
      protectedPaths: [root],
      trashItem: async () => { throw new Error('trash unavailable') },
    })).rejects.toThrow('trash unavailable')

    expect(readDesktopMarketStateForUserData(userDataDir).requested).toBe('community-market')
    expect(readDesktopSetupWizardState(userDataDir, profile)?.outcome).toBe('completed')
    expect(existsSync(profile)).toBe(true)
  })

  it('moves only the validated DSH Home to trash and recreates an empty root', async () => {
    const { root, home } = await fixture()
    const trashed = join(root, 'trashed-dsh')
    const trashItem = vi.fn(async (path: string) => { await rename(path, trashed) })

    await expect(resetDesktopDataDirectory({
      homeDir: home,
      userDataDir: join(root, 'desktop-state'),
      protectedPaths: [root, join(root, 'desktop-state')],
      trashItem,
    })).resolves.toBe(home)

    expect(trashItem).toHaveBeenCalledWith(home)
    expect(existsSync(join(trashed, 'session.jsonl'))).toBe(true)
    expect(existsSync(home)).toBe(true)
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })

  it('rejects roots, symlinks, uninitialized directories, and protected ancestors', async () => {
    const { root, home } = await fixture()
    expect(() => assertDesktopFactoryResetTarget('/', [root], 'darwin')).toThrow('filesystem root')
    expect(() => assertDesktopFactoryResetTarget(root, [join(root, 'desktop-state')], 'darwin'))
      .toThrow('contains protected')
    const empty = join(root, 'empty')
    mkdirSync(empty)
    expect(() => assertDesktopFactoryResetTarget(empty, [root], 'darwin')).toThrow('not an initialized DSH Home')
    expect(assertDesktopFactoryResetTarget(home, [root], 'darwin')).toBe(home)
  })
})
