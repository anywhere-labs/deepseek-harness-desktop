/**
 * Keep the page keys inside the composer that owns the caret.
 *
 * The composer sits at the end of the conversation scroller, so the part of a
 * page key the composer cannot consume chains onto the transcript: one
 * keystroke both pages the caret and drags the conversation, which contradicts
 * the rule that focus decides which surface is scrolled.
 *
 * The key is never prevented, so natural caret paging (including the smooth
 * animation Blink gives it) still runs; only the scroll position that leaked
 * onto the transcript is restored. The `[data-composer-seat]` boundary is the
 * one upstream already uses to keep composer keys out of the transcript's
 * reading intents, so a page key pressed outside the composer still scrolls the
 * transcript.
 */

/** Quiet time after the last restored frame before the guard stands down. */
const SETTLE_MS = 200
/** Upper bound for one key press, so a long animation cannot pin the transcript. */
const MAX_HOLD_MS = 800
/** Upstream seat that marks a key as composer-owned. */
const COMPOSER_SEAT_SELECTOR = '[data-composer-seat]'
/** Upstream conversation scroller a composer page key must not move. */
const CONVERSATION_SCROLL_SELECTOR = '[data-conversation-scroll]'

/** One armed restore: the scroller to pin and the position to keep. */
interface HeldScroll {
  readonly element: Element
  readonly top: number
}

/**
 * Restore the transcript scroll a page key chains onto from the composer.
 *
 * A restore has to be repeated, because Blink animates the chained scroll over
 * several frames: the scroller stays held until it has been quiet for
 * `SETTLE_MS`, and for at most `MAX_HOLD_MS` after one key press.
 * @returns disposer releasing the hold and removing the listeners.
 */
export function installPageKeyScrollGuard(): () => void {
  if (typeof document === 'undefined') return () => {}

  let held: HeldScroll | null = null
  let settle: ReturnType<typeof setTimeout> | undefined
  let deadline = 0

  const release = (): void => {
    held = null
    clearTimeout(settle)
    settle = undefined
  }

  const hold = (element: Element, top: number, until: number): void => {
    held = { element, top }
    deadline = until
    clearTimeout(settle)
    settle = setTimeout(release, SETTLE_MS)
  }

  const onScroll = (event: Event): void => {
    const current = held
    if (current === null || event.target !== current.element) return
    if (Date.now() > deadline) {
      release()
      return
    }
    if (current.element.scrollTop !== current.top) current.element.scrollTop = current.top
    hold(current.element, current.top, deadline)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'PageUp' && event.key !== 'PageDown') return
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const focused = document.activeElement
    if (!(focused instanceof Element)) return
    const seat = focused.closest(COMPOSER_SEAT_SELECTOR)
    if (seat === null) return
    const scroller = seat.closest(CONVERSATION_SCROLL_SELECTOR)
    if (scroller === null) return
    hold(scroller, scroller.scrollTop, Date.now() + MAX_HOLD_MS)
  }

  /** A real scroll gesture outranks the guard, so a wheel turn or a press releases it. */
  const onGesture = (): void => { release() }

  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('scroll', onScroll, true)
  document.addEventListener('wheel', onGesture, true)
  document.addEventListener('pointerdown', onGesture, true)
  return () => {
    release()
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('scroll', onScroll, true)
    document.removeEventListener('wheel', onGesture, true)
    document.removeEventListener('pointerdown', onGesture, true)
  }
}
