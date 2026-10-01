/**
 * Marvis human-in-the-loop bridge: two tools that let the driving agent hand a
 * task to Tencent Marvis through the clipboard. Marvis has no API, so the
 * operator pastes the task card into Marvis and copies the result back — this
 * plugin owns the copy-out (`marvis_send`) and the collect-back
 * (`marvis_collect`), plus a per-hour send cap that prevents the bridge from
 * being used as an unbounded free-token faucet.
 *
 * @module dsh-plugin-desktop-beta/marvis
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import { buildMarvisTaskCard, parseMarvisResult } from './marvis-protocol.ts'
import type { Plan } from './orchestrator/types.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-marvis'

/** The `tools` registry must be present before the Marvis tools register. */
export const inject = ['tools']

/** Bridge limits. */
export interface Config {
  /** Maximum `marvis_send` calls accepted within a rolling hour. */
  maxSendsPerHour: number
}

/** Validated marvis configuration. */
export const Config: z<Config> = z.object({
  maxSendsPerHour: z.number().step(1).min(1).max(10_000).default(100),
})

const SEND_DESCRIPTION =
  'Copy a Marvis task card to the clipboard so the user can paste it into Marvis and run it. '
  + 'Use this to delegate work to Marvis; the user completes the hand-off manually, then you call marvis_collect to read the result.'

const COLLECT_DESCRIPTION =
  'Read the Marvis result the user copied back to the clipboard. '
  + 'Call this after the user says they have copied Marvis\'s output. Returns the parsed result text.'

const SEND_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', required: true },
    copied: { type: 'boolean', required: true },
    prompt: { type: 'string', required: true },
  },
} as const

const COLLECT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    result: { type: 'string' },
    error: { type: 'string' },
  },
} as const

/** Rolling-hour send limiter; one instance per plugin mount. */
class SendLimiter {
  private readonly stamps: number[] = []

  constructor(private readonly limit: number) {}

  /** Accept the send if the rolling-hour cap is not exceeded. */
  accept(now: number): boolean {
    const windowStart = now - 60 * 60 * 1000
    while (this.stamps.length > 0 && (this.stamps[0] ?? 0) < windowStart) this.stamps.shift()
    if (this.stamps.length >= this.limit) return false
    this.stamps.push(now)
    return true
  }
}

/** Shape a `Plan`-like card from a bare task description for `marvis_send`. */
function cardFromTask(taskId: string, task: string): Plan {
  return {
    taskId,
    level: 'L2',
    reason: 'marvis_send: explicit hand-off',
    goal: task,
    budget: { maxTokens: 8000, maxSteps: 3, maxRetries: 1 },
    executor: 'marvis',
    taskCard: {
      taskId,
      goal: task,
      context: task,
      tools: [],
      outputFormat: 'markdown',
      maxSteps: 3,
      maxTokens: 8000,
      maxRetries: 1,
    },
    subGoals: [],
    requiresHuman: true,
  }
}

/** Install the `marvis_send` and `marvis_collect` tools. */
export function apply(ctx: Context, config: Config): void {
  const tools = ctx.get('tools')
  if (tools === undefined) {
    ctx.logger.warn('desktop-marvis: no tools service mounted; marvis tools unavailable')
    return
  }
  const limiter = new SendLimiter(config.maxSendsPerHour)
  let taskSequence = 0

  const clipboardOf = () => ctx.get('desktopClipboard')

  ctx.effect(
    () => tools.register(defineTool({
      name: 'marvis_send',
      description: SEND_DESCRIPTION,
      parameters: {
        task: {
          type: 'string',
          required: true,
          description: 'The task to hand to Marvis, in full detail.',
        },
      },
      output: {
        schema: SEND_OUTPUT_SCHEMA,
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        const clipboard = clipboardOf()
        if (clipboard === undefined) {
          return { taskId: '', copied: false, prompt: 'Clipboard unavailable in this environment.' }
        }
        if (!limiter.accept(Date.now())) {
          return { taskId: '', copied: false, prompt: 'Marvis send limit reached for this hour.' }
        }
        taskSequence += 1
        const taskId = `marvis-${Date.now()}-${taskSequence}`
        const card = buildMarvisTaskCard(cardFromTask(taskId, args.task))
        clipboard.writeText(card.clipboardText)
        return { taskId, copied: true, prompt: card.prompt }
      },
      presentCall: (args): ToolCallView => ({
        card: 'generic',
        title: 'Send to Marvis',
        kind: 'other',
        rawInput: args.task,
      }),
    })),
    'dsh-plugin-desktop: desktop-marvis marvis_send tool',
  )

  ctx.effect(
    () => tools.register(defineTool({
      name: 'marvis_collect',
      description: COLLECT_DESCRIPTION,
      parameters: {},
      output: {
        schema: COLLECT_OUTPUT_SCHEMA,
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => {
        const clipboard = clipboardOf()
        if (clipboard === undefined) {
          return { ok: false, error: 'Clipboard unavailable in this environment.' }
        }
        const result = parseMarvisResult(clipboard.readText())
        if (result === undefined) {
          return { ok: false, error: 'No Marvis result found in the clipboard yet.' }
        }
        return { ok: true, result }
      },
      presentCall: (): ToolCallView => ({
        card: 'generic',
        title: 'Collect from Marvis',
        kind: 'other',
        rawInput: '',
      }),
    })),
    'dsh-plugin-desktop: desktop-marvis marvis_collect tool',
  )
}
