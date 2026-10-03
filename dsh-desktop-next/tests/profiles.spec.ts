import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { composeEntries, loadOverlayPatches, loadProfileDirectory, OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-app-boot'
import { AA_PACKAGE, COMMUNITY_MARKET_PACKAGE, DSH_MARKET_PACKAGE, loadNextProfile, NEXT_PACKAGE, NextProfiles, profileName, readNextProfilePatches, WEB_BUNDLES } from '../src/profiles.ts'
import * as privateFiles from '../src/private-files.ts'
import * as linkProjections from '../../dsh-plugin-desktop-beta/src/link-projections.ts'

const roots: string[] = []
function profiles() { const home = mkdtempSync(join(tmpdir(), 'dsh-next-profiles-')); roots.push(home); return new NextProfiles(home) }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it.each(['../outside', 'a/b', 'a\\b', 'node_modules', 'CON', '', 'a'.repeat(65)])('rejects invalid profile name %s', name => {
  expect(() => profileName(name)).toThrow()
})
it('starts fresh homes with desktop and preserves an explicitly selected legacy Profile', () => {
  const manager = profiles()
  expect(manager.active).toBe('desktop')
  const legacy = manager.ensure('default')
  const original = readFileSync(join(legacy, 'package.json'), 'utf8')
  manager.ensure(manager.active)
  expect(manager.features('desktop')).toEqual({ remoteControl: false, market: false })
  expect(JSON.parse(readFileSync(join(manager.directory('desktop'), 'package.json'), 'utf8')).dsh.profile.bundles)
    .not.toContain(COMMUNITY_MARKET_PACKAGE)
  expect(manager.list()).toEqual(['default', 'desktop'])
  expect(readFileSync(join(legacy, 'package.json'), 'utf8')).toBe(original)
  manager.select('default')
  expect(new NextProfiles(manager.home).active).toBe('default')
  expect(manager.selectable('desktop')).toBe(true)
})
it('opens an existing Web Profile without recording a Next bundle for other launchers', () => {
  const manager = profiles()
  const dir = manager.create('work')
  const path = join(dir, 'package.json')
  const original = JSON.parse(readFileSync(path, 'utf8'))
  original.dsh.profile.bundles = original.dsh.profile.bundles.filter((name: string) =>
    name !== 'dsh-desktop-next' && name !== COMMUNITY_MARKET_PACKAGE)
  delete original.dsh.desktopNextPlugins
  delete original.dsh.desktopNextScheduleBundle
  original.custom = 'stable-setting'
  const bytes = JSON.stringify(original)
  writeFileSync(path, bytes)
  expect(manager.selectable('work')).toBe(true)
  expect(manager.features('work')).toEqual({ remoteControl: false, market: false })
  manager.select('work')
  expect(readFileSync(path, 'utf8')).toBe(bytes)

  const profile = loadNextProfile(dir, manager.home)
  expect(profile.layers.map(layer => layer.packageName)).toContain('dsh-desktop-next')
  expect(loadProfileDirectory('stable', dir, NEXT_PACKAGE).layers.map(layer => layer.packageName))
    .not.toContain('dsh-desktop-next')
  const adopted = JSON.parse(readFileSync(path, 'utf8'))
  expect(adopted.custom).toBe('stable-setting')
  expect(adopted.dsh.profile.bundles).toEqual(original.dsh.profile.bundles)
  expect(manager.features('work')).toEqual({ remoteControl: false, market: false })
  expect(readdirSync(manager.home)).not.toContain('recovery')
  // The only Next write is its one-time Scheduled Tasks migration marker.
  const { desktopNextScheduleBundle, ...shared } = adopted.dsh
  expect(desktopNextScheduleBundle).toBe(1)
  expect(shared).toEqual(original.dsh)
  const marked = readFileSync(path, 'utf8')
  manager.ensure('work')
  expect(readFileSync(path, 'utf8')).toBe(marked)
})
it('isolates profile configuration and preserves existing files on ensure', () => {
  const manager = profiles()
  const first = manager.ensure('desktop')
  manager.create('work')
  expect(manager.features('work')).toEqual({ remoteControl: false, market: false })
  writeFileSync(join(first, 'cordis.patch.yml'), '# user patch\n[]\n')
  manager.ensure('desktop')
  manager.setFeatures('work', { remoteControl: true, market: false })
  manager.select('work')
  expect(new NextProfiles(manager.home).active).toBe('work')
  expect(manager.features('desktop')).toEqual({ remoteControl: false, market: false })
  expect(manager.features('work')).toEqual({ remoteControl: true, market: false })
  expect(readFileSync(join(first, 'cordis.patch.yml'), 'utf8')).toBe('# user patch\n[]\n')
  expect(() => manager.create('work')).toThrow()
})

it('records onboarding per Profile together with its plugin choices and retains unrelated configuration', () => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  manager.create('work')
  const file = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.dsh.profile.bundles.push('my-plugin')
  manifest.dependencies = { 'my-plugin': '1.0.0' }
  manifest.custom = 'keep'
  writeFileSync(file, JSON.stringify(manifest))
  expect(manager.onboardingRequired('desktop')).toBe(true)
  manager.finishOnboarding('desktop', { features: { market: false, dshMarket: true, remoteControl: true }, computerUse: true })
  const reread = new NextProfiles(manager.home)
  reread.ensure('desktop')
  expect(reread.onboardingRequired('desktop')).toBe(false)
  expect(reread.accountSetupPending('desktop')).toBe(true)
  expect(reread.accountSetupPending('work')).toBe(false)
  reread.dismissAccountSetup('desktop')
  expect(new NextProfiles(manager.home).accountSetupPending('desktop')).toBe(false)
  expect(reread.onboardingRequired('work')).toBe(true)
  expect(reread.features('desktop')).toEqual({ market: false, dshMarket: true, remoteControl: true })
  expect(reread.computerUseEnabled('desktop')).toBe(true)
  expect(reread.computerUseEnabled('work')).toBe(false)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
    custom: 'keep', dependencies: manifest.dependencies,
    dsh: { desktopNextOnboarding: { version: 1, outcome: 'completed' }, profile: { bundles: expect.arrayContaining(['my-plugin']) } },
  })
  manager.select('work'); manager.select('desktop')
  expect(manager.onboardingRequired('desktop')).toBe(false)
})

