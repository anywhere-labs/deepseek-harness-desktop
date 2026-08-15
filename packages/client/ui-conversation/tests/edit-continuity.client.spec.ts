// @vitest-environment jsdom
/**
 * Edit continuity at the real Session level: after the message-edit fold, the
 * session must remain usable — the next user message appends a new node, the
 * composer phase stays active, and nothing marks the session removed.
 */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { Session } from '../../runtime/src/client/sessions/session.ts'
import type { ConversationRuntime, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { commandDefinition } from '../src/client/conversation-nodes/command.ts'
import { compactionDefinition } from '../src/client/conversation-nodes/compaction.ts'
import { unknownFallbackDefinition } from '../src/client/conversation-nodes/fallback.ts'
import { nextStepInboxDefinition, nextTurnInboxDefinition } from '../src/client/conversation-nodes/inbox.ts'
import { messageDefinition } from '../src/client/conversation-nodes/message.ts'
import { retryDefinition } from '../src/client/conversation-nodes/retry.ts'
import { toolDefinition } from '../src/client/conversation-nodes/tool.ts'
import { turnErrorDefinition } from '../src/client/conversation-nodes/turn-error.ts'
import { turnMaxTokensDefinition } from '../src/client/conversation-nodes/turn-max-tokens.ts'
import { turnTailDefinition } from '../src/client/conversation-nodes/turn-tail.ts'

const SID = 'edit-continuity' as SessionId

const DEFINITIONS: ConversationRuntime['events'] = {
  entries: () => [
    nextTurnInboxDefinition, nextStepInboxDefinition, messageDefinition, assistantDefinition,
    toolDefinition, commandDefinition, compactionDefinition, retryDefinition, turnErrorDefinition,
    turnMaxTokensDefinition, turnTailDefinition,
  ],
  fallbackEntry: () => unknownFallbackDefinition,
} as unknown as ConversationRuntime['events']
const VIEWS: ConversationRuntime['views'] = {
  entries: () => [chatViewDefinition],
} as unknown as ConversationRuntime['views']

const at = (seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): SessionEvent =>
  ({ seq, time: 1_700_000_000_000 + seq, type, data, ...extra }) as unknown as SessionEvent

/** One completed turn: turn/start .. turn/end, from `startSeq` (6 events). */
function oneTurn(startSeq: number, turn: number, ask: string, answer: string): SessionEvent[] {
  const user = createUserMessage({ content: [{ type: 'text', text: ask }], source: { kind: 'user' } })
  const assistant = createMessage({
    role: 'assistant',
    content: [{ type: 'text', text: answer }],
    source: { kind: 'model', provider: 'mock', model: 'mock' },
  })
  return [
    at(startSeq, 'turn/start', { turn }),
    at(startSeq + 1, 'user/message', user, { surfaceOp: 'append' }),
    at(startSeq + 2, 'step/start', { turn, step: 1 }),
    at(startSeq + 3, 'assistant/message', { turn, step: 1, message: assistant, provenance: { provider: 'mock', model: 'mock' } }, { surfaceOp: 'append' }),
    at(startSeq + 4, 'step/end', { turn, step: 1 }),
    at(startSeq + 5, 'turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

function fakeApi(history: SessionEvent[]) {
  return {
    sessions: {
      history: () => Promise.resolve({ rpcId: 'h' as never, result: { ok: true, value: { events: history.map(event => ({ event })), hasMore: false } } }),
      prompt: () => Promise.resolve({ rpcId: 'p' as never, result: { ok: true, value: { accepted: true as const } } }),
    },
  } as never
}

function userNodes(snapshot: ConversationSnapshot): { kind: string; messageId: unknown; seq: number; content: unknown }[] {
  return [...snapshot.chat.nodes.values()]
    .map(node => ({ data: node.data as { kind?: string; messageId?: unknown; seq?: number; content?: unknown } | undefined }))
    .filter(entry => entry.data?.kind === 'user')
    .map(entry => ({
      kind: entry.data!.kind as string,
      messageId: entry.data!.messageId,
      seq: entry.data!.seq as number,
      content: entry.data!.content,
    }))
}

describe('edit continuity on the real Session', () => {
  it('keeps the session usable after the edit fold and the next turn', async () => {
    const turn1 = oneTurn(0, 1, '第一问', '第一答')
    const session = new Session(SID, fakeApi(turn1), {} as never, {
      conversation: { events: DEFINITIONS, views: VIEWS } as unknown as ConversationRuntime,
    })
    await session.open()
    let snapshot = session.getSnapshot()
    expect(snapshot.openState).toBe('open')
    expect(userNodes(snapshot).map(node => node.messageId)).toEqual([expect.any(String)])
    const originalId = userNodes(snapshot)[0]!.messageId as MessageId

    // The edit arrives as a host-mutated replacement (cold sessions fold it
    // locally; the seq guard dedups the live broadcast). The replacement
    // carries the ORIGINAL message id — the client rebuilds it from the edit
    // request, exactly like the message-edit hook in apply.ts.
    session.acceptHostEvent({
      type: 'user/message',
      seq: 6,
      time: 1_700_000_000_006,
      data: {
        id: originalId,
        role: 'user',
        content: [{ type: 'text', text: '第一问已编辑' }],
        source: { kind: 'user' },
      },
      surfaceOp: { op: 'replace', start: 1, end: 1 },
      sourceEventSeqs: [1],
    })
    snapshot = session.getSnapshot()
    expect(userNodes(snapshot)).toHaveLength(1)
    const edited = userNodes(snapshot)[0]!
    expect(edited.messageId).toBe(originalId)
    expect(JSON.stringify(edited.content)).toContain('第一问已编辑')

    // A SECOND edit of the same message keeps folding into the same node.
    session.acceptHostEvent({
      type: 'user/message',
      seq: 7,
      time: 1_700_000_000_007,
      data: {
        id: originalId,
        role: 'user',
        content: [{ type: 'text', text: '第一问再次编辑' }],
        source: { kind: 'user' },
      },
      surfaceOp: { op: 'replace', start: 6, end: 6 },
      sourceEventSeqs: [6],
    })
    snapshot = session.getSnapshot()
    expect(userNodes(snapshot)).toHaveLength(1)
    expect(JSON.stringify(userNodes(snapshot)[0]!.content)).toContain('第一问再次编辑')

    // The next turn appends a new user message: the edited node keeps its
    // identity, a second user node appears, and the session stays usable.
    const turn2 = oneTurn(8, 2, '第二问', '第二答')
    for (const event of turn2) {
      session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event })
    }
    snapshot = session.getSnapshot()
    expect(userNodes(snapshot).map(node => node.messageId)).toEqual([originalId, expect.any(String)])
    expect(userNodes(snapshot)[1]!.content ? JSON.stringify(userNodes(snapshot)[1]!.content) : '').toContain('第二问')
    expect(snapshot.removed).toBe(false)
    expect(snapshot.composerPhase).not.toBe('blank')
  })
})
