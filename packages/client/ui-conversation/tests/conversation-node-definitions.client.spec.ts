import { describe, expect, it } from 'vitest'
import type {
  ChatConversationViewNode, ChatSnapshot, ConversationEventInput,
  ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
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
import type {
  AssistantChatData, ManualCompactionChatData, RetryChatData, ToolChatData, TurnTailChatData,
} from '../src/client/contract/chat-nodes.ts'

const DEFINITIONS: readonly ConversationNodeDefinition[] = [
  nextTurnInboxDefinition,
  nextStepInboxDefinition,
  messageDefinition,
  assistantDefinition,
  toolDefinition,
  commandDefinition,
  compactionDefinition,
  retryDefinition,
  turnErrorDefinition,
  turnMaxTokensDefinition,
  turnTailDefinition,
]

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return DEFINITIONS
  }

  fallbackEntry(): ConversationNodeDefinition {
    return unknownFallbackDefinition
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
  }
}

function at(
  seq: number,
  type: string,
  data: unknown,
  extra: Record<string, unknown> = {},
): ConversationEventInput {
  return {
    event: {
      seq,
      time: 1_700_000_000_000 + seq,
      type,
      data,
      ...extra,
    } as unknown as ConversationEventInput['event'],
    view: undefined,
  }
}

function assembler(entries: readonly ConversationEventInput[] = [], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, hasMore)
  value.flush()
  return value
}

function snapshot(value: ConversationNodeAssembler): ChatSnapshot {
  const current = value.snapshot('chat') as ChatSnapshot | undefined
  if (current === undefined) throw new Error('chat view was not registered')
  return current
}

function node(value: ChatSnapshot, kind: string): ChatConversationViewNode | undefined {
  return value.nodes.values().find(candidate => candidate.kind === kind)
}

function textMessage(id: string, text: string) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistantMessage(id: string, text: string) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'fake', model: 'fake' },
  }
}

function toolResult(callId: string, text: string) {
  return {
    id: `result-${callId}`,
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      content: [{ type: 'text', text }],
      isError: false,
    }],
  }
}

