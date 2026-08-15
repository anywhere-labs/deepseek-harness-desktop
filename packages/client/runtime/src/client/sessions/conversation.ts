// ConversationSnapshot / ConversationNode: the only data shape the logic layer feeds the UI.
// Publication contract: every change swaps the top-level object; unchanged
// substructures keep their references (the React.memo premise). Chat node and
// Location stores are stable live readers, so old snapshots are not time-point
// views. callId/approvalId stay plain string here (narrow to real brands when
// convenient).

import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry/types'
import type { TodoItem } from '@deepseek-ai/dsh-session/types'
import type {
  RpcError, SessionId, SubagentAddress, ToolCallView, ToolResultView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { PendingInteraction } from './pending.ts'
import type { ContextProvenanceView, KnownContextForm } from './context-provenance.ts'
import type {
  ChatConversationViewNode, ConversationTimelineSnapshot, ConversationViewSnapshotStore,
} from '../contract/conversation.ts'
export type { TodoItem }

/** Request configuration recorded for one provider call. */
export interface AssistantRequestConfig {
  provider: string
  model: string
  purpose?: string
  thinking?: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
}

/** Stable provider/model identity reported for one completed request. */
export interface AssistantProvenanceView {
  provider: string
  model: string
}

/** Assistant content blocks sorted by what the UI cares about
 *  (text body / collapsible reasoning / tool-call card head / other fallback). */
export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'image'; attachment: ImageAttachmentRef }
  | { kind: 'tool-call'; callId: string; name: string; argsRaw: string }
  | { kind: 'other'; block: unknown }

/**
 * core ContentBlock[] -> AssistantBlock[] (classifier shared by finalized messages and partial block-end).
 * @param content - core content blocks verbatim.
 * @returns UI-classified blocks in source order.
 */
export function toAssistantBlocks(content: readonly ContentBlock[]): AssistantBlock[] {
  return content.map(toAssistantBlock)
}

/**
 * Classify one block (ToolCallBlock fields are id/arguments, mapped to callId/argsRaw).
 * @param block - one core content block.
 * @returns the UI classification.
 */
export function toAssistantBlock(block: ContentBlock): AssistantBlock {
  switch (block.type) {
    case 'text': return { kind: 'text', text: block.text }
    case 'reasoning': return { kind: 'reasoning', text: block.text }
    case 'image': return { kind: 'image', attachment: block.attachment }
    case 'tool-call': return { kind: 'tool-call', callId: String(block.id), name: block.name, argsRaw: block.arguments }
    default: return { kind: 'other', block }
  }
}

/** A finalized user message. */
export interface UserMessageNode {
  kind: 'user'
  /** Stable identity carried from the `user/message` event; survives in-place edits. */
  messageId: MessageId
  seq: number
  /** Unix epoch ms from the source session event. */
  time: number
  content: readonly ContentBlock[]
  source: unknown
}

/** Recorded boundaries used to derive assistant latency and throughput. */
export interface AssistantTiming {
  /** Matching step/start timestamp, or null when it is outside the current event window. */
  stepStartTime: number | null
  /** First non-empty text/reasoning/tool delta timestamp, or null when no token delta was recorded. */
  firstTokenTime: number | null
  /** Final assistant/message timestamp. */
  completedTime: number
}

/** A finalized (or interruption-frozen) assistant message. */
export interface AssistantMessageNode {
  kind: 'assistant'
  seq: number
  /**
   * Stable identity of the finalized model output, carried from the
   * `assistant/message` event. Absent on interruption-frozen partials: those
   * were never finalized, so they address no durable message.
   */
  messageId?: MessageId
  /** Unix epoch ms from the source session event (or turn/end when frozen from a partial). */
  time: number
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
  usage?: unknown
  provenance?: AssistantProvenanceView
  requestConfig?: AssistantRequestConfig
  /** Timing derived from the recorded step/chunk/message event sequence. */
  timing?: AssistantTiming
  /** Frozen partial of an aborted turn (no finalize ever arrives): rendered with a 已停止 marker.
   *  Synthetic seq (fractional, derived from the turn/end seq) keeps it ordered inside the flow. */
  interrupted?: true
}

/** A human message admitted from the next-step inbox while a turn was running. */
export interface SteeringMessageNode {
  kind: 'steering'
  /** Stable message identity shared with its pre-admission inbox occurrence. */
  messageId: MessageId
  seq: number
  /** Unix epoch ms from the source session event. */
  time: number
  content: readonly ContentBlock[]
  source: unknown
}

