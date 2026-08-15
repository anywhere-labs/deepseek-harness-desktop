import { describe, expect, it, vi } from 'vitest'
import type { ApiProxy, HostFrame, MuxFrame } from '../src/api/index.ts'
import type { ClientResponse, RpcMessage, RpcReceipt, RpcRequest } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { toFetchHandler } from '../src/fetch/handler.ts'
import { AbstractApiClient, InProcessApiClient } from '../src/fetch/client.ts'

/** Minimal in-memory ApiProxy: echoes rpcIds, scripts one frame per stream. */
function fakeApi(overrides: Partial<{ muxFrames: MuxFrame[]; hostFrames: HostFrame[]; crashOn: string }> = {}): ApiProxy {
  const muxFrames = overrides.muxFrames ?? [{ type: 'session/subscribed', sessionId: 's1' as never, lastSeq: -1 }]
  const hostFrames = overrides.hostFrames ?? [{ type: 'host/session-removed', sessionId: 's1' as never }]
  async function * stream<F>(frames: F[], signal: AbortSignal): AsyncGenerator<RpcRequest<F>> {
    for (const payload of frames) {
      if (signal.aborted) return
      yield { rpcId: RpcId(`frame-${String(frames.indexOf(payload))}`), payload }
    }
  }
  return {
    sessions: {
      async list(request) {
        if (overrides.crashOn === 'session.list') throw new Error('impl crashed')
        return { rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }
      },
      async search(request, signal) {
        if (request.payload.query === 'hang') {
          if (!signal.aborted) {
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
          }
          return {
            rpcId: request.rpcId,
            result: { ok: false, error: { code: 'cancelled', message: 'aborted', details: {} } },
          }
        }
        return {
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: { items: [{ sessionId: 's1' as never, snippet: 'fixture match' }], hasMore: false },
          },
        }
      },
      async create(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { sessionId: 's-new' as never } } }
      },
      async history(request) {
        if (request.payload.sessionId === ('with-projections' as never)) {
          return {
            rpcId: request.rpcId,
            result: { ok: true, value: { events: [], hasMore: false, projections: { asOfSeq: 9, values: { todos: [{ content: 'current', status: 'in_progress' as const }] } } } },
          }
        }
        return {
          rpcId: request.rpcId,
          result: { ok: false, error: { code: 'session-not-found', message: 'nope', details: { sessionId: request.payload.sessionId } } },
        }
      },
      async models(request) {
        return {
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: {
              current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
              routable: true,
              groups: [],
              failures: [],
            },
          },
        }
      },
      async selectModel(request) {
        return {
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: {
              selected: {
                provider: request.payload.provider,
                model: request.payload.model,
                ...request.payload.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: request.payload.reasoningEffort },
              },
            },
          },
        }
      },
      async rename(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { title: request.payload.title, seq: 0 } } }
      },
      async fork(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { sessionId: 's-fork' as never } } }
      },
      async prompt(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true as const } } }
      },
      async attachment(request) {
        return {
          rpcId: request.rpcId,
          result: { ok: true, value: { attachment: { attachmentId: 'a' as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }, data: 'AA==' } },
        }
      },
      async updateQueue(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true as const } } }
      },
      async cancel(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true as const } } }
      },
      async delete(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { deleted: true as const } } }
      },
    },
    subagents: {
      async list(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { entries: [], parentAvailable: false } } }
      },
      async history(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { events: [], hasMore: false } } }
      },
      async prompt(request, signal) {
        if (request.payload.content.some(block => block.type === 'text' && block.text === 'hang')) {
          if (!signal.aborted) {
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
          }
          return {
            rpcId: request.rpcId,
            result: { ok: false, error: { code: 'cancelled' as const, message: 'aborted', details: {} } },
          }
        }
        return {
          rpcId: request.rpcId,
          result: { ok: true, value: { messageId: 'message-1' as never } },
        }
      },
      async interrupt(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true as const } } }
      },
    },
    host: {
      async describe(request) {
        return {
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: { version: 'v', cwd: '/w', attachedSessions: 0, canOpenPath: true },
          },
        }
      },
      async pickDirectory(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { path: null } } }
      },
      async listDirectory(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { path: '/w', home: '/w', crumbs: [{ name: '/', path: '/', hidden: false }], entries: [], truncated: false } } }
      },
      async createDirectory(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { path: '/w/new' } } }
      },
      async openPath(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { opened: true as const } } }
      },
    },
    workspace: {
      async list(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { items: [], archivedSessionIds: [] } } }
      },
      async create(request) {
        return {
          rpcId: request.rpcId,
          result: { ok: true, value: { workspace: { workspaceId: 'w1' as never, path: '/w', title: 'w', sessionIds: [], createdAt: 't', updatedAt: 't' }, created: true } },
        }
      },
      async rename(request) {
        return {
          rpcId: request.rpcId,
          result: { ok: true, value: { workspace: { workspaceId: 'w1' as never, path: '/w', title: 'w', sessionIds: [], createdAt: 't', updatedAt: 't' } } },
        }
      },
      async delete(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { deleted: true as const } } }
      },
      async insertBefore(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { workspaceIds: [request.payload.workspaceId] } } }
      },
      async insertSessionBefore(request) {
        return {
          rpcId: request.rpcId,
          result: { ok: true, value: { workspace: { workspaceId: 'w1' as never, path: '/w', title: 'w', sessionIds: [], createdAt: 't', updatedAt: 't' } } },
        }
      },
      async archiveSession(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { archivedSessionIds: [request.payload.sessionId] } } }
      },
    },
    agentPresets: {
      list(request: RpcRequest<{}>) {
        return Promise.resolve({
          rpcId: request.rpcId,
          result: { ok: true as const, value: { presets: [], authorable: false, hasDocument: false } },
        })
      },
      select(request: RpcRequest<{ agentPreset: string }>) {
        const value = { agentPreset: request.payload.agentPreset }
        return Promise.resolve({ rpcId: request.rpcId, result: { ok: true as const, value } })
      },
      read(request: RpcRequest<{ agentPreset: string }>) {
        const value = { agentPreset: request.payload.agentPreset, trust: 'user' as const, content: '' }
        return Promise.resolve({ rpcId: request.rpcId, result: { ok: true as const, value } })
      },
      copy(request: RpcRequest<{ from: string; agentPreset: string }>) {
        const value = { agentPreset: request.payload.agentPreset }
        return Promise.resolve({ rpcId: request.rpcId, result: { ok: true as const, value } })
      },
      openDocument(request: RpcRequest<{ agentPreset: string }>) {
        return Promise.resolve({ rpcId: request.rpcId, result: { ok: true as const, value: { opened: true as const } } })
      },
      remove(request: RpcRequest<{ agentPreset: string }>) {
        return Promise.resolve({ rpcId: request.rpcId, result: { ok: true as const, value: {} } })
      },
    },
    skills: {
      async list(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { skills: [{ name: 'commit-helper', description: 'Git commits', modelInvocable: true }] } } }
      },
    },
    goals: {
      async create(request) {
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'stub', details: {} } } }
      },
      async edit(request) {
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'stub', details: {} } } }
      },
      async pause(request) {
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'stub', details: {} } } }
      },
      async resume(request) {
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'stub', details: {} } } }
      },
      async complete(request) {
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'stub', details: {} } } }
      },
      async clear(request) {
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'stub', details: {} } } }
      },
    },
    settings: {
      async describe(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { writable: true, hasDocument: false, namespaces: [] } } }
      },
      async openDocument(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { opened: true as const } } }
      },
      async update(request) {
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'settings-rejected', message: 'stub', details: { ns: request.payload.ns } } } }
      },
      async replace(request) {
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'settings-rejected', message: 'stub', details: { ns: request.payload.ns } } } }
      },
      async mutate(request) {
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'settings-rejected', message: 'stub', details: { ns: request.payload.ns } } } }
      },
    },
    credentials: {
      async describe(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { credentials: {} } } }
      },
      async set(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: {} } }
      },
      async unset(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: {} } }
      },
    },
    llm: {
      async providers(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { providers: [] } } }
      },
      async models(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { groups: [], failures: [] } } }
      },
      async discoverModels(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { models: [] } } }
      },
    },
    events: {
      mux: (_request, signal) => stream(muxFrames, signal),
      host: (_request, signal) => stream(hostFrames, signal),
    },
    async respond(message: ClientResponse): Promise<RpcReceipt> {
      return message.rpcId === 'known' ? { accepted: true } : { accepted: false, reason: 'not-pending' }
    },
    downloads: {
      async sessionLog() {
        return new Response('stub', { status: 404 })
      },
    },
  }
}