it('skips onboarding without changing current choices, while a recreated Profile starts fresh', () => {
  const manager = profiles()
  const dir = manager.create('work')
  manager.setFeatures('work', { market: false, dshMarket: true, remoteControl: true })
  const patch = '# existing choice\n- id: computer-use-cua-driver-native\n  disabled: false\n'
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  manager.finishOnboarding('work')
  expect(manager.accountSetupPending('work')).toBe(false)
  expect(manager.onboardingRequired('work')).toBe(false)
  expect(manager.features('work')).toEqual({ market: false, dshMarket: true, remoteControl: true })
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh.desktopNextOnboarding.outcome).toBe('skipped')
  rmSync(dir, { recursive: true })
  manager.create('work')
  expect(manager.onboardingRequired('work')).toBe(true)
  expect(manager.computerUseEnabled('work')).toBe(false)
})

it.each([
  { market: true, dshMarket: true, remoteControl: false },
  { market: true, remoteControl: 'yes' },
  { market: false, remoteControl: false, extra: true },
])('leaves onboarding incomplete and configuration untouched on invalid choices %j', value => {
  const manager = profiles()
  const file = join(manager.ensure('desktop'), 'package.json')
  const original = readFileSync(file, 'utf8')
  expect(() => manager.finishOnboarding('desktop', { features: value, computerUse: false })).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(original)
  expect(manager.onboardingRequired('desktop')).toBe(true)
})

