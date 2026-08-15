/**
 * In-place user-message editing over the session surface. The edit appends a
 * replacement `user/message` that carries the ORIGINAL message id and a
 * `replace` surface operation shadowing the target event: the surface fold
 * (and therefore every later model request) sees the new text, the UI folds
 * the replacement into the same message node, and the append-only log keeps
 * both texts. The replacement is a plain `{ kind: 'user' }` message with the
 * text the caller supplied. Live sessions are edited through their agent;
 * cold sessions are edited through session persistence, so a reopened
 * conversation is editable without resuming its agent.
 * @module @deepseek-ai/dsh-message-edit
 */

import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the sessionPersistence service's Context merge so the cold
// path's ctx.get resolves the typed service.
import type {} from '@deepseek-ai/dsh-session-persistence'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MessageEditFailure,
  MessageEditRequest,
  MessageEditResult,
} from './types.ts'

export type * from './types.ts'

/** Deployment-varying input bound. */
export interface Config {
  /** Maximum replacement text length in characters; longer edits are refused. */
  readonly maxMessageChars: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    messageEdit: MessageEditService
  }
}

/** Validate the one deployment-varying limit at the configuration boundary. */
function resolveMaxMessageChars(value: number): number {
  // The schemastery Config already enforces min(1); this guard covers direct
  // construction outside the Loader, which no shipped path exercises.
  /* v8 ignore next 4 -- schema-guarded defensive arm for direct construction */
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `message-edit: maxMessageChars must be a positive safe integer, got ${String(value)}`,
    )
  }
  return value
}

/** Build a frozen success branch. */
function success(seq: number): MessageEditResult {
  return Object.freeze({ ok: true, value: Object.freeze({ seq }) })
}

/** Build a frozen business-failure branch. */
function rejected(error: MessageEditFailure): MessageEditResult {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}

/** Build the replacement `user/message` event for a target message. */
function replacementEvent(target: SessionEvent<'user/message'>, text: string): UserMessage {
  return {
    id: target.data.id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** The current surface `user/message` carrying `messageId`, or undefined. */
function editableMessage(
  events: readonly SessionEvent[],
  surface: readonly number[],
  messageId: MessageId,
): SessionEvent<'user/message'> | undefined {
  for (let index = surface.length - 1; index >= 0; index -= 1) {
    const seq = surface[index]
    // The surface node list is a dense number array by construction.
    /* v8 ignore next 1 -- dense-array defense for a non-sparse fold product */
    if (seq === undefined) continue
    const event = events[seq]
    if (event === undefined || event.type !== 'user/message') continue
    if (event.data.id !== messageId) continue
    if (event.data.source.kind !== 'user') return undefined
    return event
  }
  return undefined
}

/**
 * The message-edit Remote service: rewrites one settled user message in place.
 * Live sessions are edited through their agent (the appended event broadcasts
 * to viewers); cold sessions are edited through session persistence, so an
 * edit never has to resume an agent just to rewrite text.
 */
export class MessageEditService extends TypertRemoteService {
  static inject = ['agents']

  /** Loader validation for the input bound. */
  static Config: s<Config> = s.object({
    maxMessageChars: s.number().step(1).min(1).default(20000),
  })

  private readonly maxMessageChars: number

  /**
   * @param ctx - Host context carrying the live agent registry.
   * @param config - Input bound policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageEdit')
    this.maxMessageChars = resolveMaxMessageChars(config.maxMessageChars)
  }

  /**
   * Rewrite one settled user message in place: append a replacement
   * `user/message` (same message id, plain user source) that shadows the
   * target on the model surface. The message is located by its stable id on
   * the CURRENT surface, so consecutive edits of the same message keep
   * working (each edit targets the previous replacement). A message
   * compacted away or injected as context is refused. The target session may
   * be live (edited through its agent) or cold (edited through persistence).
   * @param request - target session, target message id, and replacement text.
   * @returns the replacement event seq plus the event, or an explicit failure.
   */
  @Remote('messageEdit')
  async edit(request: MessageEditRequest): Promise<MessageEditResult> {
    const text = request.text.trim()
    if (text.length === 0) return rejected({ code: 'message-blank' })
    if (text.length > this.maxMessageChars) {
      return rejected({
        code: 'message-too-long',
        maxChars: this.maxMessageChars,
        actualChars: text.length,
      })
    }

    const agent = this.ctx.agents.get(request.sessionId)
    if (agent !== undefined) {
      const events = agent.session.events
      const surface = foldSurface(events)
      const target = editableMessage(events, surface.nodes, request.messageId)
      if (target === undefined) {
        return rejected({ code: 'message-not-found', messageId: request.messageId })
      }
      const event = agent.session.append('user/message', replacementEvent(target, text), {
        surfaceOp: { op: 'replace', start: target.seq, end: target.seq },
        sourceEventSeqs: [target.seq],
      })
      return success(event.seq)
    }

    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      return rejected({ code: 'session-not-found', sessionId: request.sessionId })
    }
    const stored = (await persistence.list()).find(header => header.id === request.sessionId)
    if (stored === undefined) {
      return rejected({ code: 'session-not-found', sessionId: request.sessionId })
    }
    const loaded = await persistence.load(request.sessionId)
    const surface = foldSurface(loaded.events)
    const target = editableMessage(loaded.events, surface.nodes, request.messageId)
    if (target === undefined) {
      return rejected({ code: 'message-not-found', messageId: request.messageId })
    }
    const event: SessionEvent<'user/message'> = {
      type: 'user/message',
      seq: loaded.events.length,
      time: Date.now(),
      data: replacementEvent(target, text),
      surfaceOp: { op: 'replace', start: target.seq, end: target.seq },
      sourceEventSeqs: [target.seq],
    }
    await persistence.append(request.sessionId, [event])
    return success(event.seq)
  }
}

export default MessageEditService