/** A context/system injection surfaced in the flow. */
export interface ContextMessageNode {
  kind: 'context'
  seq: number
  /** Unix epoch ms from the source session event. */
  time: number
  content: readonly ContentBlock[]
  source: unknown
  /** Role and producer name projected from `source` ({@link contextProvenance}). */
  provenance: ContextProvenanceView
  /** Producer-declared information form ({@link contextForm}); null presents as opaque. */
  form: KnownContextForm | null
}

/** Durable notice that a closed failed step is waiting for a model-request retry. */
export type ModelRetryNode = LlmRetryEventData & {
  kind: 'model-retry'
  seq: number
  /** Unix epoch ms from the llm/retry session event. */
  time: number
  /**
   * Client-derived lifecycle: scheduled until a retry turn starts, started
   * once it does, or cancelled when the failed turn aborts first.
   */
  retryState: 'scheduled' | 'started' | 'cancelled'
}

/** Durable terminal failure for a turn that has no scheduled retry. */
export interface TurnErrorNode {
  kind: 'turn-error'
  /** Seq of the owning turn/end event. */
  seq: number
  /** Unix epoch ms from the turn/end event. */
  time: number
  turn: number
  step: number
  message: string
  code?: string
}

/** Durable notice for a turn ended by the per-request output-token cap. */
export interface TurnMaxTokensNode {
  kind: 'turn-max-tokens'
  /** Seq of the owning turn/end event. */
  seq: number
  /** Unix epoch ms from the turn/end event. */
  time: number
  turn: number
  step: number
}

/** A tool result paired (when in-window) with its call head. */
export interface ToolResultNode {
  kind: 'tool-result'
  seq: number
  /** Unix epoch ms from the tool/result session event. */
  time: number
  callId: string
  /** Call head backfilled from the in-window tool/call; null when window truncation left the call outside (card head shows callId). */
  call: { name: string; argsRaw: string } | null
  /** Unix epoch ms of the paired tool/call when the call is still in-window; used for call-row duration. */
  callTime: number | null
  content: readonly ContentBlock[]
  isError: boolean
  error?: { name: string; code: string }
  meta?: unknown
  /** Host-computed render intent from the paired tool/call's wire view; null = generic JSON card (documented default). */
  callView: ToolCallView | null
  /** Host-computed render intent from this tool/result's wire view; null = same default. */
  resultView: ToolResultView | null
  /** Child calls owned by this call, in dispatch order. */
  subCalls: readonly ToolCallBlock[]
}

/**
 * One landed compaction, marked at the checkpoint's own log position. The
 * conversation it shadowed on the model surface stays in the transcript above
 * it: the marker reports where the model stopped seeing that history, it does
 * not replace it. The framed checkpoint payload is an instruction envelope
 * written for the model and never renders.
 */
export interface CompactionSummaryNode {
  kind: 'compaction'
  /** Seq of the replacement `user/message` that landed the checkpoint. */
  seq: number
  /** Unix epoch ms of the checkpoint event. */
  time: number
  /** Summary text from the checkpoint's cited `compaction/summary` event; null when
   *  the window cut left that event outside (the marker is then not expandable). */
  summary: string | null
  /** Seq of the loaded `compaction/summary` event, or null when that event is outside the window. */
  summaryEventSeq: number | null
  /** Number of surface items replaced, or null when the summary event is unavailable or malformed. */
  shadowedItemCount: number | null
  /** Estimated token price of the replaced items, or null when the summary event is unavailable or malformed. */
  shadowedTokenCount: number | null
}

/**
 * Fallback for surface events this UI version does not know: the documented
 * default arm of `SessionEventMap`, which is merge-extensible, so the
 * projection's switch cannot end in `assertNever`. No event produces this node
 * today — `isAppendSurfaceEvent` admits only the three types in core's
 * `SurfaceEventType`, and each has its own arm — and it exists so widening that
 * set core-side degrades to a raw row instead of dropping the event silently.
 */
export interface UnknownSurfaceNode {
  kind: 'unknown'
  seq: number
  /** Unix epoch ms from the source session event when known. */
  time: number
  type: string
  data: unknown
}

