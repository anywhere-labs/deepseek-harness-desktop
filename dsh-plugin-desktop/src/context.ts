/**
 * Layered context compression and durable long-term memory for DSH Desktop.
 *
 * Upstream `compaction-basic` already folds long spans of the session surface
 * into L1 segment-summary checkpoints (`<compacted-summary>` user messages).
 * This plugin adds the two layers above it, so the context pyramid becomes
 * L0 original -> L1 segment summary -> L2 session summary -> L3 long-term
 * memory, with each layer a condensation of the one below:
 *
 * - L2 (session summary): when one session accumulates `foldEvery` L1
 *   checkpoints, this plugin condenses them into a single session-level
 *   summary through one `ctx.llm.stream()` call.
 * - L3 (long-term memory): that session summary is stored durably in the
 *   `desktop_memory` KV domain (per-record, on the shipped json backend), so
 *   it survives the session and can be recalled on resume.
 *
 * The short-term/long-term boundary is the recall step: L0–L2 live in the live
 * context, while L3 lives on disk and re-enters context as a `user/message`
 * (source kind `desktop-memory`) at the first step of a turn — once per memory
 * version — when `recall` is enabled.
 *
 * @module dsh-plugin-desktop-beta/context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: activates the `compaction/summary` SessionEventMap augmentation so
// the `session/event` listener below can match it.
import type {} from '@deepseek-ai/dsh-compaction'

/** Durable source for a long-term memory message injected at turn start. */
interface DesktopMemorySource {
  kind: 'desktop-memory'
  form: 'recall'
  version: 1
  sessionId: string
  foldedSummaries: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'desktop-memory': DesktopMemorySource
  }
}

const memoryRecord = zod.object({
  /** Condensation level; `session` is the folded L2 summary stored as L3 memory. */
  level: zod.enum(['session', 'longterm']),
  /** The folded summary text. */
  content: zod.string(),
  /** How many L1 checkpoints were folded into this record. */
  foldedSummaries: zod.number().int().nonnegative(),
  /** Creation time in Unix epoch milliseconds. */
  createdAt: zod.number().int().nonnegative(),
})

const memorySpec = defineDomain({
  name: 'desktop_memory',
  version: 1,
  // One document per session: a write rewrites only that session's record, and
  // a corrupt record can be moved aside without discarding the whole unit.
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    memories: domainTable(memoryRecord),
  },
})

/** Stable Cordis plugin name. */
export const name = 'desktop-context'

/** Durable KV domain facility required to open the long-term memory store. */
export const inject = ['storageDomain']

/** Layered-compression and recall policy. */
export interface Config {
  /** Number of L1 checkpoints to fold into one durable L2 session summary. */
  foldEvery: number
  /** Token cap for the L2 summarization call. */
  maxTokens: number
  /** Provider for the L2 call; empty inherits the L1 checkpoint's route. */
  l2Provider: string
  /** Model for the L2 call; empty inherits the L1 checkpoint's route. */
  l2Model: string
  /** Inject the durable session summary at the first step of a turn. */
  recall: boolean
}

/** Validated layered-compression and recall policy. */
export const Config: z<Config> = z.object({
  foldEvery: z.number().step(1).min(1).max(64).default(4),
  maxTokens: z.number().step(1).min(128).max(16_384).default(1024),
  l2Provider: z.string().default(''),
  l2Model: z.string().default(''),
  recall: z.boolean().default(true),
})

/** Frames the recalled memory as established context for the model. */
const RECALL_PREAMBLE =
  'This is your durable long-term memory for this session, saved from earlier conversation. Treat it as established context and build on it without restating it.'

/** Instruction appended after the accumulated L1 checkpoints for the L2 fold. */
const FOLD_INSTRUCTION = [
  'Condense the conversation checkpoints below into a single session-level summary.',
  'Merge all checkpoints: preserve still-relevant facts and decisions, and drop anything a later checkpoint supersedes.',
  '',
  'Output a concise Markdown summary covering: the primary goal, key decisions and constraints, the current state, and the next step.',
  'Do not mention that the context was compacted or that this is a summarization request.',
].join('\n')

