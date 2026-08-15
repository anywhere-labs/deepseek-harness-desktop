/** Request/result vocabulary of the rollback Remote. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One rollback request: restore a session to before one message, optionally reverting code. */
export interface RollbackRequest {
  /** The live session to rewind. */
  readonly sessionId: SessionId
  /** Seq of the message the user picked; the service cuts at its turn's start. */
  readonly messageSeq: number
  /** Whether to also revert the file changes the dropped span made. */
  readonly code?: boolean
}

/** One code-revert hunk that could not be applied. */
export interface CodeRevertFailure {
  /** The model-facing path whose hunk failed. */
  readonly path: string
  /** Why the reverse application failed. */
  readonly reason: string
}

/** Closed failure vocabulary of one rollback call. */
export type RollbackFailure =
  | {
    readonly code: 'session-not-found'
    /** The requested session id, for diagnostics. */
    readonly sessionId: SessionId
  }
  | {
    readonly code: 'message-seq-out-of-range'
    /** The requested message seq. */
    readonly messageSeq: number
    /** Current log length. */
    readonly logLength: number
  }
  | { readonly code: 'no-turn' }
  | {
    readonly code: 'rewind-failed'
    /** The loop failure, verbatim. */
    readonly message: string
  }

/** Settled outcome of one rollback call. */
export type RollbackResult =
  | {
    readonly ok: true
    readonly value: {
      /** The cut seq the session now ends at (the picked message's turn start). */
      readonly cutSeq: number
      /** How many file diffs were reverted, when code rollback was requested. */
      readonly codeReverted: number
      /** Hunks that could not be reverted (code rollback only). */
      readonly codeFailures: readonly CodeRevertFailure[]
    }
  }
  | { readonly ok: false; readonly error: RollbackFailure }
