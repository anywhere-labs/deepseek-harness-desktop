import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RENDERER_SURFACE_PROBE, RendererSurfaceWatchdog } from '../src/renderer-surface-watchdog.ts'

function setup() {
  const active = vi.fn(() => true)
  const probe = vi.fn<() => Promise<unknown>>(async () => true)
  const healthy = vi.fn()
  const failed = vi.fn()
  const watchdog = new RendererSurfaceWatchdog({ active, probe, healthy, failed })
  watchdog.start()
  return { watchdog, active, probe, healthy, failed }
}

describe('renderer surface watchdog', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('requires two consecutive empty-page observations', async () => {
    const { watchdog, probe, healthy, failed } = setup()
    probe.mockResolvedValueOnce(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(failed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(healthy).toHaveBeenCalledOnce()
    probe.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(failed).toHaveBeenCalledWith('renderer surface watchdog: page has no visible content', false)
    watchdog.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('detects a hung renderer using a main-process deadline without overlapping probes', async () => {
    const { watchdog, probe, failed } = setup()
    probe.mockImplementation(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(14_999)
    expect(probe).toHaveBeenCalledOnce()
    expect(failed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_001)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(failed).toHaveBeenCalledWith('renderer surface watchdog: page did not respond', true)
    watchdog.stop()
  })

  it('ignores stale results after navigation and stops all timers on disposal', async () => {
    const { watchdog, probe, failed, healthy } = setup()
    let resolve!: (value: boolean) => void
    probe.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await vi.advanceTimersByTimeAsync(5000)
    watchdog.reset()
    resolve(false)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5000)
    expect(healthy).toHaveBeenCalledOnce()
    expect(failed).not.toHaveBeenCalled()
    watchdog.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pauses while hidden, loading, recovering, or shutting down', async () => {
    const { watchdog, active, probe, failed } = setup()
    probe.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(5000)
    active.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probe).toHaveBeenCalledOnce()
    active.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(failed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(failed).toHaveBeenCalledOnce()
    watchdog.stop()
  })

  it('discards results when the window becomes hidden during a probe', async () => {
    const { watchdog, active, probe, failed } = setup()
    let resolve!: (value: boolean) => void
    probe.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await vi.advanceTimersByTimeAsync(5000)
    active.mockReturnValue(false)
    resolve(false)
    await Promise.resolve()
    active.mockReturnValue(true)
    probe.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(failed).not.toHaveBeenCalled()
    watchdog.stop()
  })

  it('treats a suspended clock as inconclusive instead of a hung page', async () => {
    const { watchdog, probe, failed } = setup()
    probe.mockImplementation(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(5000)
    vi.setSystemTime(Date.now() + 120_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(failed).not.toHaveBeenCalled()
    watchdog.stop()
  })

  it('ignores a deferred DOM probe and handles evaluation rejection', async () => {
    const { watchdog, probe, failed } = setup()
    probe.mockResolvedValueOnce(false).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('navigation'))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(failed).not.toHaveBeenCalled()
    watchdog.stop()
  })
})

describe('renderer surface probe', () => {
  function probeSurface(options: { missing?: boolean; text?: string; visible?: boolean; hidden?: boolean; loading?: boolean; offscreen?: boolean; portal?: 'visible' | 'hidden' | 'empty' } = {}) {
    const root = {
      matches: () => false,
      childNodes: options.text === undefined ? [] : [{ nodeType: 3, textContent: options.text }],
      checkVisibility: () => options.visible !== false,
      getBoundingClientRect: () => ({ width: 100, height: 40, top: options.offscreen ? 900 : 0, left: 0, right: 100, bottom: 40 }),
    }
    return runInNewContext(RENDERER_SURFACE_PROBE, {
      document: {
        visibilityState: options.hidden ? 'hidden' : 'visible',
        readyState: options.loading ? 'loading' : 'complete',
        getElementById: (id: string) => id === 'root' && !options.missing ? root : null,
        querySelectorAll: () => options.portal === undefined ? [] : [{ ...root,
          childNodes: options.portal === 'empty' ? [] : [{ nodeType: 3, textContent: 'Desktop setup' }],
          checkVisibility: () => options.portal !== 'hidden',
        }],
        createTreeWalker: (element: unknown) => ({ currentNode: element, nextNode: () => null }),
      },
      NodeFilter: { SHOW_ELEMENT: 1 },
      Node: { TEXT_NODE: 3 },
      innerWidth: 1000,
      innerHeight: 800,
    })
  }

  it('detects an unmounted or empty application, not just a live JS context', () => {
    expect(probeSurface({ missing: true })).toBe(false)
    expect(probeSurface()).toBe(false)
    expect(probeSurface({ text: '   ' })).toBe(false)
  })

  it('requires meaningful content visible in the viewport', () => {
    expect(probeSurface({ text: 'New conversation' })).toBe(true)
    expect(probeSurface({ text: 'New conversation', visible: false })).toBe(false)
    expect(probeSurface({ text: 'New conversation', offscreen: true })).toBe(false)
  })

  it('defers hidden and loading documents', () => {
    expect(probeSurface({ hidden: true })).toBe('hidden')
    expect(probeSurface({ loading: true })).toBeNull()
  })
  it('accepts visible official onboarding outside the hidden app root without excusing an empty portal', () => {
    expect(probeSurface({ text: 'Hidden shell', visible: false, portal: 'visible' })).toBe(true)
    expect(probeSurface({ text: 'Hidden shell', visible: false, portal: 'hidden' })).toBe(false)
    expect(probeSurface({ portal: 'empty' })).toBe(false)
    expect(probeSurface({ missing: true, portal: 'visible' })).toBe(true)
  })
})
