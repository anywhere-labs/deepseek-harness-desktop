import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { harness } from './helpers.ts'

describe('dsh-message-edit through the agent loop', () => {
  it('rejects an invalid maxMessageChars configuration at load', async () => {
    // The Loader's schemastery Config rejects the value before the service
    // constructor runs.
    await expect(harness(new MockAdapter([]), { maxMessageChars: 0 })).rejects.toThrow(/invalid config/u)
  })

  it('rewrites a settled user message in place on the model surface', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const agent = ctx.agentLoop.create(SessionId('me-edit-ok'), { provider: 'mock', model: 'mock' })
    const original = createUserMessage({
      content: [{ type: 'text', text: '原始消息' }],
      source: { kind: 'user' },
    })
    agent.followup(original)
    await agent.whenIdle()
    const targetSeq = agent.session.events.findIndex(event => event.type === 'user/message')

    const result = await ctx.messageEdit.edit({
      sessionId: agent.id,
      messageId: original.id,
      text: '  修改后的消息  ',
    })
    expect(result.ok).toBe(true)
    const replacementSeq = result.ok ? result.value.seq : -1

    // The replacement shadows the original on the surface; the derived
    // history (and therefore the next model request) sees the new text.
    const surface = foldSurface(agent.session.events)
    expect(surface.nodes).not.toContain(targetSeq)
    expect(surface.nodes).toContain(replacementSeq)
    const derived = agent.session.deriveMessages().filter(message => message.role === 'user')
    const texts = derived.map(message =>
      message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    expect(texts).toContain('修改后的消息')
    expect(texts).not.toContain('原始消息')
    // Same message id, so client nodes and references stay stable.
    const replacement = agent.session.events[replacementSeq]
    expect(replacement?.type === 'user/message' && replacement.data.id).toBe(original.id)
  })

  it('edits an earlier message when later messages and assistant replies sit above it on the surface', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok'), textResponse('ok')]))
    const agent = ctx.agentLoop.create(SessionId('me-many'), { provider: 'mock', model: 'mock' })
    const first = createUserMessage({ content: [{ type: 'text', text: '第一条' }], source: { kind: 'user' } })
    agent.followup(first)
    await agent.whenIdle()
    const second = createUserMessage({ content: [{ type: 'text', text: '第二条' }], source: { kind: 'user' } })
    agent.followup(second)
    await agent.whenIdle()

    // The surface is [first, assistant, second, assistant]; the edit scans
    // backward past the assistant and second message to reach the target.
    const result = await ctx.messageEdit.edit({ sessionId: agent.id, messageId: first.id, text: '第一条已改' })
    expect(result.ok).toBe(true)
    const texts = agent.session.deriveMessages()
      .filter(message => message.role === 'user')
      .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    expect(texts).toEqual(['第一条已改', '第二条'])
  })

  it('edits the same message repeatedly, targeting the latest replacement', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const agent = ctx.agentLoop.create(SessionId('me-edit-twice'), { provider: 'mock', model: 'mock' })
    const original = createUserMessage({
      content: [{ type: 'text', text: '第一版' }],
      source: { kind: 'user' },
    })
    agent.followup(original)
    await agent.whenIdle()

    const first = await ctx.messageEdit.edit({ sessionId: agent.id, messageId: original.id, text: '第二版' })
    const second = await ctx.messageEdit.edit({ sessionId: agent.id, messageId: original.id, text: '第三版' })
    expect(first.ok && second.ok).toBe(true)
    const texts = agent.session.deriveMessages()
      .filter(message => message.role === 'user')
      .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    expect(texts).toEqual(['第三版'])
  })

  it('edits a cold persisted session without an agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'me-cold-'))
    try {
      const ctx = await harness(new MockAdapter([]))
      await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
      const persistence = ctx.sessionPersistence
      const id = SessionId('me-cold-session')
      await persistence.create({ id, version: 0, createdAt: Date.now() })
      const original = createUserMessage({
        content: [{ type: 'text', text: '冷会话原文' }],
        source: { kind: 'user' },
      })
      await persistence.append(id, [{
        type: 'user/message',
        seq: 0,
        time: Date.now(),
        data: original,
        surfaceOp: 'append',
      }])

      // No agent exists for this session: the edit must go through persistence.
      expect(ctx.agents.get(id)).toBeUndefined()
      const result = await ctx.messageEdit.edit({ sessionId: id, messageId: original.id, text: '冷会话已改' })
      expect(result.ok).toBe(true)
      const replacementSeq = result.ok ? result.value.seq : -1
      expect(replacementSeq).toBe(1)

      const loaded = await persistence.load(id)
      const surface = foldSurface(loaded.events)
      expect(surface.nodes).toEqual([1])
      const replacement = loaded.events[replacementSeq]
      expect(replacement?.type === 'user/message' && replacement.data.id).toBe(original.id)
      const text = replacement?.type === 'user/message'
        && replacement.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text).toBe('冷会话已改')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails closed for an unknown session with no agent and no persisted log', async () => {
    const ctx = await harness(new MockAdapter([]))
    const sessionId = SessionId('me-missing')
    const result = await ctx.messageEdit.edit({ sessionId, messageId: 'm-1' as MessageId, text: 'x' })
    expect(result).toEqual({ ok: false, error: { code: 'session-not-found', sessionId } })
  })

  it('refuses a blank edit', async () => {
    const ctx = await harness(new MockAdapter([]))
    const agent = ctx.agentLoop.create(SessionId('me-blank'), { provider: 'mock', model: 'mock' })
    const result = await ctx.messageEdit.edit({ sessionId: agent.id, messageId: 'm-1' as MessageId, text: '   ' })
    expect(result).toEqual({ ok: false, error: { code: 'message-blank' } })
  })

  it('refuses an over-long edit', async () => {
    const ctx = await harness(new MockAdapter([]), { maxMessageChars: 5 })
    const agent = ctx.agentLoop.create(SessionId('me-long'), { provider: 'mock', model: 'mock' })
    const result = await ctx.messageEdit.edit({ sessionId: agent.id, messageId: 'm-1' as MessageId, text: 'abcdef' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'message-too-long', maxChars: 5, actualChars: 6 },
    })
  })

  it('refuses an unknown message id and a non-user source', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok'), textResponse('ok')]))
    const agent = ctx.agentLoop.create(SessionId('me-unknown'), { provider: 'mock', model: 'mock' })
    const ghost = createUserMessage({ content: [{ type: 'text', text: 'never sent' }], source: { kind: 'user' } })
    const unknown = await ctx.messageEdit.edit({ sessionId: agent.id, messageId: ghost.id, text: 'x' })
    expect(unknown).toEqual({ ok: false, error: { code: 'message-not-found', messageId: ghost.id } })

    const injected = createUserMessage({
      content: [{ type: 'text', text: 'injected context' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    agent.followup(injected)
    await agent.whenIdle()
    const nonUser = await ctx.messageEdit.edit({ sessionId: agent.id, messageId: injected.id, text: 'x' })
    expect(nonUser).toEqual({ ok: false, error: { code: 'message-not-found', messageId: injected.id } })
  })
})
