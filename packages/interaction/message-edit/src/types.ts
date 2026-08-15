/** Request/result vocabulary of the message-edit Remote. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm'

/** One edit request: rewrite a settled user message in place. */
export interface MessageEditRequest {
  /** The session whose log carries the message; live or cold. */
  readonly sessionId: SessionId
  /** Stable identity of the `user/message` to rewrite (survives prior edits). */
  readonly messageId: MessageId
  /** The replacement plain text; the message's other blocks are preserved as-is. */
  readonly text: string
}

/** Closed failure vocabulary of one edit call. */
export type MessageEditFailure =
  | {
    readonly code: 'session-not-found'
    /** The requested session id, for diagnostics. */
    readonly sessionId: SessionId
  }
  | {
    readonly code: 'message-not-found'
    /** The requested message id. */
    readonly messageId: MessageId
  }
  | { readonly code: 'message-blank' }
  | {
    readonly code: 'message-too-long'
    /** Deployment maximum for the message text. */
    readonly maxChars: number
    /** Actual trimmed text length in characters. */
    readonly actualChars: number
  }

/** Settled outcome of one edit call. */
export type MessageEditResult =
  | {
    readonly ok: true
    /** The seq of the replacement `user/message` appended to the log. */
    readonly value: { readonly seq: number }
  }
  | { readonly ok: false; readonly error: MessageEditFailure }