it.each([true, false])('saves Computer Use=%s in the official row without losing comments, expressions or other overrides', enabled => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, `# My Profile\n- id: agent\n  config:\n    label: !!js "'keep'"\n- id: computer-use-cua-driver-native\n  disabled: false # first override\n- id: computer-use-cua-driver-native\n  name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'\n  disabled: true # final override\n`)
  expect(manager.computerUseEnabled('desktop')).toBe(false)
  manager.finishOnboarding('desktop', { features: { market: false, remoteControl: false }, computerUse: enabled })
  const saved = readFileSync(patchPath, 'utf8')
  expect(saved).toContain('# My Profile')
  expect(saved).toContain('!!js')
  expect(saved).toContain('# first override')
  expect(saved).toContain('# final override')
  const profile = loadNextProfile(dir, manager.home)
  const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  expect(rows.find(row => row.id === 'computer-use-cua-driver-native')?.disabled).toBe(!enabled)
  expect(manager.computerUseEnabled('desktop')).toBe(enabled)
  // Subsequent official manager edits own the row; completion never forces it back on.
  writeFileSync(patchPath, '- id: computer-use-cua-driver-native\n  disabled: true\n')
  manager.ensure('desktop')
  expect(manager.computerUseEnabled('desktop')).toBe(false)
  expect(manager.onboardingRequired('desktop')).toBe(false)
})

it.each([undefined, 'yes', 1, null])('rejects an invalid Computer Use choice %j before writing either file', computerUse => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  const manifest = readFileSync(join(dir, 'package.json'), 'utf8')
  const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  expect(() => manager.finishOnboarding('desktop', { features: { market: false, remoteControl: false }, computerUse })).toThrow('Computer Use')
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifest)
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
})

it('reads the saved enablement through later configuration-only and name-mismatched overrides', () => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: computer-use-cua-driver-native\n  disabled: false\n- id: computer-use-cua-driver-native\n  config: {}\n- id: computer-use-cua-driver-native\n  name: another-plugin\n  disabled: true\n')
  expect(manager.computerUseEnabled('desktop')).toBe(true)
})

it.each([': broken: [yaml', 'disabled: false\n'])('does not overwrite an invalid patch while completing onboarding: %s', patch => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  const manifest = readFileSync(join(dir, 'package.json'), 'utf8')
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  expect(() => manager.finishOnboarding('desktop', { features: { market: false, remoteControl: false }, computerUse: true })).toThrow()
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifest)
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  expect(manager.onboardingRequired('desktop')).toBe(true)
})

