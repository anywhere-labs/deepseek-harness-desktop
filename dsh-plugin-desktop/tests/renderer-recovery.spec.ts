import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopRendererRecovery } from '../src/renderer-recovery.ts'

function setup() {
  const available = vi.fn(() => true)
  const reload = vi.fn()
  const exhausted = vi.fn()
  const log = vi.fn()
  const recovery = new DesktopRendererRecovery({ available, reload, exhausted, log })
  return { recovery, available, reload, exhausted, log }
}

describe('automatic renderer recovery', () => {
  it('accepts a healthy background document when Chromium reports it occluded', () => {
    vi.useFakeTimers()
    const recovery = new DesktopRendererRecovery({
      available: () => true, reload: vi.fn(), exhausted: vi.fn(), log: vi.fn(), requireSurface: () => true,
    })
    recovery.fail('blank')
    vi.advanceTimersByTime(0)
    recovery.loaded()
    recovery.report({ status: 'healthy' })
    expect(recovery.detail).toBe('blank')
    recovery.surfaceBecameHidden()
    expect(recovery.detail).toBeUndefined()
    recovery.stop()
  })

  it('requires visible surface evidence and permits background completion after hiding', () => {
    vi.useFakeTimers()
    const requireSurface = vi.fn(() => true)
    const recovery = new DesktopRendererRecovery({
      available: () => true, reload: vi.fn(), exhausted: vi.fn(), log: vi.fn(), requireSurface,
    })
    recovery.fail('blank')
    vi.advanceTimersByTime(0)
    recovery.loaded()
    recovery.report({ status: 'healthy' })
    expect(recovery.detail).toBe('blank')
    expect(recovery.canProbeSurface).toBe(true)
    requireSurface.mockReturnValue(false)
    recovery.visibilityChanged()
    expect(recovery.detail).toBeUndefined()
    recovery.stop()
  })

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it.each(['page-first', 'client-first'] as const)('requires page load and client health in %s order', (order) => {
    const { recovery, reload, exhausted } = setup()
    recovery.fail('oom')
    vi.advanceTimersByTime(0)
    if (order === 'page-first') recovery.loaded()
    else recovery.report({ status: 'healthy' })
    expect(recovery.detail).toBe('oom')
    if (order === 'page-first') recovery.report({ status: 'healthy' })
    else recovery.loaded()
    expect(recovery.detail).toBeUndefined()
    vi.advanceTimersByTime(90_000)
    expect(reload).toHaveBeenCalledOnce()
    expect(exhausted).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['page-only', 'client-only', 'neither'] as const)('retries and stops when health remains %s', (health) => {
    const { recovery, reload, exhausted } = setup()
    recovery.fail('oom')
    vi.advanceTimersByTime(0)
    if (health === 'page-only') recovery.loaded()
    if (health === 'client-only') recovery.report({ status: 'healthy' })
    vi.advanceTimersByTime(30_000)
    expect(reload).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1000)
    expect(reload).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(33_000)
    expect(reload).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(30_000)
    expect(exhausted).toHaveBeenCalledOnce()
    expect(recovery.exhausted).toBe(true)
    vi.advanceTimersByTime(300_000)
    expect(reload).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('coalesces failures during backoff and clears stale health between attempts', () => {
    const { recovery, reload } = setup()
    recovery.fail('oom')
    recovery.fail('connection reset')
    vi.advanceTimersByTime(0)
    expect(reload).toHaveBeenCalledOnce()
    recovery.loaded()
    recovery.report({ status: 'failed', plugins: ['broken-plugin'] })
    recovery.loaded()
    recovery.report({ status: 'healthy' })
    vi.advanceTimersByTime(1000)
    recovery.report({ status: 'healthy' })
    expect(recovery.detail).toContain('broken-plugin')
    recovery.loaded()
    expect(recovery.detail).toBeUndefined()
    recovery.stop()
  })

  it('bounds rapid crashes even when every reload initially reports healthy', () => {
    const { recovery, reload, exhausted } = setup()
    for (const delay of [0, 1000, 3000]) {
      recovery.fail('oom')
      vi.advanceTimersByTime(delay)
      recovery.loaded()
      recovery.report({ status: 'healthy' })
    }
    recovery.fail('oom')
    expect(reload).toHaveBeenCalledTimes(3)
    expect(exhausted).toHaveBeenCalledOnce()
    recovery.report({ status: 'healthy' })
    recovery.loaded()
    expect(recovery.exhausted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restores the automatic retry budget only after a healthy stable minute', () => {
    const { recovery, reload, exhausted } = setup()
    for (let cycle = 0; cycle < 5; cycle += 1) {
      recovery.fail('oom')
      vi.advanceTimersByTime(0)
      expect(reload).toHaveBeenCalledTimes(cycle + 1)
      recovery.loaded()
      recovery.report({ status: 'healthy' })
      vi.advanceTimersByTime(60_000)
    }
    expect(exhausted).not.toHaveBeenCalled()
    recovery.stop()
  })

  it('bounds synchronous reload errors and permits explicit retry after exhaustion', () => {
    const { recovery, reload, exhausted } = setup()
    reload.mockImplementation(() => { throw new Error('reload failed') })
    recovery.fail('oom')
    vi.advanceTimersByTime(4000)
    expect(reload).toHaveBeenCalledTimes(3)
    expect(exhausted).toHaveBeenCalledOnce()
    expect(recovery.detail).toContain('reload failed')
    reload.mockReset()
    recovery.retry()
    vi.advanceTimersByTime(0)
    expect(reload).toHaveBeenCalledOnce()
    recovery.loaded()
    recovery.report({ status: 'healthy' })
    expect(recovery.exhausted).toBe(false)
    recovery.stop()
  })

  it.each(['scheduled', 'loading', 'healthy'] as const)('stops all timers and ignores late events from %s', (phase) => {
    const { recovery, reload, exhausted } = setup()
    recovery.fail('oom')
    if (phase !== 'scheduled') vi.advanceTimersByTime(0)
    if (phase === 'healthy') {
      recovery.loaded()
      recovery.report({ status: 'healthy' })
    }
    const reloads = reload.mock.calls.length
    recovery.stop()
    recovery.fail('late crash')
    recovery.report({ status: 'healthy' })
    recovery.loaded()
    recovery.retry()
    vi.advanceTimersByTime(300_000)
    expect(reload).toHaveBeenCalledTimes(reloads)
    expect(exhausted).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not reload when the window becomes unavailable', () => {
    const { recovery, available, reload, exhausted } = setup()
    recovery.fail('oom')
    available.mockReturnValue(false)
    vi.advanceTimersByTime(300_000)
    expect(reload).not.toHaveBeenCalled()
    expect(exhausted).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears an exhausted recovery state when restored on confirmed health', () => {
    const { recovery, reload, exhausted, log } = setup()
    recovery.fail('oom')
    vi.advanceTimersByTime(94_000)
    expect(reload).toHaveBeenCalledTimes(3)
    expect(exhausted).toHaveBeenCalledOnce()
    expect(recovery.exhausted).toBe(true)
    recovery.restore()
    expect(recovery.exhausted).toBe(false)
    expect(recovery.detail).toBeUndefined()
    expect(log).toHaveBeenCalledWith('automatic renderer recovery healthy')
    recovery.stop()
  })

  it('clears an exhausted recovery when late health arrives after page load timeout', () => {
    const { recovery, reload, exhausted, log } = setup()
    recovery.fail('timeout')
    vi.advanceTimersByTime(0)
    vi.advanceTimersByTime(30_000)
    vi.advanceTimersByTime(1000)
    vi.advanceTimersByTime(30_000)
    vi.advanceTimersByTime(3000)
    vi.advanceTimersByTime(30_000)
    expect(reload).toHaveBeenCalledTimes(3)
    expect(exhausted).toHaveBeenCalledOnce()
    expect(recovery.exhausted).toBe(true)
    expect(recovery.detail).toBe('renderer recovery timed out waiting for page load and client health')

    recovery.loaded()
    recovery.report({ status: 'healthy' })
    expect(recovery.exhausted).toBe(false)
    expect(recovery.detail).toBeUndefined()
    expect(log).toHaveBeenCalledWith('automatic renderer recovery healthy')
    recovery.stop()
  })
})
