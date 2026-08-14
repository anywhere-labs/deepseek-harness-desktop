import { describe, expect, it, vi } from 'vitest'
import {
  handleDesktopZoomShortcut,
  resetDesktopZoom,
  type DesktopZoomEvent,
  type DesktopZoomInput,
  type DesktopZoomTarget,
} from '../src/zoom-shortcuts.ts'

interface ZoomHarness {
  readonly event: DesktopZoomEvent
  readonly preventDefault: ReturnType<typeof vi.fn<() => void>>
  readonly setZoomLevel: ReturnType<typeof vi.fn<(level: number) => void>>
  readonly target: DesktopZoomTarget
}

const baseInput: DesktopZoomInput = {
  type: 'keyDown',
  key: '+',
  control: true,
  meta: false,
  alt: false,
}

function zoomHarness(level: number): ZoomHarness {
  const preventDefault = vi.fn<() => void>()
  const setZoomLevel = vi.fn<(next: number) => void>()
  return {
    event: { preventDefault },
    preventDefault,
    setZoomLevel,
    target: {
      getZoomLevel: () => level,
      setZoomLevel,
    },
  }
}

describe('desktop zoom shortcuts', () => {
  it.each([
    { key: '+', control: true, meta: false },
    { key: '=', control: true, meta: false },
    { key: '+', control: false, meta: true },
  ])('zooms in for $key with a desktop accelerator', ({ key, control, meta }) => {
    const harness = zoomHarness(0)

    expect(handleDesktopZoomShortcut(harness.event, {
      ...baseInput,
      key,
      control,
      meta,
    }, harness.target)).toBe(true)

    expect(harness.preventDefault).toHaveBeenCalledOnce()
    expect(harness.setZoomLevel).toHaveBeenCalledWith(1)
  })

  it.each(['-', '_'])('zooms out for %s without crossing the lower bound', (key) => {
    const ordinary = zoomHarness(-2)
    expect(handleDesktopZoomShortcut(ordinary.event, { ...baseInput, key }, ordinary.target)).toBe(true)
    expect(ordinary.setZoomLevel).toHaveBeenCalledWith(-3)

    const bounded = zoomHarness(-3)
    expect(handleDesktopZoomShortcut(bounded.event, { ...baseInput, key }, bounded.target)).toBe(true)
    expect(bounded.preventDefault).toHaveBeenCalledOnce()
    expect(bounded.setZoomLevel).not.toHaveBeenCalled()
  })

  it('does not cross the upper bound', () => {
    const harness = zoomHarness(6)

    expect(handleDesktopZoomShortcut(harness.event, baseInput, harness.target)).toBe(true)

    expect(harness.preventDefault).toHaveBeenCalledOnce()
    expect(harness.setZoomLevel).not.toHaveBeenCalled()
  })

  it('resets the current zoom with the zero shortcut', () => {
    const harness = zoomHarness(-2)

    expect(handleDesktopZoomShortcut(harness.event, { ...baseInput, key: '0' }, harness.target)).toBe(true)

    expect(harness.setZoomLevel).toHaveBeenCalledWith(0)
  })

  it.each([
    { ...baseInput, type: 'keyUp' },
    { ...baseInput, alt: true },
    { ...baseInput, control: false, meta: false },
    { ...baseInput, key: 'x' },
  ])('leaves unrelated input to the renderer', (input) => {
    const harness = zoomHarness(0)

    expect(handleDesktopZoomShortcut(harness.event, input, harness.target)).toBe(false)

    expect(harness.preventDefault).not.toHaveBeenCalled()
    expect(harness.setZoomLevel).not.toHaveBeenCalled()
  })

  it('clears a persisted zoom level for a newly loaded window', () => {
    const harness = zoomHarness(-3)

    resetDesktopZoom(harness.target)

    expect(harness.setZoomLevel).toHaveBeenCalledWith(0)
  })
})
