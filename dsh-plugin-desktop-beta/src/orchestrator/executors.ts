/**
 * Executor implementations for the orchestrator: local (L0), flash (L1), and
 * marvis (L2). Executors are deliberately dumb — they run one task card and
 * report, never re-level or escalate. The flash executor delegates to a fresh
 * `spawn` subagent so the child sees only its task card, never the caller's
 * history (the information-isolation rule).
 *
 * @module dsh-plugin-desktop-beta/orchestrator/executors
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { buildMarvisTaskCard } from '../marvis-protocol.ts'
import type { Executor, ExecutorError, ExecutorResult, Plan } from './types.ts'

/** Concatenate the text blocks of a model output. */
function textOf(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** Build a structured failure result with the elapsed duration. */
function failure(
  plan: Plan,
  startedAt: number,
  error: Omit<ExecutorError, 'taskId' | 'level'>,
  attempts: number,
): ExecutorResult {
  return {
    ok: false,
    error: { ...error, taskId: plan.taskId, level: plan.level },
    attempts,
    tokensUsed: 0,
    durationMs: Date.now() - startedAt,
  }
}

/** Build a success result carrying string data. */
function success(plan: Plan, startedAt: number, data: string, attempts: number): ExecutorResult {
  return {
    ok: true,
    data,
    attempts,
    tokensUsed: 0,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * L0 executor: deterministic, single-step, zero-token work. It recognizes a
 * small set of deterministic operations (JSON formatting) and refuses anything
 * that needs a model, so a mis-leveled task fails back to the Pro planner.
 */
export class LocalScriptExecutor implements Executor {
  readonly name = 'local' as const

  canHandle(level: Executor['name'] extends never ? never : Plan['level']): boolean {
    return level === 'L0'
  }

  async execute(plan: Plan, _signal: AbortSignal, _parent: Agent | undefined): Promise<ExecutorResult> {
    const startedAt = Date.now()
    const text = plan.taskCard.context.trim()

    // Deterministic JSON formatting: a well-formed JSON value is pretty-printed.
    const candidate = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text
    try {
      const parsed = JSON.parse(candidate) as unknown
      return success(plan, startedAt, JSON.stringify(parsed, null, 2), 1)
    } catch {
      return failure(
        plan,
        startedAt,
        {
          code: 'UNSUPPORTED_L0',
          message: 'The task was leveled L0 but is not a recognized deterministic operation.',
          attempted: ['json-format'],
        },
        1,
      )
    }
  }
}

/**
 * L1 executor: one-shot delegation to a fresh `spawn` subagent. The child
 * receives only the task card as its prompt and never inherits parent history.
 */
export class FlashExecutor implements Executor {
  readonly name = 'flash' as const

  constructor(private readonly ctx: Context) {}

  canHandle(level: Plan['level']): boolean {
    return level === 'L1'
  }

  async execute(plan: Plan, signal: AbortSignal, parent: Agent | undefined): Promise<ExecutorResult> {
    const startedAt = Date.now()
    if (parent === undefined) {
      return failure(
        plan,
        startedAt,
        { code: 'NO_PARENT', message: 'The flash executor needs a delegating agent.', attempted: [] },
        1,
      )
    }
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) {
      return failure(
        plan,
        startedAt,
        { code: 'NO_SUBAGENTS', message: 'No subagent service is mounted.', attempted: [] },
        1,
      )
    }

    const card = plan.taskCard
    const prompt: ContentBlock[] = [{
      type: 'text',
      text: `Task (${card.taskId}): ${card.goal}\n\nContext:\n${card.context}\n\n`
        + `Complete this task and return the result as ${card.outputFormat}.`,
    }]

    try {
      const run = await subagents.start('spawn', { label: card.taskId, prompt, parent, signal })
      try {
        const result = await run.result
        const text = textOf(result.output).trim()
        if (result.stopReason === 'completed' && text.length > 0) {
          return success(plan, startedAt, text, 1)
        }
        return failure(
          plan,
          startedAt,
          {
            code: `SUBAGENT_${result.stopReason.toUpperCase().replace(/-/g, '_')}`,
            message: result.diagnostic ?? `Subagent ended with stop reason "${result.stopReason}".`,
            attempted: ['subagent-spawn'],
          },
          1,
        )
      } finally {
        await run.dispose()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failure(
        plan,
        startedAt,
        { code: 'SUBAGENT_ERROR', message, attempted: ['subagent-spawn'] },
        1,
      )
    }
  }
}

/**
 * L2 executor: hands the task card to the Marvis bridge (human-in-the-loop
 * clipboard flow). It copies the card to the system clipboard and returns the
 * operator prompt; the operator pastes it into Marvis and the driving agent
 * later reads the result back through the `marvis_collect` tool.
 */
export class MarvisExecutor implements Executor {
  readonly name = 'marvis' as const

  constructor(private readonly ctx: Context) {}

  canHandle(level: Plan['level']): boolean {
    return level === 'L2'
  }

  async execute(plan: Plan, _signal: AbortSignal, _parent: Agent | undefined): Promise<ExecutorResult> {
    const startedAt = Date.now()
    const clipboard = this.ctx.get('desktopClipboard')
    if (clipboard === undefined) {
      return failure(
        plan,
        startedAt,
        { code: 'NO_CLIPBOARD', message: 'Clipboard unavailable in this environment.', attempted: [] },
        1,
      )
    }
    const card = buildMarvisTaskCard(plan)
    clipboard.writeText(card.clipboardText)
    return success(plan, startedAt, card.prompt, 1)
  }
}

/** Build the executor set for one orchestrator instance, in level order. */
export function createExecutors(ctx: Context): Executor[] {
  return [
    new LocalScriptExecutor(),
    new FlashExecutor(ctx),
    new MarvisExecutor(ctx),
  ]
}
