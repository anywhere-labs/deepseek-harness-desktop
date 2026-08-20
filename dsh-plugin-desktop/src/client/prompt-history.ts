import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

interface ConversationInput {
  readonly input: {
    for(context: unknown): {
      setDraft(text: string): void
    }
  }
}

interface ConversationHistoryNode {
  readonly kind?: unknown
  readonly content?: unknown
  readonly name?: unknown
  readonly args?: unknown
}

interface SessionsInputHistory {
  readonly list: {
    getSnapshot(): { current: string | undefined }
  }
  scope(sessionId: string): unknown
  binding(sessionId: string): {
    readonly session: {
      getSnapshot(): { nodes: readonly ConversationHistoryNode[] }
    }
  } | undefined
}

interface NavigationState {
  index: number
  readonly draft: string
}

/** In-memory submitted-input history isolated by session. */
export class PromptHistory {
  private readonly entries = new Map<string, string[]>()
  private readonly navigation = new Map<string, NavigationState>()
  private readonly hydrated = new Set<string>()

  /** Seed one session from its already-loaded durable conversation nodes. */
  hydrate(sessionId: string, drafts: readonly string[]): void {
    if (this.hydrated.has(sessionId)) return
    for (const draft of drafts) this.recordEntry(sessionId, draft)
    this.hydrated.add(sessionId)
  }

  /** Record a non-empty submitted draft and leave history navigation. */
  record(sessionId: string, draft: string): void {
    this.recordEntry(sessionId, draft)
    this.navigation.delete(sessionId)
  }

  /** Move backward through a session's submitted inputs, starting from the current draft. */
  previous(sessionId: string, draft: string): string | undefined {
    const history = this.entries.get(sessionId)
    if (history === undefined || history.length === 0) return undefined
    const current = this.navigation.get(sessionId)
    if (current === undefined) {
      const index = history.length - 1
      this.navigation.set(sessionId, { index, draft })
      return history[index]
    }
    if (current.index === 0) return history[0]
    current.index -= 1
    return history[current.index]
  }

  /** Move forward through a session's submitted inputs, restoring the original draft after the newest entry. */
  next(sessionId: string): string | undefined {
    const current = this.navigation.get(sessionId)
    if (current === undefined) return undefined
    const history = this.entries.get(sessionId)
    if (history === undefined || current.index >= history.length - 1) {
      this.navigation.delete(sessionId)
      return current.draft
    }
    current.index += 1
    return history[current.index]
  }

  /** Leave history navigation after an ordinary input edit. */
  reset(sessionId: string): void {
    this.navigation.delete(sessionId)
  }

  /** Whether a session is currently moving through submitted input history. */
  isNavigating(sessionId: string): boolean {
    return this.navigation.has(sessionId)
  }

  private recordEntry(sessionId: string, draft: string): void {
    if (draft.trim() === '') return
    const history = this.entries.get(sessionId) ?? []
    if (history.at(-1) !== draft) history.push(draft)
    this.entries.set(sessionId, history)
  }
}

function composerTextarea(target: EventTarget | null): HTMLTextAreaElement | undefined {
  if (!(target instanceof HTMLTextAreaElement)) return undefined
  return target.closest('[data-composer-card]') === null ? undefined : target
}

function sessions(ctx: ClientContext): SessionsInputHistory | undefined {
  return ctx.get('sessions') as SessionsInputHistory | undefined
}

function currentSessionId(ctx: ClientContext): string | undefined {
  return sessions(ctx)?.list.getSnapshot().current
}

function textFromNode(node: ConversationHistoryNode): string | undefined {
  if (node.kind === 'command' && typeof node.name === 'string') {
    return `/${node.name}${typeof node.args === 'string' ? node.args : ''}`
  }
  if (node.kind !== 'user' && node.kind !== 'steering') return undefined
  if (!Array.isArray(node.content)) return undefined
  const text = node.content.flatMap((block: unknown) => {
    if (typeof block !== 'object' || block === null) return []
    const candidate = block as { type?: unknown; text?: unknown }
    return candidate.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : []
  }).join('')
  return text === '' ? undefined : text
}

function hydrateHistory(ctx: ClientContext, history: PromptHistory, sessionId: string): void {
  const binding = sessions(ctx)?.binding(sessionId)
  if (binding === undefined) return
  const drafts = binding.session.getSnapshot().nodes.flatMap(node => {
    const text = textFromNode(node)
    return text === undefined ? [] : [text]
  })
  history.hydrate(sessionId, drafts)
}

