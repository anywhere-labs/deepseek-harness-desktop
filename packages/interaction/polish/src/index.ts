/**
 * Draft polishing in an isolated throwaway session. The polish request is
 * delivered to a fresh agent created for exactly one turn — same
 * provider/model/credential resolution as the target session, but the target
 * session's log is never touched, so the user's visible conversation stays
 * clean and the draft never becomes a real message. The reply text is returned
 * to the caller, which replaces the composer draft with it for review.
 * @module @deepseek-ai/dsh-polish
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  PolishFailure,
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

/** The first non-empty assistant text in the log, or undefined. */
function firstAssistantText(events: readonly SessionEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const text = event.data.message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    if (text.length > 0) return text
  }
  return undefined
}

/**
 * The polish Remote service: rewrites a draft through a throwaway agent that
 * mirrors the target session's provider/model selection. Requires a live
 * target agent — cold sessions are not resumed for a polish turn.
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
   * Polish and expand one draft in an isolated session. The target session's
   * log is never appended to: the request goes to a fresh agent that inherits
   * the target's provider/model, and that agent is disposed when the reply
   * lands. The caller replaces the composer draft with the returned text.
   * @param request - target session and the verbatim draft.
   * @returns the polished text or an explicit business failure.
   */
  @Remote('polish')
  async polish(request: PolishRequest): Promise<PolishResult> {
    const target = this.ctx.agents.get(request.sessionId)
    if (target === undefined) {
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

    let handle: Awaited<ReturnType<typeof this.ctx.agents.create>> | undefined
    try {
      handle = await this.ctx.agents.create({
        sessionId: SessionId(randomUUID()),
        agentOptions: {
          ...target.options.provider === undefined ? {} : { provider: target.options.provider },
          ...target.options.model === undefined ? {} : { model: target.options.model },
        },
        ...target.session.header.cwd === undefined ? {} : { meta: { cwd: target.session.header.cwd } },
      })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: polishPrompt(message) }],
        source: { kind: 'plugin', plugin: 'dsh-polish' },
      }))
      await handle.agent.whenIdle()

      const text = firstAssistantText(handle.agent.session.events)
      if (text === undefined) return rejected({ code: 'no-result' })
      return success(text)
    } catch (error: unknown) {
      return rejected({
        code: 'polish-session-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      // The throwaway session never persists and never appears in the UI.
      if (handle !== undefined) await handle.dispose()
    }
  }
}

export default PolishService
