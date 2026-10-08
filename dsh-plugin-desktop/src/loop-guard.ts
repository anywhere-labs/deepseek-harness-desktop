/**
 * Loop circuit breaker and recovery for DSH Desktop.
 *
 * Detects a stuck agent — consecutive identical tool calls, an over-long turn,
 * or a turn that outlives its wall-clock budget — and forces a break. The
 * break is followed by a MANDATORY reset, not a plain prompt injection: the
 * plugin assembles a de-noised high-level context (the recorded goal plus the
 * failure point, none of the polluted raw history), runs one independent model
 * call to re-clarify the goal and plan, asks the user for clarification when
 * the reflection flags ambiguity, then steers the re-aligned direction back
 * into the agent so it resumes instead of continuing to churn.
 *
 * The upstream `repeat-tool-reminder` stays advisory (it never vetoes); this
 * plugin owns the hard thresholds and the recovery path. The recovery consumes
 * the same high-level condensation that `desktop-context` produces, so a
 * session that already folds summaries has even less noise to discard here.
 *
 * @module dsh-plugin-desktop-beta/loop-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-session'

/** Source stamped on every message this plugin steers or enriches. */
interface LoopGuardSource {
  kind: 'desktop-loop-guard'
  form: 'reset' | 'reminder'
  version: 1
  reason: 'repeat' | 'steps' | 'wallclock'
  detail?: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'desktop-loop-guard': LoopGuardSource
  }
}

/** Stable Cordis plugin name. */
export const name = 'desktop-loop-guard'

/** Loop-detection thresholds and recovery policy. */
export interface Config {
  /** Consecutive-repeat counts that emit a soft reminder (advisory, no break). */
  repeatSoftThresholds: number[]
  /** Consecutive-repeat count that forces a break and the reset. */
  repeatHardThreshold: number
  /** Maximum model steps admitted in one turn before a break. */
  maxStepsPerTurn: number
  /** Maximum wall-clock milliseconds admitted in one turn before a break. */
  maxTurnWallMs: number
  /** Provider for the reflection call; empty inherits the session's resolved route. */
  reflectionProvider: string
  /** Model for the reflection call; empty inherits the session's resolved route. */
  reflectionModel: string
  /** Token cap for the reflection call. */
  reflectionMaxTokens: number
  /** Ask the user when the reflection flags an ambiguous goal or requirement. */
  askOnAmbiguity: boolean
}

/** Validated loop-detection thresholds and recovery policy. */
export const Config: z<Config> = z.object({
  repeatSoftThresholds: z.array(z.number().step(1).min(2)).default([3, 5]),
  repeatHardThreshold: z.number().step(1).min(3).default(6),
  maxStepsPerTurn: z.number().step(1).min(4).default(48),
  maxTurnWallMs: z.number().step(1).min(60_000).default(10 * 60_000),
  reflectionProvider: z.string().default(''),
  reflectionModel: z.string().default(''),
  reflectionMaxTokens: z.number().step(1).min(128).max(16_384).default(1024),
  askOnAmbiguity: z.boolean().default(true),
})

/** Why the loop was broken; carried into the reset for the reflection context. */
interface TripTrigger {
  kind: 'repeat' | 'steps' | 'wallclock'
  tool?: string
  step?: number
  elapsedMs?: number
}

/** The reflection call's structured output; parsed leniently, so a model that
 *  drops the JSON envelope degrades to a plain re-alignment without ambiguity. */
interface ReflectionResult {
  goal: string
  plan: string
  ambiguous: boolean
  question: string
}

/** Feedback shown to the model when a hard repeat threshold is crossed. */
const BLOCK_FEEDBACK =
  'This repeated tool call was stopped: the agent is re-establishing its goal '
  + 'and plan before continuing.'

/** Minimal re-alignment steered when the reflection cannot run. */
const MINIMAL_RESET_PROMPT =
  'Your previous approach was interrupted because it was looping without '
  + 'progress. Re-examine your goal, decide one concrete next step, and '
  + 'continue. If the goal or requirements are unclear, ask the user for '
  + 'clarification.'

/** Instruction appended before the de-noised reflection context. */
const REFLECTION_INSTRUCTION = [
  'You are stepping back from an agent task that got stuck in a loop.',
  'Ignore the accumulated details and re-establish a clear goal and plan.',
  'Respond with a single JSON object only, with exactly these fields:',
  '- "goal": a one-sentence restatement of the primary goal.',
  '- "plan": a concise concrete next-step plan (2 to 4 steps).',
  '- "ambiguous": true only when the goal or requirements are genuinely unclear and need the user to clarify.',
  '- "question": the clarification question for the user, or "" when unambiguous.',
].join('\n')

/** Concatenate the text blocks of a model output. */
function textOf(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** Deep key-sort of a parsed-JSON value so argument objects that differ only
 *  in property order canonicalize identically. Arguments are the loop's
 *  lossless-JSON parse output, so no bigint, cycle, or `undefined` handling is
 *  required. */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/** Canonical identity of a tool call: deep key-sort of the arguments, stringified. */
function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue))
}

