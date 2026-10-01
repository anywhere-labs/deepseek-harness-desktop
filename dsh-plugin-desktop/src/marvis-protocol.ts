/**
 * Marvis bridge wire protocol: the markers and builders that turn a task card
 * into clipboard text and parse a Marvis result back out. The bridge is
 * human-in-the-loop — the operator pastes the card into Marvis and copies the
 * result back — so the protocol must be robust to extra text around the markers
 * and to a missing envelope (in which case the whole clipboard is the result).
 *
 * @module dsh-plugin-desktop-beta/marvis-protocol
 */

import type { Plan } from './orchestrator/types.ts'

/** Marker wrapping the outbound task card JSON. */
export const MARVIS_TASK_MARKER = '===DSH_TASK===' as const
export const MARVIS_TASK_END = '===DSH_TASK_END===' as const
/** Marker wrapping the inbound result text. */
export const MARVIS_RESULT_MARKER = '===DSH_RESULT===' as const
export const MARVIS_RESULT_END = '===DSH_RESULT_END===' as const

/** Built task card: the clipboard text plus the prompt shown to the operator. */
export interface MarvisTaskCard {
  /** Full clipboard payload the operator pastes into Marvis. */
  clipboardText: string
  /** Short prompt returned to the driving agent / shown to the operator. */
  prompt: string
}

/**
 * Build the outbound clipboard payload for a plan. The card carries the task id,
 * goal, and bounded context so Marvis receives exactly the task card, never the
 * caller's full history.
 */
export function buildMarvisTaskCard(plan: Plan): MarvisTaskCard {
  const payload = JSON.stringify({
    task_id: plan.taskId,
    goal: plan.goal,
    context: plan.taskCard.context,
    output_format: plan.taskCard.outputFormat,
  })
  const clipboardText = [
    MARVIS_TASK_MARKER,
    payload,
    MARVIS_TASK_END,
    '',
    'Complete the task above and reply with your result wrapped in:',
    `${MARVIS_RESULT_MARKER} ... ${MARVIS_RESULT_END}`,
  ].join('\n')
  const prompt = `已复制任务卡（${plan.taskId}）到剪贴板。请切到 Marvis，粘贴执行，完成后全选复制结果，回来告诉我「已复制结果」。`
  return { clipboardText, prompt }
}

/**
 * Parse a Marvis result out of clipboard text. When the result envelope is
 * present, its interior is returned; otherwise the whole clipboard text is
 * treated as the result. Empty input returns `undefined`.
 */
export function parseMarvisResult(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const start = trimmed.indexOf(MARVIS_RESULT_MARKER)
  if (start >= 0) {
    const interior = trimmed.slice(start + MARVIS_RESULT_MARKER.length)
    const end = interior.indexOf(MARVIS_RESULT_END)
    const body = end >= 0 ? interior.slice(0, end) : interior
    const cleaned = body.trim()
    return cleaned.length > 0 ? cleaned : undefined
  }
  return trimmed
}
