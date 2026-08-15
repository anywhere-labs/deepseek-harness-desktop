/**
 * sessions.delete: cold sessions are removed through persistence; live
 * sessions first dispose their agent through the agent loop. The agent loop
 * itself is stubbed here — api-proxy-rename.spec.ts owns the structural
 * factory pattern, and the coordinator's remove contract owns the storage
 * semantics.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request(payload: { sessionId: SessionId }): RpcRequest<{ sessionId: SessionId }> {
  return { rpcId: RpcId(`del-${String(nextRpc++)}`), payload }
}

async function composed(): Promise<{ ctx: Context; root: string }> {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'ap-delete-'))
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return { ctx, root }
}

const api = (ctx: Context) => createApiProxy(ctx, {
  defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
  cwd: '/tmp',
})

describe('sessions.delete', () => {
  it('deletes a cold persisted session', async () => {
    const { ctx, root } = await composed()
    try {
      const persistence = ctx.sessionPersistence
      const id = sid('cold-del')
      await persistence.create({ id, version: 0, createdAt: Date.now(), cwd: '/proj' })
      await persistence.append(id, [{
        type: 'turn/start', seq: 0, time: 1, data: { turn: 1 },
      }])

      const response = await api(ctx).sessions.delete(request({ sessionId: id }))
      expect(response.result).toEqual({ ok: true, value: { deleted: true } })
      expect((await persistence.list()).map(header => header.id)).not.toContain(id)
      await expect(persistence.load(id)).rejects.toThrow(/not found/)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('disposes a live agent and then removes the persisted log', async () => {
    const { ctx, root } = await composed()
    try {
      const persistence = ctx.sessionPersistence
      // Prepare/enter/announce exposes the detach disposer so the stubbed
      // agent-loop teardown can simulate the real lifecycle removal.
      const session = ctx.sessions.prepare(sid('live-del'), { meta: { cwd: '/proj' } })
      const detachSession = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      const agent = { id: session.id, session, status: 'idle', ctx } as Agent
      const detachAgent = ctx.agents.register(agent)
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await ctx.sessions.flush(session)
      const disposeAgent = vi.fn(async () => {
        await ctx.sessions.flush(session)
        detachAgent()
        detachSession()
      })
      ctx.provide('agentLoop', { disposeAgent } as never)

      const response = await api(ctx).sessions.delete(request({ sessionId: session.id }))
      expect(response.result).toEqual({ ok: true, value: { deleted: true } })
      expect(disposeAgent).toHaveBeenCalledTimes(1)
      expect(ctx.agents.get(session.id)).toBeUndefined()
      expect(ctx.sessions.get(session.id)).toBeUndefined()
      expect((await persistence.list()).map(header => header.id)).not.toContain(session.id)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a running session', async () => {
    const { ctx, root } = await composed()
    const disposeAgent = vi.fn(async () => {})
    ctx.provide('agentLoop', { disposeAgent } as never)
    try {
      const session = ctx.sessions.create(sid('running-del'), { meta: { cwd: '/proj' } })
      ctx.agents.register({ id: session.id, session, status: 'running', ctx } as Agent)

      const response = await api(ctx).sessions.delete(request({ sessionId: session.id }))
      expect(response.result.ok).toBe(false)
      if (!response.result.ok) {
        expect(response.result.error.code).toBe('session-running')
        expect(response.result.error.details).toEqual({ sessionId: session.id })
      }
      expect(disposeAgent).not.toHaveBeenCalled()
      expect(ctx.agents.get(session.id)).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers session-not-found for an unknown session', async () => {
    const { ctx, root } = await composed()
    try {
      const id = sid('ghost-del')
      const response = await api(ctx).sessions.delete(request({ sessionId: id }))
      expect(response.result.ok).toBe(false)
      if (!response.result.ok) {
        expect(response.result.error.code).toBe('session-not-found')
        expect(response.result.error.details).toEqual({ sessionId: id })
      }
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
