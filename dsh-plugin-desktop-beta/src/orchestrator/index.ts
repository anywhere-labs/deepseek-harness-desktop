/**
 * Desktop orchestrator: plan-and-dispatch on top of the harness agent loop.
 *
 * The orchestrator exposes one optional tool, `orchestrate`. When the driving
 * agent hands a task to it, the Pro planner classifies the task into L0–L4, the
 * router picks an executor by level (a pure switch, no complexity judgement),
 * and the executor runs the bounded task card. A failed execution feeds back to
 * the Pro planner for at most `maxReplans` re-levels before the task reports
 * failure upward. Executors never re-level, auto-escalate, or change the plan.
 *
 * @module dsh-plugin-desktop-beta/orchestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { planTask } from './pro-planner.ts'
import { createExecutors } from './executors.ts'
import type { Executor, Plan } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-orchestrator'

/** Pro-planner call and re-plan policy. */
export interface Config {
  /** Provider for the Pro classification call; empty inherits the caller's route. */
  proProvider: string
  /** Model for the Pro classification call (defaults to the Pro tier). */
  proModel: string
  /** Token cap for the Pro classification call. */
  proMaxTokens: number
  /** Maximum re-plans after a failed execution before reporting failure. */
  maxReplans: number
}

/** Validated orchestrator configuration. */
export const Config: z<Config> = z.object({
  proProvider: z.string().default(''),
  proModel: z.string().default('deepseek-v4-pro'),
  proMaxTokens: z.number().step(1).min(128).max(16_384).default(1024),
  maxReplans: z.number().step(1).min(0).max(5).default(2),
})

/** Model-facing description of the `orchestrate` tool. */
const ORCHESTRATE_DESCRIPTION =
  'Classify a task by difficulty and dispatch it to the right executor. '
  + 'Use this for multi-step or uncertain work where you want the task leveled (L0 deterministic through L4 human) '
  + 'and handed to an isolated worker. Provide the task text; the result is the worker\'s output.'

/** Canonical output of `orchestrate`: the outcome and which level/executor handled it. */
const ORCHESTRATE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    taskId: { type: 'string', required: true },
    level: { type: 'string', required: true },
    output: { type: 'string' },
    error: { type: 'string' },
  },
} as const

/** Tool result returned to the driving agent. */
interface OrchestrateOutcome {
  ok: boolean
  taskId: string
  level: string
  output?: string
  error?: string
}

/** Pure level -> executor-name mapping; the router makes no complexity judgement. */
function executorNameFor(level: Plan['level']): Executor['name'] {
  switch (level) {
    case 'L0': return 'local'
    case 'L1': return 'flash'
    case 'L2': return 'marvis'
    case 'L3': return 'pro_router'
    case 'L4': return 'human'
  }
}

/**
 * Resolve the executor for a plan. L3/L4 map to executors that are not wired in
 * Phase 1, so they resolve to `undefined` and the task reports "not wired".
 */
function route(plan: Plan, executors: Executor[]): Executor | undefined {
  return executors.find(executor => executor.name === executorNameFor(plan.level))
}

/**
 * Install the `orchestrate` tool.
 * @param ctx - host context carrying the optional `tools` and `llm` services.
 * @param config - Pro call route and re-plan policy.
 */
export function apply(ctx: Context, config: Config): void {
  const tools = ctx.get('tools')
  if (tools === undefined) {
    ctx.logger.warn('desktop-orchestrator: no tools service mounted; orchestrate tool unavailable')
    return
  }
  const executors = createExecutors(ctx)

  ctx.effect(
    () => tools.register(defineTool({
      name: 'orchestrate',
      description: ORCHESTRATE_DESCRIPTION,
      parameters: {
        task: {
          type: 'string',
          required: true,
          description: 'The full task to classify and dispatch.',
        },
      },
      output: {
        schema: ORCHESTRATE_OUTPUT_SCHEMA,
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, exec) => orchestrate(ctx, config, executors, args.task, exec),
      presentCall: (args): ToolCallView => ({
        card: 'generic',
        title: 'Orchestrate',
        kind: 'other',
        rawInput: args.task,
      }),
    })),
    'dsh-plugin-desktop: desktop-orchestrator orchestrate tool',
  )
}

/**
 * Run the plan -> dispatch -> execute loop with bounded re-plans.
 * @param ctx - host context.
 * @param config - Pro call route and re-plan policy.
 * @param executors - the executor set.
 * @param task - the original task text.
 * @param exec - the tool run context (caller agent and cancellation).
 */
async function orchestrate(
  ctx: Context,
  config: Config,
  executors: Executor[],
  task: string,
  exec: ToolRunContext,
): Promise<OrchestrateOutcome> {
  const agent = exec.agent
  const sessionId = agent === undefined ? 'orchestrator' : String(agent.session.id)
  const provider = config.proProvider.length > 0
    ? config.proProvider
    : agent?.options.provider ?? ''
  const model = config.proModel.length > 0
    ? config.proModel
    : agent?.options.model ?? ''

  let currentTask = task
  let plan = await planTask(ctx, currentTask, { provider, model, maxTokens: config.proMaxTokens }, sessionId)
  let replans = 0

  for (;;) {
    const executor = route(plan, executors)
    if (executor === undefined) {
      return { ok: false, taskId: plan.taskId, level: plan.level, error: `No executor is wired for level ${plan.level}.` }
    }
    const result = await executor.execute(plan, exec.signal, agent)
    if (result.ok) {
      return {
        ok: true,
        taskId: plan.taskId,
        level: plan.level,
        output: typeof result.data === 'string' ? result.data : JSON.stringify(result.data),
      }
    }
    if (replans >= config.maxReplans) {
      return {
        ok: false,
        taskId: plan.taskId,
        level: plan.level,
        error: result.error?.message ?? 'Executor failed without a message.',
      }
    }
    replans += 1
    currentTask = `${task}\n\nPrevious attempt failed at level ${plan.level}: ${result.error?.message ?? 'unknown'}. Re-classify.`
    plan = await planTask(ctx, currentTask, { provider, model, maxTokens: config.proMaxTokens }, sessionId)
  }
}
