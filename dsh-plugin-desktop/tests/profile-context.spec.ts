import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { composeEntries, initProfile, PROFILE_TEMPLATES, prepareProfileEntries, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopProfileBoot } from '../src/profile-context.ts'
import { prepareDesktopProfile } from '../src/profile.ts'

const homes: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function fixture(profileName = 'desktop') {
  const home = mkdtempSync(join(tmpdir(), 'desktop-profile-context-'))
  homes.push(home)
  if (profileName !== 'desktop') initProfile(join(home, 'profiles', profileName), PROFILE_TEMPLATES.web!.bundles)
  const prepared = prepareDesktopProfile('1', home, 'win32', profileName)
  const pnpm = {
    activeProfileName: profileName, activeProfileDir: prepared.profile.dir, homeDir: home,
    appExecutable: process.execPath, pnpmBinPath: join(home, 'pnpm.mjs'),
    electronVersion: '44.0.0', nodeBinDir: join(home, 'node-bin'),
    nodeShimPath: join(home, 'node-bin', 'node'), clearEnvironmentPath: join(home, 'clear.mjs'),
    dshBootstrapPath: join(home, 'dsh.mjs'),
  }
  const ctx = new Context()
  contexts.push(ctx)
  // The isolated Host receives a structured-cloned preparation over IPC.
  const boot = createDesktopProfileBoot(structuredClone(prepared), pnpm)
  boot.prepare(ctx)
  return { prepared, pnpm, ctx, boot, home }
}

it('rereads user patches while preserving the Desktop composition and root file', () => {
  const { prepared, ctx, home } = fixture('web')
  const rootMtime = statSync(prepared.rootConfig).mtimeMs
  const read = () => composeEntries([readProfilePatches('test', ctx.profileContext)])
  expect(read()).toEqual(composeEntries([prepared.patches]))
  writeFileSync(prepared.profile.patchPath, '- id: plugin-manager\n  disabled: true\n')
  writeFileSync(join(home, 'cordis.patch.yml'), '- id: timer\n  disabled: true\n')
  const rows = read()
  expect(rows.find(row => row.id === 'plugin-manager')?.disabled).toBe(true)
  expect(rows.find(row => row.id === 'timer')?.disabled).toBe(true)
  expect(rows.find(row => row.id === 'desktop-shell')?.name).toBe('dsh-plugin-desktop')
  expect(rows.filter(row => row.id === 'desktop-directory-picker-browse-host')).toHaveLength(1)
  expect(statSync(prepared.rootConfig).mtimeMs).toBe(rootMtime)
  expect(ctx.profileContext.name).toBe('web')
  expect(ctx.profileContext.home).toBe(home)
  expect(ctx.profileContext.packageManager?.command).toBe(process.execPath)
  expect(ctx.profileContext.packageManager?.args).toContain('--config.minimumReleaseAge=0')
  expect(ctx.profileContext.packageManager?.env.DSH_HOME).toBe(home)
  expect(ctx.profileContext.packageManager?.env.ELECTRON_RUN_AS_NODE).toBe('1')
  expect(readFileSync(prepared.profile.patchPath, 'utf8')).toContain('disabled: true')
})

it('keeps the running generation\'s layout rows when a saved mode hot-reloads the Profile', () => {
  const { prepared, ctx } = fixture()
  expect(prepared.mode).toBe('compatibility')
  // Setup and the mode picker save the mode into the patch layer mid-generation.
  writeFileSync(prepared.profile.patchPath, '- id: desktop-shell\n  config:\n    mode: extended\n')
  const rows = composeEntries([readProfilePatches('test', ctx.profileContext)])
  expect(rows.find(row => row.id === 'desktop-shell')?.config).toEqual(expect.objectContaining({ mode: 'extended' }))
  // The open compatibility page never installs Desktop's layout; keep the official one.
  expect(rows.find(row => row.id === 'ui-layout')?.disabled ?? false).toBe(false)
})

it('signals readiness once and cancels listeners on disposal or unsubscription', async () => {
  const { ctx, boot } = fixture()
  const callback = vi.fn()
  const cancelled = vi.fn()
  ctx.appReady!.onReady(callback)
  ctx.appReady!.onReady(cancelled)()
  expect(callback).not.toHaveBeenCalled()
  boot.markReady()
  boot.markReady()
  expect(callback).toHaveBeenCalledTimes(1)
  expect(cancelled).not.toHaveBeenCalled()
  const late = vi.fn()
  ctx.appReady!.onReady(late)
  expect(late).toHaveBeenCalledTimes(1)
  const failed = fixture()
  failed.ctx.appReady!.onReady(cancelled)
  await failed.ctx.fiber.dispose()
  failed.boot.markReady()
  expect(cancelled).not.toHaveBeenCalled()
})

it('rejects mismatched package-manager and Profile identities', () => {
  const { prepared, pnpm } = fixture()
  expect(() => createDesktopProfileBoot(prepared, { ...pnpm, activeProfileName: 'other' }))
    .toThrow('identity disagree')
})

// rc.2 preflight runs before pluginPackages exists and repeats after settings/HMR.
it('checks the selected artifact while still denying incompatible active Profile plugins', () => {
  const { ctx, home, prepared } = fixture()
  const packageName = '@deepseek-ai/dsh-session'
  const ancestor = join(home, 'profiles', 'node_modules', packageName)
  mkdirSync(ancestor, { recursive: true })
  writeFileSync(join(ancestor, 'package.json'), JSON.stringify({
    name: packageName, version: '99.0.0', peerDependencies: { '@deepseek-ai/dsh-llm': '0.1.5-rc.2' },
  }))
  const base = pathToFileURL(join(prepared.profile.dir, 'package.json')).href
  const entries = [{ id: 'session-probe', name: packageName }]
  expect(prepareProfileEntries(ctx, entries, base)[0]?.disabled).not.toBe(true)
  // Once package inventory starts, preflight must retain the launcher's selection.
  ctx.provide('pluginPackages', { packageOf: () => ({ manifestPath: join(ancestor, 'package.json') }) } as never)
  expect(prepareProfileEntries(ctx, entries, base)[0]?.disabled).not.toBe(true)
  const active = join(prepared.profile.dir, 'node_modules', 'incompatible-plugin')
  mkdirSync(active, { recursive: true })
  writeFileSync(join(active, 'package.json'), JSON.stringify({
    name: 'incompatible-plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-llm': '0.1.5-rc.2' },
  }))
  expect(prepareProfileEntries(ctx, [{ id: 'incompatible', name: 'incompatible-plugin' }], base)[0]?.disabled).toBe(true)
})