function client(api: ApiProxy = fakeApi(), timeoutMs?: number): InProcessApiClient {
  return new InProcessApiClient(toFetchHandler(api), timeoutMs)
}

async function collect<F>(stream: AsyncIterable<RpcRequest<F>>): Promise<RpcRequest<F>[]> {
  const out: RpcRequest<F>[] = []
  for await (const envelope of stream) out.push(envelope)
  return out
}

describe('unary round trip (handler ⇄ client, no network)', () => {
  it('carries a success result and echoes the minted rpcId', async () => {
    const response = await client().sessions.list({})
    expect(response.result).toEqual({ ok: true, value: { items: [] } })
    expect(response.rpcId).toMatch(/[0-9a-f-]{36}/)
  })

  it('carries the tail-page projections block through the wire schema (Zod must not strip it)', async () => {
    const response = await client().sessions.history({ sessionId: 'with-projections' as never })
    expect(response.result.ok).toBe(true)
    if (response.result.ok) {
      expect(response.result.value.projections).toEqual(
        { asOfSeq: 9, values: { todos: [{ content: 'current', status: 'in_progress' }] } },
      )
    }
  })

  it('carries a business error as 200 + error result', async () => {
    const response = await client().sessions.history({ sessionId: 'missing' as never })
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) expect(response.result.error.code).toBe('session-not-found')
  })

  it('covers create/prompt/updateQueue/cancel/describe passthrough', async () => {
    const c = client()
    expect((await c.sessions.search({ query: 'fixture' })).result).toEqual({
      ok: true,
      value: { items: [{ sessionId: 's1', snippet: 'fixture match' }], hasMore: false },
    })
    expect((await c.sessions.create({})).result.ok).toBe(true)
    expect((await c.sessions.models({ sessionId: 's' as never })).result.ok).toBe(true)
    const selected = await c.sessions.selectModel({
      sessionId: 's' as never,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    })
    expect(selected.result).toMatchObject({
      ok: true,
      value: {
        selected: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          reasoningEffort: 'max',
        },
      },
    })
    const renamed = await c.sessions.rename({ sessionId: 's' as never, title: 'named' })
    expect(renamed.result).toMatchObject({ ok: true, value: { title: 'named', seq: 0 } })
    expect((await c.sessions.prompt({ sessionId: 's' as never, mode: 'queue', content: [{ type: 'text', text: 'x' }] })).result.ok).toBe(true)
    expect((await c.sessions.attachment({ sessionId: 's' as never, attachmentId: 'a' as never })).result.ok).toBe(true)
    expect((await c.sessions.updateQueue({
      sessionId: 's' as never,
      itemId: 'item-1' as never,
      action: { kind: 'remove' },
    })).result.ok).toBe(true)
    expect((await c.sessions.cancel({ sessionId: 's' as never })).result.ok).toBe(true)
    expect((await c.host.describe({})).result.ok).toBe(true)
  })

  it('round-trips every agent-preset method, authoring included', async () => {
    const c = client()

    // The whole domain crosses the carrier: the roster a picker reads, the
    // per-session switch, and the authoring calls the settings page makes.
    // Each has its own request schema, so a registration missing from either
    // half fails here rather than in the browser.
    expect((await c.agentPresets.list({})).result).toEqual({
      ok: true, value: { presets: [], authorable: false, hasDocument: false },
    })
    expect((await c.agentPresets.select({ sessionId: 's' as never, agentPreset: 'minimal' })).result)
      .toEqual({ ok: true, value: { agentPreset: 'minimal' } })
    expect((await c.agentPresets.read({ agentPreset: 'mine' })).result).toEqual({
      ok: true, value: { agentPreset: 'mine', trust: 'user', content: '' },
    })
    expect((await c.agentPresets.copy({ from: 'standard', agentPreset: 'mine' })).result)
      .toEqual({ ok: true, value: { agentPreset: 'mine' } })
    expect((await c.agentPresets.openDocument({ agentPreset: 'mine' })).result)
      .toEqual({ ok: true, value: { opened: true } })
    expect((await c.agentPresets.remove({ agentPreset: 'mine' })).result).toEqual({ ok: true, value: {} })
  })

  it('round-trips the native picker without the default unary timeout', async () => {
    const api = fakeApi()
    api.host.pickDirectory = async (request) => {
      await new Promise(resolve => setTimeout(resolve, 15))
      return { rpcId: request.rpcId, result: { ok: true, value: { path: '/tmp/project' } } }
    }
    const response = await client(api, 1).host.pickDirectory({})
    expect(response.result).toEqual({ ok: true, value: { path: '/tmp/project' } })
  })

  it('round-trips the browse listing and creation calls through the wire form', async () => {
    const c = client()
    const listed = await c.host.listDirectory({ path: '/w' })
    expect(listed.result).toEqual({
      ok: true,
      value: { path: '/w', home: '/w', crumbs: [{ name: '/', path: '/', hidden: false }], entries: [], truncated: false },
    })
    const home = await c.host.listDirectory({})
    expect(home.result).toMatchObject({ ok: true, value: { home: '/w' } })
    const created = await c.host.createDirectory({ path: '/w', name: 'fresh' })
    expect(created.result).toEqual({ ok: true, value: { path: '/w/new' } })
  })

  it('round-trips host.openPath through the wire form', async () => {
    const api = fakeApi()
    let opened: string | undefined
    api.host.openPath = async (request) => {
      opened = request.payload.path
      return { rpcId: request.rpcId, result: { ok: true, value: { opened: true as const } } }
    }
    const response = await client(api).host.openPath({ path: '/tmp/a.txt' })
    expect(opened).toBe('/tmp/a.txt')
    expect(response.result).toEqual({ ok: true, value: { opened: true } })
  })

  it('round-trips skill.list through the wire form', async () => {
    const c = client()
    const skills = await c.skills.list({ sessionId: 's' as never })
    expect(skills.result).toEqual({ ok: true, value: { skills: [{ name: 'commit-helper', description: 'Git commits', modelInvocable: true }] } })
  })

  it('lets host.pickDirectory finish after the 30-second default unary deadline', async () => {
    vi.useFakeTimers()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(() => {
        controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      }, milliseconds)
      return controller.signal
    })
    try {
      const api = fakeApi()
      api.host.pickDirectory = async (request) => {
        await new Promise(resolve => setTimeout(resolve, 30_001))
        return { rpcId: request.rpcId, result: { ok: true, value: { path: '/tmp/slow' } } }
      }
      const execution = client(api).host.pickDirectory({})
      const assertion = expect(execution).resolves.toMatchObject({
        result: { ok: true, value: { path: '/tmp/slow' } },
      })

      await Promise.all([
        vi.advanceTimersByTimeAsync(30_001),
        assertion,
      ])
      expect(timeoutSpy).not.toHaveBeenCalled()
    } finally {
      timeoutSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('round-trips the subagent domain through the wire form', async () => {
    const c = client()
    expect((await c.subagents.list({ parentSessionId: 'parent' as never })).result)
      .toEqual({ ok: true, value: { entries: [], parentAvailable: false } })
    expect((await c.subagents.history({
      parentSessionId: 'parent' as never,
      childSessionId: 'child' as never,
      mode: 'one-shot',
    })).result).toEqual({ ok: true, value: { events: [], hasMore: false } })
    expect((await c.subagents.prompt({
      parentSessionId: 'parent' as never,
      childSessionId: 'child' as never,
      mode: 'continuable',
      content: [],
    })).result).toEqual({ ok: true, value: { messageId: 'message-1' } })
    expect((await c.subagents.interrupt({
      parentSessionId: 'parent' as never,
      childSessionId: 'child' as never,
      mode: 'continuable',
    })).result).toEqual({ ok: true, value: { accepted: true } })
  })

  it('keeps caller and connection aborts on a deadline-exempt unary', async () => {
    const api = fakeApi()
    const started = Promise.withResolvers<AbortSignal>()
    api.host.pickDirectory = async (request, signal) => {
      started.resolve(signal)
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
      return {
        rpcId: request.rpcId,
        result: { ok: false, error: { code: 'cancelled', message: 'aborted', details: {} } },
      }
    }
    const controller = new AbortController()
    const execution = client(api).host.pickDirectory({}, controller.signal)
    const handlerSignal = await started.promise

    controller.abort(new Error('connection closed'))

    await expect(execution).rejects.toThrow('connection closed')
    expect(handlerSignal.aborted).toBe(true)
  })

  it('propagates the carrier Request signal into session.search', async () => {
    const handler = toFetchHandler(fakeApi())
    const controller = new AbortController()
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'r-search-sig',
      method: 'session.search',
      payload: { query: 'hang' },
    })
    const pending = handler.fetch(new Request(
      'http://x/api/session.search',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal },
    ))
    controller.abort()
    const response = await pending
    const parsed = await response.json() as {
      rpcId: string
      result: { error?: { code: string } }
    }
    expect(parsed.rpcId).toBe('r-search-sig')
    expect(parsed.result.error?.code).toBe('cancelled')
  })

  it('propagates the carrier Request signal into subagent.prompt', async () => {
    const handler = toFetchHandler(fakeApi())
    const controller = new AbortController()
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'r-subagent-sig',
      method: 'subagent.prompt',
      payload: {
        parentSessionId: 'parent',
        childSessionId: 'child',
        mode: 'continuable',
        content: [{ type: 'text', text: 'hang' }],
      },
    })
    const pending = handler.fetch(new Request(
      'http://x/api/subagent.prompt',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal },
    ))
    controller.abort()
    const response = await pending
    const parsed = await response.json() as {
      rpcId: string
      result: { error?: { code: string } }
    }
    expect(parsed.rpcId).toBe('r-subagent-sig')
    expect(parsed.result.error?.code).toBe('cancelled')
  })

  it('propagates the carrier Request signal into host.pickDirectory', async () => {
    const api = fakeApi()
    api.host.pickDirectory = async (request, signal) => {
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
      return {
        rpcId: request.rpcId,
        result: { ok: false, error: { code: 'cancelled', message: 'aborted', details: {} } },
      }
    }
    const handler = toFetchHandler(api)
    const controller = new AbortController()
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r-picker', method: 'host.pickDirectory', payload: {} })
    const pending = handler.fetch(new Request('http://x/api/host.pickDirectory', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal,
    }))
    controller.abort()
    const parsed = await (await pending).json() as { result: { error?: { code: string } } }
    expect(parsed.result.error?.code).toBe('cancelled')
  })
})

