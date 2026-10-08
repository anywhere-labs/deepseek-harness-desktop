/**
 * The Pro planner: the single classification entry for the orchestrator.
 *
 * It runs one independent model call (the "Pro" tier) that classifies a task
 * into L0–L4 and returns a bounded plan. The planner is the only place a level
 * is assigned — executors never re-level, and the router never re-judges
 * complexity. If the model drops the JSON envelope, the parser degrades to a
 * safe default (L1, direct flash execution) rather than failing the task.
 *
 * @module dsh-plugin-desktop-beta/orchestrator/pro-planner
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Budget, Level, Plan, TaskCard } from './types.ts'

/** The model-facing instruction that fixes the planner's JSON contract. */
const PLAN_INSTRUCTION = [
  'Classify the following task into exactly one difficulty level and respond with a single JSON object only.',
  'Levels: L0 (deterministic, single-step, no LLM needed), L1 (single goal, 1-3 steps), L2 (multi-step, needs decomposition), L3 (multi-goal, cross-domain, unclear path), L4 (open-ended, high-risk, needs a human).',
  'Prefer the lowest level that is safe; when unsure, pick the higher level.',
  'Respond with exactly these fields:',
  '- "level": one of "L0", "L1", "L2", "L3", "L4".',
  '- "reason": one sentence explaining the level.',
  '- "goal": a one-sentence restatement of the goal.',
  '- "budget": an object with integer "maxTokens", "maxSteps", "maxRetries".',
  '- "subGoals": an array of strings; empty unless the level is L3 or L4.',
  '- "requiresHuman": true only when the task is irreversible, high-cost, or high-risk.',
].join('\n')

/** Deterministic level -> executor mapping; the router switches on the level. */
const LEVEL_TO_EXECUTOR: Record<Level, Plan['executor']> = {
  L0: 'local',
  L1: 'flash',
  L2: 'marvis',
  L3: 'pro_router',
  L4: 'human',
}

/** Resolved call route for the Pro planner. */
export interface PlanRoute {
  provider: string
  model: string
  maxTokens: number
}

/** Monotonic per-process sequence for the human-readable task id. */
let taskSequence = 0

/** Generate a stable, human-readable task id in `dsh-YYYYMMDD-NNN` form. */
function makeTaskId(now: Date): string {
  taskSequence += 1
  const y = String(now.getFullYear())
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const seq = String(taskSequence).padStart(3, '0')
  return `dsh-${y}${m}${d}-${seq}`
}

/** Concatenate the text blocks of a model output. */
function textOf(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** Read one integer field leniently, clamping to a non-negative safe value. */
function intField(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
}

/**
 * Parse the planner's JSON output into a `Plan`, tolerating a ```json fence and
 * missing fields. An unparsable output degrades to L1 so the task still runs.
 * @param text - the raw planner output text.
 * @param task - the original task description, used as the goal fallback.
 * @param taskId - the pre-generated task identity.
 */
function parsePlan(text: string, task: string, taskId: string): Plan {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fence?.[1] ?? text
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(candidate) as Record<string, unknown>
  } catch {
    raw = {}
  }

  const level: Level =
    raw.level === 'L0' || raw.level === 'L1' || raw.level === 'L2' || raw.level === 'L3' || raw.level === 'L4'
      ? raw.level
      : 'L1'

  const goal = typeof raw.goal === 'string' && raw.goal.length > 0 ? raw.goal : task
  const reason = typeof raw.reason === 'string' ? raw.reason : 'level fallback: planner output was not parseable'

  const budgetValue = raw.budget as Record<string, unknown> | undefined
  const budget: Budget = {
    maxTokens: intField(budgetValue?.maxTokens, 8000),
    maxSteps: intField(budgetValue?.maxSteps, 3),
    maxRetries: intField(budgetValue?.maxRetries, 2),
  }

  const subGoals: string[] = Array.isArray(raw.subGoals)
    ? raw.subGoals.filter((entry): entry is string => typeof entry === 'string')
    : []

  const requiresHuman = raw.requiresHuman === true

  const taskCard: TaskCard = {
    taskId,
    goal,
    context: task,
    tools: [],
    outputFormat: 'markdown',
    maxSteps: budget.maxSteps,
    maxTokens: budget.maxTokens,
    maxRetries: budget.maxRetries,
  }

  return {
    taskId,
    level,
    reason,
    goal,
    budget,
    executor: LEVEL_TO_EXECUTOR[level],
    taskCard,
    subGoals,
    requiresHuman,
  }
}

/**
 * Classify one task into a plan through the Pro model tier.
 * @param ctx - host context carrying the optional `llm` service.
 * @param task - the raw task description to classify.
 * @param route - resolved provider/model/token route for the planner call.
 * @param sessionId - the caller session identity, for call attribution.
 * @returns the parsed plan; never throws for a non-planning model failure.
 */
export async function planTask(
  ctx: Context,
  task: string,
  route: PlanRoute,
  sessionId: SessionId,
): Promise<Plan> {
  const taskId = makeTaskId(new Date())
  const llm = ctx.get('llm')
  if (llm === undefined || route.provider.length === 0 || route.model.length === 0) {
    return parsePlan('', task, taskId)
  }

  const messages: RequestMessage[] = [{
    role: 'user',
    content: [{ type: 'text', text: `${PLAN_INSTRUCTION}\n\nTask:\n${task}` }],
  }]
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages,
    maxTokens: route.maxTokens,
    sessionId,
    purpose: 'compaction',
  }

  try {
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream(options)) assembler.push(chunk)
    if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
      return parsePlan('', task, taskId)
    }
    const text = textOf(assembler.blocks()).trim()
    if (text.length === 0) return parsePlan('', task, taskId)
    return parsePlan(text, task, taskId)
  } catch {
    // A transport/model failure must not strand the task: fall back to L1.
    return parsePlan('', task, taskId)
  }
}
