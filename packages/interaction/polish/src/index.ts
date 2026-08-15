/**
 * Draft polishing as a direct model call — no session is created, no log
 * entry is written, nothing is ever sent. The service resolves the target
 * session's provider/model selection and makes one streaming request through
 * `ctx.llm.prepareCall`, exactly as "asking the model directly" would: the
 * polished text comes back and the caller replaces the composer draft with it
 * for the user to review. The visible conversation is untouched by
 * construction.
 * @module @deepseek-ai/dsh-polish
 */

import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
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
  // The schemastery Config already enforces min(1); this guard covers direct
  // construction outside the Loader, which no shipped path exercises.
  /* v8 ignore next 4 -- schema-guarded defensive arm for direct construction */
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

/** Accumulate the reply's text blocks from the chunk stream (text deltas only; the block-end text duplicates them). */
function accumulatedText(chunks: AsyncIterable<StreamChunk>): Promise<string> {
  let text = ''
  return (async () => {
    for await (const chunk of chunks) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    return text.trim()
  })()
}

/**
 * The polish Remote service: rewrites a draft through ONE direct model call on
 * the target session's provider/model selection. Nothing is logged and no
 * session is created; cold targets cannot resolve a selection and are refused.
 */
export class PolishService extends TypertRemoteService {
  static inject = ['agents', 'llm']

  /** Loader validation for the input bound. */
  static Config: s<Config> = s.object({
    maxMessageChars: s.number().step(1).min(1).default(20000),
  })

  private readonly maxMessageChars: number

  /**
   * @param ctx - Host context carrying the agent registry and the LLM service.
   * @param config - Input bound policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'polish')
    this.maxMessageChars = resolveMaxMessageChars(config.maxMessageChars)
  }

  /**
   * Polish and expand one draft through a direct model call mirroring the
   * target session's provider/model selection. The visible session is never
   * touched; the caller replaces the composer draft with the returned text.
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
    const provider = target.options.provider
    const model = target.options.model
    if (provider === undefined || model === undefined) {
      return rejected({ code: 'polish-failed', message: 'target session has no provider/model selection' })
    }

    try {
      const prepared = await this.ctx.llm.prepareCall({ provider, model })
      const text = await accumulatedText(prepared.stream({
        ...prepared.config,
        messages: [createUserMessage({
          content: [{ type: 'text', text: polishPrompt(message) }],
          source: { kind: 'user' },
        })],
      }))
      if (text.length === 0) return rejected({ code: 'no-result' })
      return success(text)
    } catch (error: unknown) {
      return rejected({
        code: 'polish-failed',
        // Adapters throw Errors; the String fallback covers hostile non-Error throws.
        /* v8 ignore next 1 -- Error-only throw contract from the LLM service */
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

export default PolishService
