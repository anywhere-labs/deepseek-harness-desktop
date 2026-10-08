/**
 * Executor implementations for the orchestrator: local (L0), flash (L1),
 * marvis (L2), the pro router (L3 long path), and human (L4). Executors are
 * deliberately dumb — they run one task card and report, never re-level or
 * escalate. The flash executor delegates to a fresh `spawn` subagent so the
 * child sees only its task card, never the caller's history (the
 * information-isolation rule). The L3 router recurses over the Pro planner's
 * sub-goals; the L4 executor hands off to a human instead of acting.
 *
 * @module dsh-plugin-desktop-beta/orchestrator/executors
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { buildMarvisTaskCard } from '../marvis-protocol.ts'
import type { ExecuteContext, Executor, ExecutorError, ExecutorResult, Plan } from './types.ts'

/** Recursive dispatch used by the L3 router to run sub-goals. */
export type Dispatch = (task: string, depth: number) => Promise<ExecutorResult>

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
    taskId: plan.taskId,
    level: plan.level,
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
    taskId: plan.taskId,
    level: plan.level,
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

  canHandle(level: Plan['level']): boolean {
    return level === 'L0'
  }

  async execute(plan: Plan, _context: ExecuteContext): Promise<ExecutorResult> {
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

  async execute(plan: Plan, context: ExecuteContext): Promise<ExecutorResult> {
    const startedAt = Date.now()
    const parent = context.parent
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
      const run = await subagents.start('spawn', { label: card.taskId, prompt, parent, signal: context.signal })
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

  async execute(plan: Plan, _context: ExecuteContext): Promise<ExecutorResult> {
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

/**
 * L3 executor: the Pro -> Router long path. It recurses over the Pro planner's
 * sub-goals, dispatching each one back through the classifier/executor chain,
 * then joins the sub-goal outputs. Depth growth is the caller's responsibility
 * (the router caps it); this executor only fans out and collects.
 */
export class ProRouterExecutor implements Executor {
  readonly name = 'pro_router' as const

  constructor(private readonly dispatch: Dispatch) {}

  canHandle(level: Plan['level']): boolean {
    return level === 'L3'
  }

  async execute(plan: Plan, context: ExecuteContext): Promise<ExecutorResult> {
    const startedAt = Date.now()
    const subGoals = plan.subGoals
    if (subGoals.length === 0) {
      return failure(
        plan,
        startedAt,
        { code: 'NO_SUBGOALS', message: 'The task was leveled L3 but produced no sub-goals.', attempted: [] },
        1,
      )
    }

    const results: ExecutorResult[] = []
    let tokensUsed = 0
    for (const subGoal of subGoals) {
      const result = await this.dispatch(subGoal, context.depth + 1)
      results.push(result)
      tokensUsed += result.tokensUsed
    }

    const firstFailure = results.find(result => !result.ok)
    if (firstFailure === undefined) {
      const joined = results
        .map((result, index) => `[${index + 1}] ${String(result.data ?? '')}`)
        .join('\n\n')
      return {
        ok: true,
        taskId: plan.taskId,
        level: plan.level,
        data: joined,
        attempts: results.length,
        tokensUsed,
        durationMs: Date.now() - startedAt,
      }
    }

    return {
      ok: false,
      taskId: plan.taskId,
      level: plan.level,
      error: {
        code: firstFailure.error?.code ?? 'SUBGOAL_FAILED',
        message: firstFailure.error?.message ?? 'A sub-goal failed.',
        attempted: firstFailure.error?.attempted ?? ['sub-goals'],
        taskId: plan.taskId,
        level: plan.level,
      },
      attempts: results.length,
      tokensUsed,
      durationMs: Date.now() - startedAt,
    }
  }
}

/**
 * L4 executor: open-ended, high-risk work that must not run unattended. It
 * stops the chain and returns a hand-off prompt; the driving agent relays it to
 * the user, who performs the task and reports the outcome back.
 */
export class HumanExecutor implements Executor {
  readonly name = 'human' as const

  canHandle(level: Plan['level']): boolean {
    return level === 'L4'
  }

  async execute(plan: Plan, _context: ExecuteContext): Promise<ExecutorResult> {
    const startedAt = Date.now()
    const prompt = [
      `This task was leveled L4 (open-ended / high-risk) and must not run unattended.`,
      ``,
      `Goal: ${plan.goal}`,
      `Why: ${plan.reason}`,
      ``,
      `Please hand it to the user, then report back their decision or result.`,
    ].join('\n')
    return success(plan, startedAt, prompt, 1)
  }
}

/** Build the executor set for one orchestrator instance, in level order. */
export function createExecutors(ctx: Context, dispatch: Dispatch): Executor[] {
  return [
    new LocalScriptExecutor(),
    new FlashExecutor(ctx),
    new MarvisExecutor(ctx),
    new ProRouterExecutor(dispatch),
    new HumanExecutor(),
  ]
}
