/** Request/result vocabulary of the polish Remote. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One polish request: rewrite and expand a draft in an isolated session. */
export interface PolishRequest {
  /** The live session whose provider/model selection the polish turn mirrors. */
  readonly sessionId: SessionId
  /** The user-message draft to polish, verbatim. */
  readonly message: string
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
  | {
    readonly code: 'polish-session-failed'
    /** The throwaway-session failure, verbatim. */
    readonly message: string
  }

/** Settled outcome of one polish call. */
export type PolishResult =
  | {
    readonly ok: true
    /** The polished and expanded text. */
    readonly value: { readonly text: string }
  }
  | { readonly ok: false; readonly error: PolishFailure }