function hasOpenCandidateMenu(textarea: HTMLTextAreaElement): boolean {
  const card = textarea.closest('[data-composer-card]')
  return card !== null && card.querySelector('[role="listbox"]') !== null
}

function restoreDraft(ctx: ClientContext, sessionId: string, textarea: HTMLTextAreaElement, draft: string): void {
  const scope = sessions(ctx)?.scope(sessionId)
  const conversation = ctx.get('conversation') as ConversationInput | undefined
  if (scope === undefined || conversation === undefined) return
  conversation.input.for(scope).setDraft(draft)
  textarea.ownerDocument.defaultView?.requestAnimationFrame(() => {
    textarea.setSelectionRange(draft.length, draft.length)
  })
}

function isUnmodifiedArrow(event: KeyboardEvent): event is KeyboardEvent & { key: 'ArrowUp' | 'ArrowDown' } {
  return (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
}

function isHistoryEntryPoint(textarea: HTMLTextAreaElement, key: 'ArrowUp' | 'ArrowDown'): boolean {
  if (textarea.selectionStart !== textarea.selectionEnd) return false
  return key === 'ArrowUp'
    ? textarea.selectionStart === 0
    : textarea.selectionEnd === textarea.value.length
}

function isHistorySubmission(event: KeyboardEvent, textarea: HTMLTextAreaElement): boolean {
  return event.key === 'Enter'
    && !event.repeat
    && !event.shiftKey
    && !event.isComposing
    // keyCode 229 is the legacy IME signal used by the upstream composer.
    // oxlint-disable-next-line typescript/no-deprecated
    && event.keyCode !== 229
    && !textarea.disabled
    && !textarea.readOnly
    && !hasOpenCandidateMenu(textarea)
}

/** Install desktop-only submitted-input navigation for the standard DSH composer. */
export function installPromptHistory(ctx: ClientContext, documentRoot: Document = document): () => void {
  const history = new PromptHistory()

  const onInput = (event: Event): void => {
    const textarea = composerTextarea(event.target)
    const sessionId = currentSessionId(ctx)
    if (textarea !== undefined && sessionId !== undefined) history.reset(sessionId)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    const textarea = composerTextarea(event.target)
    const sessionId = currentSessionId(ctx)
    if (textarea === undefined || sessionId === undefined) return
    if (isHistorySubmission(event, textarea)) {
      hydrateHistory(ctx, history, sessionId)
      history.record(sessionId, textarea.value)
      return
    }
    if (!isUnmodifiedArrow(event) || textarea.disabled || textarea.readOnly || hasOpenCandidateMenu(textarea)) return
    if (!history.isNavigating(sessionId) && !isHistoryEntryPoint(textarea, event.key)) return
    hydrateHistory(ctx, history, sessionId)
    const draft = event.key === 'ArrowUp'
      ? history.previous(sessionId, textarea.value)
      : history.next(sessionId)
    if (draft === undefined) return
    event.preventDefault()
    restoreDraft(ctx, sessionId, textarea, draft)
  }
  const onClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target.closest('button') : null
    if (target === null) return
    const card = target.closest('[data-composer-card]')
    if (card === null) return
    const textarea = card.querySelector<HTMLTextAreaElement>('textarea')
    if (textarea === null || textarea.disabled || textarea.readOnly || textarea.value.trim() === '') return
    const buttons = card.querySelectorAll('button:not(:disabled)')
    if (buttons[buttons.length - 1] !== target) return
    const submitted = textarea.value
    queueMicrotask(() => {
      if (textarea.value !== '') return
      const sessionId = currentSessionId(ctx)
      if (sessionId !== undefined) {
        hydrateHistory(ctx, history, sessionId)
        history.record(sessionId, submitted)
      }
    })
  }

  documentRoot.addEventListener('input', onInput)
  documentRoot.addEventListener('keydown', onKeyDown, true)
  documentRoot.addEventListener('click', onClick)
  return () => {
    documentRoot.removeEventListener('input', onInput)
    documentRoot.removeEventListener('keydown', onKeyDown, true)
    documentRoot.removeEventListener('click', onClick)
  }
}
