import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPageKeyScrollGuard } from '../src/client/page-key-scroll-guard.ts'
import { installDesktopOwnedStyles } from '../src/client/styles.ts'

type Listener = (event: Record<string, unknown>) => void

/** Upstream boundaries the guard scopes itself with. */
const COMPOSER_SEAT = '[data-composer-seat]'
const CONVERSATION_SCROLL = '[data-conversation-scroll]'

/** Element double that answers `closest` and carries a scroll position. */
class FakeElement {
  scrollTop = 0
  private readonly chain: (selector: string) => FakeElement | null
  constructor(chain: (selector: string) => FakeElement | null) { this.chain = chain }
  closest(selector: string): FakeElement | null { return this.chain(selector) }
}

/** Capture-phase document double: the guard only ever talks to `document`. */
function documentDouble() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    document: {
      activeElement: null as Element | null,
      addEventListener: (type: string, listener: Listener): void => {
        const bound = listeners.get(type) ?? new Set<Listener>()
        bound.add(listener)
        listeners.set(type, bound)
      },
      removeEventListener: (type: string, listener: Listener): void => {
        listeners.get(type)?.delete(listener)
      },
    },
    fire: (type: string, event: Record<string, unknown> = {}): void => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, ...event })
    },
    listenerCount: (type: string): number => listeners.get(type)?.size ?? 0,
  }
}

/** A caret inside the composer seat, with the conversation scroller above it. */
function caretInComposer(scroller: FakeElement): FakeElement {
  const seat = new FakeElement(selector => selector === CONVERSATION_SCROLL ? scroller : null)
  return new FakeElement(selector => selector === COMPOSER_SEAT ? seat : null)
}

describe('page-key scroll guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('pins the transcript across the frames of one composer page key', () => {
    const { document, fire, listenerCount } = documentDouble()
    vi.stubGlobal('document', document)
    vi.stubGlobal('Element', FakeElement)
    const scroller = new FakeElement(() => null)
    scroller.scrollTop = 1400
    document.activeElement = caretInComposer(scroller) as unknown as Element
    const dispose = installPageKeyScrollGuard()

    fire('keydown', { key: 'PageUp' })
    // Blink animates the chained scroll, so every frame of it has to be undone.
    for (const frame of [2080, 2244, 2312]) {
      scroller.scrollTop = frame
      fire('scroll', { target: scroller })
      expect(scroller.scrollTop).toBe(1400)
    }
    expect(listenerCount('keydown')).toBe(1)
    expect(listenerCount('scroll')).toBe(1)

    dispose()
    expect(listenerCount('keydown')).toBe(0)
    expect(listenerCount('scroll')).toBe(0)
  })

  it('leaves other keys, other scrollers, and other focus alone', () => {
    const { document, fire } = documentDouble()
    vi.stubGlobal('document', document)
    vi.stubGlobal('Element', FakeElement)
    const scroller = new FakeElement(() => null)
    scroller.scrollTop = 1400
    installPageKeyScrollGuard()

    for (const keydown of [
      { key: 'ArrowUp' },
      { key: 'PageUp', defaultPrevented: true },
      { key: 'PageDown', ctrlKey: true },
    ]) {
      fire('keydown', keydown)
      scroller.scrollTop = 2000
      fire('scroll', { target: scroller })
      expect(scroller.scrollTop).toBe(2000)
    }

    // A page key outside the composer scrolls the transcript on purpose.
    document.activeElement = new FakeElement(() => null) as unknown as Element
    fire('keydown', { key: 'PageDown' })
    scroller.scrollTop = 2100
    fire('scroll', { target: scroller })
    expect(scroller.scrollTop).toBe(2100)

    // Back in the composer: only this scroller is held, and only at its own position.
    document.activeElement = caretInComposer(scroller) as unknown as Element
    scroller.scrollTop = 1400
    fire('keydown', { key: 'PageUp' })
    fire('scroll', { target: new FakeElement(() => null) })
    expect(scroller.scrollTop).toBe(1400)
    scroller.scrollTop = 2300
    fire('scroll', { target: scroller })
    expect(scroller.scrollTop).toBe(1400)
  })

  it('stands down once the scroller has been quiet', () => {
    vi.useFakeTimers()
    const { document, fire } = documentDouble()
    vi.stubGlobal('document', document)
    vi.stubGlobal('Element', FakeElement)
    const scroller = new FakeElement(() => null)
    document.activeElement = caretInComposer(scroller) as unknown as Element
    installPageKeyScrollGuard()

    fire('keydown', { key: 'PageDown' })
    vi.advanceTimersByTime(250)
    scroller.scrollTop = 1900
    fire('scroll', { target: scroller })
    expect(scroller.scrollTop).toBe(1900)
  })

  it('stops pinning when one key press outlives its bound', () => {
    vi.useFakeTimers()
    const { document, fire } = documentDouble()
    vi.stubGlobal('document', document)
    vi.stubGlobal('Element', FakeElement)
    const scroller = new FakeElement(() => null)
    scroller.scrollTop = 1400
    document.activeElement = caretInComposer(scroller) as unknown as Element
    installPageKeyScrollGuard()

    fire('keydown', { key: 'PageUp' })
    for (let elapsed = 0; elapsed < 750; elapsed += 150) {
      vi.advanceTimersByTime(150)
      scroller.scrollTop = 2000
      fire('scroll', { target: scroller })
      expect(scroller.scrollTop).toBe(1400)
    }
    vi.advanceTimersByTime(150)
    scroller.scrollTop = 2000
    fire('scroll', { target: scroller })
    expect(scroller.scrollTop).toBe(2000)
  })

  it('clips the frame overflow instead of hiding it', () => {
    let css = ''
    const style = {
      dataset: {},
      get textContent() { return css },
      set textContent(value: string) { css = value },
      remove: vi.fn(),
    }
    vi.stubGlobal('document', {
      createElement: () => style,
      head: { appendChild: vi.fn() },
    })

    installDesktopOwnedStyles()
    expect(css).toMatch(/\.dshDesktopFrame \{[^}]*overflow: clip;/)
    expect(css).not.toMatch(/\.dshDesktopFrame \{[^}]*overflow: hidden;/)
  })

  it('installs nothing without a document', () => {
    // A runtime without a DOM has no document at all: the guard must not touch one.
    vi.stubGlobal('document', undefined)
    const dispose = installPageKeyScrollGuard()
    expect(dispose).toBeTypeOf('function')
    expect(() => { dispose() }).not.toThrow()
  })
})