/**
 * One slash-command lifecycle folded from the log-only `command/run` /
 * `command/done` pair (paired by commandId, mirroring tool call↔result).
 * Log-only events are not surface events, so the command Definition indexes
 * them separately and the Chat builder orders the resulting node by seq. A window cut
 * between the pair soft-falls like tool pairs: a done with no in-window run
 * still builds a node (name/args null), and a run with no done renders as
 * still executing.
 */
export interface CommandNode {
  kind: 'command'
  /** Seq of the command/run event; the done event's seq when only the done is in-window. */
  seq: number
  /** Unix epoch ms of the anchoring event. */
  time: number
  /** Pairing id minted by the host executor. */
  commandId: CommandId
  /** Command name (run payload's structured field); null when the run fell outside the window. */
  name: string | null
  /**
   * Verbatim rawInput after the name, including separator whitespace; null
   * when omitted by the command or when the run fell outside the window.
   */
  args: string | null
  /** Settlement outcome (done payload); null while the command is still executing. */
  outcome: {
    kind: 'success' | 'error'
    text?: string
    /** Earlier authoritative domain event for a richer client-computed presentation. */
    sourceEventSeq?: number
  } | null
}

/** Finalized conversation node union (kind discriminates; seq is the React key). */
export type ConversationNode =
  | UserMessageNode
  | AssistantMessageNode
  | SteeringMessageNode
  | ContextMessageNode
  | ModelRetryNode
  | TurnErrorNode
  | TurnMaxTokensNode
  | ToolResultNode
  | CommandNode
  | CompactionSummaryNode
  | UnknownSurfaceNode

/** In-flight tool card material: tool/call seen, tool/result not yet. */
export interface RunningToolCall {
  callId: string
  name: string
  argsRaw: string
  turn: number
  step: number
  /** Unix epoch ms when the tool/call event was logged. */
  time: number
  /** Host-computed render intent riding the tool/call frame; null = generic JSON card. */
  callView: ToolCallView | null
  /** Child calls owned by this call, in dispatch order. */
  subCalls: readonly ToolCallBlock[]
}

/** One running or settled call, recursively owning its child calls. */
export type ToolCallBlock = RunningToolCall | ToolResultNode

/** One transient inbox occurrence from the authoritative `session/queue` snapshot. */
export interface QueuedMessage {
  readonly id: MessageId
  /** Stable message identity used for transient-to-durable steering handoff. */
  readonly messageId: MessageId
  /** Agent-resolved placement; only queued rows accept queue mutations. */
  readonly placement: 'queued' | 'steering' | 'context'
  /** Complete content used to render pending steering before it becomes durable. */
  readonly content: readonly ContentBlock[]
  readonly preview: string
  /** Complete editable text; null when the message contains non-text blocks. */
  readonly text: string | null
}

/** In-progress assistant output (chunk accumulator product). */
export interface PartialAssistant {
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
}

/** History-open lifecycle of a Session window. */
export type OpenState = 'cold' | 'loading' | 'open' | 'error'

/**
 * Input-area shape of an OPEN session, derived at snapshot assembly (the one
 * place that knows the predicate — consumers switch, never re-derive):
 *
 * - `blank`: the authoritative blank bit is still set and no prompt was
 *   attempted — the UI renders the blank-session guidance hero.
 * - `engaging`: a first prompt was attempted, but no accepted turn or other
 *   authoritative activity signal has arrived — the UI keeps the composer
 *   visible through admission and error frames.
 * - `active`: the session is non-blank beyond its pending first prompt,
 *   contains visible non-command Chat content, is running, or owns a pending
 *   interaction — the ordinary conversation view.
 *
 * A failed first prompt stays `engaging` (composer + error strip — retry
 * semantics; returning to the hero would discard the error context).
 * Sessions whose window is not open (`loading`/`error`) are outside phase
 * jurisdiction: consumers branch on {@link ConversationSnapshot.openState}
 * first.
 */
export type ComposerPhase = 'blank' | 'engaging' | 'active'

/** Send/stop failure surfaced in the input error strip; op picks the user-facing copy (发送失败 vs 停止失败). */
export interface PromptError {
  op: 'send' | 'stop'
  error: RpcError
}

/**
 * Stable live per-key reader. An old ChatSnapshot observes later flushes
 * through this store.
 */
