import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { harness } from './helpers.ts'

function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }> | undefined {
  return log.find(event => event.type === type) as Extract<SessionEvent, { type: T }> | undefined
}

describe('dsh-polish through the agent loop', () => {
  it('rewrites the draft, logs the plugin-sourced request, and answers the model label', async () => {
    const ctx = await harness(new MockAdapter([textResponse('润色后的、更完整的消息文本。')]))
    const agent = ctx.agentLoop.create(SessionId('it-polish-ok'), { provider: 'mock', model: 'mock' })

    const result = await ctx.polish.polish({ sessionId: agent.id, message: '  帮我写一个bug  ' })
    expect(result).toEqual({ ok: true, value: { text: '润色后的、更完整的消息文本。' } })

    const log = agent.session.events
    const request = findEvent(log, 'user/message')
    expect(request?.data.source).toEqual({ kind: 'plugin', plugin: 'dsh-polish' })
    const text = request?.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(text).toContain('帮我写一个bug')
    expect(text).toContain('保持原意')
    expect(findEvent(log, 'assistant/message')).toBeDefined()

    expect(ctx.polish.model({ sessionId: agent.id })).toEqual({ label: 'mock' })
  })

  it('uses the logged request header model after a real turn', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok'), textResponse('润色结果。')]))
    const agent = ctx.agentLoop.create(SessionId('it-polish-header'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first turn' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const result = await ctx.polish.polish({ sessionId: agent.id, message: 'second draft' })
    expect(result).toEqual({ ok: true, value: { text: '润色结果。' } })
    expect(ctx.polish.model({ sessionId: agent.id })).toEqual({ label: 'mock' })
  })

  it('refuses a blank draft', async () => {
    const ctx = await harness(new MockAdapter([]))
    const agent = ctx.agentLoop.create(SessionId('it-polish-blank'), { provider: 'mock', model: 'mock' })
    const result = await ctx.polish.polish({ sessionId: agent.id, message: '   ' })
    expect(result).toEqual({ ok: false, error: { code: 'message-blank' } })
  })

  it('refuses an over-long draft', async () => {
    const ctx = await harness(new MockAdapter([]), { maxMessageChars: 5 })
    const agent = ctx.agentLoop.create(SessionId('it-polish-long'), { provider: 'mock', model: 'mock' })
    const result = await ctx.polish.polish({ sessionId: agent.id, message: 'abcdef' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'message-too-long', maxChars: 5, actualChars: 6 },
    })
  })

  it('fails closed without a live agent', async () => {
    const ctx = await harness(new MockAdapter([]))
    const sessionId = SessionId('it-polish-missing')
    const result = await ctx.polish.polish({ sessionId, message: 'hello' })
    expect(result).toEqual({ ok: false, error: { code: 'session-not-found', sessionId } })
    expect(ctx.polish.model({ sessionId })).toEqual({ label: '' })
  })

  it('reports no-result when the model replies with nothing', async () => {
    const ctx = await harness(new MockAdapter([textResponse('')]))
    const agent = ctx.agentLoop.create(SessionId('it-polish-empty'), { provider: 'mock', model: 'mock' })
    const result = await ctx.polish.polish({ sessionId: agent.id, message: 'draft' })
    expect(result).toEqual({ ok: false, error: { code: 'no-result' } })
  })
})
