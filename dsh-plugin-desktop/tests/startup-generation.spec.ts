import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopStartupGeneration } from '../src/startup-generation.ts'

afterEach(() => {
  vi.useRealTimers()
})

function generation(quiesceTimeoutMs = 5_000) {
  const logger = { error: vi.fn<(message: string) => void>() }
  return {
    logger,
    value: new DesktopStartupGeneration({ logger, quiesceTimeoutMs }),
  }
}

describe('Desktop startup generation ownership', () => {
  it('releases one Host before process resources and coalesces concurrent requests', async () => {
    const target = generation()
    const events: string[] = []
    const host = {
      fiber: {
        dispose: vi.fn(async () => { events.push('host') }),
      },
    }
    target.value.bindHost(host)
    target.value.bindHost(host)
    target.value.own(() => { events.push('pnpm') })
    target.value.own(() => { events.push('dsh') })

    await Promise.all([
      target.value.release(),
      target.value.release(),
    ])
    await target.value.release()

    expect(host.fiber.dispose).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['host', 'dsh', 'pnpm'])
  })

  it('shares idempotent resource releases with Host effects', async () => {
    const target = generation()
    const release = vi.fn()
    const hostEffect = target.value.own(release)

    hostEffect()
    hostEffect()
    await target.value.release()

    expect(release).toHaveBeenCalledTimes(1)
  })

  it('coalesces recovery quiescence and leaves resources alive until release', async () => {
    const target = generation()
    let finishHost!: () => void
    const host = {
      fiber: {
        dispose: vi.fn(async () => await new Promise<void>(resolve => { finishHost = resolve })),
      },
    }
    const release = vi.fn()
    target.value.bindHost(host)
    target.value.own(release)

    const first = target.value.quiesceForRecovery()
    const second = target.value.quiesceForRecovery()
    await vi.waitFor(() => { expect(host.fiber.dispose).toHaveBeenCalledTimes(1) })
    finishHost()

    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(release).not.toHaveBeenCalled()
    await target.value.release()
    expect(host.fiber.dispose).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('reports a quiesce timeout while final release still awaits the same Host', async () => {
    vi.useFakeTimers()
    const target = generation(25)
    let finishHost!: () => void
    const host = {
      fiber: {
        dispose: vi.fn(async () => await new Promise<void>(resolve => { finishHost = resolve })),
      },
    }
    target.value.bindHost(host)

    const quiesce = target.value.quiesceForRecovery()
    await vi.advanceTimersByTimeAsync(25)
    await expect(quiesce).resolves.toBe(false)
    expect(target.logger.error).toHaveBeenCalledWith(
      'dsh-plugin-desktop: plugin Host did not stop in time; mutating recovery actions are unavailable',
    )

    const release = target.value.release()
    finishHost()
    await expect(release).resolves.toBeUndefined()
    expect(host.fiber.dispose).toHaveBeenCalledTimes(1)
  })

  it('retries a failed recovery quiesce during final release', async () => {
    const target = generation()
    const host = {
      fiber: {
        dispose: vi.fn()
          .mockRejectedValueOnce(new Error('Host stop failed'))
          .mockResolvedValueOnce(undefined),
      },
    }
    target.value.bindHost(host)

    await expect(target.value.quiesceForRecovery()).resolves.toBe(false)
    expect(target.logger.error).toHaveBeenCalledWith(
      'dsh-plugin-desktop: failed to stop the plugin Host before recovery: Host stop failed',
    )
    await expect(target.value.release()).resolves.toBeUndefined()
    expect(host.fiber.dispose).toHaveBeenCalledTimes(2)
  })

  it('releases every resource and preserves the first failure', async () => {
    const target = generation()
    const released: string[] = []
    target.value.own(() => {
      released.push('first')
      throw new Error('first release failed')
    })
    target.value.own(() => {
      released.push('second')
      throw new Error('second release failed')
    })

    await expect(target.value.release()).rejects.toThrow('second release failed')
    expect(released).toEqual(['second', 'first'])
  })

  it('rejects a second Host or resource registration after release', async () => {
    const target = generation()
    const first = { fiber: { dispose: vi.fn(async () => {}) } }
    target.value.bindHost(first)
    expect(() => target.value.bindHost({ fiber: { dispose: vi.fn(async () => {}) } }))
      .toThrow('startup generation already owns another Host')

    await target.value.release()
    expect(() => target.value.own(() => {})).toThrow('startup generation is already released')
  })
})
