import type { Context } from '@deepseek-ai/cordis'
import type {
  ContextMessageNode, ConversationNodeDefinition, ConversationPreviousContext,
  SteeringMessageNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  contextForm, contextProvenance,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-agent/types'
import { trajectoryNode } from './trajectory-definition-common.ts'

/* jscpd:ignore-start -- Target-owned Definitions intentionally keep their event
 * state machines independent; see ../../../../../.agents/notes/implemented/
 * architecture/2026-08-09-client-conversation-node-assembly.md. */
interface InboxIdentity {
  readonly id: string
}

interface InboxSplice {
  readonly start: number
  readonly removedCount?: number
  readonly inserted: readonly InboxIdentity[]
  readonly outcome?: 'canceled'
}

interface InboxState {
  readonly pending: readonly InboxIdentity[]
  readonly claimed: ReadonlySet<string>
}

type MessageNode = UserMessageNode | SteeringMessageNode | ContextMessageNode

function applySplice(
  previous: ConversationPreviousContext<InboxState> | undefined,
  splice: InboxSplice,
): InboxState {
  const pending = [...(previous?.state.pending ?? [])]
  const claimed = new Set(previous?.state.claimed ?? [])
  const removed = pending.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
  for (const identity of splice.inserted) claimed.delete(identity.id)
  if (splice.outcome !== 'canceled') {
    for (const identity of removed) claimed.add(identity.id)
  }
  return { pending, claimed }
}

const trajectoryInboxDefinition: ConversationNodeDefinition<InboxState> = {
  kind: 'trajectory-inbox-next-step',
  match: event => event.type === 'agent/inbox/spliced'
    && event.data.target === 'next-step'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    if (match.event.type !== 'agent/inbox/spliced') {
      throw new Error('trajectory-inbox-next-step start requires agent/inbox/spliced')
    }
    return applySplice(
      reader.previous<InboxState>('trajectory-inbox-next-step'),
      match.event.data,
    )
  },
  update: context => context.state,
  publication: () => 'none',
}

const trajectoryMessageDefinition: ConversationNodeDefinition<MessageNode> = {
  kind: 'trajectory-input-message',
  target: 'trajectory',
  match: event => event.type === 'user/message'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    if (match.event.type !== 'user/message') {
      throw new Error('trajectory-input-message start requires user/message')
    }
    const event = match.event
    if (event.data.source.kind !== 'user') {
      return {
        kind: 'context',
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        provenance: contextProvenance(event.data.source),
        form: contextForm(event.data.source),
      }
    }
    const claimed = reader.previous<InboxState>('trajectory-inbox-next-step')
      ?.state.claimed.has(String(event.data.id)) === true
    return claimed
      ? {
        kind: 'steering',
        messageId: event.data.id,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
      }
      : {
        kind: 'user',
        messageId: event.data.id,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
      }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, { kind: 'node', node: context.state }),
}
/* jscpd:ignore-end */

/**
 * Register Trajectory-owned inbox classification and message records.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerTrajectoryMessageDefinitions(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryInboxDefinition)
  ctx.conversationEvents.register(trajectoryMessageDefinition)
}
