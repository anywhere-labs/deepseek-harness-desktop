import { beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  resolve: undefined as undefined | ((
    specifier: string,
    context: { parentURL?: string },
    nextResolve: (specifier: string, context: { parentURL?: string }) => unknown,
  ) => unknown),
  deregister: vi.fn(),
}))

vi.mock('node:module', () => ({
  registerHooks: vi.fn((definition: { resolve: typeof hooks.resolve }) => {
    hooks.resolve = definition.resolve
    return { deregister: hooks.deregister }
  }),
}))

const { installProfilePackageResolver } = await import('../src/module-resolution.ts')

describe('installProfilePackageResolver', () => {
  beforeEach(() => {
    hooks.resolve = undefined
    hooks.deregister.mockClear()
  })

  it('routes Loader bare imports through the selected profile and keeps relative imports unchanged', async () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/'
    const dispose = installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn(async (specifier: string, context: { parentURL?: string }) => ({
      specifier,
      context,
    }))
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(hooks.resolve?.(
      'dsh-plugin-desktop',
      { parentURL: loaderEntryUrl },
      nextResolve,
    )).toEqual({
      shortCircuit: true,
      url: new URL('../lib/index.js', new URL('../src/module-resolution.ts', import.meta.url)).href,
    })

    await expect(hooks.resolve?.(
      'left-pad',
      { parentURL: loaderEntryUrl },
      nextResolve,
    )).resolves.toEqual({
      specifier: 'left-pad',
      context: { parentURL: profileBaseUrl },
    })

    await expect(hooks.resolve?.(
      './relative.js',
      { parentURL: loaderEntryUrl },
      nextResolve,
    )).resolves.toEqual({
      specifier: './relative.js',
      context: { parentURL: loaderEntryUrl },
    })

    await expect(hooks.resolve?.(
      'left-pad',
      { parentURL: 'file:///C:/Users/test/other.js' },
      nextResolve,
    )).resolves.toEqual({
      specifier: 'left-pad',
      context: { parentURL: 'file:///C:/Users/test/other.js' },
    })

    dispose()
    expect(hooks.deregister).toHaveBeenCalledTimes(1)
  })

  it('resolves dependencies of a linked profile plugin through the selected profile', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    const linkedPluginUrl = 'file:///D:/workspace/plugins/dsh-linked/lib/index.js'
    const profileDependencyUrl = 'file:///C:/Users/test/profile/node_modules/zod/index.js'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === 'dsh-linked' && context.parentURL === profileBaseUrl) {
        return { url: linkedPluginUrl }
      }
      if (specifier === 'zod' && context.parentURL === profileBaseUrl) {
        return { url: profileDependencyUrl }
      }
      const error = new Error(`Cannot find package '${specifier}' imported from ${context.parentURL ?? 'unknown'}`)
      Object.assign(error, { code: 'ERR_MODULE_NOT_FOUND' })
      throw error
    })
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(hooks.resolve?.(
      'dsh-linked',
      { parentURL: loaderEntryUrl },
      nextResolve,
    )).toEqual({ url: linkedPluginUrl })

    expect(hooks.resolve?.(
      'zod',
      { parentURL: linkedPluginUrl },
      nextResolve,
    )).toEqual({ url: profileDependencyUrl })
  })

  it('keeps profile dependency fallback across linked plugin relative modules', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    const linkedPluginUrl = 'file:///D:/workspace/plugins/dsh-linked/lib/index.js'
    const linkedFeatureUrl = 'file:///D:/workspace/plugins/dsh-linked/lib/feature.js'
    const profileDependencyUrl = 'file:///C:/Users/test/profile/node_modules/zod/index.js'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === 'dsh-linked' && context.parentURL === profileBaseUrl) {
        return { url: linkedPluginUrl }
      }
      if (specifier === './feature.js' && context.parentURL === linkedPluginUrl) {
        return { url: linkedFeatureUrl }
      }
      if (specifier === 'zod' && context.parentURL === profileBaseUrl) {
        return { url: profileDependencyUrl }
      }
      const error = new Error(`Cannot find package '${specifier}' imported from ${context.parentURL ?? 'unknown'}`)
      Object.assign(error, { code: 'ERR_MODULE_NOT_FOUND' })
      throw error
    })
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(hooks.resolve?.('dsh-linked', { parentURL: loaderEntryUrl }, nextResolve))
      .toEqual({ url: linkedPluginUrl })
    expect(hooks.resolve?.('./feature.js', { parentURL: linkedPluginUrl }, nextResolve))
      .toEqual({ url: linkedFeatureUrl })
    expect(hooks.resolve?.('zod', { parentURL: linkedFeatureUrl }, nextResolve))
      .toEqual({ url: profileDependencyUrl })
  })

  it('keeps profile dependency fallback across linked plugin package dependencies', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    const linkedPluginUrl = 'file:///D:/workspace/plugins/dsh-linked/lib/index.js'
    const localDependencyUrl = 'file:///D:/workspace/plugins/dsh-linked/node_modules/local-dependency/index.js'
    const profilePeerUrl = 'file:///C:/Users/test/profile/node_modules/profile-peer/index.js'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === 'dsh-linked' && context.parentURL === profileBaseUrl) {
        return { url: linkedPluginUrl }
      }
      if (specifier === 'local-dependency' && context.parentURL === linkedPluginUrl) {
        return { url: localDependencyUrl }
      }
      if (specifier === 'profile-peer' && context.parentURL === profileBaseUrl) {
        return { url: profilePeerUrl }
      }
      const error = new Error(`Cannot find package '${specifier}' imported from ${context.parentURL ?? 'unknown'}`)
      Object.assign(error, { code: 'ERR_MODULE_NOT_FOUND' })
      throw error
    })
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(hooks.resolve?.('dsh-linked', { parentURL: loaderEntryUrl }, nextResolve))
      .toEqual({ url: linkedPluginUrl })
    expect(hooks.resolve?.('local-dependency', { parentURL: linkedPluginUrl }, nextResolve))
      .toEqual({ url: localDependencyUrl })
    expect(hooks.resolve?.('profile-peer', { parentURL: localDependencyUrl }, nextResolve))
      .toEqual({ url: profilePeerUrl })
  })

  it('does not expose profile dependencies to unrelated modules', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (context.parentURL === profileBaseUrl) {
        return { url: 'file:///C:/Users/test/profile/node_modules/zod/index.js' }
      }
      const error = new Error(`Cannot find package '${specifier}' imported from ${context.parentURL ?? 'unknown'}`)
      Object.assign(error, { code: 'ERR_MODULE_NOT_FOUND' })
      throw error
    })

    expect(() => hooks.resolve?.(
      'zod',
      { parentURL: 'file:///C:/Program%20Files/DSH%20Desktop/resources/app.asar/lib/main.js' },
      nextResolve,
    )).toThrow('Cannot find package')
    expect(nextResolve).toHaveBeenCalledTimes(1)
  })

  it('deregisters hooks only once even if the disposer is reused', () => {
    const dispose = installProfilePackageResolver('file:///C:/Users/test/profile/')

    dispose()
    dispose()

    expect(hooks.deregister).toHaveBeenCalledTimes(1)
  })
})
