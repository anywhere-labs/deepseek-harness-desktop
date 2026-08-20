import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { installPromptHistory, PromptHistory } from '../src/client/prompt-history.ts'

class FakeDocumentRoot {
  private readonly listeners = new Map<string, EventListenerOrEventListenerObject[]>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(candidate => candidate !== listener))
  }

  dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event)
      else listener.handleEvent(event)
    }
  }
}

class FakeTextarea extends EventTarget {
  value: string
  disabled = false
  readOnly = false
  selectionStart = 0
  selectionEnd = 0
  readonly ownerDocument = {
    defaultView: {
      requestAnimationFrame: (callback: FrameRequestCallback): number => {
        callback(0)
        return 0
      },
    },
  } as unknown as Document

  constructor(value = '') {
    super()
    this.value = value
    this.selectionStart = value.length
    this.selectionEnd = value.length
  }

  closest(selector: string): Element | null {
    return selector === '[data-composer-card]' ? {} as Element : null
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }
}

class FakeKeyboardEvent {
  defaultPrevented: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly isComposing: boolean
  readonly keyCode: number

  constructor(
    readonly target: EventTarget,
    readonly key: string,
    options: {
      defaultPrevented?: boolean
      altKey?: boolean
      ctrlKey?: boolean
      metaKey?: boolean
      shiftKey?: boolean
      isComposing?: boolean
      keyCode?: number
    } = {},
  ) {
    this.defaultPrevented = options.defaultPrevented ?? false
    this.altKey = options.altKey ?? false
    this.ctrlKey = options.ctrlKey ?? false
    this.metaKey = options.metaKey ?? false
    this.shiftKey = options.shiftKey ?? false
    this.isComposing = options.isComposing ?? false
    this.keyCode = options.keyCode ?? 0
  }

  preventDefault(): void {
    this.defaultPrevented = true
  }
}

function contextFor(nodes: () => readonly unknown[], writes: string[]): ClientContext {
  const scope = {}
  return {
    get(name: string): unknown {
      if (name === 'sessions') {
        return {
          list: { getSnapshot: () => ({ current: 'session-1' }) },
          scope: () => scope,
          binding: () => ({ session: { getSnapshot: () => ({ nodes: nodes() }) } }),
        }
      }
      if (name === 'conversation') {
        return { input: { for: () => ({ setDraft: (draft: string) => { writes.push(draft) } }) } }
      }
      return undefined
    },
  } as unknown as ClientContext
}

function userNode(text: string): unknown {
  return { kind: 'user', content: [{ type: 'text', text }] }
}

const textareaDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLTextAreaElement')

beforeEach(() => {
  Object.defineProperty(globalThis, 'HTMLTextAreaElement', { configurable: true, value: FakeTextarea })
})

afterEach(() => {
  if (textareaDescriptor === undefined) {
    delete (globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement
    return
  }
  Object.defineProperty(globalThis, 'HTMLTextAreaElement', textareaDescriptor)
})

describe('desktop prompt history', () => {
  it('walks backward and forward while restoring the draft that preceded navigation', () => {
    const history = new PromptHistory()
    history.sync('session-1', ['first prompt', '/status'])

    expect(history.previous('session-1', 'unfinished draft')).toBe('/status')
    expect(history.previous('session-1', '/status')).toBe('first prompt')
    expect(history.previous('session-1', 'first prompt')).toBe('first prompt')
    expect(history.next('session-1')).toBe('/status')
    expect(history.next('session-1')).toBe('unfinished draft')
    expect(history.next('session-1')).toBeUndefined()
  })

  it('refreshes the recall view from durable nodes and ignores blank duplicate entries', () => {
    const history = new PromptHistory()
    history.sync('session-1', ['earlier prompt', '   ', 'earlier prompt', '/status'])

    expect(history.previous('session-1', '')).toBe('/status')
    expect(history.previous('session-1', '/status')).toBe('earlier prompt')

    history.reset('session-1')
    history.sync('session-1', ['earlier prompt', '/status', 'accepted prompt'])
    expect(history.previous('session-1', '')).toBe('accepted prompt')
  })

  it('keeps histories isolated by session and leaves navigation after edits', () => {
    const history = new PromptHistory()
    history.sync('session-1', ['one'])
    history.sync('session-2', ['two'])

    expect(history.previous('session-1', '')).toBe('one')
    expect(history.previous('session-2', '')).toBe('two')
    history.reset('session-1')
    expect(history.isNavigating('session-1')).toBe(false)
    expect(history.next('session-1')).toBeUndefined()
  })

  it('waits for an accepted conversation node before recalling a submitted draft', () => {
    let nodes: readonly unknown[] = []
    const writes: string[] = []
    const root = new FakeDocumentRoot()
    const dispose = installPromptHistory(contextFor(() => nodes, writes), root as unknown as Document)
    const textarea = new FakeTextarea('rejected draft')
    textarea.selectionStart = 0
    textarea.selectionEnd = 0

    root.dispatch('keydown', new FakeKeyboardEvent(textarea, 'Enter') as unknown as Event)
    const rejected = new FakeKeyboardEvent(textarea, 'ArrowUp')
    root.dispatch('keydown', rejected as unknown as Event)
    expect(rejected.defaultPrevented).toBe(false)
    expect(writes).toEqual([])

    nodes = [userNode('accepted prompt')]
    const accepted = new FakeKeyboardEvent(textarea, 'ArrowUp')
    root.dispatch('keydown', accepted as unknown as Event)
    expect(accepted.defaultPrevented).toBe(true)
    expect(writes).toEqual(['accepted prompt'])
    expect(textarea.selectionStart).toBe('accepted prompt'.length)
    expect(textarea.selectionEnd).toBe('accepted prompt'.length)
    dispose()
  })

  it('leaves composer-owned candidate-menu arrows and IME composition untouched', () => {
    const writes: string[] = []
    const root = new FakeDocumentRoot()
    const dispose = installPromptHistory(contextFor(() => [userNode('saved prompt')], writes), root as unknown as Document)
    const textarea = new FakeTextarea()

    const candidate = new FakeKeyboardEvent(textarea, 'ArrowUp', { defaultPrevented: true })
    root.dispatch('keydown', candidate as unknown as Event)
    const composing = new FakeKeyboardEvent(textarea, 'ArrowUp', { isComposing: true })
    root.dispatch('keydown', composing as unknown as Event)

    expect(candidate.defaultPrevented).toBe(true)
    expect(composing.defaultPrevented).toBe(false)
    expect(writes).toEqual([])
    dispose()
  })

  it('removes its document listeners when the client effect disposes', () => {
    const writes: string[] = []
    const root = new FakeDocumentRoot()
    const dispose = installPromptHistory(contextFor(() => [userNode('saved prompt')], writes), root as unknown as Document)
    const textarea = new FakeTextarea()
    dispose()

    root.dispatch('keydown', new FakeKeyboardEvent(textarea, 'ArrowUp') as unknown as Event)
    expect(writes).toEqual([])
  })
})
