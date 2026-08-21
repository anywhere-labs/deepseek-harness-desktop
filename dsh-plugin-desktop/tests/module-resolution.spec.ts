import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const cjsOriginal = vi.fn((
    request: string,
    _parent?: { filename?: string } | null,
    _isMain?: boolean,
    _options?: unknown,
  ) => `ordinary:${request}`)
  return {
    resolve: undefined as undefined | ((
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context: { parentURL?: string }) => unknown,
    ) => unknown),
    deregister: vi.fn(),
    sources: new Map<string, 'install' | 'profile'>(),
    overlay: vi.fn((packageName: string) => {
      const source = harness.sources.get(packageName) ?? 'profile'
      return {
        packageName,
        selected: {
          source,
          manifestPath: `/${source}/${packageName}/package.json`,
        },
      }
    }),
    cjsOriginal,
    cjsModule: { _resolveFilename: cjsOriginal },
  }
})

vi.mock('node:module', () => ({
  default: harness.cjsModule,
  registerHooks: vi.fn((definition: { resolve: typeof harness.resolve }) => {
    harness.resolve = definition.resolve
    return { deregister: harness.deregister }
  }),
}))

vi.mock('../src/package-overlay.ts', () => ({
  findOverlayPackage: harness.overlay,
  packageNameFromSpecifier(specifier: string): string | undefined {
    if (specifier.length === 0 || specifier.startsWith('.') || specifier.startsWith('/')
      || specifier.startsWith('#') || URL.canParse(specifier)) return undefined
    const parts = specifier.split('/')
    return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
  },
  resolveOverlayPackage: harness.overlay,
}))

const { installProfilePackageResolver } = await import('../src/module-resolution.ts')

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
    harness.cjsOriginal.mockClear()
    harness.cjsModule._resolveFilename = harness.cjsOriginal
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
      { parentURL: loaderEntryUrl },
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
    expect(harness.overlay).not.toHaveBeenCalled()
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

  it('uses the same overlay for CommonJS package manifests resolved from the Profile anchor', () => {
    const profileBaseUrl = 'file:///tmp/dsh-profile/package.json'
    harness.sources.set('@deepseek-ai/dsh-client-modules', 'install')
    const dispose = installProfilePackageResolver(profileBaseUrl)
    const resolveFilename = harness.cjsModule._resolveFilename

    expect(resolveFilename(
      '@deepseek-ai/dsh-client-modules/package.json',
      { filename: '/tmp/dsh-profile/package.json' },
      false,
    )).toBe('/install/@deepseek-ai/dsh-client-modules/package.json')
    expect(resolveFilename(
      '@deepseek-ai/dsh-client-modules/package.json',
      { filename: '/tmp/another-profile/package.json' },
      false,
    )).toBe('ordinary:@deepseek-ai/dsh-client-modules/package.json')
    expect(resolveFilename(
      '@deepseek-ai/dsh-client-modules/client.js',
      { filename: '/tmp/dsh-profile/package.json' },
      false,
    )).toBe('ordinary:@deepseek-ai/dsh-client-modules/client.js')

    dispose()
    expect(harness.cjsModule._resolveFilename).toBe(harness.cjsOriginal)
  })

  it('deregisters hooks only once even if the disposer is reused', () => {
    const dispose = installProfilePackageResolver('file:///C:/Users/test/profile/package.json')
    dispose()
    dispose()
    expect(harness.deregister).toHaveBeenCalledTimes(1)
  })
})