describe('built-in conversation node Definitions', () => {
  it('keeps one keyed Assistant node while streaming settles and materializes interruption from Location', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'streaming' },
      }),
    ])
    const runningSnapshot = snapshot(value)
    const running = node(runningSnapshot, 'assistant-step')
    expect(running?.data).toMatchObject({ status: 'running', blocks: [{ kind: 'text', text: 'streaming' }] })
    const order = runningSnapshot.order

    value.append(at(4, 'assistant/message', {
      turn: 1,
      step: 1,
      message: assistantMessage('assistant-1', 'settled'),
    }, { surfaceOp: 'append' }))
    value.flush()

    const settledSnapshot = snapshot(value)
    const settled = node(settledSnapshot, 'assistant-step')
    expect(settled?.key).toBe(running?.key)
    expect(settledSnapshot.order).toBe(order)
    expect(settled?.data).toMatchObject({ status: 'settled', blocks: [{ kind: 'text', text: 'settled' }] })

    const interruptedValue = assembler([
      at(10, 'turn/start', { turn: 2 }),
      at(11, 'step/start', { turn: 2, step: 1 }),
      at(12, 'assistant/chunk', {
        turn: 2,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'partial' },
      }),
      at(13, 'step/end', { turn: 2, step: 1 }),
    ])
    const interrupted = node(snapshot(interruptedValue), 'assistant-step')
    expect(interrupted?.data).toMatchObject({ status: 'interrupted' })
    expect((interrupted?.data as AssistantChatData).finalNode?.interrupted).toBe(true)

    const hiddenValue = assembler([
      at(20, 'turn/start', { turn: 3 }),
      at(21, 'step/start', { turn: 3, step: 1 }),
      at(22, 'llm/retry', {
        retryId: 'retry-hidden',
        turn: 3,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'temporary' },
      }),
    ])
    expect(node(snapshot(hiddenValue), 'assistant-step')).toBeUndefined()

    const toolOnlyValue = assembler([
      at(30, 'turn/start', { turn: 4 }),
      at(31, 'step/start', { turn: 4, step: 1 }),
      at(32, 'assistant/chunk', {
        turn: 4,
        step: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read', argumentsDelta: '' },
      }),
      at(33, 'assistant/message', {
        turn: 4,
        step: 1,
        message: {
          ...assistantMessage('assistant-tool-only', ''),
          content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
        },
      }, { surfaceOp: 'append' }),
    ])
    const toolOnlySnapshot = snapshot(toolOnlyValue)
    expect(toolOnlySnapshot.order).toEqual([])
    expect(node(toolOnlySnapshot, 'assistant-step')?.visibility).toBe('hidden')
    expect(toolOnlySnapshot.legacy.nodes).toMatchObject([{
      kind: 'assistant',
      seq: 33,
      timing: { firstTokenTime: 1_700_000_000_032 },
    }])

    const interruptedToolOnlyValue = assembler([
      at(35, 'turn/start', { turn: 5 }),
      at(36, 'step/start', { turn: 5, step: 1 }),
      at(37, 'assistant/chunk', {
        turn: 5,
        step: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: 'call-2', name: 'read', argumentsDelta: '' },
      }),
      at(38, 'step/end', { turn: 5, step: 1 }),
    ])
    const interruptedToolOnly = node(snapshot(interruptedToolOnlyValue), 'assistant-step')
    expect(interruptedToolOnly?.visibility).toBe('visible')
    expect(interruptedToolOnly?.data).toMatchObject({ status: 'interrupted' })

    const retryTimingValue = assembler([
      at(50, 'turn/start', { turn: 6 }),
      at(51, 'step/start', { turn: 6, step: 1 }),
      at(52, 'assistant/chunk', {
        turn: 6,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'first attempt' },
      }),
      at(53, 'llm/retry', {
        retryId: 'retry-timing', turn: 6, step: 1, provider: 'fake', mode: 'normal',
        policyKey: 'fake-normal', retry: 1, maxRetries: 2, delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'temporary' },
      }),
      at(54, 'assistant/chunk', {
        turn: 6,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'second attempt' },
      }),
      at(55, 'assistant/message', {
        turn: 6,
        step: 1,
        message: assistantMessage('assistant-retried', 'done'),
      }, { surfaceOp: 'append' }),
    ])
    const retryTiming = (node(snapshot(retryTimingValue), 'assistant-step')?.data as AssistantChatData).finalNode
    expect(retryTiming?.timing?.firstTokenTime).toBe(1_700_000_000_052)

    const partialWindow = assembler([
      at(40, 'assistant/chunk', {
        turn: 5,
        step: 2,
        chunk: { type: 'text-delta', index: 0, text: 'loaded partial' },
      }),
      at(41, 'step/end', { turn: 5, step: 2 }),
    ], true)
    const recovered = node(snapshot(partialWindow), 'assistant-step')
    expect(recovered?.data).toMatchObject({
      status: 'interrupted',
      blocks: [{ kind: 'text', text: 'loaded partial' }],
    })
  })

  it('keeps one keyed Tool node from running through settlement and replays nested dispatch after prepend', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', { turn: 1, step: 1, callId: 'root', name: 'code', arguments: '{}' }),
    ])
    const runningSnapshot = snapshot(value)
    const running = node(runningSnapshot, 'tool-call')
    expect((running?.data as ToolChatData).root).toMatchObject({ callId: 'root', name: 'code' })
    const order = runningSnapshot.order

    value.append(at(4, 'tool/result', {
      turn: 1,
      step: 1,
      message: toolResult('root', 'done'),
    }, { surfaceOp: 'append' }))
    value.flush()

    const settledSnapshot = snapshot(value)
    const settled = node(settledSnapshot, 'tool-call')
    expect(settled?.key).toBe(running?.key)
    expect(settledSnapshot.order).toBe(order)
    expect((settled?.data as ToolChatData).root).toMatchObject({ kind: 'tool-result', callId: 'root' })

    const history = assembler([
      at(14, 'tool/code-dispatch-start', {
        rootCallId: 'history-root',
        parentCallId: 'history-root',
        subCallId: 'child',
        name: 'read',
        arguments: { path: 'README.md' },
      }),
      at(15, 'tool/code-dispatch', {
        rootCallId: 'history-root',
        parentCallId: 'history-root',
        subCallId: 'child',
        name: 'read',
        arguments: { path: 'README.md' },
        isError: false,
        content: [{ type: 'text', text: 'contents' }],
      }),
      at(16, 'tool/result', {
        turn: 2,
        step: 1,
        message: toolResult('history-root', 'root done'),
      }, { surfaceOp: 'append' }),
    ], true)
    const before = node(snapshot(history), 'tool-call')
    expect((before?.data as ToolChatData).root.subCalls).toMatchObject([
      { kind: 'tool-result', callId: 'child', call: { name: 'read' } },
    ])

    history.prepend([
      at(10, 'turn/start', { turn: 2 }),
      at(11, 'step/start', { turn: 2, step: 1 }),
      at(13, 'tool/call', {
        turn: 2,
        step: 1,
        callId: 'history-root',
        name: 'code',
        arguments: '{}',
      }),
    ], false)
    history.flush()

    const after = node(snapshot(history), 'tool-call')
    expect(after?.key).toBe(before?.key)
    expect((after?.data as ToolChatData).root.subCalls).toMatchObject([
      { kind: 'tool-result', callId: 'child', call: { name: 'read' } },
    ])

    const firstChild = (after?.data as ToolChatData).root.subCalls[0]
    history.append(at(17, 'tool/code-dispatch-start', {
      rootCallId: 'history-root',
      parentCallId: 'history-root',
      subCallId: 'second-child',
      name: 'write',
      arguments: { path: 'out.txt' },
    }))
    history.flush()
    const withSecondChild = node(snapshot(history), 'tool-call')
    expect((withSecondChild?.data as ToolChatData).root.subCalls[0]).toBe(firstChild)
  })

  it('prepends an older turn without replacing already materialized nodes', () => {
    const value = assembler([
      at(20, 'turn/start', { turn: 2 }),
      at(21, 'user/message', textMessage('newer-user', 'newer'), { surfaceOp: 'append' }),
      at(22, 'step/start', { turn: 2, step: 1 }),
      at(23, 'assistant/message', {
        turn: 2,
        step: 1,
        message: assistantMessage('newer-assistant', 'newer answer'),
      }, { surfaceOp: 'append' }),
      at(24, 'step/end', { turn: 2, step: 1 }),
      at(25, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ], true)
    const before = snapshot(value)
    const existing = before.nodes.get(before.order.find(key => before.nodes.get(key)?.kind === 'assistant-step') ?? '')
    const store = before.nodes

    value.prepend([
      at(10, 'turn/start', { turn: 1 }),
      at(11, 'user/message', textMessage('older-user', 'older'), { surfaceOp: 'append' }),
      at(12, 'step/start', { turn: 1, step: 1 }),
      at(13, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('older-assistant', 'older answer'),
      }, { surfaceOp: 'append' }),
      at(14, 'step/end', { turn: 1, step: 1 }),
      at(15, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], false)
    value.flush()

    const after = snapshot(value)
    expect(after.nodes).toBe(store)
    expect(after.nodes.get(existing?.key ?? '')).toBe(existing)
    expect(after.order).toHaveLength(before.order.length + 3)
    expect(after.order.map(key => after.nodes.get(key)?.kind)).toEqual([
      'user', 'assistant-step', 'turn-tail',
      'user', 'assistant-step', 'turn-tail',
    ])
  })

  it('appends a later turn without replacing nodes from the completed turn', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'user/message', textMessage('first-user', 'first'), { surfaceOp: 'append' }),
      at(3, 'step/start', { turn: 1, step: 1 }),
      at(4, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('first-assistant', 'first answer'),
      }, { surfaceOp: 'append' }),
      at(5, 'step/end', { turn: 1, step: 1 }),
      at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const before = snapshot(value)
    const oldOrder = before.order
    const oldNodes = oldOrder.map(key => before.nodes.get(key))

    value.append(at(7, 'turn/start', { turn: 2 }))
    value.append(at(8, 'user/message', textMessage('second-user', 'second'), { surfaceOp: 'append' }))
    value.flush()

    const after = snapshot(value)
    expect(after.nodes).toBe(before.nodes)
    expect(after.order.slice(0, oldOrder.length)).toEqual(oldOrder)
    expect(oldOrder.map(key => after.nodes.get(key))).toEqual(oldNodes)
    expect(after.order.map(key => after.nodes.get(key)?.kind)).toEqual([
      'user', 'assistant-step', 'turn-tail', 'user',
    ])
  })

  it('keeps branching unavailable when a tool result follows the closing Assistant', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('assistant-before-tool', 'running a tool'),
      }, { surfaceOp: 'append' }),
      at(4, 'tool/call', { turn: 1, step: 1, callId: 'late-tool', name: 'read', arguments: '{}' }),
      at(5, 'tool/result', {
        turn: 1,
        step: 1,
        message: toolResult('late-tool', 'done'),
      }, { surfaceOp: 'append' }),
      at(6, 'step/end', { turn: 1, step: 1 }),
      at(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])

    const tail = node(snapshot(value), 'turn-tail')?.data as TurnTailChatData
    expect(tail.closing?.finalNode.seq).toBe(3)
    expect(tail.branchUnavailable).toBe(true)
  })

  it('replays inbox predecessors after prepend and reclassifies the dependent message as steering', () => {
    const value = assembler([
      at(3, 'user/message', textMessage('steer-1', 'change direction'), { surfaceOp: 'append' }),
    ], true)
    const before = node(snapshot(value), 'user')
    expect(before).toBeDefined()

    value.prepend([
      at(1, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        inserted: [textMessage('steer-1', 'change direction')],
      }),
      at(2, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        removedCount: 1,
        inserted: [],
      }),
    ], false)
    value.flush()

    const after = node(snapshot(value), 'steering')
    expect(after?.key).toBe(before?.key)
    expect(after?.data).toMatchObject({ kind: 'steering', messageId: 'steer-1' })
    expect(node(snapshot(value), 'user')).toBeUndefined()
  })

  it('orders claimed steering after the finalized Turn tail', () => {
    const steering = textMessage('steer-after-answer', 'change direction')
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('assistant-before-steering', 'initial answer'),
      }, { surfaceOp: 'append' }),
      at(4, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        inserted: [steering],
      }),
      at(5, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        removedCount: 1,
        inserted: [],
      }),
      at(6, 'user/message', steering, { surfaceOp: 'append' }),
      at(7, 'step/end', { turn: 1, step: 1 }),
      at(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])

    const current = snapshot(value)
    const steeringNode = node(current, 'steering')
    expect(steeringNode).toBeDefined()
    expect(current.locations.getTurn(1).at(-1)).toBe(steeringNode?.key)
  })

  it('classifies appended producer context from durable source metadata', () => {
    const value = assembler([
      at(1, 'user/message', {
        ...textMessage('skill-context', 'follow these instructions'),
        source: { kind: 'skill-invocation', name: 'demo-skill', form: 'instructions' },
      }, { surfaceOp: 'append' }),
    ])

    expect(node(snapshot(value), 'context')?.data).toMatchObject({
      kind: 'context',
      provenance: { role: 'inject', label: 'demo-skill' },
      form: 'instructions',
    })
  })

  it('keeps replacement copies out of Chat business nodes', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'user/message', {
        ...textMessage('replacement-user', 'model-only context'),
        source: { kind: 'plugin', plugin: 'foreign' },
      }, { surfaceOp: { op: 'replace', start: 1, end: 1 } }),
      at(4, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('replacement-assistant', 'rewritten answer'),
      }, { surfaceOp: { op: 'replace', start: 2, end: 2 } }),
      at(5, 'tool/call', { turn: 1, step: 1, callId: 'root', name: 'read', arguments: '{}' }),
      at(6, 'tool/result', {
        turn: 1,
        step: 1,
        message: toolResult('root', 'pruned result'),
      }, { surfaceOp: { op: 'replace', start: 3, end: 3 } }),
    ])

    const current = snapshot(value)
    expect(node(current, 'user')).toBeUndefined()
    expect(node(current, 'context')).toBeUndefined()
    expect(node(current, 'assistant-step')).toBeUndefined()
    expect((node(current, 'tool-call')?.data as ToolChatData).root).not.toHaveProperty('kind')
  })

  it('folds an in-place edit into the SAME user node with the new text', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'user/message', {
        ...textMessage('edit-me', '第一版'),
        source: { kind: 'user' },
      }, { surfaceOp: 'append' }),
      at(4, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('edit-answer', 'ok'),
      }, { surfaceOp: 'append' }),
      at(5, 'user/message', {
        ...textMessage('edit-me', '第二版'),
        source: { kind: 'user' },
      }, { surfaceOp: { op: 'replace', start: 3, end: 3 }, sourceEventSeqs: [3] }),
    ])

    const current = snapshot(value)
    // One node, same id, updated text — no second bubble.
    const users = [...current.nodes.values()]
      .filter((entry): entry is ChatConversationViewNode => (entry.data as { kind?: string } | undefined)?.kind === 'user')
      .map(entry => entry.data)
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({
      kind: 'user',
      messageId: 'edit-me',
      content: [{ type: 'text', text: '第二版' }],
    })
  })

  it('assembles retry chains and keeps manual and automatic compaction ownership separate', () => {
    const retry = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'llm/retry', {
        retryId: 'retry-1',
        turn: 1,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'first' },
      }),
      at(4, 'llm/retry-started', { retryId: 'retry-1', turn: 1, step: 1, retry: 1 }),
      at(5, 'llm/retry', {
        retryId: 'retry-1',
        turn: 1,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 2,
        maxRetries: 2,
        delayMs: 20,
        failure: { code: 'TRANSPORT', message: 'second' },
      }),
      at(6, 'step/end', { turn: 1, step: 1 }),
      at(7, 'turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'failed' } },
      }),
    ])
    const retryNode = node(snapshot(retry), 'model-retry')
    const retryData = retryNode?.data as RetryChatData
    expect(retryData.attempts.map(attempt => attempt.retryState)).toEqual(['started', 'cancelled'])
    expect(node(snapshot(retry), 'turn-error')).toBeUndefined()

    const compactions = assembler([
      at(10, 'command/run', {
        commandId: 'command-1',
        name: 'compact',
        source: { kind: 'user' },
      }),
      at(11, 'compaction/start', {
        compactionId: 'manual-1',
        sourceCommandId: 'command-1',
        turn: null,
      }),
      at(12, 'compaction/summary', {
        compactionId: 'manual-1',
        sourceCommandId: 'command-1',
        summary: [{ type: 'text', text: 'manual summary' }],
        shadowedSeqs: [1, 2],
        shadowedTokenCount: 100,
      }),
      at(13, 'user/message', {
        ...textMessage('manual-checkpoint', 'checkpoint'),
        source: {
          kind: 'plugin',
          plugin: 'compact',
          compactionId: 'manual-1',
          sourceCommandId: 'command-1',
        },
      }, { surfaceOp: { op: 'replace', start: 1, end: 2 } }),
      at(14, 'compaction/end', {
        compactionId: 'manual-1',
        sourceCommandId: 'command-1',
        turn: null,
      }),
      at(15, 'command/done', {
        commandId: 'command-1',
        kind: 'success',
        sourceEventSeq: 12,
      }),
      at(20, 'compaction/start', { compactionId: 'automatic-1', turn: null }),
      at(21, 'compaction/summary', {
        compactionId: 'automatic-1',
        summary: [{ type: 'text', text: 'automatic summary' }],
        shadowedSeqs: [3, 4],
        shadowedTokenCount: 200,
      }),
      at(22, 'user/message', {
        ...textMessage('automatic-checkpoint', 'checkpoint'),
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'automatic-1' },
      }, { surfaceOp: { op: 'replace', start: 3, end: 4 } }),
      at(23, 'compaction/end', { compactionId: 'automatic-1', turn: null }),
    ])

    const manual = node(snapshot(compactions), 'manual-compaction')
    expect((manual?.data as ManualCompactionChatData).compaction).toMatchObject({
      summary: 'manual summary',
      summaryEventSeq: 12,
    })
    const automatic = node(snapshot(compactions), 'compaction')
    expect(automatic?.data).toMatchObject({ summary: 'automatic summary', summaryEventSeq: 21 })
    expect(snapshot(compactions).nodes.values().filter(candidate => candidate.kind === 'compaction')).toHaveLength(1)
  })

  it('fills a landed compaction marker when an older page supplies its summary', () => {
    const value = assembler([
      at(13, 'user/message', {
        ...textMessage('checkpoint', 'checkpoint'),
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1' },
      }, { surfaceOp: { op: 'replace', start: 1, end: 8 } }),
    ], true)
    const before = node(snapshot(value), 'compaction')
    expect(before?.data).toMatchObject({ summary: null, summaryEventSeq: null })

    value.prepend([
      at(9, 'compaction/start', { compactionId: 'compact-1', turn: null }),
      at(10, 'compaction/summary', {
        compactionId: 'compact-1',
        summary: [
          { type: 'text', text: 'older ' },
          { type: 'image', data: 'ignored' },
          { type: 'text', text: 'summary' },
        ],
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 42,
      }),
    ], false)
    value.flush()

    const after = node(snapshot(value), 'compaction')
    expect(after?.key).toBe(before?.key)
    expect(after?.data).toMatchObject({
      summary: 'older summary',
      summaryEventSeq: 10,
      shadowedItemCount: 3,
      shadowedTokenCount: 42,
    })
  })

  it('renders a historical compaction when its start remains outside the loaded window', () => {
    const value = assembler([
      at(10, 'compaction/summary', {
        compactionId: 'compact-windowed',
        summary: [{ type: 'text', text: 'loaded summary' }],
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 42,
      }),
      at(11, 'user/message', {
        ...textMessage('checkpoint-windowed', 'checkpoint'),
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-windowed' },
      }, { surfaceOp: { op: 'replace', start: 1, end: 3 } }),
    ], true)

    expect(node(snapshot(value), 'compaction')?.data).toMatchObject({
      summary: 'loaded summary',
      summaryEventSeq: 10,
      shadowedItemCount: 3,
      shadowedTokenCount: 42,
    })
  })

  it('ignores legacy compaction transactions without correlation ids', () => {
    const value = assembler([
      at(10, 'compaction/start', { turn: null }),
      at(11, 'compaction/end', { turn: null, error: 'This operation was aborted' }),
      at(20, 'compaction/start', { turn: null }),
      at(21, 'compaction/summary', {
        summary: [{ type: 'text', text: 'legacy summary' }],
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 42,
      }),
      at(22, 'user/message', {
        ...textMessage('legacy-checkpoint', 'checkpoint'),
        source: { kind: 'plugin', plugin: 'compact' },
      }, { surfaceOp: { op: 'replace', start: 1, end: 3 } }),
      at(23, 'compaction/end', { turn: null }),
    ], true)

    expect(node(snapshot(value), 'compaction')).toBeUndefined()
  })

  it('ignores legacy retry and code-dispatch events without correlation ids', () => {
    const value = assembler([
      at(10, 'llm/retry', {
        turn: 1,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'first legacy retry' },
      }),
      at(11, 'llm/retry-started', { turn: 1, step: 1, retry: 1 }),
      at(20, 'llm/retry', {
        turn: 2,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'second legacy retry' },
      }),
      at(30, 'tool/code-dispatch-start', {
        parentCallId: 'root',
        subCallId: 'child',
        name: 'legacy-subcall',
        arguments: {},
      }),
      at(31, 'tool/code-dispatch', {
        parentCallId: 'root',
        subCallId: 'child',
        name: 'legacy-subcall',
        arguments: {},
        content: [],
      }),
    ], true)

    expect(node(snapshot(value), 'model-retry')).toBeUndefined()
    expect(node(snapshot(value), 'tool-call')).toBeUndefined()
  })

  it('suppresses a turn error when the loaded tail contains only a later retry attempt', () => {
    const value = assembler([
      at(5, 'llm/retry', {
        retryId: 'retry-paged',
        turn: 1,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 2,
        maxRetries: 2,
        delayMs: 20,
        failure: { code: 'TRANSPORT', message: 'second' },
      }),
      at(6, 'step/end', { turn: 1, step: 1 }),
      at(7, 'turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'failed' } },
      }),
    ], true)

    expect(node(snapshot(value), 'model-retry')).toBeUndefined()
    expect(node(snapshot(value), 'turn-error')).toBeUndefined()

    value.prepend([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'llm/retry', {
        retryId: 'retry-paged',
        turn: 1,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'first' },
      }),
      at(4, 'llm/retry-started', {
        retryId: 'retry-paged', turn: 1, step: 1, retry: 1,
      }),
    ], false)
    value.flush()

    const retry = node(snapshot(value), 'model-retry')
    expect((retry?.data as RetryChatData).attempts).toHaveLength(2)
    expect(node(snapshot(value), 'turn-error')).toBeUndefined()
  })

  it('materializes a max-tokens notice and keeps completed and error turns clean', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/message', {
        turn: 1, step: 1, message: assistantMessage('a1', 'truncated answer'),
      }, { surfaceOp: 'append' }),
      at(4, 'step/end', { turn: 1, step: 1 }),
      at(5, 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } }),
    ])
    const notice = node(snapshot(value), 'turn-max-tokens')
    expect(notice?.data).toMatchObject({ kind: 'turn-max-tokens', seq: 5, turn: 1, step: 1 })
    expect(node(snapshot(value), 'turn-error')).toBeUndefined()
    // The tail stays the turn's last node so its branch action survives; the
    // notice slots between the truncated closing Assistant and the tail.
    const tail = node(snapshot(value), 'turn-tail')
    expect(notice?.anchorSeq).toBeLessThan(tail?.anchorSeq ?? Number.NEGATIVE_INFINITY)
    expect(notice?.anchorSeq).toBeGreaterThan(3)

    const completed = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(node(snapshot(completed), 'turn-max-tokens')).toBeUndefined()

    const failed = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'failed' } },
      }),
    ])
    expect(node(snapshot(failed), 'turn-max-tokens')).toBeUndefined()
    expect(node(snapshot(failed), 'turn-error')).toBeDefined()
  })

  it('keeps the max-tokens notice when the window starts after the owning turn/start', () => {
    const value = assembler([
      at(9, 'turn/end', { turn: 3, reason: { kind: 'max-tokens' } }),
    ], true)
    const notice = node(snapshot(value), 'turn-max-tokens')
    expect(notice?.data).toMatchObject({ kind: 'turn-max-tokens', seq: 9, turn: 3 })
  })

  it('pins the max-tokens Definition edges the engine cannot reach', () => {
    // The engine only hands start the single matched turn/end and never emits
    // update Matches for this kind; these direct calls pin the declared
    // behavior of both required Definition members anyway.
    const match = (seq: number, type: string, data: unknown) => ({
      event: { seq, time: seq * 1_000, type, data },
      view: undefined,
      role: 'start',
      location: undefined,
    }) as unknown as Parameters<typeof turnMaxTokensDefinition.start>[1]
    const context = (state: unknown, matches: unknown[] = []) => ({
      key: 'k', kind: 'turn-max-tokens', id: '1', matches, start: undefined, state, current: new Map(),
    }) as unknown as Parameters<NonNullable<typeof turnMaxTokensDefinition.buildViewNode>>[0]
    const reader = { previous: () => undefined }

    expect(() => turnMaxTokensDefinition.start(context(undefined), match(1, 'turn/start', { turn: 1 }), reader))
      .toThrow('turn-max-tokens start requires a max-tokens turn/end')
    const state = { turn: 1, seq: 5, time: 5_000 }
    expect(turnMaxTokensDefinition.update(
      context(state) as Parameters<typeof turnMaxTokensDefinition.update>[0],
      match(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    )).toBe(state)
    expect(turnMaxTokensDefinition.buildViewNode?.(context(undefined))).toBeNull()
  })

  it('preserves nested Tools and manual compaction evidence when their start events are outside the window', () => {
    const value = assembler([
      at(12, 'tool/code-dispatch-start', {
        rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read_file', arguments: { path: 'a' },
      }),
      at(13, 'tool/code-dispatch', {
        rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read_file', arguments: { path: 'a' },
        isError: false, content: [{ type: 'text', text: 'child result' }],
      }),
      at(14, 'tool/result', {
        turn: 1,
        step: 1,
        message: toolResult('root', 'root result'),
      }, { surfaceOp: 'append' }),
      at(20, 'compaction/summary', {
        compactionId: 'manual-1',
        sourceCommandId: 'command-1',
        summary: [{ type: 'text', text: 'manual summary' }],
        shadowedSeqs: [1, 2],
        shadowedTokenCount: 100,
      }),
      at(21, 'user/message', {
        ...textMessage('manual-checkpoint', 'checkpoint'),
        source: {
          kind: 'plugin',
          plugin: 'compact',
          compactionId: 'manual-1',
          sourceCommandId: 'command-1',
        },
      }, { surfaceOp: { op: 'replace', start: 1, end: 2 } }),
      at(22, 'command/done', {
        commandId: 'command-1',
        kind: 'success',
        sourceEventSeq: 20,
      }),
    ], true)

    const tool = node(snapshot(value), 'tool-call')
    const root = (tool?.data as ToolChatData).root
    expect(root.subCalls).toHaveLength(1)
    expect(root.subCalls[0]).toMatchObject({ callId: 'child', kind: 'tool-result' })
    const manual = node(snapshot(value), 'manual-compaction')
    expect((manual?.data as ManualCompactionChatData)).toMatchObject({
      command: { commandId: 'command-1', name: 'compact', outcome: { kind: 'success' } },
      compaction: { summary: 'manual summary', summaryEventSeq: 20 },
    })
  })
})
