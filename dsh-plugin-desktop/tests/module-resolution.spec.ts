import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harness = vi.hoisted(() => {
  const realpathNative = vi.fn((candidate: string) => candidate)
  const realpathSync = Object.assign(
    vi.fn((candidate: string) => realpathNative(candidate)),
    { native: realpathNative },
  )
  const cjsOriginal = vi.fn((
    request: string,
    _parent?: { filename?: string } | null,
    _isMain?: boolean,
    _options?: unknown,
  ) => `ordinary:${request}`)
  const registerHooks = vi.fn((definition: { resolve: typeof harness.resolve }) => {
    harness.resolve = definition.resolve
    return { deregister: harness.deregister }
  })
  return {
    resolve: undefined as undefined | ((
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context: { parentURL?: string }) => unknown,
    ) => unknown),
    deregister: vi.fn(),
    sources: new Map<string, 'install' | 'profile'>(),
    overlay: vi.fn((packageName: string, options: { profilePackageUrl: string }) => {
      const source = harness.sources.get(packageName) ?? 'profile'
      const selected = {
        source,
        manifestPath: source === 'profile'
          ? join(
              dirname(fileURLToPath(options.profilePackageUrl)),
              'node_modules',
              ...packageName.split('/'),
              'package.json',
            )
          : `/install/${packageName}/package.json`,
      }
      return {
        packageName,
        selected,
        [source]: selected,
      }
    }),
    registerHooks,
    cjsOriginal,
    cjsModule: { _resolveFilename: cjsOriginal },
    realpathNative,
    realpathSync,
  }
})

vi.mock('node:module', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:module')>(),
  default: harness.cjsModule,
  registerHooks: harness.registerHooks,
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  realpathSync: harness.realpathSync,
}))

vi.mock('../src/package-overlay.ts', () => ({
  PackageOverlayNotFoundError: class PackageOverlayNotFoundError extends Error {},
  findOverlayPackage: harness.overlay,
  packageNameFromSpecifier(specifier: string): string | undefined {
    if (specifier.length === 0 || specifier.startsWith('.') || specifier.startsWith('/')
      || specifier.startsWith('#') || URL.canParse(specifier)) return undefined
    const parts = specifier.split('/')
    return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
  },
  resolveOverlayPackage: harness.overlay,
}))

const {
  installProfilePackageResolver: retainProfilePackageResolver,
  refreshProfilePackageSelections,
  selectProfilePackage,
} = await import('../src/module-resolution.ts')
const releases: Array<() => void> = []

function installProfilePackageResolver(profileBaseUrl: string): () => void {
  const release = retainProfilePackageResolver(profileBaseUrl)
  releases.push(release)
  return release
}

function missing(specifier: string, parentURL?: string): Error {
  return Object.assign(
    new Error(`Cannot find package '${specifier}' imported from ${parentURL ?? 'unknown'}`),
    { code: 'ERR_MODULE_NOT_FOUND' },
  )
}