it('restores the original patch and leaves onboarding pending when completion cannot be saved', () => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  const write = vi.spyOn(privateFiles, 'atomicJson').mockImplementationOnce(() => { throw new Error('Cannot save manifest') })
  try {
    expect(() => manager.finishOnboarding('desktop', { features: { market: false, remoteControl: true }, computerUse: true })).toThrow('Cannot save manifest')
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(manager.onboardingRequired('desktop')).toBe(true)
    expect(manager.features('desktop')).toEqual({ market: false, remoteControl: false })
  } finally { write.mockRestore() }
})
it('refuses a symlinked profile before writing outside Next home', () => {
  const manager = profiles()
  const outside = profiles()
  mkdirSync(join(manager.home, 'profiles'))
  symlinkSync(outside.home, join(manager.home, 'profiles', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => manager.ensure('escape')).toThrow('real directory')
})
it('recovers without parsing broken patches or deleting plugin packages and home patches', async () => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  manifest.dsh.profile.bundles.push('missing-third-party-plugin')
  manifest.dependencies = { 'missing-third-party-plugin': '1.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  const broken = ': invalid: [yaml'
  writeFileSync(join(dir, 'cordis.patch.yml'), broken)
  writeFileSync(join(manager.home, 'cordis.patch.yml'), '# keep home patch\n[]\n')
  mkdirSync(join(dir, 'node_modules', 'missing-third-party-plugin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'missing-third-party-plugin', 'keep'), 'plugin')
  manager.setFeatures('desktop', { remoteControl: true, market: true })
  manager.finishOnboarding('desktop')
  const backup = await manager.recover('desktop')
  expect(readFileSync(backup!, 'utf8')).toBe(broken)
  expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh.profile.bundles).toEqual(WEB_BUNDLES)
  expect(manager.features('desktop')).toEqual({ remoteControl: false, market: false })
  expect(manager.onboardingRequired('desktop')).toBe(false)
  expect(readFileSync(join(dir, 'node_modules', 'missing-third-party-plugin', 'keep'), 'utf8')).toBe('plugin')
  expect(readFileSync(join(manager.home, 'cordis.patch.yml'), 'utf8')).toContain('keep home patch')
})
it.each(['desktop', 'work', 'default'])('offers the Browser in %s without enabling optional bundles or overriding user choices', name => {
  const manager = profiles()
  const dir = manager.ensure(name)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  for (const bundle of OPTIONAL_BUNDLES) expect(manifest.dsh.profile.bundles).not.toContain(bundle)
  const profile = loadNextProfile(dir, manager.home)
  const layers = profile.layers.map(layer => layer.patches)
  const browser = (patches = loadOverlayPatches('next', profile.patchPath)) =>
    composeEntries([...layers, patches]).find(row => row.id === 'ui-sidebar-browser')
  expect(browser()).toMatchObject({ name: '@deepseek-ai/dsh-client-ui-sidebar-browser', disabled: false })
  for (const disabled of [true, false]) {
    writeFileSync(profile.patchPath, `- id: ui-sidebar-browser\n  disabled: ${disabled}\n`)
    expect(browser()?.disabled).toBe(disabled)
  }
})

it('composes optional AA and Market while retaining the official Web layout', () => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  manager.setFeatures('desktop', { remoteControl: true, market: true, dshMarket: true })
  const profile = loadNextProfile(dir, manager.home)
  const rows = composeEntries([...profile.layers.map(layer => layer.patches), loadOverlayPatches('next', join(dir, 'desktop-next.cordis.patch.json'))])
  expect(rows.some(row => row.name === AA_PACKAGE && !row.disabled)).toBe(true)
  expect(rows.some(row => row.name === COMMUNITY_MARKET_PACKAGE && !row.disabled)).toBe(true)
  expect(rows.some(row => row.name === DSH_MARKET_PACKAGE && !row.disabled)).toBe(true)
  expect(rows.some(row => row.id === 'ui-layout' && !row.disabled)).toBe(true)
  expect(rows.some(row => row.name === '@deepseek-ai/dsh-computer-use' && !row.disabled)).toBe(true)
  expect(rows.some(row => row.name === '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native' && row.disabled)).toBe(true)
  // Client module discovery requires a package root, not the previous /extensions subpath.
  expect(rows.find(row => row.id === 'desktop-next-capabilities')?.name).toBe('dsh-desktop-next')
  const overlays = [fileURLToPath(new URL('../host.cordis.patch.yml', import.meta.url)),
    join(dir, 'desktop-next.cordis.patch.json')]
  const reread = readNextProfilePatches(dir, manager.home, overlays)
  const reconciled = composeEntries([reread])
  expect(reconciled.some(row => row.name === 'dsh-community-market' && !row.disabled)).toBe(true)
  expect(reconciled.find(row => row.id === 'webserver')?.disabled).toBe(true)
  expect(reconciled.some(row => row.name === 'dsh-desktop-next/webserver' && !row.disabled)).toBe(true)
  writeFileSync(profile.patchPath, '- id: ui-sidebar-browser\n  disabled: true\n- id: computer-use-cua-driver-native\n  disabled: false\n')
  const updated = composeEntries([readNextProfilePatches(dir, manager.home, overlays)])
  expect(updated.find(row => row.id === 'ui-sidebar-browser')?.disabled).toBe(true)
  expect(updated.find(row => row.id === 'computer-use-cua-driver-native')?.disabled).toBe(false)
  const pending = composeEntries([readNextProfilePatches(dir, manager.home, overlays,
    [{ id: 'ui-sidebar-browser', disabled: false }])])
  expect(pending.find(row => row.id === 'ui-sidebar-browser')?.disabled).toBe(false)
  manager.setFeatures('desktop', { remoteControl: false, market: false })
  const disabled = composeEntries([...loadNextProfile(dir, manager.home).layers.map(layer => layer.patches), loadOverlayPatches('next', join(dir, 'desktop-next.cordis.patch.json'))])
  expect(disabled.some(row => !row.disabled && (row.name === AA_PACKAGE || row.name === 'dsh-community-market'))).toBe(false)
})

it('shares AA defaults across Profiles and replaces legacy generated state overrides', () => {
  const manager = profiles()
  for (const name of ['desktop', 'work']) {
    const dir = manager.ensure(name)
    manager.setFeatures(name, { remoteControl: true, market: false })
    const legacyRoot = join(manager.home, 'agents-anywhere', name)
    mkdirSync(legacyRoot, { recursive: true })
    const legacyState = join(legacyRoot, 'settings.json')
    writeFileSync(legacyState, '{"fixture":"preserve"}')
    const overlayPath = join(dir, 'desktop-next.cordis.patch.json')
    writeFileSync(overlayPath, JSON.stringify([{ id: 'agents-anywhere-bridge-next', config: {
      dshHome: manager.home, stateRoot: legacyRoot,
    } }]))
    loadNextProfile(dir, manager.home)
    const rows = composeEntries([readNextProfilePatches(dir, manager.home, [overlayPath])])
    const aa = rows.find(row => row.id === 'agents-anywhere-bridge-next')
    expect(aa?.disabled).not.toBe(true)
    expect(aa?.config).toEqual({ dshHome: manager.home })
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))[0].config).toEqual({ dshHome: manager.home })
    expect(readFileSync(legacyState, 'utf8')).toBe('{"fixture":"preserve"}')
  }
})