export interface ChatNodeStore {
  /** @param key - stable Conversation Context key. @returns current Node, when visible or hidden. */
  get(key: string): ChatConversationViewNode | undefined
  /** @returns all currently materialized Nodes without imposing render order. */
  values(): readonly ChatConversationViewNode[]
}

/**
 * Stable live Location index. An old ChatSnapshot observes later membership
 * changes through this index.
 */
export interface ChatLocationNodeIndex {
  /** @param turn - owning turn. @returns ordered Chat Node keys in the turn. */
  getTurn(turn: number): readonly string[]
  /** @param turn - owning turn. @param step - owning step. @returns ordered Chat Node keys in the step. */
  getStep(turn: number, step: number): readonly string[]
}

/** Compatibility projection backing StatsLine and the legacy top-level snapshot fields. */
export interface LegacyConversationSlice {
  readonly nodes: readonly ConversationNode[]
  readonly turnTimings: ReadonlyMap<number, { readonly startTime: number; readonly endTime?: number }>
  readonly turnEnds: ReadonlyMap<number, number>
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
}

/** Incremental Chat publication with immutable order and stable live keyed readers. */
export interface ChatSnapshot {
  readonly order: readonly string[]
  readonly nodes: ChatNodeStore
  readonly locations: ChatLocationNodeIndex
  readonly timeline: ConversationTimelineSnapshot
  readonly legacy: LegacyConversationSlice
}

const EMPTY_LIST: readonly never[] = []
const EMPTY_TIMELINE: ConversationTimelineSnapshot = { turnOrder: EMPTY_LIST, turns: new Map() }

/** Empty target store used by fixtures and Sessions without registered views. */
export const EMPTY_CONVERSATION_VIEWS: ConversationViewSnapshotStore = {
  get: () => undefined,
}

/** Empty Chat target used before a view builder is registered. */
export const EMPTY_CHAT_SNAPSHOT: ChatSnapshot = {
  order: EMPTY_LIST,
  nodes: {
    get: () => undefined,
    values: () => EMPTY_LIST,
  },
  locations: {
    getTurn: () => EMPTY_LIST,
    getStep: () => EMPTY_LIST,
  },
  timeline: EMPTY_TIMELINE,
  legacy: {
    nodes: EMPTY_LIST,
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: EMPTY_LIST,
  },
}

/** The immutable snapshot contract Session hands to uSES (see the web client architecture RFC). */
export interface ConversationSnapshot {
  sessionId: SessionId
  /** Registered target snapshots assembled from Session events. */
  views: ConversationViewSnapshotStore
  /** Final Chat target assembled from independently registered business Definitions. */
  chat: ChatSnapshot
  /** Legacy top-level compatibility field mirrored from the registered Chat Definitions. */
  nodes: readonly ConversationNode[]
  /** Exact in-window `turn/start` time and optional matching `turn/end` time. */
  turnTimings: ReadonlyMap<number, { readonly startTime: number; readonly endTime?: number }>
  /** In-window completed turn number -> its `turn/end` event seq. */
  turnEnds: ReadonlyMap<number, number>
  partial: PartialAssistant | null
  runningCalls: readonly RunningToolCall[]
  pending: readonly PendingInteraction[]
  /** Authoritative transient inbox snapshot, including queued and steering placements. */
  queue: readonly QueuedMessage[]
  running: boolean
  /**
   * Catalog-discovered continuation address. Its parent availability controls
   * human input; null means ordinary session transport.
   */
  subagent: { address: SubagentAddress; parentAvailable: boolean } | null
  /** Input-area shape (see {@link ComposerPhase}); derived here, switched on by consumers. */
  composerPhase: ComposerPhase
  /** Set after host/session-removed; the UI grays out and disables input. */
  removed: boolean
  openState: OpenState
  openError: RpcError | null
  hasMore: boolean
  loadingOlder: boolean
  promptError: PromptError | null
  /**
   * Whether this session still has an empty log (no user message yet).
   * Mirrors the host summary's derived blank bit: seeded from `session.list`
   * / the `host/session-added` frame, flipped false by the first ACCEPTED
   * prompt locally (on the RPC success response — acceptance proves the
   * user message is in the host log; a rejected first prompt keeps the
   * session blank and reusable) and by any `running: true` status remotely,
   * and re-aligned by every list re-pull (the summary stays authoritative).
   * Blank sessions are hidden from session lists and reused by New Session.
   */
  blank: boolean
  lastAgentError: string | null
}
