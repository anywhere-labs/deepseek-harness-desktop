/**
 * sessions domain zod schemas (names derived from map keys: sessionListRequestSchema /
 * sessionListValueSchema). SessionEvent passthrough = strict envelope (type/seq/time) + wide
 * data: the merge-extensible event API keeps an unknown-type branch at the union level,
 * with no field-level passthrough. SessionId brand cast point: sessionIdSchema, and only there.
 */

import { z } from 'zod'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type {
  HistoryEntry, ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  ModelReasoningEffort, ModelSelection, SessionListMetadata, SessionProjectionsBlock, SessionSearchItem, SessionSummary,
} from './sessions.ts'
import type { ToolEventView } from './events.ts'
import type { AttachmentIdType, ImageAttachmentLimits, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { WorkspaceId } from './workspace.ts'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
  truncateUnicodeCodePoints,
} from './session-search.ts'

/** SessionId: one brand cast after schema validation (the only cast point in this domain). */
export const sessionIdSchema = z.string().min(1) as unknown as z.ZodType<SessionId>

/** MessageId: one brand cast after non-empty string validation. */
export const messageIdSchema = z.string().min(1) as unknown as z.ZodType<MessageId>

/**
 * WorkspaceId: the workspace domain's one brand cast. Hosted here rather
 * than in workspace.schema because session.create references it while
 * workspace.schema references sessionIdSchema — schema modules must stay a
 * DAG (both casts used at module top level; a cycle is a load-time TDZ).
 */
export const workspaceIdSchema = z.string().min(1) as unknown as z.ZodType<WorkspaceId>

/** SessionEvent passthrough: strict envelope, wide data (the client fold handles unknown types via its documented default). */
export const sessionEventSchema = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative(),
  time: z.number(),
  data: z.unknown(),
  sourceEventSeqs: z.array(z.number()).optional(),
  surfaceOp: z.unknown().optional(),
  ignorable: z.literal(true).optional(),
}) as unknown as z.ZodType<SessionEvent>

/** SessionSummary row of session.list (`projections` reuses the history block's shape and schema). */
export const sessionSummarySchema = z.object({
  sessionId: sessionIdSchema,
  updatedAt: z.number(),
  running: z.boolean(),
  blank: z.boolean(),
  parentSessionId: sessionIdSchema.optional(),
  origin: z.literal('subagent').optional(),
  cwd: z.string().optional(),
  agentPreset: z.string().optional(),
  projections: z.lazy(() => sessionProjectionsBlockSchema).optional(),
}) as unknown as z.ZodType<Wire<SessionSummary>>

/** session.list request payload (cursor is a reserved seat, unimplemented in v1). */
export const sessionListRequestSchema = z.object({
  cursor: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'session.list'>>>

/** session.list response value. */
export const sessionListValueSchema: z.ZodType<Wire<ResponseValue<'session.list'>>> = z.object({
  items: z.array(sessionSummarySchema),
})

/** Fixed wire bound for one interactive sidebar query. */
const SESSION_SEARCH_QUERY_MAX_CHARS = 500

/** session.search request payload. */
export const sessionSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(SESSION_SEARCH_QUERY_MAX_CHARS)
    .refine(query => !query.includes('\0'), { message: 'search query must not contain NUL' }),
}) satisfies z.ZodType<Wire<RequestPayload<'session.search'>>>

/** One session.search result. */
export const sessionSearchItemSchema = z.object({
  sessionId: sessionIdSchema,
  snippet: z.string().refine(
    snippet => truncateUnicodeCodePoints(
      snippet,
      SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
    ) === snippet,
    { message: `search snippet must contain at most ${SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS} Unicode code points` },
  ),
}) satisfies z.ZodType<Wire<SessionSearchItem>>

