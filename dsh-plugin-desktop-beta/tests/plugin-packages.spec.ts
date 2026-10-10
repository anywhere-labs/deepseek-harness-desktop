import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it } from 'vitest'
import { installProfilePackageResolver } from '../src/module-resolution.ts'
import { DesktopPluginPackages } from '../src/plugin-packages.ts'

const ICON = '<svg xmlns="http://www.w3.org/2000/svg"/>\n'
const roots: string[] = []
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeManifest(directory: string, manifest: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest)}\n`)
}

/** A Profile with one local plugin and stale copies above it, as left by older Desktop installs. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-packages-'))
  roots.push(root)
  const profileDirectory = join(root, 'profiles', 'smoke')
  const pluginDirectory = join(profileDirectory, 'node_modules', 'dsh-plugin-packages-fixture')
  const staleDirectory = join(root, 'profiles', 'node_modules')
  writeManifest(profileDirectory, { name: 'dsh-plugin-packages-profile', private: true, type: 'module' })
  writeManifest(pluginDirectory, {
    name: 'dsh-plugin-packages-fixture',
    version: '1.0.0',
    description: 'Manifest description',
    icon: './icon.svg',
    type: 'module',
    exports: { '.': './index.js', './locale/*.json': './locale/*.json', './package.json': './package.json' },
  })
  writeFileSync(join(pluginDirectory, 'index.js'), 'export function apply() {}\n')
  writeFileSync(join(pluginDirectory, 'icon.svg'), ICON)
  mkdirSync(join(pluginDirectory, 'locale'))
  writeFileSync(join(pluginDirectory, 'locale', 'en.json'), JSON.stringify({ meta: { title: 'Fixture', description: 'Fixture plugin' } }))
  writeFileSync(join(pluginDirectory, 'locale', 'zh.json'), JSON.stringify({ meta: { title: '示例插件', description: '示例插件说明' } }))
  const nestedDirectory = join(pluginDirectory, 'node_modules', 'dsh-plugin-packages-nested')
  writeManifest(nestedDirectory, { name: 'dsh-plugin-packages-nested', version: '1.0.0' })
  writeManifest(join(staleDirectory, '@deepseek-ai', 'schemastery'), { name: '@deepseek-ai/schemastery', version: '999.0.0' })
  writeManifest(join(staleDirectory, 'dsh-plugin-packages-stale-only'), { name: 'dsh-plugin-packages-stale-only', version: '1.0.0' })

  const profileBaseUrl = pathToFileURL(join(profileDirectory, 'package.json')).href
  cleanups.push(installProfilePackageResolver(profileBaseUrl))
  const ctx = new Context()
  const fiber = ctx.plugin(DesktopPluginPackages)
  await fiber.await()
  cleanups.push(() => ctx.fiber.dispose())
  const packages = ctx.get('pluginPackages')
  // Stable's pinned service type predates refresh(); narrow to the Desktop class that provides it.
  if (!(packages instanceof DesktopPluginPackages)) throw new Error('Desktop pluginPackages was not provided')
  return {
    ctx, fiber, packages, profileDirectory, pluginDirectory, nestedDirectory,
    // The Loader's root tree uses the Profile directory URL as its base.
    boundary: pathToFileURL(profileDirectory).href + '/',
  }
}

it('provides official display metadata through the Desktop Profile resolver', async () => {
  const { packages, boundary } = await fixture()
  expect(packages).toBeInstanceOf(PluginPackages)
  expect(packages.metaOf('dsh-plugin-packages-fixture', boundary)).toEqual({
    title: { en: 'Fixture', zh: '示例插件' },
    description: { en: 'Fixture plugin', zh: '示例插件说明' },
    icon: `data:image/svg+xml;base64,${Buffer.from(ICON).toString('base64')}`,
  })
})

it('answers Profile-boundary lookups with the resolver selection instead of stale copies above the Profile', async () => {
  const { packages, boundary, pluginDirectory } = await fixture()
  const local = packages.packageOf('dsh-plugin-packages-fixture/locale/en.json', boundary)
  expect(local).toMatchObject({ name: 'dsh-plugin-packages-fixture', version: '1.0.0', dir: pluginDirectory })
  expect(local?.manifest.description).toBe('Manifest description')

  const installed = createRequire(new URL('../package.json', import.meta.url)).resolve('@deepseek-ai/schemastery/package.json')
  expect(packages.packageOf('@deepseek-ai/schemastery', boundary)?.manifestPath).toBe(installed)
  // The official Node lookup alone would return this stale ancestor copy.
  expect(packages.packageOf('dsh-plugin-packages-stale-only', boundary)).toBeUndefined()
  expect(packages.packageOf('./relative.js', boundary)).toBeUndefined()
})

it('keeps the official Node lookup for parents inside a selected package', async () => {
  const { packages, pluginDirectory, nestedDirectory } = await fixture()
  const parent = pathToFileURL(join(pluginDirectory, 'index.js')).href
  expect(packages.packageOf('dsh-plugin-packages-nested', parent)?.dir).toBe(nestedDirectory)
})

it('re-selects packages after the official plugin manager refreshes them', async () => {
  const { packages, boundary, profileDirectory } = await fixture()
  const installed = packages.packageOf('@deepseek-ai/schemastery', boundary)
  const upgraded = join(profileDirectory, 'node_modules', '@deepseek-ai', 'schemastery')
  writeManifest(upgraded, { name: '@deepseek-ai/schemastery', version: '999.0.0' })
  // A generation keeps its selection until a package operation publishes a new one.
  expect(packages.packageOf('@deepseek-ai/schemastery', boundary)?.dir).toBe(installed?.dir)
  await packages.refresh()
  expect(packages.packageOf('@deepseek-ai/schemastery', boundary)).toMatchObject({ version: '999.0.0', dir: upgraded })
})

it('removes the service when its fiber is disposed', async () => {
  const { ctx, fiber } = await fixture()
  await fiber.dispose()
  expect(ctx.get('pluginPackages')).toBeUndefined()
})
