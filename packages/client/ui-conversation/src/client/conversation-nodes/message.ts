import type { Context } from '@deepseek-ai/cordis'
import type {
  ContextMessageNode, ConversationNodeDefinition, SteeringMessageNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  contextForm, contextProvenance, isAppendSurfaceEvent, isReplacementSurfaceEvent,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { InboxState } from './inbox.ts'
import { chatNode } from './common.ts'

type MessageNode = UserMessageNode | SteeringMessageNode | ContextMessageNode

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Ordinary turn-opening user message. */
    user: UserMessageNode
    /** User message admitted into an active turn. */
    steering: SteeringMessageNode
    /** Non-user context injected into model history. */
    context: ContextMessageNode
  }
}

function isCompactionCheckpoint(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return false
  const source = event.data.source
  return source.kind === 'plugin' && source.plugin === 'compact'
}

/** User, steering, and injected-context message classification Definition. */
export const messageDefinition: ConversationNodeDefinition<MessageNode> = {
  kind: 'input-message',
  target: 'chat',
  match: (event) => {
    if (event.type === 'user/message' && isAppendSurfaceEvent(event) && !isCompactionCheckpoint(event)) {
      return { id: String(event.data.id), role: 'start' }
    }
    // An edit shadows its target on the model surface; the UI folds it into
    // the SAME node (same message id) instead of appending a second bubble.
    if (event.type === 'user/message' && isReplacementSurfaceEvent(event) && !isCompactionCheckpoint(event)) {
      return { id: String(event.data.id), role: 'update' }
    }
    return null
  },
  start: (_context, match, reader) => {
    if (match.event.type !== 'user/message') throw new Error('input-message start requires user/message')
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
    const claimed = reader.previous<InboxState>('inbox-next-step')?.state.claimed.has(String(event.data.id)) === true
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
  update: (context, match) => {
    if (match.event.type !== 'user/message' || context.state.kind !== 'user') return context.state
    // In-place edit: replace the visible text blocks, keep the node identity
    // and position. Non-text blocks of the original (images, attachments) are
    // preserved as they were; only the text the user rewrote changes.
    return {
      ...context.state,
      content: match.event.data.content,
    }
  },
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNode(context, context.state.kind, context.state.seq, context.state)
  },
}

/**
 * Register the user, steering, and injected-context message contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerMessageConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(messageDefinition)
}