/** Source object for a reset or reminder message produced by this plugin. */
function guardSource(form: 'reset' | 'reminder', reason: TripTrigger['kind'], detail?: string): LoopGuardSource {
  return detail === undefined
    ? { kind: 'desktop-loop-guard', form, version: 1, reason }
    : { kind: 'desktop-loop-guard', form, version: 1, reason, detail }
}

/** Build the de-noised reflection context: goal plus failure point, no raw history. */
function buildReflectionContext(goal: GoalView | undefined, trigger: TripTrigger): string {
  const lines: string[] = ['## Current goal']
  if (goal === undefined) {
    lines.push('(no explicit goal recorded)')
  } else {
    lines.push(`- Objective: ${goal.objective}`)
    lines.push(`- Phase: ${goal.phase}`)
    lines.push(`- Rounds started: ${goal.roundsStarted} / ${goal.maxGoalRounds}`)
  }
  lines.push('')
  lines.push('## Why the loop was broken')
  if (trigger.kind === 'repeat') {
    lines.push(`- Repeated identical tool call: ${trigger.tool ?? 'unknown'}`)
  } else if (trigger.kind === 'steps') {
    lines.push(`- Step budget exceeded: ${trigger.step ?? '?'} steps in one turn`)
  } else {
    lines.push(`- Wall-clock budget exceeded: ~${Math.round((trigger.elapsedMs ?? 0) / 1000)}s in one turn`)
  }
  return lines.join('\n')
}

/** Parse the reflection output as JSON, tolerating a ```json fence. */
function parseReflection(text: string): ReflectionResult {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fence?.[1] ?? text
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>
    return {
      goal: typeof parsed.goal === 'string' ? parsed.goal : '',
      plan: typeof parsed.plan === 'string' ? parsed.plan : '',
      ambiguous: parsed.ambiguous === true,
      question: typeof parsed.question === 'string' ? parsed.question : '',
    }
  } catch {
    // Fail-soft: treat the whole output as a plain re-alignment, no ambiguity.
    return { goal: '', plan: text, ambiguous: false, question: '' }
  }
}

/** Compose the steered re-alignment message from the reflection and any clarification. */
function composeAlignedMessage(reflection: ReflectionResult, clarification: string | undefined): string {
  const lines = [
    'Your previous approach was interrupted because it was looping without progress.',
    'Here is a re-established direction:',
    '',
  ]
  if (reflection.goal.length > 0) lines.push(`## Goal\n${reflection.goal}`, '')
  if (reflection.plan.length > 0) lines.push(`## Plan\n${reflection.plan}`, '')
  if (clarification !== undefined && clarification.length > 0) {
    lines.push(`## User clarification\n${clarification}`, '')
  }
  lines.push('Continue from here. Do not repeat the exact same actions that caused the loop.')
  return lines.join('\n')
}

/**
 * Install the detector, the circuit breaker, and the reset path.
 * @param ctx - Host context carrying the optional `llm`, `goals`, and `userQuestions` services.
 * @param config - validated loop-detection and recovery values.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Per-agent consecutive-repeat chain.
  const chains = new WeakMap<Agent, { key: string; count: number }>()
  // Per-agent current turn start wall-clock; keyed by turn number.
  const turnStarts = new WeakMap<Agent, { turn: number; startedAt: number }>()
  // Agents currently in the reset phase; prevents re-triggering mid-reset.
  const resetting = new WeakSet<Agent>()
  // Latest resolved provider/model per session, folded from request/header events.
  const latestRoute = new Map<string, { provider: string; model: string }>()

  const softSet = new Set(config.repeatSoftThresholds)

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'request/header') return
    latestRoute.set(String(session.id), {
      provider: event.data.header.config.provider,
      model: event.data.header.config.model,
    })
  })

  /** Run the mandatory reset for one tripped agent, then re-enter the loop. */
  async function resetLoop(agent: Agent, trigger: TripTrigger): Promise<void> {
    if (resetting.has(agent)) return
    resetting.add(agent)
    let aligned: UserMessage
    try {
      aligned = await reflect(ctx, config, agent, trigger, latestRoute)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`desktop-loop-guard: reset failed (${message}); steering a minimal re-alignment`)
      aligned = createUserMessage({
        source: guardSource('reset', trigger.kind, trigger.tool),
        content: [{ type: 'text', text: MINIMAL_RESET_PROMPT }],
      })
    }
    resetting.delete(agent)
    try {
      agent.steer(aligned)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`desktop-loop-guard: steering the reset failed: ${message}`)
    }
  }

  // Detect consecutive repeats and force a break at the hard threshold. The soft
  // tier enriches like the upstream advisor; the hard tier short-circuits with a
  // block and starts the reset.
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const agent = exec.agent
    if (agent === undefined || resetting.has(agent)) return next()

    const key = JSON.stringify([exec.name, canonicalize(exec.arguments)])
    const chain = chains.get(agent)
    const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
    chains.set(agent, { key, count })

    if (count >= config.repeatHardThreshold) {
      chains.delete(agent)
      void resetLoop(agent, { kind: 'repeat', tool: exec.name })
      return { kind: 'block', feedback: [{ type: 'text', text: BLOCK_FEEDBACK }] }
    }
    const decision = await next()
    if (!softSet.has(count) || decision.kind === 'block') return decision
    const reminder: UserMessage = createUserMessage({
      source: guardSource('reminder', 'repeat', exec.name),
      content: [{
        type: 'text',
        text: `You have called \`${exec.name}\` ${count} times in a row with the same arguments. `
          + 'If it is not making progress, stop and reconsider your approach.',
      }],
    })
    return { ...decision, additionalContexts: [reminder, ...decision.additionalContexts ?? []] }
  })

  // Reset the repeat chain on a user interjection, enforce the step and
  // wall-clock budgets, and gate re-entry while a reset is in flight.
  ctx.on('agent/pre-step', async ({ agent, turn, step, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) {
      chains.delete(agent)
      turnStarts.delete(agent)
    }
    if (resetting.has(agent)) return { kind: 'reject' }

    const start = turnStarts.get(agent)
    if (start === undefined || start.turn !== turn) {
      turnStarts.set(agent, { turn, startedAt: Date.now() })
    }

    if (step >= config.maxStepsPerTurn) {
      turnStarts.delete(agent)
      void resetLoop(agent, { kind: 'steps', step })
      return { kind: 'reject' }
    }
    const startedAt = turnStarts.get(agent)!.startedAt
    if (Date.now() - startedAt >= config.maxTurnWallMs) {
      turnStarts.delete(agent)
      void resetLoop(agent, { kind: 'wallclock', elapsedMs: Date.now() - startedAt })
      return { kind: 'reject' }
    }
    return next()
  })
}

