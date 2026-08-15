/** Request/result vocabulary of the polish Remote. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One polish request: rewrite and expand a draft over the session's agent channel. */
export interface PolishRequest {
  /** The live session whose agent performs the polish turn. */
  readonly sessionId: SessionId
  /** The user-message draft to polish, verbatim. */
  readonly message: string
}

/** Ask the current model label of one session (button caption input). */
export interface PolishModelRequest {
  /** The live session whose model label to read. */
  readonly sessionId: SessionId
}

/** Model label answer; absent when the session has no resolvable selection. */
export interface PolishModelResult {
  /** Display label of the session's current model; empty when unresolvable. */
  readonly label: string
}

/** Closed failure vocabulary of one polish call. */
export type PolishFailure =
  | {
    readonly code: 'session-not-found'
    /** The requested session id, for diagnostics. */
    readonly sessionId: SessionId
  }
  | { readonly code: 'message-blank' }
  | {
    readonly code: 'message-too-long'
    /** Deployment maximum for the input draft. */
    readonly maxChars: number
    /** Actual trimmed input length in characters. */
    readonly actualChars: number
  }
  | { readonly code: 'no-result' }

/** Settled outcome of one polish call. */
export type PolishResult =
  | {
    readonly ok: true
    /** The polished and expanded text. */
    readonly value: { readonly text: string }
  }
  | { readonly ok: false; readonly error: PolishFailure }
