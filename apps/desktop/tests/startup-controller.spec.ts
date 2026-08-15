import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopStartupCancelledError,
  startRecoverableDesktopHost,
  type DesktopHostMode,
  type DesktopRecoveryRequest,
} from '../src/startup-controller.ts'
import type { HostSupervisor } from '../src/host-supervisor.ts'

interface FakeHost extends HostSupervisor {
  readonly startDeferred: ReturnType<typeof deferred<string>>
  readonly shutdownDeferred: ReturnType<typeof deferred<undefined>>
  readonly shutdownCalls: ReturnType<typeof vi.fn>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function fakeHost(autoShutdown = true): FakeHost {
  const startDeferred = deferred<string>()
  const shutdownDeferred = deferred<undefined>()
  const shutdownCalls = vi.fn()
  return {
    startDeferred,
    shutdownDeferred,
    shutdownCalls,
    start: () => startDeferred.promise,
    shutdown: () => {
      shutdownCalls()
      if (autoShutdown) shutdownDeferred.resolve(undefined)
      return shutdownDeferred.promise
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('recoverable desktop Host startup', () => {
  it('returns a normal Host without showing recovery on the fast path', async () => {
    const host = fakeHost()
    const prompt = vi.fn()
    const starting = startRecoverableDesktopHost({ createHost: () => host, prompt })
    host.startDeferred.resolve('http://127.0.0.1:4123')

    await expect(starting).resolves.toEqual({ host, origin: 'http://127.0.0.1:4123', safeMode: false })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('continues waiting after the slow-start prompt', async () => {
    vi.useFakeTimers()
    const host = fakeHost()
    const prompt = vi.fn(async () => 'wait' as const)
    const starting = startRecoverableDesktopHost({ createHost: () => host, prompt, slowStartMs: 25 })

    await vi.advanceTimersByTimeAsync(25)
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ kind: 'slow', mode: 'normal' }))
    host.startDeferred.resolve('http://127.0.0.1:4123')
    await expect(starting).resolves.toEqual({ host, origin: 'http://127.0.0.1:4123', safeMode: false })
  })

  it('dismisses an in-flight prompt when the Host becomes ready', async () => {
    vi.useFakeTimers()
    const host = fakeHost()
    let request: DesktopRecoveryRequest | undefined
    const prompt = vi.fn(async (value: DesktopRecoveryRequest) => {
      request = value
      await new Promise<void>((resolve) => { value.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      return 'dismissed' as const
    })
    const starting = startRecoverableDesktopHost({ createHost: () => host, prompt, slowStartMs: 25 })

    await vi.advanceTimersByTimeAsync(25)
    host.startDeferred.resolve('http://127.0.0.1:4123')
    await expect(starting).resolves.toEqual({ host, origin: 'http://127.0.0.1:4123', safeMode: false })
    expect(request?.signal.aborted).toBe(true)
  })

  it('fully stops the normal Host before starting safe mode', async () => {
    vi.useFakeTimers()
    const normal = fakeHost(false)
    const safe = fakeHost()
    const modes: DesktopHostMode[] = []
    const prompt = vi.fn(async () => 'safe-mode' as const)
    const starting = startRecoverableDesktopHost({
      createHost: (mode) => {
        modes.push(mode)
        return mode === 'normal' ? normal : safe
      },
      prompt,
      slowStartMs: 25,
    })

    await vi.advanceTimersByTimeAsync(25)
    expect(normal.shutdownCalls).toHaveBeenCalledOnce()
    expect(modes).toEqual(['normal'])
    normal.startDeferred.reject(new Error('normal stopped'))
    normal.shutdownDeferred.resolve(undefined)
    await vi.waitFor(() => { expect(modes).toEqual(['normal', 'safe']) })
    safe.startDeferred.resolve('http://127.0.0.1:4222')
    await expect(starting).resolves.toEqual({ host: safe, origin: 'http://127.0.0.1:4222', safeMode: true })
  })

  it('fully stops the Host when the recovery prompt fails', async () => {
    vi.useFakeTimers()
    const host = fakeHost(false)
    const failure = new Error('dialog unavailable')
    const starting = startRecoverableDesktopHost({
      createHost: () => host,
      prompt: async () => { throw failure },
      slowStartMs: 25,
    })

    await vi.advanceTimersByTimeAsync(25)
    expect(host.shutdownCalls).toHaveBeenCalledOnce()
    host.startDeferred.reject(new Error('stopped'))
    host.shutdownDeferred.resolve(undefined)
    await expect(starting).rejects.toBe(failure)
  })

  it('offers recovery after an immediate failure and retries the selected mode', async () => {
    const first = fakeHost()
    const second = fakeHost()
    const hosts = [first, second]
    const prompt = vi.fn(async () => 'retry' as const)
    const starting = startRecoverableDesktopHost({ createHost: () => hosts.shift()!, prompt })
    first.startDeferred.reject(new Error('invalid configuration'))
    await Promise.resolve()
    second.startDeferred.resolve('http://127.0.0.1:4333')

    await expect(starting).resolves.toEqual({ host: second, origin: 'http://127.0.0.1:4333', safeMode: false })
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failure', mode: 'normal' }))
  })

  it('cancels startup through application-owned shutdown', async () => {
    const host = fakeHost(false)
    const abort = new AbortController()
    const starting = startRecoverableDesktopHost({ createHost: () => host, prompt: vi.fn(), signal: abort.signal })

    abort.abort()
    await vi.waitFor(() => { expect(host.shutdownCalls).toHaveBeenCalledOnce() })
    host.startDeferred.reject(new Error('stopped'))
    host.shutdownDeferred.resolve(undefined)
    await expect(starting).rejects.toBeInstanceOf(DesktopStartupCancelledError)
  })
})
