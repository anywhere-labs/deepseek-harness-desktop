/**
 * Draft polishing over the session's own agent channel. The polish request is
 * delivered as a plugin-sourced `user/message` and the model reply lands as an
 * ordinary `assistant/message`, so the operation is fully reconstructable from
 * the session log (model-visible means logged) and uses the session's current
 * provider/model/credential resolution exactly like a normal turn. The result
 * is the first non-empty assistant message appended after the request; the
 * caller replaces the composer draft with it for the user to review.
 * @module @deepseek-ai/dsh-polish
 */

import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  PolishFailure,
  PolishModelRequest,
  PolishModelResult,
  PolishRequest,
  PolishResult,
} from './types.ts'

export type * from './types.ts'

/** Deployment-varying input bound. */
export interface Config {
  /** Maximum input draft length in characters; longer drafts are refused. */
  readonly maxMessageChars: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    polish: PolishService
  }
}

/** Validate the one deployment-varying limit at the configuration boundary. */
function resolveMaxMessageChars(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `polish: maxMessageChars must be a positive safe integer, got ${String(value)}`,
    )
  }
  return value
}

/** Build a frozen success branch. */
function success(text: string): PolishResult {
  return Object.freeze({ ok: true, value: Object.freeze({ text }) })
}

/** Build a frozen business-failure branch. */
function rejected(error: PolishFailure): PolishResult {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}

/** The polish instruction; the model must answer with the text only. */
function polishPrompt(message: string): string {
  return [
    '请润色并扩展下面的用户消息。要求：',
    '1. 完全保持原意，不要改变事实或立场；',
    '2. 使表达更清晰、更有条理、更完整，适当补充必要的背景与细节；',
    '3. 使用与原文相同的语言；',
    '4. 只输出润色后的完整文本，不要添加任何解释、前缀、引号或标题，不要调用任何工具。',
    '',
    '原文：',
    message,
  ].join('\n')
}

/** The latest logged request-header model, or undefined before any request. */
function latestModel(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'request/header') return event.data.header.config.model
  }
  return undefined
}

/**
 * The polish Remote service: rewrites a draft through the session's own agent.
 * Requires a live agent — cold sessions are not resumed for a polish turn.
 */
export class PolishService extends TypertRemoteService {
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
    super(ctx, 'polish')
    this.maxMessageChars = resolveMaxMessageChars(config.maxMessageChars)
  }

  /**
   * Polish and expand one draft through the session's own agent channel. The
   * request is logged as a plugin-sourced user message and the first non-empty
   * assistant reply after it is the result; the caller replaces the composer
   * draft with the returned text.
   * @param request - target session and the verbatim draft.
   * @returns the polished text or an explicit business failure.
   */
  @Remote('polish')
  async polish(request: PolishRequest): Promise<PolishResult> {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      return rejected({ code: 'session-not-found', sessionId: request.sessionId })
    }
    const message = request.message.trim()
    if (message.length === 0) return rejected({ code: 'message-blank' })
    if (message.length > this.maxMessageChars) {
      return rejected({
        code: 'message-too-long',
        maxChars: this.maxMessageChars,
        actualChars: message.length,
      })
    }

    // The baseline is the log length BEFORE the followup: the polish turn is
    // the first work appended after it. A concurrent human turn admitted while
    // the polish turn runs appends after the polish reply, so the first
    // non-empty assistant message past the baseline stays the polish result.
    const baseline = agent.session.events.length
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: polishPrompt(message) }],
      source: { kind: 'plugin', plugin: 'dsh-polish' },
    }))
    await agent.whenIdle()

    for (const event of agent.session.events.slice(baseline)) {
      if (event.type !== 'assistant/message') continue
      const text = event.data.message.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim()
      if (text.length > 0) return success(text)
    }
    return rejected({ code: 'no-result' })
  }

  /**
   * Read the display label of one session's current model, for the caller's
   * button caption. Resolves from the latest logged request header, falling
   * back to the agent options.
   * @param request - target session.
   * @returns the model label; empty when nothing is resolvable.
   */
  @Remote('model')
  model(request: PolishModelRequest): PolishModelResult {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) return { label: '' }
    return { label: latestModel(agent.session.events) ?? agent.options.model ?? '' }
  }
}

export default PolishService