/** Run the de-noised reflection (and optional user question), returning the re-aligned message. */
async function reflect(
  ctx: Context,
  config: Config,
  agent: Agent,
  trigger: TripTrigger,
  latestRoute: ReadonlyMap<string, { provider: string; model: string }>,
): Promise<UserMessage> {
  const source = guardSource('reset', trigger.kind, trigger.tool)

  // 1. De-noised context: the recorded goal plus the failure point.
  const goals = ctx.get('goals')
  let goal: GoalView | undefined
  if (goals !== undefined) {
    try {
      goal = goals.get(agent)
    } catch {
      goal = undefined
    }
  }
  const context = buildReflectionContext(goal, trigger)

  // 2. Independent reflection call.
  const llm = ctx.get('llm')
  const route = latestRoute.get(String(agent.session.id))
  const provider = config.reflectionProvider.length > 0
    ? config.reflectionProvider
    : route?.provider ?? agent.options.provider ?? ''
  const model = config.reflectionModel.length > 0
    ? config.reflectionModel
    : route?.model ?? agent.options.model ?? ''
  if (llm === undefined || provider.length === 0 || model.length === 0) {
    return createUserMessage({
      source,
      content: [{ type: 'text', text: MINIMAL_RESET_PROMPT }],
    })
  }

  const messages: RequestMessage[] = [{
    role: 'user',
    content: [{ type: 'text', text: `${REFLECTION_INSTRUCTION}\n\n${context}` }],
  }]
  const options: GenerateOptions = {
    provider,
    model,
    messages,
    maxTokens: config.reflectionMaxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
  }
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
    throw new Error(`reflection call failed: ${assembler.finish.failure.message}`)
  }
  const text = textOf(assembler.blocks()).trim()
  if (text.length === 0) throw new Error('reflection call produced no text')
  const reflection = parseReflection(text)

  // 3. Ask the user when the reflection flags ambiguity.
  let clarification: string | undefined
  if (reflection.ambiguous && config.askOnAmbiguity) {
    const userQuestions = ctx.get('userQuestions')
    if (userQuestions !== undefined) {
      clarification = await askClarification(userQuestions, agent, reflection)
    }
  }

  // 4. Steer the re-aligned direction.
  return createUserMessage({
    source,
    content: [{ type: 'text', text: composeAlignedMessage(reflection, clarification) }],
  })
}

/** Ask the user to confirm or adjust the re-clarified goal and plan. */
async function askClarification(
  userQuestions: Context['userQuestions'],
  agent: Agent,
  reflection: ReflectionResult,
): Promise<string | undefined> {
  const question: AskUserQuestionItem = {
    id: 'desktop-loop-guard-reset',
    question: reflection.question.length > 0
      ? reflection.question
      : 'Please confirm or adjust the re-clarified goal and plan:',
    detail: `${reflection.goal}\n\n${reflection.plan}`,
    options: [
      { label: 'Proceed with this plan' },
      { label: 'I need to adjust it' },
    ],
  }
  try {
    const answer: AskUserQuestionAnswer = await userQuestions.ask({ questions: [question], agent })
    const item = answer.answers.find(entry => entry.id === 'desktop-loop-guard-reset')
    if (item === undefined) return undefined
    if (item.custom !== undefined && item.custom.length > 0) return item.custom
    if (item.selected.includes('I need to adjust it')) {
      return 'The user asked to adjust the plan but provided no specific note; ask again for the exact change.'
    }
    return undefined
  } catch {
    // No answerer (headless) or a non-live agent: fail-soft, continue without clarification.
    return undefined
  }
}