describe('installProfilePackageResolver', () => {
  beforeEach(() => {
    harness.resolve = undefined
    harness.deregister.mockClear()
    harness.overlay.mockClear()
    harness.sources.clear()
    harness.registerHooks.mockClear()
    harness.cjsOriginal.mockClear()
    harness.cjsModule._resolveFilename = harness.cjsOriginal
    harness.realpathNative.mockReset()
    harness.realpathNative.mockImplementation((candidate: string) => candidate)
    harness.realpathSync.mockClear()
  })

  afterEach(() => {
    for (const release of releases.splice(0).reverse()) release()
  })

  it.each(['node:fs', 'fs', 'node:path', 'path'])('passes builtin %s through without inspecting the parent filesystem', specifier => {
    installProfilePackageResolver('file:///profiles/desktop/package.json')
    harness.realpathNative.mockClear()
    const parent = join(tmpdir(), 'untracked-plugin', 'index.js')
    const context = { parentURL: pathToFileURL(parent).href }
    const result = { url: specifier }
    const nextResolve = vi.fn(() => result)
    expect(harness.resolve?.(specifier, context, nextResolve)).toBe(result)
    expect(nextResolve).toHaveBeenCalledExactlyOnceWith(specifier, context)
    expect(harness.cjsModule._resolveFilename(specifier, { filename: parent }, false)).toBe(`ordinary:${specifier}`)
    expect(harness.realpathNative).not.toHaveBeenCalled()
    expect(harness.overlay).not.toHaveBeenCalled()
  })

  it('uses the overlay-selected side for every Loader package and subpath', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    harness.sources.set('@deepseek-ai/dsh-web-app', 'install')
    harness.sources.set('dsh-plugin-desktop', 'profile')
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    const installed = harness.resolve?.(
      '@deepseek-ai/dsh-web-app',
      { parentURL: profileBaseUrl },
      nextResolve,
    ) as { context: { parentURL?: string } }
    expect(installed.context.parentURL).not.toBe(profileBaseUrl)
    expect(installed.context.parentURL).toMatch(/\/lib\/index\.js$/u)

    expect(harness.resolve?.(
      'dsh-plugin-desktop/profile',
      { parentURL: loaderEntryUrl },
      nextResolve,
    )).toEqual({
      specifier: 'dsh-plugin-desktop/profile',
      context: { parentURL: profileBaseUrl },
    })
    expect(harness.overlay).toHaveBeenCalledWith('@deepseek-ai/dsh-web-app', expect.any(Object))
    expect(harness.overlay).toHaveBeenCalledWith('dsh-plugin-desktop', expect.any(Object))
  })

  it('caches one overlay selection per Profile generation and package root', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    harness.sources.set('plugin', 'install')
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string) => ({
      url: `file:///C:/Program%20Files/DSH/resources/app.asar/node_modules/plugin/${specifier.endsWith('/feature') ? 'feature.js' : 'index.js'}`,
    }))
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    harness.resolve?.('plugin', { parentURL: loaderEntryUrl }, nextResolve)
    harness.resolve?.('plugin/feature', { parentURL: loaderEntryUrl }, nextResolve)

    expect(harness.overlay).toHaveBeenCalledTimes(1)
  })

  it('refreshes overlay selection when a new HMR generation retains the Profile', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    harness.sources.set('plugin', 'install')
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({
      url: `file:///resolved/${specifier}.js`,
      context,
    }))
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
    harness.resolve?.('plugin', { parentURL: loaderEntryUrl }, nextResolve)

    harness.sources.set('plugin', 'profile')
    installProfilePackageResolver(profileBaseUrl)
    const refreshed = harness.resolve?.('plugin/feature', { parentURL: loaderEntryUrl }, nextResolve) as {
      context: { parentURL?: string }
    }

    expect(harness.overlay).toHaveBeenCalledTimes(2)
    expect(refreshed.context.parentURL).toBe(profileBaseUrl)
  })

  it('reports the Loader selection for Profile-boundary package lookups and shares its cache', () => {
    const profileBaseUrl = 'file:///tmp/dsh/profiles/desktop/package.json'
    harness.sources.set('plugin', 'install')
    expect(selectProfilePackage('plugin', profileBaseUrl)).toBeUndefined()
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))

    expect(selectProfilePackage('plugin/feature', 'file:///tmp/dsh/profiles/desktop/')).toEqual({
      source: 'install', manifestPath: '/install/plugin/package.json',
    })
    harness.resolve?.('plugin', { parentURL: profileBaseUrl }, nextResolve)
    expect(harness.overlay).toHaveBeenCalledTimes(1)

    harness.overlay.mockReturnValueOnce(undefined as never)
    expect(selectProfilePackage('missing', profileBaseUrl)).toBeNull()
    for (const specifier of ['node:fs', './relative.js', '#internal']) {
      expect(selectProfilePackage(specifier, profileBaseUrl)).toBeUndefined()
    }
    // Requests from untracked modules keep Node's own lookup from their parent.
    expect(selectProfilePackage('plugin', pathToFileURL(join(tmpdir(), 'untracked', 'index.js')).href)).toBeUndefined()
    expect(harness.overlay).toHaveBeenCalledTimes(2)
  })

  it('re-selects packages for later imports after a package operation refresh', () => {
    const profileBaseUrl = 'file:///tmp/dsh/profiles/desktop/package.json'
    harness.sources.set('plugin', 'install')
    installProfilePackageResolver(profileBaseUrl)
    expect(selectProfilePackage('plugin', profileBaseUrl)).toMatchObject({ source: 'install' })

    harness.sources.set('plugin', 'profile')
    expect(selectProfilePackage('plugin', profileBaseUrl)).toMatchObject({ source: 'install' })
    refreshProfilePackageSelections()
    expect(selectProfilePackage('plugin', profileBaseUrl)).toMatchObject({ source: 'profile' })
    expect(harness.overlay).toHaveBeenCalledTimes(2)
  })

  it('also recognizes the Loader native dynamic-import fallback', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(harness.resolve?.(
      '@deepseek-ai/dsh-web-app',
      { parentURL: loaderEntryUrl },
      nextResolve,
    )).toEqual({
      specifier: '@deepseek-ai/dsh-web-app',
      context: { parentURL: profileBaseUrl },
    })
  })

  it('recognizes the clean-boot Profile directory URL as a Loader boundary', () => {
    const profileBaseUrl = 'file:///tmp/dsh/profiles/desktop/package.json'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))

    expect(harness.resolve?.(
      '@deepseek-ai/dsh-web-app',
      { parentURL: 'file:///tmp/dsh/profiles/desktop/' },
      nextResolve,
    )).toEqual({
      specifier: '@deepseek-ai/dsh-web-app',
      context: { parentURL: profileBaseUrl },
    })
    expect(harness.overlay).toHaveBeenCalledWith('@deepseek-ai/dsh-web-app', expect.any(Object))
  })

  it('keeps non-package Loader specifiers on ordinary Node resolution', () => {
    installProfilePackageResolver('file:///C:/Users/test/profile/package.json')
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(harness.resolve?.('./relative.js', { parentURL: loaderEntryUrl }, nextResolve)).toEqual({
      specifier: './relative.js',
      context: { parentURL: loaderEntryUrl },
    })
    expect(harness.resolve?.('cordis:include', { parentURL: loaderEntryUrl }, nextResolve)).toEqual({
      specifier: 'cordis:include',
      context: { parentURL: loaderEntryUrl },
    })
    expect(harness.resolve?.('\\\\server\\share\\plugin.cjs', { parentURL: loaderEntryUrl }, nextResolve))
      .toEqual({
        specifier: '\\\\server\\share\\plugin.cjs',
        context: { parentURL: loaderEntryUrl },
      })
    expect(harness.overlay).not.toHaveBeenCalled()
  })

  it('keeps repeated Loader selection and the tracked ASAR graph off realpath', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    const pluginUrl = 'file:///C:/Program%20Files/DSH/resources/app.asar/node_modules/plugin/index.js'
    const featureUrl = 'file:///C:/Program%20Files/DSH/resources/app.asar/node_modules/plugin/feature.js'
    const dependencyUrl = 'file:///C:/Program%20Files/DSH/resources/app.asar/node_modules/dependency/index.js'
    harness.sources.set('plugin', 'install')
    installProfilePackageResolver(profileBaseUrl)
    harness.realpathNative.mockClear()
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
    const loadPlugin = vi.fn(() => ({ url: pluginUrl }))

    expect(harness.resolve?.('plugin', { parentURL: loaderEntryUrl }, loadPlugin)).toEqual({ url: pluginUrl })
    expect(harness.resolve?.('plugin/subpath', { parentURL: loaderEntryUrl }, loadPlugin)).toEqual({ url: pluginUrl })
    expect(harness.overlay).toHaveBeenCalledTimes(1)

    expect(harness.resolve?.('./feature.js', { parentURL: pluginUrl }, () => ({ url: featureUrl })))
      .toEqual({ url: featureUrl })
    expect(harness.resolve?.('dependency', { parentURL: featureUrl }, () => ({ url: dependencyUrl })))
      .toEqual({ url: dependencyUrl })
    expect(harness.resolve?.('node:path', { parentURL: dependencyUrl }, (specifier, context) => ({
      url: specifier,
      context,
    }))).toEqual({ url: 'node:path', context: { parentURL: dependencyUrl } })
    expect(harness.resolve?.(
      './native.js',
      { parentURL: 'file:///C:/Program%20Files/DSH/resources/app.asar.unpacked/lib/untracked.js' },
      (specifier, context) => ({ specifier, context }),
    )).toEqual({
      specifier: './native.js',
      context: {
        parentURL: 'file:///C:/Program%20Files/DSH/resources/app.asar.unpacked/lib/untracked.js',
      },
    })
    expect(harness.realpathNative).not.toHaveBeenCalled()
  })

  it('canonicalizes an aliased Profile boundary once and reuses the cached path', () => {
    const profileDirectory = join(tmpdir(), 'dsh-real-profile')
    const profileBaseUrl = pathToFileURL(join(profileDirectory, 'package.json')).href
    const aliasConfig = join(tmpdir(), 'dsh-profile-alias', 'cordis.yml')
    const canonicalConfig = join(profileDirectory, 'cordis.yml')
    harness.sources.set('plugin', 'install')
    installProfilePackageResolver(profileBaseUrl)
    harness.realpathNative.mockClear()
    harness.realpathNative.mockImplementation((candidate: string) => (
      candidate === aliasConfig ? canonicalConfig : candidate
    ))
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))

    expect(harness.resolve?.('plugin', { parentURL: pathToFileURL(aliasConfig).href }, nextResolve))
      .toEqual(expect.objectContaining({ specifier: 'plugin' }))
    expect(harness.resolve?.('plugin/subpath', { parentURL: pathToFileURL(aliasConfig).href }, nextResolve))
      .toEqual(expect.objectContaining({ specifier: 'plugin/subpath' }))
    expect(harness.realpathNative).toHaveBeenCalledTimes(1)
    expect(harness.realpathNative).toHaveBeenCalledWith(aliasConfig)
    expect(harness.overlay).toHaveBeenCalledTimes(1)
  })

  it('reuses canonical URL identities, preserves query/hash, and invalidates them on HMR', () => {
    const profileDirectory = join(tmpdir(), 'dsh-url-cache')
    const profileBaseUrl = pathToFileURL(join(profileDirectory, 'package.json')).href
    const alias = join(tmpdir(), 'dsh-url-cache-alias', 'cordis.yml')
    const aliasUrl = pathToFileURL(alias).href + '?rev=1#entry'
    let target = join(profileDirectory, 'cordis.yml')
    installProfilePackageResolver(profileBaseUrl)
    harness.realpathNative.mockImplementation(candidate => candidate === alias ? target : candidate)
    const state = (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for('dsh-plugin-desktop.profile-package-resolver.v1')
    ] as { registrations: Map<string, { canonicalPaths: Map<string, string>, canonicalModuleKeys: Map<string, string> }> }
    const registration = state.registrations.get(profileBaseUrl)!
    const getPath = vi.spyOn(registration.canonicalPaths, 'get')
    const nextResolve = vi.fn(() => ({ url: 'node:fs' }))
    for (let index = 0; index < 100; index += 1) {
      harness.resolve?.('plugin', { parentURL: aliasUrl }, nextResolve)
    }
    expect(getPath.mock.calls.filter(([path]) => path === alias)).toHaveLength(1)
    expect(registration.canonicalModuleKeys.get(aliasUrl)).toBe(pathToFileURL(target).href + '?rev=1#entry')
    target = join(profileDirectory, 'next.yml')
    installProfilePackageResolver(profileBaseUrl)
    expect(registration.canonicalModuleKeys.size).toBe(0)
    harness.resolve?.('plugin', { parentURL: aliasUrl }, nextResolve)
    expect(registration.canonicalModuleKeys.get(aliasUrl)).toBe(pathToFileURL(target).href + '?rev=1#entry')
  })

  it('does not cache a failed canonical lookup before an aliased Profile file appears', () => {
    const profileDirectory = join(tmpdir(), 'dsh-published-profile')
    const profileBaseUrl = pathToFileURL(join(profileDirectory, 'package.json')).href
    const aliasConfig = join(tmpdir(), 'dsh-pending-profile-alias', 'cordis.yml')
    const canonicalConfig = join(profileDirectory, 'cordis.yml')
    harness.sources.set('plugin', 'install')
    installProfilePackageResolver(profileBaseUrl)
    harness.realpathNative.mockClear()
    let published = false
    harness.realpathNative.mockImplementation((candidate: string) => {
      if (candidate !== aliasConfig) return candidate
      if (!published) throw Object.assign(new Error('not published'), { code: 'ENOENT' })
      return canonicalConfig
    })
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))
    const parentURL = pathToFileURL(aliasConfig).href

    expect(harness.resolve?.('plugin', { parentURL }, nextResolve))
      .toEqual({ specifier: 'plugin', context: { parentURL } })
    expect(harness.overlay).not.toHaveBeenCalled()

    published = true
    expect(harness.resolve?.('plugin', { parentURL }, nextResolve))
      .toEqual(expect.objectContaining({ specifier: 'plugin' }))
    expect(harness.realpathNative).toHaveBeenCalledTimes(2)
    expect(harness.overlay).toHaveBeenCalledTimes(1)
  })

  it('tracks both alias and canonical URLs for a linked module graph', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    const aliasPluginPath = join(tmpdir(), 'dsh-linked-alias', 'index.js')
    const canonicalPluginPath = join(tmpdir(), 'dsh-linked-real', 'index.js')
    const aliasPluginUrl = pathToFileURL(aliasPluginPath).href
    const canonicalPluginUrl = pathToFileURL(canonicalPluginPath).href
    const dependencyUrl = 'file:///C:/Users/test/profile/node_modules/profile-peer/index.js'
    harness.sources.set('linked-plugin', 'install')
    installProfilePackageResolver(profileBaseUrl)
    harness.realpathNative.mockClear()
    harness.realpathNative.mockImplementation((candidate: string) => (
      candidate === aliasPluginPath ? canonicalPluginPath : candidate
    ))
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(harness.resolve?.('linked-plugin', { parentURL: loaderEntryUrl }, () => ({ url: aliasPluginUrl })))
      .toEqual({ url: aliasPluginUrl })
    expect(harness.resolve?.('profile-peer', { parentURL: canonicalPluginUrl }, () => ({ url: dependencyUrl })))
      .toEqual({ url: dependencyUrl })
    expect(harness.realpathNative).toHaveBeenCalledTimes(2)
    expect(harness.realpathNative).toHaveBeenNthCalledWith(1, aliasPluginPath)
    expect(harness.realpathNative).toHaveBeenNthCalledWith(2, fileURLToPath(dependencyUrl))
  })

  it('keeps package-local dependencies and Profile fallback across linked relative modules', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    const linkedPluginUrl = 'file:///D:/workspace/plugins/dsh-linked/lib/index.js'
    const linkedFeatureUrl = 'file:///D:/workspace/plugins/dsh-linked/lib/feature.js'
    const localDependencyUrl = 'file:///D:/workspace/plugins/dsh-linked/node_modules/local-dependency/index.js'
    const profilePeerUrl = 'file:///C:/Users/test/profile/node_modules/profile-peer/index.js'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === 'dsh-linked' && context.parentURL === profileBaseUrl) return { url: linkedPluginUrl }
      if (specifier === './feature.js' && context.parentURL === linkedPluginUrl) return { url: linkedFeatureUrl }
      if (specifier === 'local-dependency' && context.parentURL === linkedFeatureUrl) return { url: localDependencyUrl }
      if (specifier === 'profile-peer' && context.parentURL === profileBaseUrl) return { url: profilePeerUrl }
      throw missing(specifier, context.parentURL)
    })
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(harness.resolve?.('dsh-linked', { parentURL: loaderEntryUrl }, nextResolve)).toEqual({ url: linkedPluginUrl })
    expect(harness.resolve?.('./feature.js', { parentURL: linkedPluginUrl }, nextResolve)).toEqual({ url: linkedFeatureUrl })
    expect(harness.resolve?.('local-dependency', { parentURL: linkedFeatureUrl }, nextResolve)).toEqual({ url: localDependencyUrl })
    expect(harness.resolve?.('profile-peer', { parentURL: localDependencyUrl }, nextResolve)).toEqual({ url: profilePeerUrl })
  })

  it('allows linked Profile modules to resolve dependencies from shared Profile node_modules', () => {
    const profileBaseUrl = 'file:///tmp/dsh/profiles/desktop/package.json'
    const linkedPluginUrl = 'file:///tmp/dsh/linked-plugins/plugin/index.js'
    const sharedDependencyUrl = 'file:///tmp/dsh/profiles/node_modules/profile-peer/index.js'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === 'plugin' && context.parentURL === profileBaseUrl) return { url: linkedPluginUrl }
      if (specifier === 'profile-peer' && context.parentURL === linkedPluginUrl) {
        // Node's default resolver may mutate the hook context before reporting
        // a miss. The resolver must retain the original linked-module owner.
        context.parentURL = profileBaseUrl
        throw missing(specifier, context.parentURL)
      }
      if (specifier === 'profile-peer' && context.parentURL === profileBaseUrl) return { url: sharedDependencyUrl }
      throw missing(specifier, context.parentURL)
    })
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(harness.resolve?.('plugin', { parentURL: loaderEntryUrl }, nextResolve))
      .toEqual({ url: linkedPluginUrl })
    expect(harness.resolve?.('profile-peer', { parentURL: linkedPluginUrl }, nextResolve))
      .toEqual({ url: sharedDependencyUrl })
  })

  it('allows a Desktop-selected package to use a missing dependency from the Profile overlay', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    const desktopPluginUrl = 'file:///Applications/DSH.app/Contents/Resources/app.asar/node_modules/plugin/index.js'
    const profilePeerUrl = 'file:///C:/Users/test/profile/node_modules/profile-peer/index.js'
    harness.sources.set('plugin', 'install')
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === 'plugin' && context.parentURL?.endsWith('/lib/index.js')) return { url: desktopPluginUrl }
      if (specifier === 'profile-peer' && context.parentURL === profileBaseUrl) return { url: profilePeerUrl }
      throw missing(specifier, context.parentURL)
    })
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(harness.resolve?.('plugin', { parentURL: loaderEntryUrl }, nextResolve)).toEqual({ url: desktopPluginUrl })
    expect(harness.resolve?.('profile-peer', { parentURL: desktopPluginUrl }, nextResolve)).toEqual({ url: profilePeerUrl })
  })

  it('falls back to the Desktop installation after CommonJS-style misses', () => {
    const profileBaseUrl = 'file:///tmp/dsh/profiles/desktop/package.json'
    const pluginUrl = 'file:///tmp/dsh/profiles/desktop/node_modules/plugin/index.cjs'
    const desktopDependencyUrl = 'file:///Applications/DSH.app/Contents/Resources/app.asar/node_modules/dependency/index.cjs'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === 'plugin' && context.parentURL === profileBaseUrl) return { url: pluginUrl }
      if (specifier === 'dependency' && context.parentURL?.endsWith('/lib/index.js')) {
        return { url: desktopDependencyUrl }
      }
      throw Object.assign(new Error(`missing ${specifier}`), { code: 'MODULE_NOT_FOUND' })
    })

    expect(harness.resolve?.('plugin', { parentURL: profileBaseUrl }, nextResolve)).toEqual({ url: pluginUrl })
    expect(harness.resolve?.('dependency', { parentURL: pluginUrl }, nextResolve))
      .toEqual({ url: desktopDependencyUrl })
  })

  it('bypasses an obsolete shared Profile proxy before using the Desktop package', () => {
    const profileBaseUrl = 'file:///tmp/dsh/profiles/desktop/package.json'
    const pluginUrl = 'file:///tmp/dsh/profiles/desktop/node_modules/plugin/index.cjs'
    const staleUrl = 'file:///tmp/dsh/profiles/node_modules/@deepseek-ai/schemastery/index.js'
    const desktopUrl = 'file:///Applications/DSH.app/Contents/Resources/app.asar/node_modules/@deepseek-ai/schemastery/lib/index.cjs'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === 'plugin' && context.parentURL === profileBaseUrl) return { url: pluginUrl }
      if (specifier === '@deepseek-ai/schemastery' && context.parentURL?.endsWith('/lib/index.js')) {
        return { url: desktopUrl }
      }
      return { url: staleUrl }
    })

    expect(harness.resolve?.('plugin', { parentURL: profileBaseUrl }, nextResolve)).toEqual({ url: pluginUrl })
    expect(harness.resolve?.('@deepseek-ai/schemastery', { parentURL: pluginUrl }, nextResolve))
      .toEqual({ url: desktopUrl })
    expect(nextResolve).toHaveBeenCalledTimes(4)
  })

  it('does not expose Profile dependencies to unrelated modules', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (context.parentURL === profileBaseUrl) return { url: 'file:///C:/Users/test/profile/node_modules/zod/index.js' }
      throw missing(specifier, context.parentURL)
    })

    expect(() => harness.resolve?.(
      'zod',
      { parentURL: 'file:///C:/Program%20Files/DSH%20Desktop/resources/app.asar/lib/main.js' },
      nextResolve,
    )).toThrow('Cannot find package')
    expect(nextResolve).toHaveBeenCalledTimes(1)
  })

  it('uses the same hook and overlay for CommonJS package manifests from Profile anchors', () => {
    const profileManifestPath = join(tmpdir(), 'dsh-profile', 'package.json')
    const profileConfigPath = join(tmpdir(), 'dsh-profile', 'cordis.yml')
    const profileBaseUrl = pathToFileURL(profileManifestPath).href
    harness.sources.set('@deepseek-ai/dsh-client-modules', 'install')
    installProfilePackageResolver(profileBaseUrl)
    const resolveFilename = harness.cjsModule._resolveFilename
    expect(resolveFilename(
      '@deepseek-ai/dsh-client-modules/package.json',
      { filename: profileManifestPath },
      false,
    )).toMatch(/node_modules[\\/]@deepseek-ai[\\/]dsh-client-modules[\\/]package\.json$/u)
    expect(resolveFilename(
      '@deepseek-ai/dsh-client-modules/package.json',
      { filename: profileConfigPath },
      false,
    )).toMatch(/node_modules[\\/]@deepseek-ai[\\/]dsh-client-modules[\\/]package\.json$/u)
    expect(resolveFilename(
      '@deepseek-ai/dsh-client-modules/package.json',
      { filename: join(tmpdir(), 'another-profile', 'package.json') },
      false,
    )).toBe('ordinary:@deepseek-ai/dsh-client-modules/package.json')
  })

  it('keeps the ESM hook in pass-through mode during explicit CommonJS resolution', () => {
    const profileManifestPath = join(tmpdir(), 'dsh-profile-bypass', 'package.json')
    const profileBaseUrl = pathToFileURL(profileManifestPath).href
    const pluginPath = join(dirname(profileManifestPath), 'node_modules', 'profile-plugin', 'index.cjs')
    const pluginUrl = pathToFileURL(pluginPath).href
    const dependencyPath = join(dirname(profileManifestPath), 'node_modules', 'profile-dependency', 'index.cjs')
    installProfilePackageResolver(profileBaseUrl)
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
    expect(harness.resolve?.(
      'profile-plugin',
      { parentURL: loaderEntryUrl },
      () => ({ url: pluginUrl }),
    )).toEqual({ url: pluginUrl })
    harness.overlay.mockClear()
    const nestedNextResolve = vi.fn(() => ({ url: pathToFileURL(dependencyPath).href }))
    harness.cjsOriginal.mockImplementationOnce((request: string) => {
      harness.resolve?.(request, { parentURL: profileBaseUrl }, nestedNextResolve)
      return dependencyPath
    })

    expect(harness.cjsModule._resolveFilename(
      'profile-dependency',
      { filename: pluginPath },
      false,
    )).toBe(dependencyPath)
    expect(nestedNextResolve).toHaveBeenCalledTimes(1)
    expect(harness.overlay).not.toHaveBeenCalled()
  })

  it('propagates Profile ownership from a config boundary through a relative CommonJS child', () => {
    const profileManifestPath = join(tmpdir(), 'dsh-profile-relative-cjs', 'package.json')
    const helperPath = join(dirname(profileManifestPath), 'lib', 'helper.cjs')
    const peerPath = join(dirname(profileManifestPath), 'node_modules', 'profile-peer', 'index.cjs')
    installProfilePackageResolver(pathToFileURL(profileManifestPath).href)
    harness.cjsOriginal.mockImplementation((request: string) => {
      if (request === './helper.cjs') return helperPath
      if (request === 'profile-peer') return peerPath
      return `ordinary:${request}`
    })

    expect(harness.cjsModule._resolveFilename(
      './helper.cjs',
      { filename: profileManifestPath },
      false,
    )).toBe(helperPath)
    expect(harness.cjsModule._resolveFilename(
      'profile-peer',
      { filename: helperPath },
      false,
    )).toBe(peerPath)
    expect(harness.overlay).not.toHaveBeenCalled()
  })

  it('migrates a live v1 resolver state in place during HMR', () => {
    const profileBaseUrl = 'file:///tmp/dsh/profiles/hmr/package.json'
    installProfilePackageResolver(profileBaseUrl)
    const symbol = Symbol.for('dsh-plugin-desktop.profile-package-resolver.v1')
    const state = (globalThis as unknown as Record<PropertyKey, unknown>)[symbol] as {
      registrations: Map<string, Record<string, unknown>>
    }
    const registration = state.registrations.get(profileBaseUrl)
    if (registration === undefined) throw new Error('missing test resolver registration')
    delete registration.canonicalPaths
    delete registration.canonicalModuleKeys
    delete registration.overlayCandidates
    delete registration.activeSequences

    expect(() => installProfilePackageResolver(profileBaseUrl)).not.toThrow()
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))
    expect(harness.resolve?.('plugin', { parentURL: loaderEntryUrl }, nextResolve)).toEqual({
      specifier: 'plugin',
      context: { parentURL: profileBaseUrl },
    })
    expect(harness.registerHooks).toHaveBeenCalledTimes(1)
  })

  it('deregisters hooks only once even if the disposer is reused', () => {
    const dispose = installProfilePackageResolver('file:///C:/Users/test/profile/package.json')
    dispose()
    dispose()
    expect(harness.deregister).toHaveBeenCalledTimes(1)
    expect(harness.cjsModule._resolveFilename).toBe(harness.cjsOriginal)
  })

  it('multiplexes Profiles through one hook and tolerates out-of-order release', () => {
    const first = installProfilePackageResolver('file:///tmp/dsh/profiles/first/package.json')
    const second = installProfilePackageResolver('file:///tmp/dsh/profiles/second/package.json')
    expect(harness.registerHooks).toHaveBeenCalledTimes(1)

    first()
    expect(harness.deregister).not.toHaveBeenCalled()
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))
    expect(harness.resolve?.(
      'second-plugin',
      { parentURL: 'file:///tmp/dsh/profiles/second/' },
      nextResolve,
    )).toEqual({
      specifier: 'second-plugin',
      context: { parentURL: 'file:///tmp/dsh/profiles/second/package.json' },
    })

    second()
    expect(harness.deregister).toHaveBeenCalledTimes(1)
    expect(harness.cjsModule._resolveFilename).toBe(harness.cjsOriginal)
  })

  it('reference-counts duplicate Profile registrations', () => {
    const first = installProfilePackageResolver('file:///tmp/dsh/profiles/desktop/package.json')
    const second = installProfilePackageResolver('file:///tmp/dsh/profiles/desktop/package.json')
    expect(harness.registerHooks).toHaveBeenCalledTimes(1)
    second()
    expect(harness.deregister).not.toHaveBeenCalled()
    first()
    expect(harness.deregister).toHaveBeenCalledTimes(1)
  })

  it('restores the correct newest Profile after an A-B-A retain is released', () => {
    const firstProfile = 'file:///tmp/dsh/profiles/first/package.json'
    const secondProfile = 'file:///tmp/dsh/profiles/second/package.json'
    const first = installProfilePackageResolver(firstProfile)
    const second = installProfilePackageResolver(secondProfile)
    const newestFirst = installProfilePackageResolver(firstProfile)
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))

    newestFirst()
    expect(harness.resolve?.('plugin', { parentURL: loaderEntryUrl }, nextResolve)).toEqual({
      specifier: 'plugin',
      context: { parentURL: secondProfile },
    })

    second()
    expect(harness.resolve?.('plugin', { parentURL: loaderEntryUrl }, nextResolve)).toEqual({
      specifier: 'plugin',
      context: { parentURL: firstProfile },
    })
    first()
  })

  it('requires a plain package.json file URL anchor', () => {
    expect(() => installProfilePackageResolver('https://example.com/package.json'))
      .toThrow('plain file URL')
    expect(() => installProfilePackageResolver('file:///tmp/profile/cordis.yml'))
      .toThrow('package.json anchor')
    expect(() => installProfilePackageResolver('file:///tmp/profile/package.json?generation=1'))
      .toThrow('plain file URL')
  })
})
