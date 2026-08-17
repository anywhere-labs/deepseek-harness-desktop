import { describe, expect, it } from 'vitest'
import { DESKTOP_PACKAGE_NAME } from '../src/profile.ts'
import type { DesktopProfileSummary } from '../src/profile-manager.ts'
import {
  computePluginImportPlan,
  desktopOwnedBundles,
  desktopProfileJustCreated,
  pluginImportPlanForProfiles,
  WEB_PROFILE_NAME,
} from '../src/profile-plugin-import.ts'

function summary(
  name: string,
  bundles: readonly string[],
  overrides: Partial<DesktopProfileSummary> = {},
): DesktopProfileSummary {
  return {
    name,
    dir: `/profiles/${name}`,
    exists: true,
    bundles,
    webCapable: true,
    ...overrides,
  }
}

describe('web profile plugin import planning', () => {
  it('classifies every source bundle exactly once and preserves source order', () => {
    const plan = computePluginImportPlan(
      summary(WEB_PROFILE_NAME, ['@deepseek-ai/dsh-base', 'community-a', DESKTOP_PACKAGE_NAME, 'community-b']),
      summary('desktop', ['@deepseek-ai/dsh-base', 'community-a']),
      desktopOwnedBundles(),
    )
    expect(plan).toEqual({
      source: WEB_PROFILE_NAME,
      target: 'desktop',
      toImport: ['community-b'],
      alreadyPresent: ['community-a'],
      skippedOwned: ['@deepseek-ai/dsh-base', DESKTOP_PACKAGE_NAME],
    })
  })

  it('never offers launcher-owned required bundles for import', () => {
    const plan = computePluginImportPlan(
      summary(WEB_PROFILE_NAME, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']),
      summary('desktop', []),
      desktopOwnedBundles(),
    )
    expect(plan.toImport).toEqual([])
    expect(plan.skippedOwned).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  })

  it('exposes the desktop-owned bundle set with the shell package last', () => {
    const owned = desktopOwnedBundles()
    expect(owned).toContain('@deepseek-ai/dsh-base')
    expect(owned).toContain('@deepseek-ai/dsh-web-app')
    expect(owned[owned.length - 1]).toBe(DESKTOP_PACKAGE_NAME)
  })

  it('returns the web-to-target offer with a non-empty import list', () => {
    const plan = pluginImportPlanForProfiles(
      [summary(WEB_PROFILE_NAME, ['community-a', 'community-b']), summary('desktop', [])],
      'desktop',
      desktopOwnedBundles(),
    )
    expect(plan?.source).toBe(WEB_PROFILE_NAME)
    expect(plan?.target).toBe('desktop')
    expect(plan?.toImport).toEqual(['community-a', 'community-b'])
  })

  it('returns undefined when the target already has every web bundle', () => {
    expect(pluginImportPlanForProfiles(
      [summary(WEB_PROFILE_NAME, ['community-a']), summary('desktop', ['community-a'])],
      'desktop',
      desktopOwnedBundles(),
    )).toBeUndefined()
  })

  it('returns undefined when the web profile is missing or broken', () => {
    expect(pluginImportPlanForProfiles(
      [summary('desktop', [])],
      'desktop',
      desktopOwnedBundles(),
    )).toBeUndefined()
    expect(pluginImportPlanForProfiles(
      [summary(WEB_PROFILE_NAME, ['community-a'], { problem: 'broken manifest' }), summary('desktop', [])],
      'desktop',
      desktopOwnedBundles(),
    )).toBeUndefined()
  })

  it('returns undefined when the target profile is missing', () => {
    expect(pluginImportPlanForProfiles(
      [summary(WEB_PROFILE_NAME, ['community-a'])],
      'desktop',
      desktopOwnedBundles(),
    )).toBeUndefined()
  })

  it('detects the one-shot first-creation window only for a fresh active desktop profile', () => {
    expect(desktopProfileJustCreated(false, 'desktop')).toBe(true)
    expect(desktopProfileJustCreated(true, 'desktop')).toBe(false)
    expect(desktopProfileJustCreated(false, 'web')).toBe(false)
  })
})
