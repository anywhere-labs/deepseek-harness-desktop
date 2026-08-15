import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function persistentHarness(adapter: MockAdapter): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-'))
  dirs.push(root)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, root }
}

async function noPersistenceHarness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** Drive one user turn to completion and return the log length after it. */
async function runTurn(ctx: Context, agent: Agent, text: string): Promise<number> {
  const before = agent.session.events.length
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return before
}

describe('agent-loop rewind', () => {
  it('truncates the session at a turn boundary and resumes the same identity', async () => {
    // Turn 1 consumes the first response; turn 2 the second.
    const adapter = new MockAdapter([textResponse('first reply'), textResponse('second reply')])
    const { ctx, root } = await persistentHarness(adapter)
    const id = SessionId('it-rewind')
    const agent = ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' })
    await runTurn(ctx, agent, 'first')
    await runTurn(ctx, agent, 'second')

    // The second turn's turn/start is the cut: truncating there keeps exactly
    // the first turn. Two completed turns must be present.
    const turnStarts = agent.session.events
      .filter(event => event.type === 'turn/start')
    expect(turnStarts).toHaveLength(2)
    const cut = turnStarts[1]?.seq as number
    // Sanity: everything is durable before rewinding.
    await ctx.sessions.flush(agent.session)
    const storedBefore = await ctx.sessionPersistence.load(id)
    expect(storedBefore.events.map(event => event.seq)).toEqual(
      agent.session.events.map(event => event.seq),
    )

    const handle = await ctx.agentLoop.rewind(agent, cut)
    const rewound = ctx.agents.get(id)
    expect(rewound).toBeDefined()
    expect(rewound).not.toBe(agent)
    // The resumed log is the truncated prefix plus the constructor's
    // `session/end-seed` marker (Session appends it after a non-empty seed).
    expect(rewound?.session.events.map(event => event.seq)).toEqual([
      ...agent.session.events.slice(0, cut).map(event => event.seq),
      cut,
    ])
    expect(rewound?.session.events.length).toBe(cut + 1)

    // The resumed agent continues the log from the cut.
    await runTurn(ctx, rewound as Agent, 'after rewind')
    const continued = rewound?.session.events
    expect(continued?.at(-1)?.type).toBe('turn/end')
    expect(continued?.at(-1)?.seq).toBeGreaterThan(cut)

    // Persistence observes the truncated prefix plus the continuation.
    const stored = await ctx.sessionPersistence.load(id)
    expect(stored.events.map(event => event.seq)).toEqual(
      continued?.map(event => event.seq),
    )

    // The replacement handle is owned like any resume handle.
    await handle.dispose()
    expect(ctx.agents.get(id)).toBeUndefined()
    void root
  })

  it('refuses a non-live agent, an out-of-range toSeq, and a missing persistence', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const { ctx } = await persistentHarness(adapter)
    const id = SessionId('it-rewind-guards')
    const agent = ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' })
    await runTurn(ctx, agent, 'turn')

    await expect(ctx.agentLoop.rewind(agent, 999)).rejects.toThrow('exceeds log length')
    const stranger = ctx.agentLoop.create(SessionId('it-rewind-stranger'), { provider: 'mock', model: 'mock' })
    await expect(ctx.agentLoop.rewind(stranger, 999)).rejects.toThrow('exceeds log length')
    void stranger

    const keyless = await noPersistenceHarness(adapter)
    const keylessAgent = keyless.agentLoop.create(SessionId('it-rewind-nop'), { provider: 'mock', model: 'mock' })
    await expect(keyless.agentLoop.rewind(keylessAgent, 0)).rejects.toThrow(
      'session persistence is not configured',
    )
    await keyless.fiber.dispose()
    await ctx.fiber.dispose()
  })
})
