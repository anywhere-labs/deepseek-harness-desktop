import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { harness } from './helpers.ts'

describe('dsh-polish through the agent loop', () => {
  it('polishes in a throwaway session without touching the target session log', async () => {
    const { ctx } = await harness(new MockAdapter([textResponse('润色后的、更完整的消息文本。')]))
    const agent = ctx.agentLoop.create(SessionId('it-polish-ok'), { provider: 'mock', model: 'mock' })
    const baseline = agent.session.events.length

    const result = await ctx.polish.polish({ sessionId: agent.id, message: '  帮我写一个bug  ' })
    expect(result).toEqual({ ok: true, value: { text: '润色后的、更完整的消息文本。' } })

    // The visible conversation is untouched: nothing appended at all, and the
    // throwaway session is gone again (the target still resolves).
    expect(agent.session.events.length).toBe(baseline)
    expect(agent.session.events.some(event => event.type === 'user/message')).toBe(false)
    expect(ctx.agents.get(agent.id)).toBe(agent)
  })

  it('mirrors the target session provider/model selection', async () => {
    const { ctx, adapter } = await harness(new MockAdapter([textResponse('润色结果。')]))
    const agent = ctx.agentLoop.create(SessionId('it-polish-model'), { provider: 'mock', model: 'mock' })

    await ctx.polish.polish({ sessionId: agent.id, message: 'draft' })
    const request = adapter.requests.at(-1)
    expect(request?.provider).toBe('mock')
    expect(request?.model).toBe('mock')
  })

  it('refuses a blank draft', async () => {
    const { ctx } = await harness(new MockAdapter([]))
    const agent = ctx.agentLoop.create(SessionId('it-polish-blank'), { provider: 'mock', model: 'mock' })
    const result = await ctx.polish.polish({ sessionId: agent.id, message: '   ' })
    expect(result).toEqual({ ok: false, error: { code: 'message-blank' } })
  })

  it('refuses an over-long draft', async () => {
    const { ctx } = await harness(new MockAdapter([]), { maxMessageChars: 5 })
    const agent = ctx.agentLoop.create(SessionId('it-polish-long'), { provider: 'mock', model: 'mock' })
    const result = await ctx.polish.polish({ sessionId: agent.id, message: 'abcdef' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'message-too-long', maxChars: 5, actualChars: 6 },
    })
  })

  it('fails closed without a live agent', async () => {
    const { ctx } = await harness(new MockAdapter([]))
    const sessionId = SessionId('it-polish-missing')
    const result = await ctx.polish.polish({ sessionId, message: 'hello' })
    expect(result).toEqual({ ok: false, error: { code: 'session-not-found', sessionId } })
  })

  it('reports no-result when the model reply is empty', async () => {
    const { ctx } = await harness(new MockAdapter([textResponse('')]))
    const agent = ctx.agentLoop.create(SessionId('it-polish-empty'), { provider: 'mock', model: 'mock' })
    const result = await ctx.polish.polish({ sessionId: agent.id, message: 'draft' })
    expect(result).toEqual({ ok: false, error: { code: 'no-result' } })
  })

  it('reports polish-session-failed when the throwaway session cannot be created', async () => {
    const { ctx } = await harness(new MockAdapter([]))
    const agent = ctx.agentLoop.create(SessionId('it-polish-fail'), { provider: 'mock', model: 'mock' })
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    ctx.agents.create = () => Promise.reject(new Error('factory down'))
    try {
      const result = await ctx.polish.polish({ sessionId: agent.id, message: 'draft' })
      expect(result).toEqual({
        ok: false,
        error: { code: 'polish-session-failed', message: 'factory down' },
      })
    } finally {
      ctx.agents.create = originalCreate
    }
    // The target session stays live and untouched.
    expect(ctx.agents.get(agent.id)).toBe(agent)
  })
})
