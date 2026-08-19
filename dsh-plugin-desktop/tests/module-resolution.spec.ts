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

  it('deregisters hooks only once even if the disposer is reused', () => {
    const dispose = installProfilePackageResolver('file:///C:/Users/test/profile/')

    dispose()
    dispose()

    expect(hooks.deregister).toHaveBeenCalledTimes(1)
  })
})
