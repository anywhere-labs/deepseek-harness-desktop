/**
 * The rollback entry's injected face. The target
 * 'conversation.chat.assistant-leading-actions' slot is declared and typed by
 * ui-conversation; this package only contributes the entry, so no SlotMap
 * merge lives here. The owner passes the durable message identity plus the
 * message's event seq — the anchor the rollback truncates the session log at.
 * @module @deepseek-ai/dsh-client-ui-rollback/client/slots
 */

import type {
  InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { RollbackResult } from '@deepseek-ai/dsh-rollback/types'
// Type-only: pulls the ui-conversation SlotMap merge (the leading-actions entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls this package's LocaleNamespaceMap merge (the 'rollback' seat).
import type {} from './locales.ts'

/** One code-revert hunk that could not be applied. */
export interface RollbackFailureView {
  /** The model-facing path whose hunk failed. */
  readonly path: string
  /** Why the reverse application failed. */
  readonly reason: string
}

/** Settled outcome of one rollback call, normalized for the button surface. */
export type RollbackOutcome =
  | {
    readonly ok: true
    /** The cut seq the session now ends at (the picked message's turn start). */
    readonly cutSeq: number
    /** How many file diffs were reverted, when code rollback was requested. */
    readonly codeReverted: number
    /** Hunks that could not be reverted (code rollback only). */
    readonly codeFailures: readonly RollbackFailureView[]
  }
  | {
    readonly ok: false
    /** The wire failure code. */
    readonly code: string
    /** The wire failure message, for the raw fallback. */
    readonly message: string
  }

/** Injected business face of the rollback entry (session-bound). */
export interface RollbackActions {
  /**
   * Rewind the session to before one message, optionally reverting code.
   * @param messageSeq - the picked message's event seq.
   * @param code - whether to also revert the dropped span's file changes.
   * @returns the cut seq plus code-revert counts, or a normalized failure.
   */
  rollback: (messageSeq: number, code: boolean) => Promise<RollbackOutcome>
}

/** Full props of one assistant-message rollback entry. */
export type RollbackButtonProps =
  PropsRuntime<'conversation.chat.assistant-leading-actions'>
  & InjectFace<RollbackActions>
  & PropsLocale<'rollback'>

/** Normalize a carrier-wrapped wire result to the button surface. */
export function normalizeRollback(result: RemoteResult<RollbackResult>): RollbackOutcome {
  // Two envelopes: the carrier (RemoteResult) and the business result; each
  // carries its own failure vocabulary, and a business failure carries a
  // message only on the branches that need it.
  const failure = (error: { code: string; message?: string }): RollbackOutcome => ({
    ok: false,
    code: error.code,
    message: error.message === undefined ? error.code : error.message,
  })
  if (!result.ok) return failure(result.error)
  if (!result.value.ok) return failure(result.value.error)
  return {
    ok: true,
    cutSeq: result.value.value.cutSeq,
    codeReverted: result.value.value.codeReverted,
    codeFailures: result.value.value.codeFailures,
  }
}
