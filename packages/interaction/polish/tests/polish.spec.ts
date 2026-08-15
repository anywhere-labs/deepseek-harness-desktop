import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { harness } from './helpers.ts'

describe('dsh-polish through a direct model call', () => {
  it('polishes without touching the target session log and without creating a session', async () => {
    const { ctx } = await harness(new MockAdapter([textResponse('润色后的、更完整的消息文本。')]))
    const agent = ctx.agentLoop.create(SessionId('it-polish-ok'), { provider: 'mock', model: 'mock' })
    const baseline = agent.session.events.length

    const result = await ctx.polish.polish({ sessionId: agent.id, message: '  帮我写一个bug  ' })
    expect(result).toEqual({ ok: true, value: { text: '润色后的、更完整的消息文本。' } })

    // No session created, no log entry written: the visible conversation is
    // byte-identical and the agent registry holds only the target.
    expect(agent.session.events.length).toBe(baseline)
    expect(ctx.agents.get(agent.id)).toBe(agent)
  })

  it('mirrors the target session provider/model selection on the direct call', async () => {
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

  it('refuses a target without a provider/model selection', async () => {
    const { ctx } = await harness(new MockAdapter([]))
    const agent = ctx.agentLoop.create(SessionId('it-polish-no-route'), {})
    const result = await ctx.polish.polish({ sessionId: agent.id, message: 'draft' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'polish-failed', message: 'target session has no provider/model selection' },
    })
  })

  it('reports no-result when the model reply is empty', async () => {
    const { ctx } = await harness(new MockAdapter([textResponse('')]))
    const agent = ctx.agentLoop.create(SessionId('it-polish-empty'), { provider: 'mock', model: 'mock' })
    const result = await ctx.polish.polish({ sessionId: agent.id, message: 'draft' })
    expect(result).toEqual({ ok: false, error: { code: 'no-result' } })
  })

  it('reports polish-failed when the direct call cannot dispatch', async () => {
    const { ctx } = await harness(new MockAdapter([]))
    // The target agent exists but its route has no registered adapter, so the
    // direct call fails at dispatch — no session is created either way.
    const agent = ctx.agentLoop.create(SessionId('it-polish-fail'), { provider: 'ghost', model: 'ghost' })
    const result = await ctx.polish.polish({ sessionId: agent.id, message: 'draft' })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false, error: { code: 'polish-failed' } })
    expect(ctx.agents.get(agent.id)).toBe(agent)
  })
})
