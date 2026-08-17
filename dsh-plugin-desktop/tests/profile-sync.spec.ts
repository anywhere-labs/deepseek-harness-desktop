import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  initProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  writeProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import {
  computeProfileBundleUnion,
  DESKTOP_PROFILE_NAME,
  isSyncedBundle,
  mergeBundlesForProfile,
  readProfileBundles,
  syncProfileManifests,
  WEB_PROFILE_NAME,
} from '../src/profile-sync.ts'

const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-sync-'))
  homes.push(home)
  return home
}

function initProfileWithBundles(home: string, name: string, thirdParty: string[]): string {
  const dir = join(home, 'profiles', name)
  const template = PROFILE_TEMPLATES.web
  if (template === undefined) throw new Error('test requires the shipped Web template')
  initProfile(dir, template)
  const manifest = readProfileManifest('test', dir)
  writeProfileManifest(dir, {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: [...template, ...thirdParty],
      },
    },
  })
  return dir
}

afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  }
})

describe('profile bundle synchronization', () => {
  it('treats framework and launcher bundles as non-synced', () => {
    expect(isSyncedBundle('@deepseek-ai/dsh-base')).toBe(false)
    expect(isSyncedBundle('@deepseek-ai/dsh-web-app')).toBe(false)
    expect(isSyncedBundle('dsh-plugin-desktop')).toBe(false)
    expect(isSyncedBundle('dshmarket')).toBe(true)
  })

  it('merges framework order first, then existing third-party, then new union', () => {
    const existing = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-a']
    const merged = mergeBundlesForProfile(existing, new Set(['dsh-a', 'dsh-b']))
    expect(merged).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'dsh-a',
      'dsh-b',
    ])
  })

  it('does not duplicate framework bundles when both profiles share them', () => {
    const union = new Set(['dshmarket'])
    const merged = mergeBundlesForProfile(
      ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      union,
    )
    expect(merged.filter(bundle => bundle === '@deepseek-ai/dsh-base')).toHaveLength(1)
  })

  it('computes the union of third-party bundles across existing profiles', () => {
    const home = temporaryHome()
    initProfileWithBundles(home, WEB_PROFILE_NAME, ['dshmarket'])
    initProfileWithBundles(home, DESKTOP_PROFILE_NAME, ['dsh-workbench-plugin'])
    const union = computeProfileBundleUnion(home, [WEB_PROFILE_NAME, DESKTOP_PROFILE_NAME])
    expect(union.has('dshmarket')).toBe(true)
    expect(union.has('dsh-workbench-plugin')).toBe(true)
  })

  it('aligns both profile manifests to the shared bundle union', () => {
    const home = temporaryHome()
    initProfileWithBundles(home, WEB_PROFILE_NAME, ['dshmarket'])
    initProfileWithBundles(home, DESKTOP_PROFILE_NAME, ['dsh-workbench-plugin'])

    const report = syncProfileManifests(home, [WEB_PROFILE_NAME, DESKTOP_PROFILE_NAME])

    expect(report.updatedProfiles.sort()).toEqual([DESKTOP_PROFILE_NAME, WEB_PROFILE_NAME])
    const webBundles = readProfileBundles(join(home, 'profiles', WEB_PROFILE_NAME))
    const desktopBundles = readProfileBundles(join(home, 'profiles', DESKTOP_PROFILE_NAME))
    expect(webBundles).toContain('dsh-workbench-plugin')
    expect(desktopBundles).toContain('dshmarket')
    // Framework bundles must remain present and unduplicated in both profiles.
    for (const bundles of [webBundles, desktopBundles]) {
      expect(bundles.filter(bundle => bundle === '@deepseek-ai/dsh-base')).toHaveLength(1)
      expect(bundles.filter(bundle => bundle === '@deepseek-ai/dsh-web-app')).toHaveLength(1)
      expect(bundles).not.toContain('dsh-plugin-desktop')
    }
  })

  it('skips profiles that do not exist on disk without touching the existing one', () => {
    const home = temporaryHome()
    initProfileWithBundles(home, WEB_PROFILE_NAME, ['dshmarket'])
    const report = syncProfileManifests(home, [WEB_PROFILE_NAME, DESKTOP_PROFILE_NAME])
    // The missing desktop profile is skipped; web already holds the only union
    // member, so no manifest rewrite is needed and nothing crashes.
    expect(report.updatedProfiles).toEqual([])
    expect(readProfileBundles(join(home, 'profiles', WEB_PROFILE_NAME))).toContain('dshmarket')
  })

  it('is idempotent when profiles already share the union', () => {
    const home = temporaryHome()
    initProfileWithBundles(home, WEB_PROFILE_NAME, ['dshmarket', 'dsh-workbench-plugin'])
    initProfileWithBundles(home, DESKTOP_PROFILE_NAME, ['dshmarket', 'dsh-workbench-plugin'])
    const report = syncProfileManifests(home, [WEB_PROFILE_NAME, DESKTOP_PROFILE_NAME])
    expect(report.updatedProfiles).toEqual([])
  })
})
