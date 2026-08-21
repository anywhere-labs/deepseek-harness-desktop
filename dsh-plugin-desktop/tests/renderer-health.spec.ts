import { describe, expect, it, vi } from 'vitest'
import { DesktopRendererHealthGate } from '../src/renderer-health.ts'

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (cause: unknown) => void
} {
  let resolve!: () => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('Desktop renderer health gate', () => {
  it('commits healthy only after Renderer evidence and native mount are both ready', async () => {
    const commitHealthy = vi.fn(async () => {})
    const gate = new DesktopRendererHealthGate({ commitHealthy })
    const result = gate.begin(1_000)

    gate.report({ status: 'healthy' })
    expect(commitHealthy).not.toHaveBeenCalled()

    gate.acceptNativeMount()

    await expect(result).resolves.toEqual({ report: { status: 'healthy' } })
    expect(commitHealthy).toHaveBeenCalledOnce()
  })

  it('commits healthy when native mount becomes ready before Renderer evidence', async () => {
    const commitHealthy = vi.fn(async () => {})
    const gate = new DesktopRendererHealthGate({ commitHealthy })
    const result = gate.begin(1_000)

    gate.acceptNativeMount()
    expect(commitHealthy).not.toHaveBeenCalled()
    gate.report({ status: 'healthy' })

    await expect(result).resolves.toEqual({ report: { status: 'healthy' } })
    expect(commitHealthy).toHaveBeenCalledOnce()
  })

  it('ignores evidence received before monitoring begins', async () => {
    const commitHealthy = vi.fn(async () => {})
    const gate = new DesktopRendererHealthGate({ commitHealthy })

    gate.report({ status: 'healthy' })
    gate.acceptNativeMount()
    const result = gate.begin(1_000)
    expect(commitHealthy).not.toHaveBeenCalled()

    gate.acceptNativeMount()
    gate.report({ status: 'healthy' })

    await expect(result).resolves.toEqual({ report: { status: 'healthy' } })
    expect(commitHealthy).toHaveBeenCalledOnce()
  })

  it('keeps the first failure verdict when later healthy evidence arrives', async () => {
    const commitHealthy = vi.fn(async () => {})
    const gate = new DesktopRendererHealthGate({ commitHealthy })
    const result = gate.begin(1_000)

    gate.fail('renderer-failed', 'renderer process gone')
    gate.acceptNativeMount()
    gate.report({ status: 'healthy' })

    await expect(result).resolves.toEqual({
      report: { status: 'failed', plugins: [], error: 'renderer process gone' },
      failureReason: 'renderer-failed',
    })
    expect(gate.failureReason).toBe('renderer-failed')
    expect(commitHealthy).not.toHaveBeenCalled()
  })

  it('lets a native failure win while healthy Renderer evidence is still waiting for mount', async () => {
    const commitHealthy = vi.fn(async () => {})
    const gate = new DesktopRendererHealthGate({ commitHealthy })
    const result = gate.begin(1_000)

    gate.report({ status: 'healthy' })
    gate.fail('renderer-failed', 'renderer process gone before native mount')
    gate.acceptNativeMount()

    await expect(result).resolves.toEqual({
      report: {
        status: 'failed',
        plugins: [],
        error: 'renderer process gone before native mount',
      },
      failureReason: 'renderer-failed',
    })
    expect(commitHealthy).not.toHaveBeenCalled()
  })

  it('settles a timeout once without committing healthy', async () => {
    vi.useFakeTimers()
    try {
      const commitHealthy = vi.fn(async () => {})
      const gate = new DesktopRendererHealthGate({ commitHealthy })
      const result = gate.begin(25)

      await vi.advanceTimersByTimeAsync(25)
      gate.report({ status: 'healthy' })

      await expect(result).resolves.toEqual({
        report: {
          status: 'failed',
          plugins: [],
          error: 'The Renderer did not report boot health within 25ms.',
        },
        failureReason: 'renderer-timeout',
      })
      expect(commitHealthy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects the verdict when the durable healthy commit fails', async () => {
    const commitHealthy = vi.fn(async () => { throw new Error('disk full') })
    const gate = new DesktopRendererHealthGate({ commitHealthy })
    const result = gate.begin(1_000)

    gate.acceptNativeMount()
    gate.report({ status: 'healthy' })

    await expect(result).rejects.toThrow('disk full')
    expect(commitHealthy).toHaveBeenCalledOnce()
  })

  it('rejects the verdict when the durable healthy commit throws synchronously', async () => {
    const commitHealthy = vi.fn(() => { throw new Error('invalid health state') })
    const gate = new DesktopRendererHealthGate({ commitHealthy })
    const result = gate.begin(1_000)

    gate.acceptNativeMount()
    gate.report({ status: 'healthy' })

    await expect(result).rejects.toThrow('invalid health state')
    expect(commitHealthy).toHaveBeenCalledOnce()
  })

  it('prevents later evidence from committing after monitoring stops', async () => {
    const commitHealthy = vi.fn(async () => {})
    const gate = new DesktopRendererHealthGate({ commitHealthy })

    const result = gate.begin(1_000)
    gate.stop()
    gate.acceptNativeMount()
    gate.report({ status: 'healthy' })

    await expect(result).rejects.toThrow('renderer health monitoring stopped')
    expect(commitHealthy).not.toHaveBeenCalled()
  })

  it('ignores duplicate reports while the first healthy commit is pending', async () => {
    const pendingCommit = deferred()
    const commitHealthy = vi.fn(() => pendingCommit.promise)
    const gate = new DesktopRendererHealthGate({ commitHealthy })
    const result = gate.begin(1_000)

    gate.acceptNativeMount()
    gate.report({ status: 'healthy' })
    gate.fail('renderer-failed', 'late crash')
    gate.report({ status: 'failed', plugins: ['late-plugin'], error: 'late failure' })
    await Promise.resolve()
    expect(commitHealthy).toHaveBeenCalledOnce()
    expect(gate.failureReason).toBeUndefined()

    pendingCommit.resolve()
    await expect(result).resolves.toEqual({ report: { status: 'healthy' } })
  })
})