it('refuses to overwrite an unmanaged bundle fallback', () => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  mkdirSync(join(manager.home, 'profiles', 'node_modules', 'dsh-desktop-next'), { recursive: true })
  expect(() => loadNextProfile(dir, manager.home)).toThrow('unmanaged package')
})

it('marks broken or non-Next Profiles unavailable without modifying or loading them', () => {
  const manager = profiles()
  manager.ensure('desktop')
  const broken = manager.create('broken')
  writeFileSync(join(broken, 'package.json'), '{broken')
  const foreign = manager.create('foreign')
  writeFileSync(join(foreign, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['third-party'] } } }))
  expect(manager.list()).toEqual(['broken', 'desktop', 'foreign'])
  expect(manager.selectable('desktop')).toBe(true)
  expect(manager.selectable('broken')).toBe(false)
  expect(manager.selectable('foreign')).toBe(false)
  expect(() => manager.select('broken')).toThrow('unavailable')
  expect(manager.active).toBe('desktop')
  expect(readFileSync(join(broken, 'package.json'), 'utf8')).toBe('{broken')
})


it('migrates legacy switches once and preserves later official plugin selections across restarts', () => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  const file = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  delete manifest.dsh.desktopNextPlugins
  manifest.dsh.profile.bundles = [...WEB_BUNDLES, 'dsh-desktop-next', DSH_MARKET_PACKAGE]
  manifest.dependencies = { 'my-plugin': '1.0.0' }
  manifest.custom = 'keep'
  writeFileSync(file, JSON.stringify(manifest))
  writeFileSync(join(dir, 'desktop-next.features.json'), JSON.stringify({ market: false, remoteControl: true }))
  manager.ensure('desktop')
  expect(manager.features('desktop')).toEqual({ market: false, remoteControl: true, dshMarket: true })
  const migrated = JSON.parse(readFileSync(file, 'utf8'))
  expect(migrated).toMatchObject({ dependencies: manifest.dependencies, custom: 'keep' })
  expect(migrated.dsh.profile.bundles).not.toContain('dsh-desktop-next')
  expect(loadProfileDirectory('stable', dir, NEXT_PACKAGE).layers.map(layer => layer.packageName))
    .not.toContain('dsh-desktop-next')
  expect(readdirSync(join(manager.home, 'recovery'))).toHaveLength(1)
  // The official manager writes the bundle list, with no shell feature flag write.
  migrated.dsh.profile.bundles = [...WEB_BUNDLES, COMMUNITY_MARKET_PACKAGE, DSH_MARKET_PACKAGE]
  writeFileSync(file, JSON.stringify(migrated))
  manager.ensure('desktop')
  loadNextProfile(dir, manager.home)
  expect(manager.features('desktop')).toEqual({ market: true, remoteControl: false, dshMarket: true })
  const overlay = JSON.parse(readFileSync(join(dir, 'desktop-next.cordis.patch.json'), 'utf8'))
  expect(overlay.every((row: object) => !Object.hasOwn(row, 'disabled'))).toBe(true)
  manager.create('work')
  expect(manager.features('work')).toEqual({ market: false, remoteControl: false })
})

