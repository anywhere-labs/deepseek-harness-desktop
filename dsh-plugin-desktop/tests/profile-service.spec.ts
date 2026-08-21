import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopProfileSummary } from '../src/profile-manager.ts'
import DesktopProfileService, {
  type DesktopProfileServiceBootstrap,
} from '../src/profile-service.ts'

const DESKTOP: DesktopProfileSummary = {
  name: 'desktop',
  dir: '/profiles/desktop',
  exists: true,
  bundles: [],
  webCapable: true,
}

const WORK: DesktopProfileSummary = {
  name: 'work',
  dir: '/profiles/work',
  exists: true,
  bundles: [],
  webCapable: true,
}

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function createBootstrap(overrides: Partial<DesktopProfileServiceBootstrap> = {}): DesktopProfileServiceBootstrap {
  return {
    current: { name: DESKTOP.name, dir: DESKTOP.dir },
    list: () => [DESKTOP, WORK],
    persistSelection: () => {},
    requestRestart: () => {},
    ...overrides,
  }
}

async function mount(bootstrap: DesktopProfileServiceBootstrap): Promise<{
  readonly ctx: Context
  readonly service: DesktopProfileService
  readonly dispose: () => Promise<unknown>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin(DesktopProfileService, bootstrap)
  await fiber
  return {
    ctx,
    service: ctx.desktopProfiles as DesktopProfileService,
    dispose: () => fiber.dispose(),
  }
}