/** Concatenate the text blocks of a model output. */
function textOf(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/**
 * Register the durable memory store, the L1->L2 fold observer, and the recall
 * injection at turn start.
 * @param ctx - Host context carrying the storage domain facility.
 * @param config - validated fold and recall values.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const domain = await ctx.storageDomain.open(memorySpec)
  ctx.effect(
    () => () => { void domain.close() },
    'dsh-plugin-desktop: desktop-context memory domain',
  )
  const memories = domain.table('memories')

  // L1 checkpoints accumulated but not yet folded, per session id.
  const pending = new Map<string, string[]>()
  // Last folded-memory `createdAt` injected per session; prevents re-injecting
  // an unchanged memory on every turn while still recalling a new version.
  const injectedAt = new Map<string, number>()

  /** Fold accumulated L1 checkpoints into one durable session summary. */
  async function foldToMemory(session: Session, provider: string, model: string, summaries: string[]): Promise<void> {
    const llm = ctx.get('llm')
    if (llm === undefined) {
      ctx.logger.warn('desktop-context: no llm service mounted; skipping session-summary fold')
      return
    }
    const targetProvider = config.l2Provider.length > 0 ? config.l2Provider : provider
    const targetModel = config.l2Model.length > 0 ? config.l2Model : model
    if (targetProvider.length === 0 || targetModel.length === 0) {
      ctx.logger.warn('desktop-context: no provider/model for the session-summary fold; skipping')
      return
    }
    const checkpoints = summaries
      .map((summary, index) => `### Checkpoint ${index + 1}\n${summary}`)
      .join('\n\n')
    const messages: RequestMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: `${FOLD_INSTRUCTION}\n\n${checkpoints}` }],
    }]
    const options: GenerateOptions = {
      provider: targetProvider,
      model: targetModel,
      messages,
      maxTokens: config.maxTokens,
      sessionId: session.id,
      purpose: 'compaction',
    }
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of llm.stream(options)) assembler.push(chunk)
      if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
        ctx.logger.warn(`desktop-context: session-summary fold failed: ${assembler.finish.failure.message}`)
        return
      }
      const content = textOf(assembler.blocks()).trim()
      if (content.length === 0) {
        ctx.logger.warn('desktop-context: session-summary fold produced no text; skipping')
        return
      }
      await memories.put(String(session.id), {
        level: 'session',
        content,
        foldedSummaries: summaries.length,
        createdAt: Date.now(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`desktop-context: session-summary fold failed: ${message}`)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/summary') return
    const summary = textOf(event.data.summary).trim()
    if (summary.length === 0) return
    const sessionId = String(session.id)
    const batch = pending.get(sessionId) ?? []
    batch.push(summary)
    if (batch.length < config.foldEvery) {
      pending.set(sessionId, batch)
      return
    }
    pending.delete(sessionId)
    void foldToMemory(session, event.data.provider, event.data.model, batch)
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (!config.recall || decision.kind === 'reject' || signal.aborted) return decision
    const sessionId = String(agent.session.id)
    const record = memories.get(sessionId)
    if (record === undefined) return decision
    if (injectedAt.get(sessionId) === record.createdAt) return decision
    injectedAt.set(sessionId, record.createdAt)
    const source: DesktopMemorySource = {
      kind: 'desktop-memory',
      form: 'recall',
      version: 1,
      sessionId,
      foldedSummaries: record.foldedSummaries,
    }
    const recall: UserMessage = createUserMessage({
      source,
      content: [{ type: 'text', text: `${RECALL_PREAMBLE}\n\n${record.content}` }],
    })
    return { ...decision, messages: [recall, ...decision.messages] }
  }, { prepend: true })
}