it('keeps the recovery deselection ledger across a feature change and never reselects from it', () => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  const file = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.dependencies = { 'my-plugin': '1.0.0' }
  manifest.dsh.desktopNextDeselectedBundles = ['my-plugin']
  writeFileSync(file, JSON.stringify(manifest))

  manager.finishOnboarding('desktop', { features: { market: false, dshMarket: true, remoteControl: true }, computerUse: false })

  const after = JSON.parse(readFileSync(file, 'utf8'))
  expect(after.dsh.desktopNextDeselectedBundles).toEqual(['my-plugin'])
  expect(after.dsh.profile.bundles).not.toContain('my-plugin')
  expect(after.dependencies['my-plugin']).toBe('1.0.0')
  expect(after.dsh.profile.bundles).toContain(DSH_MARKET_PACKAGE)
  expect(after.dsh.profile.bundles).toContain(AA_PACKAGE)
  expect(after.dsh.profile.bundles).not.toContain(COMMUNITY_MARKET_PACKAGE)
})

/** A Profile as 0.1.7-rc.2 left it: no migration marker, Schedule toggled through Web rows. */
function rc2Profile(patch: string) {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  const file = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  delete manifest.dsh.desktopNextScheduleBundle
  writeFileSync(file, JSON.stringify(manifest))
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  const read = () => ({ bundles: JSON.parse(readFileSync(file, 'utf8')).dsh.profile.bundles as string[],
    patch: readFileSync(join(dir, 'cordis.patch.yml'), 'utf8') })
  return { manager, dir, file, read }
}
const SCHEDULE_BUNDLE = '@deepseek-ai/dsh-experimental-schedule-bundle'

it('selects the Scheduled Tasks bundle once for rc.2 users who had it on and drops the stale row toggles', () => {
  const { manager, dir, file, read } = rc2Profile([
    '# keep me',
    '- id: ui-sidebar-browser',
    '  disabled: true',
    '- id: time-context',
    '  disabled: false',
    '- id: schedule',
    '  disabled: false',
    '- id: ui-schedule',
    '  disabled: false',
    '',
  ].join('\n'))
  const profile = loadNextProfile(dir, manager.home)
  const after = read()
  expect(after.bundles).toContain(SCHEDULE_BUNDLE)
  expect(after.patch).toBe('# keep me\n- id: ui-sidebar-browser\n  disabled: true\n')
  expect(readdirSync(join(manager.home, 'recovery'))).toHaveLength(1)
  const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  for (const name of ['@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-schedule', '@deepseek-ai/dsh-client-ui-schedule']) {
    const row = rows.find(item => item.name === name)
    expect(row).toBeDefined()
    expect(row?.disabled).toBeFalsy()
  }

  // The bundle's own row switches write the same ids; a later deselection must stick.
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name: string) => name !== SCHEDULE_BUNDLE)
  writeFileSync(file, JSON.stringify(manifest))
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: schedule\n  disabled: false\n')
  const before = readFileSync(file, 'utf8')
  manager.ensure('desktop')
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(read().patch).toBe('- id: schedule\n  disabled: false\n')
})