describe('handler carrier-layer statuses', () => {
  const handler = toFetchHandler(fakeApi())

  it('404s unknown paths and non-POST non-stream methods', async () => {
    expect((await handler.fetch(new Request('http://x/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(404)
    expect((await handler.fetch(new Request('http://x/api/session.list', { method: 'GET' }))).status).toBe(404)
    expect((await handler.fetch(new Request('http://x/api/no.such', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'no.such', payload: {} }) }))).status).toBe(404)
  })

  it('400s a non-JSON body', async () => {
    const response = await handler.fetch(new Request('http://x/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }))
    expect(response.status).toBe(400)
  })

  it('rejects a malformed envelope with bad-request and the invalid-request sentinel rpcId', async () => {
    const response = await handler.fetch(new Request('http://x/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: true }) }))
    expect(response.status).toBe(200)
    const body = await response.json() as { rpcId: string; result: { ok: boolean; error?: { code: string } } }
    expect(body.rpcId).toBe('invalid-request')
    expect(body.result.error?.code).toBe('bad-request')
  })

  it('rejects a method/path mismatch echoing the envelope rpcId', async () => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r-9', method: 'session.cancel', payload: {} })
    const response = await handler.fetch(new Request('http://x/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
    const parsed = await response.json() as { rpcId: string; result: { error?: { message: string } } }
    expect(parsed.rpcId).toBe('r-9')
    expect(parsed.result.error?.message).toContain('does not match path')
  })

  it('rejects an invalid payload with the zod issues attached', async () => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r-10', method: 'session.cancel', payload: {} })
    const response = await handler.fetch(new Request('http://x/api/session.cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
    const parsed = await response.json() as { result: { error?: { code: string; details: { issues: unknown[] } } } }
    expect(parsed.result.error?.code).toBe('bad-request')
    expect(parsed.result.error?.details.issues.length).toBeGreaterThan(0)
  })

  it('500s when the impl itself throws', async () => {
    const crashing = toFetchHandler(fakeApi({ crashOn: 'session.list' }))
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r-11', method: 'session.list', payload: {} })
    const response = await crashing.fetch(new Request('http://x/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('impl crashed')
  })

  it('routes /api/respond, rejecting malformed client-responses as a receipt', async () => {
    const good = JSON.stringify({ type: 'client-response', rpcId: 'known', result: { ok: true, value: null } })
    const goodReceipt: unknown = await (await handler.fetch(new Request('http://x/api/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: good }))).json()
    expect(goodReceipt).toEqual({ accepted: true })
    const bad = JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'x', payload: {} })
    const badReceipt: unknown = await (await handler.fetch(new Request('http://x/api/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: bad }))).json()
    expect(badReceipt).toEqual({ accepted: false, reason: 'bad-response' })
  })

  it('accepts (url, init) form fetch invocation', async () => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r-12', method: 'session.list', payload: {} })
    const response = await handler.fetch('http://x/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(response.status).toBe(200)
  })
})

describe('SSE streams through the carrier', () => {
  it('yields mux frames as ServerRequest narrow forms and completes', async () => {
    const ac = new AbortController()
    const frames = await collect(client().events.mux({}, ac.signal))
    expect(frames).toHaveLength(1)
    expect(frames[0]?.payload).toMatchObject({ type: 'session/subscribed' })
    expect(frames[0]?.rpcId).toBe('frame-0')
  })

  it('yields host frames', async () => {
    const ac = new AbortController()
    const frames = await collect(client().events.host({}, ac.signal))
    expect(frames[0]?.payload).toMatchObject({ type: 'host/session-removed' })
  })

  it('drops frames after the consumer aborts mid-stream', async () => {
    const many = Array.from({ length: 50 }, (_, i): MuxFrame => ({ type: 'session/subscribed', sessionId: `s${String(i)}` as never, lastSeq: i }))
    const ac = new AbortController()
    const received: RpcRequest<MuxFrame>[] = []
    for await (const envelope of client(fakeApi({ muxFrames: many })).events.mux({}, ac.signal)) {
      received.push(envelope)
      if (received.length === 2) break // generator return → reader.cancel path
    }
    expect(received).toHaveLength(2)
  })

  it('swallows a reader.cancel rejection on early exit', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const frame = { type: 'server-request', rpcId: 'f0', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's', lastSeq: -1 } }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        // stream intentionally left open: the consumer breaks first
      },
      cancel() {
        throw new Error('cancel refused')
      },
    })
    const c = new InProcessApiClient({ fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) })
    const received: RpcRequest<MuxFrame>[] = []
    for await (const envelope of c.events.mux({}, new AbortController().signal)) {
      received.push(envelope)
      break
    }
    expect(received).toHaveLength(1)
  })

  it('surfaces a mid-stream impl failure as one stream/error frame, then the stream ends', async () => {
    const api = fakeApi()
    api.events.mux = (_request, _signal) => (async function * (): AsyncGenerator<RpcRequest<MuxFrame>> {
      yield { rpcId: RpcId('f0'), payload: { type: 'session/subscribed', sessionId: 's' as never, lastSeq: -1 } }
      throw new Error('stream source died')
    })()
    const frames = await collect(client(api).events.mux({}, new AbortController().signal))
    expect(frames).toHaveLength(2)
    expect(frames[1]?.payload).toMatchObject({ type: 'stream/error', error: { code: 'internal' } })
  })
})

describe('client respond and transport failures', () => {
  it('passes a client-response through and parses the receipt', async () => {
    const receipt = await client().respond({ type: 'client-response', rpcId: RpcId('known'), result: { ok: true, value: null } })
    expect(receipt).toEqual({ accepted: true })
    const late = await client().respond({ type: 'client-response', rpcId: RpcId('late'), result: { ok: true, value: null } })
    expect(late).toEqual({ accepted: false, reason: 'not-pending' })
  })

  it('throws on non-OK unary and respond and stream transport', async () => {
    const broken = new InProcessApiClient({ fetch: async () => new Response('down', { status: 503 }) })
    await expect(broken.sessions.list({})).rejects.toThrow('transport failure for /api/session.list: HTTP 503')
    await expect(broken.respond({ type: 'client-response', rpcId: RpcId('r'), result: { ok: true, value: null } }))
      .rejects.toThrow('transport failure for /api/respond')
    await expect(collect(broken.events.mux({}, new AbortController().signal))).rejects.toThrow('transport failure for /api/events.mux')
  })

  it('throws on an rpcId echo mismatch', async () => {
    const lying = new InProcessApiClient({
      fetch: async () => Response.json({ type: 'server-response', rpcId: 'someone-else', result: { ok: true, value: { items: [] } } }),
    })
    await expect(lying.sessions.list({})).rejects.toThrow('rpcId mismatch')
  })
})

describe('envelope observation', () => {
  it('batches envelopes per microtask and isolates a throwing listener', async () => {
    const c = client()
    const batches: (readonly RpcMessage[])[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unsubscribeThrowing = c.subscribeEnvelopes(() => { throw new Error('observer bug') })
    const unsubscribe = c.subscribeEnvelopes((batch) => { batches.push(batch) })
    await c.sessions.list({})
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    // request and response tap in separate microtask windows (the await between
    // them yields), so both arrive but batch count is timing-defined
    expect(batches.flatMap(batch => batch.map(message => message.type))).toEqual(['client-request', 'server-response'])
    expect(errorSpy).toHaveBeenCalled()
    unsubscribe()
    unsubscribeThrowing()
    errorSpy.mockRestore()
  })

  it('skips buffering entirely with no listeners and after unsubscribe', async () => {
    const c = client()
    const seen: RpcMessage[] = []
    const unsubscribe = c.subscribeEnvelopes((batch) => { seen.push(...batch) })
    unsubscribe()
    await c.sessions.list({})
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(seen).toHaveLength(0)
  })

  it('coalesces multiple calls in one microtask window into one flush', async () => {
    const c = client()
    const batches: (readonly RpcMessage[])[] = []
    c.subscribeEnvelopes((batch) => { batches.push(batch) })
    await Promise.all([c.sessions.list({}), c.host.describe({})])
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const total = batches.reduce((n, batch) => n + batch.length, 0)
    expect(total).toBe(4)
  })
})

describe('resolveBase', () => {
  it('prefers a real location.origin and falls back to the internal authority', async () => {
    class Probe extends AbstractApiClient {
      urls: string[] = []
      protected async doFetch(input: URL): Promise<Response> {
        this.urls.push(input.href)
        return Response.json({ type: 'server-response', rpcId: this.lastMinted, result: { ok: true, value: { items: [] } } })
      }

      lastMinted = ''
      protected override mintRpcId(): ReturnType<AbstractApiClient['mintRpcId']> {
        const id = super.mintRpcId()
        this.lastMinted = id
        return id
      }
    }
    const probe = new Probe()
    await probe.sessions.list({})
    expect(probe.urls[0]).toMatch(/^http:\/\/dsh\.internal\//)

    const globalWithLocation = globalThis as { location?: { origin?: string } }
    globalWithLocation.location = { origin: 'http://host.example' }
    try {
      const probe2 = new Probe()
      await probe2.sessions.list({})
      expect(probe2.urls[0]).toMatch(/^http:\/\/host\.example\//)
      globalWithLocation.location = { origin: 'null' } // sandboxed iframe shape
      const probe3 = new Probe()
      await probe3.sessions.list({})
      expect(probe3.urls[0]).toMatch(/^http:\/\/dsh\.internal\//)
    } finally {
      delete globalWithLocation.location
    }
  })
})