describe('desktop profile service', () => {
  it('registers the generation identity under desktopProfiles and delegates fresh listings', async () => {
    const list = vi.fn(() => [DESKTOP, WORK])
    const bootstrap = createBootstrap({
      current: { name: '工作 profile', dir: '/profiles/工作 profile' },
      list,
    })
    const { ctx, service } = await mount(bootstrap)

    expect(Boolean(ctx.get('desktopProfiles'))).toBe(true)
    expect(service.current).toEqual({ name: '工作 profile', dir: '/profiles/工作 profile' })
    expect(Object.isFrozen(service.current)).toBe(true)
    expect(service.list()).toEqual([DESKTOP, WORK])
    expect(service.list()).toEqual([DESKTOP, WORK])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('creates a profile through the launcher without selecting it', async () => {
    const create = vi.fn(() => WORK)
    const persistSelection = vi.fn()
    const requestRestart = vi.fn()
    const mounted = await mount(createBootstrap({ create, persistSelection, requestRestart }))

    expect(mounted.service.create('work')).toEqual(WORK)
    expect(create).toHaveBeenCalledWith('work')
    expect(mounted.service.current.name).toBe('desktop')
    expect(persistSelection).not.toHaveBeenCalled()
    expect(requestRestart).not.toHaveBeenCalled()
  })

  it('rejects profile creation through a retained service after disposal', async () => {
    const create = vi.fn(() => WORK)
    const mounted = await mount(createBootstrap({ create }))
    await mounted.dispose()

    expect(() => mounted.service.create('work')).toThrow('desktopProfiles service disposed')
    expect(create).not.toHaveBeenCalled()
  })

  it('does nothing when the current profile is selected', async () => {
    const persistSelection = vi.fn()
    const requestRestart = vi.fn()
    const { service } = await mount(createBootstrap({ persistSelection, requestRestart }))

    await expect(service.select('desktop')).resolves.toBeUndefined()
    expect(persistSelection).not.toHaveBeenCalled()
    expect(requestRestart).not.toHaveBeenCalled()
  })

  it('persists a new selection before requesting restart', async () => {
    const events: string[] = []
    const { service } = await mount(createBootstrap({
      persistSelection: async name => { events.push(`persist:${name}`) },
      requestRestart: async () => { events.push('restart') },
    }))

    await expect(service.select('work')).resolves.toBeUndefined()
    expect(events).toEqual(['persist:work', 'restart'])
  })

  it('treats an accepted restart as successful when teardown disposes the old service', async () => {
    let dispose!: () => Promise<unknown>
    const requestRestart = vi.fn(async () => { await dispose() })
    const mounted = await mount(createBootstrap({ requestRestart }))
    dispose = mounted.dispose

    await expect(mounted.service.select('work')).resolves.toBeUndefined()
    expect(requestRestart).toHaveBeenCalledOnce()
  })

  it('does not restart after persistence fails and permits a later valid selection', async () => {
    const persistSelection = vi.fn(async (name: string) => {
      if (name === 'broken') throw new Error('profile is unavailable')
    })
    const requestRestart = vi.fn(async () => {})
    const { service } = await mount(createBootstrap({ persistSelection, requestRestart }))

    await expect(service.select('broken')).rejects.toThrow('profile is unavailable')
    expect(requestRestart).not.toHaveBeenCalled()
    await expect(service.select('work')).resolves.toBeUndefined()
    expect(persistSelection.mock.calls).toEqual([['broken'], ['work']])
    expect(requestRestart).toHaveBeenCalledOnce()
  })

  it('lets the first concurrently persisted target win', async () => {
    const firstPersist = deferred<void>()
    const firstRestart = deferred<void>()
    const events: string[] = []
    const persistSelection = vi.fn((name: string) => {
      events.push(`persist:${name}`)
      return firstPersist.promise
    })
    const requestRestart = vi.fn(() => {
      events.push('restart')
      return firstRestart.promise
    })
    const { service } = await mount(createBootstrap({ persistSelection, requestRestart }))

    const first = service.select('work')
    const second = service.select('other')
    expect(events).toEqual(['persist:work'])
    firstPersist.resolve(undefined)
    await vi.waitFor(() => { expect(events).toEqual(['persist:work', 'restart']) })
    firstRestart.resolve(undefined)

    await expect(first).resolves.toBeUndefined()
    await expect(second).rejects.toThrow('profile "work" is already pending')
    expect(persistSelection).toHaveBeenCalledOnce()
    expect(requestRestart).toHaveBeenCalledOnce()
  })

  it('allows a concurrent target to proceed when the earlier persistence is rejected', async () => {
    const firstPersist = deferred<void>()
    const persistSelection = vi.fn((name: string) => name === 'broken' ? firstPersist.promise : Promise.resolve())
    const requestRestart = vi.fn(async () => {})
    const { service } = await mount(createBootstrap({ persistSelection, requestRestart }))

    const broken = service.select('broken')
    const work = service.select('work')
    firstPersist.reject(new Error('profile is unavailable'))

    await expect(broken).rejects.toThrow('profile is unavailable')
    await expect(work).resolves.toBeUndefined()
    expect(persistSelection.mock.calls).toEqual([['broken'], ['work']])
    expect(requestRestart).toHaveBeenCalledOnce()
  })

  it('retains a persisted target after restart failure and retries only that restart', async () => {
    const retryRestart = deferred<void>()
    const persistSelection = vi.fn(async () => {})
    const requestRestart = vi.fn()
      .mockRejectedValueOnce(new Error('restart unavailable'))
      .mockImplementationOnce(() => retryRestart.promise)
    const { service } = await mount(createBootstrap({ persistSelection, requestRestart }))

    await expect(service.select('work')).rejects.toThrow('restart unavailable')
    await expect(service.select('other')).rejects.toThrow('profile "work" is already pending')
    const retry = service.select('work')
    const duplicateRetry = service.select('work')
    expect(duplicateRetry).toBe(retry)
    expect(requestRestart).toHaveBeenCalledTimes(2)
    retryRestart.resolve(undefined)
    await expect(retry).resolves.toBeUndefined()
    await expect(duplicateRetry).resolves.toBeUndefined()
    expect(persistSelection).toHaveBeenCalledOnce()
    expect(requestRestart).toHaveBeenCalledTimes(2)
  })

  it('unregisters with its fiber and rejects retained calls after disposal', async () => {
    const pending = deferred<void>()
    const requestRestart = vi.fn(async () => {})
    const mounted = await mount(createBootstrap({
      persistSelection: () => pending.promise,
      requestRestart,
    }))
    const selection = mounted.service.select('work')

    await mounted.dispose()
    expect(mounted.ctx.get('desktopProfiles')).toBeUndefined()
    expect(() => mounted.service.current).toThrow('desktopProfiles service disposed')
    expect(() => mounted.service.list()).toThrow('desktopProfiles service disposed')
    await expect(mounted.service.select('work')).rejects.toThrow('desktopProfiles service disposed')

    pending.resolve(undefined)
    await expect(selection).rejects.toThrow('desktopProfiles service disposed')
    expect(requestRestart).not.toHaveBeenCalled()
  })

  it('rejects a second service registration for the same Cordis key', async () => {
    const ctx = new Context()
    await ctx.plugin(DesktopProfileService, createBootstrap())

    await expect(ctx.plugin(DesktopProfileService, createBootstrap()))
      .rejects.toThrow(/service "desktopProfiles" has been registered/)
  })
})