it('keeps rows the rc.2 user left off disabled under the bundle', () => {
  const { manager, read } = rc2Profile('- id: schedule\n  disabled: false\n- id: time-context\n  disabled: true\n')
  manager.ensure('desktop')
  const after = read()
  expect(after.bundles).toContain(SCHEDULE_BUNDLE)
  expect(after.patch).toBe('- id: time-context\n  disabled: true\n- id: ui-schedule\n  disabled: true\n')
})

it('clears stale toggles without selecting the bundle when rc.2 ended with Scheduled Tasks off', () => {
  const { manager, read } = rc2Profile([
    '- id: schedule',
    '  disabled: false',
    '- id: schedule',
    '  disabled: true',
    '- id: schedule',
    '  name: some-other-schedule',
    '  disabled: false',
    '- id: ui-schedule',
    '  config:',
    '    pageSize: 5',
    '',
  ].join('\n'))
  manager.ensure('desktop')
  const after = read()
  expect(after.bundles).not.toContain(SCHEDULE_BUNDLE)
  // Rows for another package and user configuration are not toggles; keep them.
  expect(after.patch).toBe('- id: schedule\n  name: some-other-schedule\n  disabled: false\n- id: ui-schedule\n  config:\n    pageSize: 5\n')
})

it('leaves a malformed patch for recovery and retries the Scheduled Tasks migration later', () => {
  const { manager, dir, file, read } = rc2Profile('- id: schedule\n  disabled: [\n')
  manager.ensure('desktop')
  expect(JSON.parse(readFileSync(file, 'utf8')).dsh.desktopNextScheduleBundle).toBeUndefined()
  expect(read().patch).toBe('- id: schedule\n  disabled: [\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: schedule\n  disabled: false\n')
  manager.ensure('desktop')
  expect(read().bundles).toContain(SCHEDULE_BUNDLE)
})

/** Lay out what a dsh 0.1.5 launcher left in the shared Profile: profile link -> owned link -> its installation. */
function projectLegacyPackages(home: string, dir: string) {
  const directoryLink = process.platform === 'win32' ? 'junction' : 'dir'
  const files: string[] = []
  const links: string[] = []
  for (const packageName of ['@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-persona']) {
    const target = join(home, 'old-desktop', 'node_modules', packageName)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'index.js'), 'old installation')
    files.push(join(target, 'index.js'))
    const owned = join(dir, '.dsh-module-fallback', 'node_modules', packageName)
    mkdirSync(dirname(owned), { recursive: true })
    symlinkSync(target, owned, directoryLink)
    const link = join(dir, 'node_modules', packageName)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(owned, link, directoryLink)
    links.push(link)
  }
  return { files, links }
}

it('retires dsh 0.1.5 link projections before composing the Profile', () => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  const { files, links } = projectLegacyPackages(manager.home, dir)
  loadNextProfile(dir, manager.home)
  for (const link of links) expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
  expect(existsSync(join(dir, '.dsh-module-fallback'))).toBe(false)
  for (const file of files) expect(readFileSync(file, 'utf8')).toBe('old installation')
})

it('still loads the Profile when the projection sweep fails', () => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  const sweep = vi.spyOn(linkProjections, 'removeLinkProjectionsSafely').mockImplementation(() => {
    throw Object.assign(new Error('EBUSY: junction is locked'), { code: 'EBUSY' })
  })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    expect(loadNextProfile(dir, manager.home).layers.map(layer => layer.packageName)).toContain('dsh-desktop-next')
    expect(sweep).toHaveBeenCalledWith(dir)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('could not remove dsh 0.1.5 link projections'))
  } finally { sweep.mockRestore(); stderr.mockRestore() }
})
