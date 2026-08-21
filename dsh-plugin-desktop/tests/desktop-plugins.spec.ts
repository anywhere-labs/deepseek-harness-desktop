import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DesktopPluginsError,
  DesktopPluginsService,
  desktopPluginBundleMutable,
  readDesktopDisabledBundles,
  type DesktopPlugins,
  type DesktopPluginsBootstrap,
} from '../src/desktop-plugins.ts'
import {
  desktopInstallAnchor,
  ensureDesktopProfile,
  prepareDesktopProfile,
} from '../src/profile.ts'

interface Harness {
  readonly ctx: Context
  readonly service: DesktopPlugins
  dispose(): Promise<void>
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(root, 0o700) } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-plugins-'))
  roots.push(root)
  return root
}

function profileManifest(home: string): {
  path: string
  value: Record<string, unknown> & { dsh: { profile: { bundles: string[] } } }
} {
  const path = join(ensureDesktopProfile(home), 'package.json')
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    & { dsh: { profile: { bundles: string[] } } }
  return { path, value }
}

function writeProfileManifest(
  path: string,
  value: Record<string, unknown> & { dsh: { profile: { bundles: string[] } } },
): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

function installBundle(home: string, packageName: string, rowId = 'external-marker'): string {
  const profileDir = ensureDesktopProfile(home)
  const packageDir = join(profileDir, 'node_modules', ...packageName.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: packageName,
    version: '1.2.3',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })}\n`)
  writeFileSync(join(packageDir, 'cordis.patch.yml'), [
    '- insert:',
    `    - id: ${rowId}`,
    `      name: ${packageName}/host`,
    '',
  ].join('\n'))
  return packageDir
}

function addBundle(home: string, packageName: string, copies = 1): void {
  const manifest = profileManifest(home)
  manifest.value.dsh.profile.bundles.push(...Array.from({ length: copies }, () => packageName))
  writeProfileManifest(manifest.path, manifest.value)
}

function bootstrap(root: string, now?: () => number): DesktopPluginsBootstrap {
  return {
    profileName: 'desktop',
    homeDir: join(root, 'dsh-home'),
    statePath: join(root, 'desktop-private', 'plugin-management', 'state.json'),
    installAnchor: desktopInstallAnchor(),
    ...(now === undefined ? {} : { now }),
  }
}

function bootstrapWithRecovery(root: string): DesktopPluginsBootstrap {
  return {
    ...bootstrap(root),
    recoveryStatePath: join(root, 'desktop-private', 'startup-recovery', 'state.json'),
  }
}

async function createHarness(options: DesktopPluginsBootstrap): Promise<Harness> {
  const ctx = new Context()
  const fiber = ctx.plugin(DesktopPluginsService, options)
  await fiber
  const service = ctx.get('desktopPlugins')
  if (service === undefined) throw new Error('desktopPlugins did not mount')
  return { ctx, service, dispose: fiber.dispose }
}

function errorCode(cause: unknown): string | undefined {
  return cause instanceof DesktopPluginsError ? cause.code : undefined
}

describe('desktop direct bundle management', () => {
  it('lists each direct bundle once and keeps only explicit product bundles immutable', async () => {
    const root = temporaryRoot()
    const options = bootstrap(root)
    installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin', 2)
    const harness = await createHarness(options)

    const first = harness.service.list()
    const second = harness.service.list()
    const external = first.filter(item => item.packageName === 'third-party-plugin')
    expect(external).toEqual([expect.objectContaining({
      bundleId: expect.stringMatching(/^bundle_[A-Za-z0-9_-]{32}$/u),
      status: 'active',
      mutable: true,
    })])
    expect(second.find(item => item.packageName === 'third-party-plugin')?.bundleId)
      .toBe(external[0]?.bundleId)
    expect(first.find(item => item.packageName === '@deepseek-ai/dsh-base')).toEqual(
      expect.objectContaining({ status: 'active', mutable: false }),
    )
    expect(first.find(item => item.packageName === '@deepseek-ai/dsh-web-app')).toEqual(
      expect.objectContaining({ status: 'active', mutable: false }),
    )
    expect(desktopPluginBundleMutable('dsh-plugin-desktop')).toBe(false)
    expect(desktopPluginBundleMutable('dsh-community-market')).toBe(false)
    expect(desktopPluginBundleMutable('../third-party-plugin')).toBe(false)
    expect(desktopPluginBundleMutable('Third-Party-Plugin')).toBe(false)
    await harness.dispose()
  })

  it('uses a one-shot preview, writes profile-scoped state atomically, and never edits the manifest', async () => {
    const root = temporaryRoot()
    const options = bootstrap(root)
    installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin')
    const manifest = profileManifest(options.homeDir)
    const before = readFileSync(manifest.path, 'utf8')
    const harness = await createHarness(options)
    const target = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    if (target === undefined) throw new Error('missing target')

    expect(() => harness.service.previewDisable('third-party-plugin')).toThrowError(
      expect.objectContaining({ code: 'invalid-target' }),
    )
    const preview = harness.service.previewDisable(target.bundleId)
    expect(preview).toEqual(expect.objectContaining({
      profileName: 'desktop',
      packageName: 'third-party-plugin',
      previewId: expect.stringMatching(/^disable_[A-Za-z0-9_-]{43}$/u),
    }))
    await expect(harness.service.executeDisable(preview.previewId)).resolves.toEqual({
      packageName: 'third-party-plugin',
    })
    await expect(harness.service.executeDisable(preview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'preview-expired',
    )

    expect(harness.service.isDisabled('third-party-plugin')).toBe(true)
    expect(harness.service.list().find(item => item.packageName === 'third-party-plugin')?.status)
      .toBe('disabled')
    expect(readFileSync(manifest.path, 'utf8')).toBe(before)
    if (process.platform !== 'win32') {
      expect(lstatSync(options.statePath).mode & 0o777).toBe(0o600)
    }
    expect(JSON.parse(readFileSync(options.statePath, 'utf8'))).toEqual({
      version: 1,
      profiles: [{ profileName: 'desktop', disabledBundles: ['third-party-plugin'] }],
    })
    await harness.dispose()
  })

  it('re-enables only a disabled direct bundle with a one-shot preview and never edits the manifest', async () => {
    const root = temporaryRoot()
    const options = bootstrap(root)
    installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin')
    const manifest = profileManifest(options.homeDir)
    const before = readFileSync(manifest.path, 'utf8')
    const harness = await createHarness(options)
    const active = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    if (active === undefined) throw new Error('missing target')
    await harness.service.executeDisable(harness.service.previewDisable(active.bundleId).previewId)
    const disabled = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    if (disabled === undefined) throw new Error('missing disabled target')

    expect(disabled).toEqual(expect.objectContaining({
      bundleId: active.bundleId,
      status: 'disabled',
      mutable: true,
    }))
    expect(() => harness.service.previewEnable('third-party-plugin')).toThrowError(
      expect.objectContaining({ code: 'invalid-target' }),
    )
    const preview = harness.service.previewEnable(disabled.bundleId)
    expect(preview).toEqual(expect.objectContaining({
      profileName: 'desktop',
      packageName: 'third-party-plugin',
      previewId: expect.stringMatching(/^enable_[A-Za-z0-9_-]{43}$/u),
    }))
    await expect(harness.service.executeEnable(preview.previewId)).resolves.toEqual({
      packageName: 'third-party-plugin',
    })
    await expect(harness.service.executeEnable(preview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'preview-expired',
    )

    expect(harness.service.isDisabled('third-party-plugin')).toBe(false)
    expect(harness.service.list().find(item => item.packageName === 'third-party-plugin')).toEqual(
      expect.objectContaining({ bundleId: active.bundleId, status: 'active', mutable: true }),
    )
    expect(readFileSync(manifest.path, 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(options.statePath, 'utf8'))).toEqual({
      version: 1,
      profiles: [],
    })
    await harness.dispose()
  })

  it('shows recovery-only disables and enables them in the recovery scope', async () => {
    const root = temporaryRoot()
    const options = bootstrapWithRecovery(root)
    installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin')
    mkdirSync(dirname(options.recoveryStatePath!), { recursive: true })
    writeFileSync(options.recoveryStatePath!, JSON.stringify({
      version: 1,
      profiles: [{ profileName: 'desktop', disabledBundles: ['third-party-plugin'] }],
    }) + '\n')
    const harness = await createHarness(options)
    const disabled = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    if (disabled === undefined) throw new Error('missing recovery-disabled target')
    expect(disabled.status).toBe('disabled')

    await harness.service.executeEnable(harness.service.previewEnable(disabled.bundleId).previewId)
    expect(JSON.parse(readFileSync(options.recoveryStatePath!, 'utf8'))).toEqual({
      version: 1,
      profiles: [],
    })
    expect(harness.service.list().find(item => item.packageName === 'third-party-plugin')?.status)
      .toBe('active')
    await harness.dispose()
  })

  it('rejects active, immutable, unknown, expired, and disposed enable targets', async () => {
    const root = temporaryRoot()
    let now = 1_800_000_000_000
    const options = bootstrap(root, () => now)
    installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin')
    const harness = await createHarness(options)
    const active = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    const core = harness.service.list().find(item => item.packageName === '@deepseek-ai/dsh-base')
    if (active === undefined || core === undefined) throw new Error('missing targets')

    expect(() => harness.service.previewEnable(active.bundleId)).toThrowError(
      expect.objectContaining({ code: 'already-active' }),
    )
    expect(() => harness.service.previewEnable(core.bundleId)).toThrowError(
      expect.objectContaining({ code: 'immutable-target' }),
    )
    expect(() => harness.service.previewEnable(`bundle_${'a'.repeat(32)}`)).toThrowError(
      expect.objectContaining({ code: 'invalid-target' }),
    )

    await harness.service.executeDisable(harness.service.previewDisable(active.bundleId).previewId)
    const preview = harness.service.previewEnable(active.bundleId)
    now += 5 * 60 * 1000
    await expect(harness.service.executeEnable(preview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'preview-expired',
    )
    now -= 1
    const disposedPreview = harness.service.previewEnable(active.bundleId)
    await harness.dispose()
    await expect(harness.service.executeEnable(disposedPreview.previewId)).rejects.toThrow('service disposed')
    expect(() => harness.service.previewEnable(active.bundleId)).toThrow('service disposed')
  })

  it('revalidates the manifest and disabled state under the lock before enabling', async () => {
    const root = temporaryRoot()
    const options = bootstrap(root)
    installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin')
    const harness = await createHarness(options)
    const target = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    if (target === undefined) throw new Error('missing target')
    await harness.service.executeDisable(harness.service.previewDisable(target.bundleId).previewId)

    const missingManifestPreview = harness.service.previewEnable(target.bundleId)
    const manifest = profileManifest(options.homeDir)
    manifest.value.dsh.profile.bundles = manifest.value.dsh.profile.bundles
      .filter(name => name !== 'third-party-plugin')
    writeProfileManifest(manifest.path, manifest.value)
    await expect(harness.service.executeEnable(missingManifestPreview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'invalid-target',
    )
    expect(readDesktopDisabledBundles(options.statePath, 'desktop').has('third-party-plugin')).toBe(true)

    manifest.value.dsh.profile.bundles.push('third-party-plugin')
    writeProfileManifest(manifest.path, manifest.value)
    const changedStatePreview = harness.service.previewEnable(target.bundleId)
    writeFileSync(options.statePath, `${JSON.stringify({ version: 1, profiles: [] }, undefined, 2)}\n`)
    await expect(harness.service.executeEnable(changedStatePreview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'already-active',
    )
    await expect(harness.service.executeEnable(changedStatePreview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'preview-expired',
    )
    await harness.dispose()
  })

  it('preserves other disabled and stale bundle names when enabling one target', async () => {
    const root = temporaryRoot()
    const options = bootstrap(root)
    installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin')
    mkdirSync(dirname(options.statePath), { recursive: true })
    writeFileSync(options.statePath, JSON.stringify({
      version: 1,
      profiles: [{
        profileName: 'desktop',
        disabledBundles: ['third-party-plugin', 'z-stale-plugin', 'a-stale-plugin'],
      }],
    }))
    const harness = await createHarness(options)
    const target = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    if (target === undefined) throw new Error('missing target')

    await harness.service.executeEnable(harness.service.previewEnable(target.bundleId).previewId)
    expect(JSON.parse(readFileSync(options.statePath, 'utf8'))).toEqual({
      version: 1,
      profiles: [{
        profileName: 'desktop',
        disabledBundles: ['a-stale-plugin', 'z-stale-plugin'],
      }],
    })
    await harness.dispose()
  })

  it('filters every duplicate layer at composition time while preserving stale disabled names', async () => {
    const root = temporaryRoot()
    const options = bootstrap(root)
    installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin', 2)
    const harness = await createHarness(options)
    const target = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    if (target === undefined) throw new Error('missing target')
    const preview = harness.service.previewDisable(target.bundleId)
    await harness.service.executeDisable(preview.previewId)

    const prepared = prepareDesktopProfile(undefined, options.homeDir, 'darwin', 'desktop', options.statePath)
    const inserted = prepared.patches.flatMap(patch => Array.isArray(patch.insert) ? patch.insert : [])
    expect(inserted.filter(row => row.id === 'external-marker')).toHaveLength(0)

    const manifest = profileManifest(options.homeDir)
    manifest.value.dsh.profile.bundles = manifest.value.dsh.profile.bundles
      .filter(name => name !== 'third-party-plugin')
    writeProfileManifest(manifest.path, manifest.value)
    expect(harness.service.list().some(item => item.packageName === 'third-party-plugin')).toBe(false)
    expect(harness.service.isDisabled('third-party-plugin')).toBe(true)
    expect(harness.service.disabledPackageNames()).toEqual(['third-party-plugin'])
    expect(readDesktopDisabledBundles(options.statePath, 'desktop').has('third-party-plugin')).toBe(true)
    await harness.dispose()
  })

  it('preserves stale names while canonicalizing duplicate and unordered state on the next write', async () => {
    const root = temporaryRoot()
    const options = bootstrap(root)
    installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin')
    mkdirSync(dirname(options.statePath), { recursive: true })
    writeFileSync(options.statePath, JSON.stringify({
      version: 1,
      profiles: [{
        profileName: 'desktop',
        disabledBundles: ['z-stale-plugin', 'a-stale-plugin', 'z-stale-plugin'],
      }],
    }))
    const harness = await createHarness(options)
    const target = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    if (target === undefined) throw new Error('missing target')
    await harness.service.executeDisable(harness.service.previewDisable(target.bundleId).previewId)

    expect(JSON.parse(readFileSync(options.statePath, 'utf8'))).toEqual({
      version: 1,
      profiles: [{
        profileName: 'desktop',
        disabledBundles: ['a-stale-plugin', 'third-party-plugin', 'z-stale-plugin'],
      }],
    })
    await harness.dispose()
  })

  it('rejects immutable targets and revalidates a direct bundle at execution', async () => {
    const root = temporaryRoot()
    const options = bootstrap(root)
    installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin')
    const harness = await createHarness(options)
    const core = harness.service.list().find(item => item.packageName === '@deepseek-ai/dsh-base')
    const external = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    if (core === undefined || external === undefined) throw new Error('missing targets')
    expect(() => harness.service.previewDisable(core.bundleId)).toThrowError(
      expect.objectContaining({ code: 'immutable-target' }),
    )
    const preview = harness.service.previewDisable(external.bundleId)
    const manifest = profileManifest(options.homeDir)
    manifest.value.dsh.profile.bundles = manifest.value.dsh.profile.bundles
      .filter(name => name !== 'third-party-plugin')
    writeProfileManifest(manifest.path, manifest.value)
    await expect(harness.service.executeDisable(preview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'invalid-target',
    )
    expect(readDesktopDisabledBundles(options.statePath, 'desktop').size).toBe(0)
    await harness.dispose()
  })

  it('expires previews and clears all authority when the Cordis generation disposes', async () => {
    const root = temporaryRoot()
    let now = 1_800_000_000_000
    const options = bootstrap(root, () => now)
    installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin')
    const harness = await createHarness(options)
    const target = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    if (target === undefined) throw new Error('missing target')
    const preview = harness.service.previewDisable(target.bundleId)
    now += 5 * 60 * 1000
    await expect(harness.service.executeDisable(preview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'preview-expired',
    )
    await harness.dispose()
    expect(() => harness.service.list()).toThrow('service disposed')
    expect(() => harness.service.previewDisable(target.bundleId)).toThrow('service disposed')
  })

  it('treats only a missing state as empty and fails loud for invalid state files', () => {
    const root = temporaryRoot()
    const options = bootstrap(root)
    expect(readDesktopDisabledBundles(options.statePath, 'desktop').size).toBe(0)
    mkdirSync(dirname(options.statePath), { recursive: true })

    writeFileSync(options.statePath, '{broken')
    expect(() => readDesktopDisabledBundles(options.statePath, 'desktop')).toThrow('invalid plugin-management state')

    writeFileSync(options.statePath, JSON.stringify({ version: 2, profiles: [] }))
    expect(() => readDesktopDisabledBundles(options.statePath, 'desktop')).toThrow('version or profiles')

    writeFileSync(options.statePath, JSON.stringify({
      version: 1,
      profiles: [
        { profileName: 'desktop', disabledBundles: [] },
        { profileName: 'desktop', disabledBundles: [] },
      ],
    }))
    expect(() => readDesktopDisabledBundles(options.statePath, 'desktop')).toThrow('duplicate profile')

    writeFileSync(options.statePath, JSON.stringify({
      version: 1,
      profiles: Array.from({ length: 65 }, (_, index) => ({
        profileName: `profile-${String(index)}`,
        disabledBundles: [],
      })),
    }))
    expect(() => readDesktopDisabledBundles(options.statePath, 'desktop')).toThrow('too many profiles')

    writeFileSync(options.statePath, JSON.stringify({
      version: 1,
      profiles: [{
        profileName: 'desktop',
        disabledBundles: Array.from({ length: 513 }, (_, index) => `plugin-${String(index)}`),
      }],
    }))
    expect(() => readDesktopDisabledBundles(options.statePath, 'desktop')).toThrow('disabledBundles')

    writeFileSync(options.statePath, 'x'.repeat(64 * 1024 + 1))
    expect(() => readDesktopDisabledBundles(options.statePath, 'desktop')).toThrow('too large')

    rmSync(options.statePath)
    const target = join(root, 'real-state.json')
    writeFileSync(target, JSON.stringify({ version: 1, profiles: [] }))
    symlinkSync(target, options.statePath)
    expect(() => readDesktopDisabledBundles(options.statePath, 'desktop')).toThrow('regular file')

    rmSync(options.statePath)
    const parentFile = join(root, 'not-a-directory')
    writeFileSync(parentFile, 'file')
    expect(() => readDesktopDisabledBundles(join(parentFile, 'state.json'), 'desktop')).toThrow()
  })

  it('rejects a symlinked private state directory before persistence', async () => {
    const root = temporaryRoot()
    const options = bootstrap(root)
    installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin')
    const harness = await createHarness(options)
    const target = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    if (target === undefined) throw new Error('missing target')
    const preview = harness.service.previewDisable(target.bundleId)
    mkdirSync(dirname(dirname(options.statePath)), { recursive: true })
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, dirname(options.statePath), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(harness.service.executeDisable(preview.previewId)).rejects.toSatisfy(
      (cause: unknown) => errorCode(cause) === 'persistence-failed',
    )
    expect(existsSync(join(outside, 'state.json'))).toBe(false)
    await harness.dispose()
  })

  it('filters a disabled bundle before reading its malformed patch during profile loading', async () => {
    const root = temporaryRoot()
    const options = bootstrap(root)
    const packageDir = installBundle(options.homeDir, 'third-party-plugin')
    addBundle(options.homeDir, 'third-party-plugin')
    const harness = await createHarness(options)
    const target = harness.service.list().find(item => item.packageName === 'third-party-plugin')
    if (target === undefined) throw new Error('missing target')
    await harness.service.executeDisable(harness.service.previewDisable(target.bundleId).previewId)
    writeFileSync(join(packageDir, 'cordis.patch.yml'), 'not: a-list\n')

    expect(() => prepareDesktopProfile(
      undefined,
      options.homeDir,
      'darwin',
      'desktop',
      options.statePath,
    )).not.toThrow()
    await harness.dispose()
  })
})