/** session.search response value. */
export const sessionSearchValueSchema = z.object({
  items: z.array(sessionSearchItemSchema).max(SESSION_SEARCH_RESULT_LIMIT),
  hasMore: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'session.search'>>>

/** session.create request payload (at most one of workspaceId / cwd). */
export const sessionCreateRequestSchema = z.object({
  workspaceId: workspaceIdSchema.optional(),
  cwd: z.string().optional(),
  sessionId: sessionIdSchema.optional(),
  agentPreset: z.string().optional(),
}).refine(
  payload => payload.workspaceId === undefined || payload.cwd === undefined,
  { message: 'session.create accepts workspaceId or cwd, not both' },
) satisfies z.ZodType<Wire<RequestPayload<'session.create'>>>

/** session.create response value. */
export const sessionCreateValueSchema = z.object({
  sessionId: sessionIdSchema,
  agentPreset: z.string().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'session.create'>>>

/** session.rename request payload (raw title; host-side normalization decides acceptance). */
export const sessionRenameRequestSchema = z.object({
  sessionId: sessionIdSchema,
  title: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'session.rename'>>>

/** session.rename response value (the normalized accepted title and its event seq). */
export const sessionRenameValueSchema = z.object({
  title: z.string().min(1),
  seq: z.number().int().nonnegative(),
}) satisfies z.ZodType<Wire<ResponseValue<'session.rename'>>>

/** session.fork request payload (atSeq anchors the completed-turn cut). */
export const sessionForkRequestSchema = z.object({
  sessionId: sessionIdSchema,
  atSeq: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'session.fork'>>>

/** session.fork response value (the child session id). */
export const sessionForkValueSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'session.fork'>>>

/** session.history request payload (beforeSeq/maxMessages page backwards from the window tail). */
export const sessionHistoryRequestSchema = z.object({
  sessionId: sessionIdSchema,
  beforeSeq: z.number().int().nonnegative().optional(),
  maxMessages: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'session.history'>>>

/** Complete provider/model selection. */
export const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<ModelSelection>>

/** One adapter-owned reasoning effort. */
export const modelReasoningEffortSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
}) satisfies z.ZodType<Wire<ModelReasoningEffort>>

/** Exact-model reasoning metadata. */
export const modelReasoningSchema = z.object({
  efforts: z.array(modelReasoningEffortSchema).min(1),
  defaultEffort: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<ModelReasoning>>

/** One advisory model entry inside a provider group. */
export const modelCatalogModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  reasoning: modelReasoningSchema.optional(),
}) satisfies z.ZodType<Wire<ModelCatalogModel>>

/** One successfully loaded provider group. */
export const modelProviderGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  models: z.array(modelCatalogModelSchema),
}) satisfies z.ZodType<Wire<ModelProviderGroup>>

/** One provider-local catalog failure. */
export const modelCatalogFailureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  message: z.string(),
}) satisfies z.ZodType<Wire<ModelCatalogFailure>>

/**
 * ToolEventView passthrough: lock only the `for` discriminant and the presence
 * of a card-tagged `view` object. The view interior is a host-computed product
 * the client reads without echoing back; deep-validating it would hand-copy
 * the dsh-tools vocabulary into this schema and drift with it.
 */
export const toolEventViewSchema = z.discriminatedUnion('for', [
  z.object({ for: z.literal('call'), view: z.looseObject({ card: z.string() }) }),
  z.object({ for: z.literal('result'), view: z.looseObject({ card: z.string() }) }),
]) as unknown as z.ZodType<ToolEventView>

/** One session.history item: the session event plus its optional host-computed tool view. */
export const historyEntrySchema: z.ZodType<Wire<HistoryEntry>> = z.object({
  event: sessionEventSchema,
  view: toolEventViewSchema.optional(),
}) as unknown as z.ZodType<Wire<HistoryEntry>>

/**
 * Projection baseline passthrough: `values` stays a wide record — each value
 * was already parsed by its provider's own schema on the host side, and
 * deep-validating here would import every domain's schema into the carrier.
 */
export const sessionProjectionsBlockSchema = z.object({
  // -1 = empty log (the lastSeq convention of session/subscribed).
  asOfSeq: z.number().int().min(-1),
  values: z.record(z.string(), z.unknown()),
}) as unknown as z.ZodType<Wire<SessionProjectionsBlock>>

/** Host-side validation for the persisted Session-list projection. */
export const sessionListMetadataProjectionSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

/**
 * imageLimits projection unit schema (host-side view validation). zod widens
 * `readonly ImageMediaType[]` to `string[]`; on the JSON wire the two
 * serialize identically, so the cast records exactly that widening.
 */
export const imageLimitsProjectionSchema = z.object({
  maxImageBytes: z.number().int().positive(),
  maxImagesPerMessage: z.number().int().positive(),
  maxMessageImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  mediaTypes: z.array(z.string()),
}) as unknown as z.ZodType<ImageAttachmentLimits>

/** session.history response value (projections rides the tail page only). */
export const sessionHistoryValueSchema: z.ZodType<Wire<ResponseValue<'session.history'>>> = z.object({
  events: z.array(historyEntrySchema),
  hasMore: z.boolean(),
  projections: sessionProjectionsBlockSchema.optional(),
})

/** session.models request payload. */
export const sessionModelsRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'session.models'>>>

/** session.models response value. */
export const sessionModelsValueSchema = z.object({
  current: modelSelectionSchema,
  routable: z.boolean(),
  groups: z.array(modelProviderGroupSchema),
  failures: z.array(modelCatalogFailureSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'session.models'>>>

/** session.selectModel request payload. */
export const sessionSelectModelRequestSchema = z.object({
  sessionId: sessionIdSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'session.selectModel'>>>

/** session.selectModel response value. */
export const sessionSelectModelValueSchema = z.object({
  selected: modelSelectionSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'session.selectModel'>>>

/** ContentBlock passthrough: core is merge-extensible — the type discriminant envelope is strict, the rest stays wide. */
export const contentBlockSchema = z.looseObject({ type: z.string() })

/** Raster image media types accepted by the version-one browser wire. */
export const imageMediaTypeSchema = z.union([
  z.literal('image/png'),
  z.literal('image/jpeg'),
  z.literal('image/webp'),
  z.literal('image/gif'),
])

/** Prompt wire content is intentionally narrower than merge-extensible durable core content. */
export const promptContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), mediaType: imageMediaTypeSchema, data: z.string(), name: z.string().optional() }),
])

/** session.prompt request payload, including optional browser-local request provenance. */
export const sessionPromptRequestSchema = z.object({
  sessionId: sessionIdSchema,
  mode: z.union([z.literal('queue'), z.literal('steer')]),
  content: z.array(promptContentPartSchema),
  clientTimeZone: z.string().optional(),
}) as unknown as z.ZodType<RequestPayload<'session.prompt'>>

/** session.prompt response value (the command slot appears only when the prompt dispatched a slash command). */
export const sessionPromptValueSchema = z.object({
  accepted: z.literal(true),
  command: z.object({
    kind: z.literal('success'),
    text: z.string().optional(),
  }).optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'session.prompt'>>>

/** Opaque attachment id after string-shape validation. */
export const attachmentIdSchema = z.string().min(1) as unknown as z.ZodType<AttachmentIdType>

/** Durable image reference returned from the authenticated session lookup. */
export const imageAttachmentRefSchema = z.object({
  attachmentId: attachmentIdSchema,
  mediaType: imageMediaTypeSchema,
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().optional(),
}) as unknown as z.ZodType<ImageAttachmentRef>

/** session.attachment request payload. */
export const sessionAttachmentRequestSchema = z.object({
  sessionId: sessionIdSchema,
  attachmentId: attachmentIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'session.attachment'>>>

/** session.attachment response value. */
export const sessionAttachmentValueSchema = z.object({
  attachment: imageAttachmentRefSchema,
  data: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'session.attachment'>>>

/** session.updateQueue request payload. */
export const sessionUpdateQueueRequestSchema = z.object({
  sessionId: sessionIdSchema,
  itemId: messageIdSchema,
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('edit'), content: z.array(contentBlockSchema) }),
    z.object({ kind: z.literal('remove') }),
    z.object({ kind: z.literal('steer') }),
  ]),
}) as unknown as z.ZodType<RequestPayload<'session.updateQueue'>>

/** session.updateQueue response value. */
export const sessionUpdateQueueValueSchema = z.object({
  accepted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'session.updateQueue'>>>

/** session.cancel request payload. */
export const sessionCancelRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'session.cancel'>>>

/** session.cancel response value. */
export const sessionCancelValueSchema = z.object({
  accepted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'session.cancel'>>>

/** session.delete request payload. */
export const sessionDeleteRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'session.delete'>>>

/** session.delete response value. */
export const sessionDeleteValueSchema = z.object({
  deleted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'session.delete'>>>
