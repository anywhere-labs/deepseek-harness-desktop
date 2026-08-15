import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import RollbackService from '@deepseek-ai/dsh-rollback'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function harness(adapter: MockAdapter): Promise<{ ctx: Context; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rollback-'))
  dirs.push(dir)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(RollbackService)
  await ctx.plugin(JsonlSessionPersistence, { root: join(dir, '.sessions'), compression: 'none' })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, dir }
}

async function runTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

function userMessages(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter(event => event.type === 'user/message')
}

describe('dsh-rollback through the agent loop', () => {
  it('rewinds the session to before the picked message', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const { ctx } = await harness(adapter)
    const id = SessionId('rb-session')
    const agent = ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' })
    await runTurn(ctx, agent, 'one')
    await runTurn(ctx, agent, 'two')
    const picked = userMessages(agent.session.events)[1]
    if (picked === undefined) throw new Error('expected a second user message')

    const result = await ctx.rollback.rollback({ sessionId: id, messageSeq: picked.seq })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const rewound = ctx.agents.get(id)
    expect(rewound).toBeDefined()
    expect(rewound?.session.events.at(-1)?.type).toBe('session/end-seed')
    expect(userMessages(rewound?.session.events ?? [])).toHaveLength(1)
    expect(result.value.cutSeq).toBeGreaterThan(0)
  })

  it('reverts code changes made in the dropped span', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-read', 'read', { file_path: 'hello.txt' }, 'reading'),
      toolCallResponse('call-edit', 'edit', {
        file_path: 'hello.txt',
        old_string: 'line two',
        new_string: 'line TWO edited',
      }, 'editing'),
      textResponse('edited'),
    ])
    const { ctx, dir } = await harness(adapter)
    const id = SessionId('rb-code')
    const agent = ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' }, { cwd: dir })
    await writeFile(join(dir, 'hello.txt'), 'line one\nline two\n')
    await runTurn(ctx, agent, 'edit the file')
    expect(await readFile(join(dir, 'hello.txt'), 'utf8')).toBe('line one\nline TWO edited\n')

    // Roll back to before the only turn: the edit hunk reverse-applies and
    // the file returns to its pre-turn content.
    const picked = userMessages(agent.session.events)[0]
    if (picked === undefined) throw new Error('expected a user message')
    const result = await ctx.rollback.rollback({ sessionId: id, messageSeq: picked.seq, code: true })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.codeFailures).toEqual([])
    expect(result.value.codeReverted).toBeGreaterThan(0)
    expect(await readFile(join(dir, 'hello.txt'), 'utf8')).toBe('line one\nline two\n')

    const rewound = ctx.agents.get(id)
    expect(userMessages(rewound?.session.events ?? [])).toHaveLength(0)
  })

  it('fails closed without a live agent or with an out-of-range message seq', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const { ctx } = await harness(adapter)
    const missing = SessionId('rb-missing')
    const result = await ctx.rollback.rollback({ sessionId: missing, messageSeq: 0 })
    expect(result).toEqual({ ok: false, error: { code: 'session-not-found', sessionId: missing } })

    const id = SessionId('rb-range')
    const agent = ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' })
    await runTurn(ctx, agent, 'turn')
    const outOfRange = await ctx.rollback.rollback({ sessionId: id, messageSeq: 9999 })
    expect(outOfRange).toEqual({
      ok: false,
      error: { code: 'message-seq-out-of-range', messageSeq: 9999, logLength: agent.session.events.length },
    })
  })
})
