/**
 * Session rollback over the agent-loop rewind. The caller picks one message by
 * seq; this service cuts at the picked message's turn start (a turn boundary,
 * so the surviving log stays balanced), optionally reverts the file diffs the
 * dropped span recorded on fs write/edit tool results (reverse-applied in
 * reverse order from the tool/result `meta.diffs`), and rewinds the live
 * agent through `ctx.agentLoop.rewind` — truncating persistence and resuming
 * the same identity.
 * @module @deepseek-ai/dsh-rollback
 */

import { Context } from '@deepseek-ai/cordis'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CodeRevertFailure,
  RollbackFailure,
  RollbackRequest,
  RollbackResult,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    rollback: RollbackService
  }
}

/** Build a frozen success branch. */
function success(value: Extract<RollbackResult, { ok: true }>['value']): RollbackResult {
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      cutSeq: value.cutSeq,
      codeReverted: value.codeReverted,
      codeFailures: Object.freeze(value.codeFailures),
    }),
  })
}

/** Build a frozen business-failure branch. */
function rejected(error: RollbackFailure): RollbackResult {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}

/** Whether an opaque tool-result meta carries file diffs (defensive narrowing). */
function isFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, oldText, newText } = value as Record<string, unknown>
  return typeof path === 'string'
    && (oldText === null || typeof oldText === 'string')
    && typeof newText === 'string'
}

/** Narrow opaque tool-result meta to its file diffs. */
function diffsOf(meta: unknown): FileDiff[] {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return []
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs)) return []
  return diffs.filter(isFileDiff)
}

/**
 * The seq of the turn/start owning `messageSeq`, or undefined when the log
 * has no turn covering it. The cut drops the whole turn: the surviving prefix
 * ends on the previous turn/end (balanced).
 */
function turnStartOf(events: readonly SessionEvent[], messageSeq: number): number | undefined {
  for (let index = messageSeq; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') return index
  }
  return undefined
}

/** Collect the dropped span's file diffs in reverse application order. */
function reverseDiffs(events: readonly SessionEvent[]): FileDiff[] {
  const collected: FileDiff[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/result' || event.data.meta === undefined) continue
    const diffs = diffsOf(event.data.meta)
    for (let diffIndex = diffs.length - 1; diffIndex >= 0; diffIndex -= 1) {
      const diff = diffs[diffIndex]
      if (diff !== undefined) collected.push(diff)
    }
  }
  return collected
}

/** Reverse-apply one hunk: replace `newText` with `oldText`, or drop `newText` when it was an insertion. */
async function applyReverse(
  workspaceRoot: string,
  diff: FileDiff,
): Promise<CodeRevertFailure | undefined> {
  const target = resolve(workspaceRoot, diff.path)
  const anchored = target === workspaceRoot || target.startsWith(workspaceRoot + sep)
  if (!anchored) return { path: diff.path, reason: 'outside the workspace' }
  let current: string
  try {
    current = await readFile(target, 'utf8')
  } catch (error: unknown) {
    return {
      path: diff.path,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  const index = current.indexOf(diff.newText)
  if (index === -1) return { path: diff.path, reason: 'hunk text not found in the current file' }
  const replacement = diff.oldText === null ? '' : diff.oldText
  await writeFile(target, current.slice(0, index) + replacement + current.slice(index + diff.newText.length))
  return undefined
}

/**
 * The rollback Remote service: rewinds one live session to before the picked
 * message, optionally reverting the file changes the dropped span recorded.
 */
export class RollbackService extends TypertRemoteService {
  static inject = ['agents', 'agentLoop']

  /**
   * @param ctx - Host context carrying the agent registry and the loop.
   */
  constructor(ctx: Context) {
    super(ctx, 'rollback')
  }

  /**
   * Rewind one live session to before the message at `messageSeq`: the cut is
   * the picked message's turn start, so the surviving log is balanced. When
   * `code` is set, the dropped span's fs write/edit hunks are reverse-applied
   * first (in reverse order); partial failures are reported, never fatal.
   * @param request - target session, picked message seq, and code-revert flag.
   * @returns the cut seq plus code-revert counts, or an explicit failure.
   */
  @Remote('rollback')
  async rollback(request: RollbackRequest): Promise<RollbackResult> {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      return rejected({ code: 'session-not-found', sessionId: request.sessionId })
    }
    if (!Number.isSafeInteger(request.messageSeq) || request.messageSeq < 0
      || request.messageSeq >= agent.session.events.length) {
      return rejected({
        code: 'message-seq-out-of-range',
        messageSeq: request.messageSeq,
        logLength: agent.session.events.length,
      })
    }
    const cutSeq = turnStartOf(agent.session.events, request.messageSeq)
    if (cutSeq === undefined) return rejected({ code: 'no-turn' })

    // Collect before the rewind (the old log is disposed underneath).
    const diffs = request.code === true
      ? reverseDiffs(agent.session.events.slice(cutSeq))
      : []
    const cwd = agent.session.header.cwd

    const codeFailures: CodeRevertFailure[] = []
    if (diffs.length > 0 && cwd === undefined) {
      for (const diff of diffs) {
        codeFailures.push({ path: diff.path, reason: 'session has no workspace root' })
      }
    } else if (diffs.length > 0 && cwd !== undefined) {
      for (const diff of diffs) {
        const failure = await applyReverse(cwd, diff)
        if (failure !== undefined) codeFailures.push(failure)
      }
    }

    try {
      await this.ctx.agentLoop.rewind(agent, cutSeq)
    } catch (error: unknown) {
      // A failed rewind leaves the session untouched but the files possibly
      // partially reverted; surface the loop failure verbatim.
      return rejected({
        code: 'rewind-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return success({
      cutSeq,
      codeReverted: diffs.length - codeFailures.length,
      codeFailures,
    })
  }
}

export default RollbackService
