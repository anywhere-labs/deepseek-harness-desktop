/**
 * Desktop orchestrator: plan-and-dispatch on top of the harness agent loop.
 *
 * The orchestrator exposes one optional tool, `orchestrate`. When the driving
 * agent hands a task to it, the Pro planner classifies the task into L0–L4, the
 * router picks an executor by level (a pure switch, no complexity judgement),
 * and the executor runs the bounded task card. A failed execution feeds back to
 * the Pro planner for at most `maxReplans` re-levels before the task reports
 * failure upward. L3 recurses over the Pro planner's sub-goals, bounded by
 * `maxDepth`; L4 hands off to a human. Executors never re-level, auto-escalate,
 * or change the plan.
 *
 * @module dsh-plugin-desktop-beta/orchestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { planTask, type PlanRoute } from './pro-planner.ts'
import { createExecutors, type Dispatch } from './executors.ts'
import type { ExecuteContext, Executor, ExecutorResult, Plan } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-orchestrator'

/** The `tools` registry must be present before the `orchestrate` tool registers. */
export const inject = ['tools']

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
  /** Maximum L3 recursion depth before the long path reports a runaway. */
  maxDepth: number
}

/** Validated orchestrator configuration. */
export const Config: z<Config> = z.object({
  proProvider: z.string().default(''),
  proModel: z.string().default('deepseek-v4-pro'),
  proMaxTokens: z.number().step(1).min(128).max(16_384).default(1024),
  maxReplans: z.number().step(1).min(0).max(5).default(2),
  maxDepth: z.number().step(1).min(1).max(8).default(3),
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

/** Resolve the executor for a plan, or `undefined` when none is wired. */
function route(plan: Plan, executors: Executor[]): Executor | undefined {
  return executors.find(executor => executor.name === executorNameFor(plan.level))
}

/**
 * Install the `orchestrate` tool.
 * @param ctx - host context carrying the optional `tools` and `llm` services.
 * @param config - Pro call route, re-plan, and depth policy.
 */
export function apply(ctx: Context, config: Config): void {
  const tools = ctx.get('tools')
  if (tools === undefined) {
    ctx.logger.warn('desktop-orchestrator: no tools service mounted; orchestrate tool unavailable')
    return
  }

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
      execute: (args, exec) => orchestrate(ctx, config, args.task, exec),
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
 * Entry point for one tool call: assemble the executor set and the recursive
 * dispatch closure, then run the top-level task at depth 0.
 */
async function orchestrate(
  ctx: Context,
  config: Config,
  task: string,
  exec: ToolRunContext,
): Promise<OrchestrateOutcome> {
  const agent = exec.agent
  const signal = exec.signal
  const sessionId: SessionId = agent === undefined ? SessionId('orchestrator') : agent.session.id
  const provider = config.proProvider.length > 0
    ? config.proProvider
    : agent?.options.provider ?? ''
  const model = config.proModel.length > 0
    ? config.proModel
    : agent?.options.model ?? ''
  const planRoute: PlanRoute = { provider, model, maxTokens: config.proMaxTokens }

  const executors: Executor[] = []
  const dispatch: Dispatch = (subTask, depth) =>
    runTask(ctx, config, executors, subTask, signal, agent, depth, planRoute, sessionId)
  executors.push(...createExecutors(ctx, dispatch))

  const result = await runTask(ctx, config, executors, task, signal, agent, 0, planRoute, sessionId)
  return toOutcome(result)
}

/**
 * Classify, route, execute, and re-plan one task (bounded re-plans, bounded
 * recursion depth). Returns the terminal `ExecutorResult`.
 */
async function runTask(
  ctx: Context,
  config: Config,
  executors: Executor[],
  task: string,
  signal: AbortSignal,
  agent: import('@deepseek-ai/dsh-agent').Agent | undefined,
  depth: number,
  planRoute: PlanRoute,
  sessionId: SessionId,
): Promise<ExecutorResult> {
  if (depth > config.maxDepth) {
    return {
      ok: false,
      taskId: '',
      level: 'L3',
      error: {
        code: 'MAX_DEPTH',
        message: `The L3 long path exceeded maxDepth (${config.maxDepth}).`,
        attempted: [],
        taskId: '',
        level: 'L3',
      },
      attempts: 1,
      tokensUsed: 0,
      durationMs: 0,
    }
  }

  let currentTask = task
  let plan = await planTask(ctx, currentTask, planRoute, sessionId)
  let replans = 0

  for (;;) {
    const executor = route(plan, executors)
    if (executor === undefined) {
      return {
        ok: false,
        taskId: plan.taskId,
        level: plan.level,
        error: {
          code: 'NO_EXECUTOR',
          message: `No executor is wired for level ${plan.level}.`,
          attempted: [],
          taskId: plan.taskId,
          level: plan.level,
        },
        attempts: 1,
        tokensUsed: 0,
        durationMs: 0,
      }
    }

    const context: ExecuteContext = { signal, parent: agent, depth }
    const result = await executor.execute(plan, context)
    if (result.ok) return result
    if (replans >= config.maxReplans) return result
    replans += 1
    currentTask = `${task}\n\nPrevious attempt failed at level ${plan.level}: ${result.error?.message ?? 'unknown'}. Re-classify.`
    plan = await planTask(ctx, currentTask, planRoute, sessionId)
  }
}

/** Convert an `ExecutorResult` to the tool's outward-facing outcome. */
function toOutcome(result: ExecutorResult): OrchestrateOutcome {
  if (result.ok) {
    return {
      ok: true,
      taskId: result.taskId,
      level: result.level,
      output: typeof result.data === 'string' ? result.data : JSON.stringify(result.data),
    }
  }
  return {
    ok: false,
    taskId: result.taskId,
    level: result.level,
    error: result.error?.message ?? 'Executor failed without a message.',
  }
}
