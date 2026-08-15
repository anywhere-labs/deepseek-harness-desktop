/**
 * Wire-protocol coverage over the isomorphic point: InProcessApiClient →
 * toFetchHandler(scripted impl) runs the real envelope wrap/unwrap, zod
 * two-level parse, rpcId discipline, and SSE framing with no network and no
 * browser. Each case scripts its own minimal ApiProxy.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApiProxy, GoalRef, HostFrame, MuxFrame, RpcMessage, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy'
import { InProcessApiClient, RpcId, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

function ok<T>(request: RpcRequest<unknown>, value: T): Promise<RpcResponse<T>> {
  return Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value } })
}

/** Scripted impl: every method resolves an empty-ish OK unless a case overrides it. */
function scriptedApi(overrides: {
  sessions?: Partial<ApiProxy['sessions']>
  subagents?: Partial<ApiProxy['subagents']>
  host?: Partial<ApiProxy['host']>
  skills?: Partial<ApiProxy['skills']>
  agentPresets?: Partial<ApiProxy['agentPresets']>
  events?: Partial<ApiProxy['events']>
  goals?: Partial<ApiProxy['goals']>
  settings?: Partial<ApiProxy['settings']>
  credentials?: Partial<ApiProxy['credentials']>
  llm?: Partial<ApiProxy['llm']>
  respond?: ApiProxy['respond']
} = {}): ApiProxy {
  async function *empty<F>(): AsyncGenerator<RpcRequest<F>> { /* no frames */ }
  const err = <T>(r: RpcRequest<unknown>): Promise<RpcResponse<T>> =>
    Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'internal' as const, message: 'stub', details: {} } } })
  return {
    sessions: {
      list: r => ok(r, { items: [] }),
      search: r => ok(r, { items: [], hasMore: false }),
      create: r => ok(r, { sessionId: sid('s-new') }),
      history: r => ok(r, {
        events: [],
        hasMore: false,
        modelSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
      models: r => ok(r, {
        current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        routable: true,
        groups: [],
        failures: [],
      }),
      selectModel: r => ok(r, {
        selected: { provider: r.payload.provider, model: r.payload.model },
      }),
      rename: r => ok(r, { title: 'renamed', seq: 0 }),
      fork: r => ok(r, { sessionId: sid('s-fork') }),
      prompt: r => ok(r, { accepted: true as const }),
      attachment: r => ok(r, {
        attachment: { attachmentId: 'a' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
        data: 'AA==',
      }),
      updateQueue: r => ok(r, { accepted: true as const }),
      cancel: r => ok(r, { accepted: true as const }),
      delete: r => ok(r, { deleted: true as const }),
      ...overrides.sessions,
    },
    subagents: {
      list: r => ok(r, { entries: [], parentAvailable: false }),
      history: r => ok(r, { events: [], hasMore: false }),
      prompt: r => ok(r, { messageId: 'message-1' as never }),
      interrupt: r => ok(r, { accepted: true as const }),
      ...overrides.subagents,
    },
    host: {
      describe: r => ok(r, {
        version: '0-test', cwd: '/t', attachedSessions: 0, canOpenPath: true,
      }),
      pickDirectory: r => ok(r, { path: null }),
      listDirectory: r => ok(r, { path: '/t', home: '/t', crumbs: [], entries: [], truncated: false }),
      createDirectory: r => ok(r, { path: '/t/new' }),
      openPath: r => ok(r, { opened: true as const }),
      ...overrides.host,
    },
    workspace: {
      list: r => ok(r, { items: [], archivedSessionIds: [] }),
      create: r => ok(r, { workspace: { workspaceId: 'w1' as never, path: '/t', title: 't', sessionIds: [], createdAt: '0', updatedAt: '0' }, created: true }),
      rename: r => ok(r, { workspace: { workspaceId: 'w1' as never, path: '/t', title: 't', sessionIds: [], createdAt: '0', updatedAt: '0' } }),
      delete: r => ok(r, { deleted: true as const }),
      insertBefore: r => ok(r, { workspaceIds: [r.payload.workspaceId] }),
      insertSessionBefore: r => ok(r, { workspace: { workspaceId: 'w1' as never, path: '/t', title: 't', sessionIds: [], createdAt: '0', updatedAt: '0' } }),
      archiveSession: r => ok(r, { archivedSessionIds: [r.payload.sessionId] }),
    },
    skills: { list: r => ok(r, { skills: [] }), ...overrides.skills },
    agentPresets: {
      list: r => ok(r, { presets: [], authorable: false, hasDocument: false }),
      select: r => ok(r, { agentPreset: r.payload.agentPreset }),
      read: r => ok(r, { agentPreset: r.payload.agentPreset, trust: 'user' as const, content: '' }),
      copy: r => ok(r, { agentPreset: r.payload.agentPreset }),
      openDocument: r => ok(r, { opened: true as const }),
      remove: r => ok(r, {}),
      ...overrides.agentPresets,
    },
    goals: {
      create: err,
      edit: err,
      pause: err,
      resume: err,
      complete: err,
      clear: err,
      ...overrides.goals,
    },
    settings: {
      describe: r => ok(r, { writable: true, hasDocument: false, namespaces: [] }),
      openDocument: r => ok(r, { opened: true as const }),
      update: err,
      replace: err,
      mutate: err,
      ...overrides.settings,
    },
    credentials: {
      describe: r => ok(r, { credentials: {} }),
      set: err,
      unset: err,
      ...overrides.credentials,
    },
    llm: {
      providers: r => ok(r, { providers: [] }),
      models: r => ok(r, { groups: [], failures: [] }),
      discoverModels: err,
      ...overrides.llm,
    },
    events: { mux: () => empty<MuxFrame>(), host: () => empty<HostFrame>(), ...overrides.events },
    respond: overrides.respond ?? (() => Promise.resolve({ accepted: false as const, reason: 'not-pending' as const })),
    downloads: { sessionLog: async () => new Response('stub', { status: 404 }) },
  }
}

function client(api: ApiProxy, timeoutMs?: number): InProcessApiClient {
  return new InProcessApiClient(toFetchHandler(api), timeoutMs)
}

/** Wrap one scripted method to record its invocation into `seen` before responding. */
function recorderInto(seen: { method: string; payload: unknown }[]) {
  return <P, V>(method: string, respond: (r: RpcRequest<P>) => Promise<RpcResponse<V>>) =>
    (r: RpcRequest<P>): Promise<RpcResponse<V>> => {
      seen.push({ method, payload: r.payload })
      return respond(r)
    }
}

describe('unary round trip', () => {
  it('carries payload out and value back through the full wire form', async () => {
    let seen: RpcRequest<{ cursor?: string }> | undefined
    const api = scriptedApi({
      sessions: {
        list: (r) => {
          seen = r
          return ok(r, { items: [{ sessionId: sid('s1'), updatedAt: 7, running: false, blank: false }] })
        },
      },
    })
    const response = await client(api).sessions.list({ cursor: 'c1' })
    // Impl received the narrow form with a minted id; client returned the same id and value.
    expect(seen?.payload).toEqual({ cursor: 'c1' })
    expect(seen?.rpcId).toBeTruthy()
    expect(response.rpcId).toBe(seen?.rpcId)
    expect(response.result).toEqual({ ok: true, value: { items: [{ sessionId: 's1', updatedAt: 7, running: false, blank: false }] } })
  })

  it('round-trips a trimmed session search query and its bounded result metadata', async () => {
    let seen: RpcRequest<{ query: string }> | undefined
    const api = scriptedApi({
      sessions: {
        search: (request) => {
          seen = request
          return ok(request, {
            items: [{ sessionId: sid('s1'), snippet: 'matching message text' }],
            hasMore: true,
          })
        },
      },
    })
    const response = await client(api).sessions.search({ query: '  message text  ' })
    expect(seen?.payload).toEqual({ query: 'message text' })
    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{ sessionId: 's1', snippet: 'matching message text' }],
        hasMore: true,
      },
    })
  })

  it('rejects an overlong session-search snippet at the client value boundary', async () => {
    const api = scriptedApi({
      sessions: {
        search: request => ok(request, {
          items: [{ sessionId: sid('s1'), snippet: '😀'.repeat(241) }],
          hasMore: false,
        }),
      },
    })

    await expect(client(api).sessions.search({ query: 'message' }))
      .rejects.toThrow(/240 Unicode code points/)
  })

  it('routes session fork with its optional cut anchor through the wire', async () => {
    let seen: RpcRequest<{ sessionId: SessionId; atSeq?: number }> | undefined
    const api = scriptedApi({
      sessions: {
        fork: (request) => {
          seen = request
          return ok(request, { sessionId: sid('s-child') })
        },
      },
    })
    const response = await client(api).sessions.fork({ sessionId: sid('s-parent'), atSeq: 7 })
    expect(seen?.payload).toEqual({ sessionId: 's-parent', atSeq: 7 })
    expect(response.result).toEqual({ ok: true, value: { sessionId: 's-child' } })
  })

  it('routes workspace rename, delete, and ordering through the wire', async () => {
    const api = scriptedApi()
    const c = client(api)
    const renamed = await c.workspace.rename({ workspaceId: 'w1' as never, title: 'next' })
    expect(renamed.result.ok).toBe(true)
    const blankTitle = await c.workspace.rename({ workspaceId: 'w1' as never, title: '   ' })
    expect(blankTitle.result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const deleted = await c.workspace.delete({ workspaceId: 'w1' as never })
    expect(deleted.result).toEqual({ ok: true, value: { deleted: true } })
    const workspaceOrder = await c.workspace.insertBefore({
      workspaceId: 'w1' as never,
      beforeWorkspaceId: 'w2' as never,
    })
    expect(workspaceOrder.result).toEqual({ ok: true, value: { workspaceIds: ['w1'] } })
    const anchored = await c.workspace.insertSessionBefore({ workspaceId: 'w1' as never, sessionId: sid('s1'), beforeSessionId: sid('s2') })
    expect(anchored.result.ok).toBe(true)
    const appended = await c.workspace.insertSessionBefore({ workspaceId: 'w1' as never, sessionId: sid('s1') })
    expect(appended.result.ok).toBe(true)
  })

  it('routes the agent-preset roster and switch through the wire', async () => {
    const c = client(scriptedApi())

    const listed = await c.agentPresets.list({})
    expect(listed.result).toEqual({ ok: true, value: { presets: [], authorable: false, hasDocument: false } })

    // The switch carries the session it is about: the host refuses one whose
    // conversation has started, and it can only know which by id.
    const selected = await c.agentPresets.select({ sessionId: sid('s1'), agentPreset: 'standard' })
    expect(selected.result).toEqual({ ok: true, value: { agentPreset: 'standard' } })
  })

  it('passes business errors through as 200 + err result, not a throw', async () => {
    const api = scriptedApi({
      sessions: {
        cancel: r => Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'session-not-found', message: 'nope', details: { sessionId: sid('sx') } } } }),
      },
    })
    const response = await client(api).sessions.cancel({ sessionId: sid('sx') })
    expect(response.result).toEqual({ ok: false, error: { code: 'session-not-found', message: 'nope', details: { sessionId: 'sx' } } })
  })

  it('throws on rpcId echo mismatch', async () => {
    const api = scriptedApi({
      sessions: { list: () => Promise.resolve({ rpcId: RpcId('forged'), result: { ok: true, value: { items: [] } } }) },
    })
    await expect(client(api).sessions.list({})).rejects.toThrow(/rpcId mismatch/)
  })

  it('rejects an invalid payload at the handler as 200 + bad-request with issues', async () => {
    const api = scriptedApi()
    const response = await client(api).sessions.history({ sessionId: 123 as unknown as SessionId })
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) {
      expect(response.result.error.code).toBe('bad-request')
      expect((response.result.error.details as { issues: unknown[] }).issues.length).toBeGreaterThan(0)
    }
  })

  it('round-trips subagent.interrupt and rejects a one-shot or incomplete address', async () => {
    const interrupt = vi.fn((r: RpcRequest<unknown>) => ok(r, { accepted: true as const }))
    const api = scriptedApi({ subagents: { interrupt } })
    const c = client(api)

    const accepted = await c.subagents.interrupt({
      parentSessionId: sid('parent'), childSessionId: sid('child'), mode: 'continuable',
    })
    expect(accepted.result).toEqual({ ok: true, value: { accepted: true } })
    expect(interrupt).toHaveBeenCalledTimes(1)

    // The wire schema owns the mode fence: a one-shot address never reaches the impl.
    const oneShot = await c.subagents.interrupt({
      parentSessionId: sid('parent'), childSessionId: sid('child'), mode: 'one-shot',
    } as never)
    expect(oneShot.result.ok).toBe(false)
    if (!oneShot.result.ok) expect(oneShot.result.error.code).toBe('bad-request')

    const incomplete = await c.subagents.interrupt({
      parentSessionId: sid('parent'), mode: 'continuable',
    } as never)
    expect(incomplete.result.ok).toBe(false)
    if (!incomplete.result.ok) expect(incomplete.result.error.code).toBe('bad-request')
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('rejects a method/path mismatch as bad-request', async () => {
    const handler = toFetchHandler(scriptedApi())
    const body = { type: 'client-request', rpcId: 'r1', method: 'session.create', payload: {} }
    const response = await handler.fetch('http://dsh.internal/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    const parsed = await response.json() as { result: { ok: boolean; error?: { code: string; message: string } } }
    expect(parsed.result.ok).toBe(false)
    expect(parsed.result.error?.code).toBe('bad-request')
    expect(parsed.result.error?.message).toMatch(/does not match path/)
  })

  it('rejects a malformed envelope as bad-request, salvaging the rpcId or falling back to the sentinel', async () => {
    const handler = toFetchHandler(scriptedApi())
    // No salvageable rpcId → the fixed invalid-request sentinel keeps the response a valid ServerResponse.
    const noId = await handler.fetch('http://dsh.internal/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonsense: true }) })
    expect(noId.status).toBe(200)
    const noIdParsed = await noId.json() as { rpcId: string; result: { ok: boolean } }
    expect(noIdParsed.result.ok).toBe(false)
    expect(noIdParsed.rpcId).toBe('invalid-request')
    // A string rpcId in the otherwise-bad body is salvaged for correlation.
    const withId = await handler.fetch('http://dsh.internal/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rpcId: 'salvage-me', nonsense: true }) })
    const withIdParsed = await withId.json() as { rpcId: string; result: { ok: boolean } }
    expect(withIdParsed.result.ok).toBe(false)
    expect(withIdParsed.rpcId).toBe('salvage-me')
  })

  it('maps carrier failures to HTTP statuses and the client throws transport failure', async () => {
    const handler = toFetchHandler(scriptedApi())
    // Unknown method → 404.
    const notFound = await handler.fetch('http://dsh.internal/api/no.such', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(notFound.status).toBe(404)
    // Non-JSON body → 400.
    const badBody = await handler.fetch('http://dsh.internal/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
    expect(badBody.status).toBe(400)
    // Impl crash → 500, and through the client that is a throw, not an err result.
    const crashing = scriptedApi({ sessions: { list: () => { throw new Error('impl exploded') } } })
    await expect(client(crashing).sessions.list({})).rejects.toThrow(/transport failure .*500/)
  })

  it('rejects non-JSON media types before executing anything (cross-site simple-request fence)', async () => {
    const list = vi.fn((r: RpcRequest<{}>) => ok(r, { items: [] }))
    const handler = toFetchHandler(scriptedApi({ sessions: { list } }))
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} })
    // A "simple" browser POST (text/plain — sent with no CORS preflight) is
    // refused at the carrier before the impl runs.
    const plain = await handler.fetch('http://dsh.internal/api/session.list', { method: 'POST', headers: { 'content-type': 'text/plain' }, body })
    expect(plain.status).toBe(415)
    // A string body with no explicit header defaults to text/plain — same fence.
    const unlabelled = await handler.fetch('http://dsh.internal/api/session.list', { method: 'POST', body })
    expect(unlabelled.status).toBe(415)
    expect(list).not.toHaveBeenCalled()
    // Media-type parameters pass: the fence checks the type, not the exact string.
    const charset = await handler.fetch('http://dsh.internal/api/session.list', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body })
    expect(charset.status).toBe(200)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('rejects when the transport never resolves within timeoutMs', async () => {
    // AbortSignal.timeout is immune to fake timers; a short real timeout keeps this fast.
    const never = new InProcessApiClient({
      fetch: (_i: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted by timeout')) })
      }),
    }, 25)
    await expect(never.sessions.list({})).rejects.toThrow()
  })

  it('aborts a unary call through the caller-supplied external signal', async () => {
    // Real-fetch semantics: on abort the rejection is the signal's reason, and the abort
    // works even when the transport ignores the signal entirely (hung impl).
    const gate = new AbortController()
    const hung = new InProcessApiClient({ fetch: () => new Promise<Response>(() => {}) }, 60_000)
    const call = hung.sessions.list({}, gate.signal)
    gate.abort(new Error('externally aborted'))
    await expect(call).rejects.toThrow(/externally aborted/)
  })

  it('rejects an already-aborted signal before touching the transport, mapping a string reason to an Error', async () => {
    let touched = false
    const c = new InProcessApiClient({
      fetch: () => {
        touched = true
        return Promise.resolve(new Response('{}'))
      },
    }, 60_000)
    const gate = new AbortController()
    gate.abort('gone before start')
    await expect(c.sessions.list({}, gate.signal)).rejects.toThrow('gone before start')
    expect(touched).toBe(false)
  })

  it('maps a non-Error, non-string abort reason to the default AbortError message', async () => {
    const gate = new AbortController()
    const hung = new InProcessApiClient({ fetch: () => new Promise<Response>(() => {}) }, 60_000)
    const call = hung.sessions.list({}, gate.signal)
    gate.abort(42)
    await expect(call).rejects.toThrow('This operation was aborted')
  })

  it('passes a signal-less doFetch straight through to the handler', async () => {
    class Probe extends InProcessApiClient {
      direct(url: URL): Promise<Response> {
        return this.doFetch(url)
      }
    }
    const probe = new Probe({ fetch: () => Promise.resolve(new Response('raw')) })
    const response = await probe.direct(new URL('http://dsh.internal/probe'))
    expect(await response.text()).toBe('raw')
  })

  it('throws on an S→C ok value that fails the method value schema (second-level parse)', async () => {
    // Impl echoes rpcId but returns a wrong-shaped value: envelope parse passes, value parse must reject.
    const api = scriptedApi({
      sessions: { list: r => Promise.resolve({ rpcId: r.rpcId, result: { ok: true, value: { items: 'not-an-array' } } }) as never },
    })
    await expect(client(api).sessions.list({})).rejects.toThrow()
  })
})

describe('workspace domain round trip', () => {
  it('routes both workspace methods through their handler rows and value schemas', async () => {
    const c = client(scriptedApi())
    const list = await c.workspace.list({})
    expect(list.result).toEqual({ ok: true, value: { items: [], archivedSessionIds: [] } })
    const created = await c.workspace.create({ path: '/t' })
    expect(created.result.ok).toBe(true)
    if (created.result.ok) expect(created.result.value.created).toBe(true)
    const archivedResponse = await c.workspace.archiveSession({ sessionId: 's-arch' as never })
    expect(archivedResponse.result).toEqual({ ok: true, value: { archivedSessionIds: ['s-arch'] } })
  })

  it('rejects a pathless create payload at the handler schema', async () => {
    const response = await client(scriptedApi()).workspace.create({} as never)
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) expect(response.result.error.code).toBe('bad-request')
  })
})

describe('SSE stream path', () => {
  it('yields frames in order and skips the comment preamble', async () => {
    const frames: MuxFrame[] = [
      { type: 'session/subscribed', sessionId: sid('s1'), lastSeq: 3 },
      { type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } },
    ]
    const api = scriptedApi({
      events: {
        async *mux(request) {
          let n = 0
          for (const frame of frames) yield { rpcId: RpcId(`push-${n++}-${request.rpcId}`), payload: frame }
        },
      },
    })
    const seen: MuxFrame[] = []
    for await (const envelope of client(api).events.mux({}, new AbortController().signal)) {
      seen.push(envelope.payload)
    }
    expect(seen).toEqual(frames)
  })

  it('reassembles frames across arbitrary chunk boundaries', async () => {
    // Two SSE frames split so one frame spans chunks and one chunk carries parts of both.
    const f1 = { type: 'server-request', rpcId: 'a', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 1 } }
    const f2 = { type: 'server-request', rpcId: 'b', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's2', lastSeq: 2 } }
    const wire = `: connected\n\ndata: ${JSON.stringify(f1)}\n\ndata: ${JSON.stringify(f2)}\n\n`
    const cuts = [5, 40, wire.indexOf('data: ', 40) + 3]
    const encoder = new TextEncoder()
    const doFetch = (): Promise<Response> => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        let prev = 0
        for (const cut of [...cuts, wire.length]) {
          controller.enqueue(encoder.encode(wire.slice(prev, cut)))
          prev = cut
        }
        controller.close()
      },
    }), { status: 200 }))
    const chopped = new InProcessApiClient({ fetch: doFetch })
    const seen: string[] = []
    for await (const envelope of chopped.events.mux({}, new AbortController().signal)) {
      seen.push((envelope.payload as { sessionId: string }).sessionId)
      expect(envelope.rpcId).toBe(seen.length === 1 ? 'a' : 'b')
    }
    expect(seen).toEqual(['s1', 's2'])
  })

  it('emits a stream/error frame then closes when the impl throws mid-stream', async () => {
    const api = scriptedApi({
      events: {
        async *host(request): AsyncGenerator<RpcRequest<HostFrame>> {
          yield { rpcId: RpcId(`p-${request.rpcId}`), payload: { type: 'host/session-added', sessionId: sid('s1'), blank: true } }
          throw new Error('impl died mid-stream')
        },
      },
    })
    const seen: HostFrame[] = []
    for await (const envelope of client(api).events.host({}, new AbortController().signal)) {
      seen.push(envelope.payload)
    }
    expect(seen.map(f => f.type)).toEqual(['host/session-added', 'stream/error'])
    const last = seen.at(-1)
    if (last?.type === 'stream/error') expect(last.error.message).toMatch(/impl died mid-stream/)
  })

  it('drops a malformed SSE frame and keeps the stream alive (S→C two-level parse)', async () => {
    const good = { type: 'server-request', rpcId: 'g1', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 1 } }
    const badEnvelope = { type: 'server-response', rpcId: 'x' } // wrong quadrant for a stream
    const badFrame = { type: 'server-request', rpcId: 'b1', method: 'nope', payload: { type: 'no/such-frame' } }
    const wire = [
      'data: {oops', // not JSON
      `data: ${JSON.stringify(badEnvelope)}`,
      `data: ${JSON.stringify(badFrame)}`,
      `data: ${JSON.stringify(good)}`,
    ].map(l => `${l}\n\n`).join('')
    const doFetch = (): Promise<Response> => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire))
        controller.close()
      },
    }), { status: 200 }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const seen: MuxFrame[] = []
      for await (const envelope of new InProcessApiClient({ fetch: doFetch }).events.mux({}, new AbortController().signal)) {
        seen.push(envelope.payload)
      }
      // The three corrupt frames are reported and skipped; the good one still arrives.
      expect(seen).toEqual([{ type: 'session/subscribed', sessionId: 's1', lastSeq: 1 }])
      expect(errorSpy.mock.calls.length).toBe(3)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('fires onOpen once headers are in, before the first frame, and not on transport failure', async () => {
    const api = scriptedApi({
      events: {
        async *mux(request): AsyncGenerator<RpcRequest<MuxFrame>> {
          yield { rpcId: RpcId(`p-${request.rpcId}`), payload: { type: 'session/subscribed', sessionId: sid('s1'), lastSeq: 0 } }
        },
      },
    })
    const order: string[] = []
    const iterator = client(api).events.mux({}, new AbortController().signal, () => order.push('open'))
    expect(order).toEqual([]) // lazy generator: no fetch (and no onOpen) before iteration
    for await (const _ of iterator) order.push('frame')
    expect(order).toEqual(['open', 'frame'])

    // Transport failure path: onOpen must not fire.
    const failing = new InProcessApiClient({ fetch: () => Promise.resolve(new Response('down', { status: 503 })) })
    const failOrder: string[] = []
    await expect((async () => {
      for await (const _ of failing.events.mux({}, new AbortController().signal, () => failOrder.push('open'))) { /* unreachable */ }
    })()).rejects.toThrow(/transport failure/)
    expect(failOrder).toEqual([])
  })

  it('stops consuming when the caller aborts', async () => {
    let implSawAbort = false
    const api = scriptedApi({
      events: {
        async *mux(_request, signal): AsyncGenerator<RpcRequest<MuxFrame>> {
          try {
            let n = 0
            while (true) {
              yield { rpcId: RpcId(`p${n}`), payload: { type: 'session/subscribed', sessionId: sid('s1'), lastSeq: n++ } }
              await new Promise(resolve => setTimeout(resolve, 5))
              if (signal.aborted) return
            }
          } finally {
            implSawAbort = true
          }
        },
      },
    })
    const abort = new AbortController()
    let count = 0
    // In-process abort ends the stream (impl returns on signal.aborted); over a real
    // network fetch the same abort surfaces as a rejection — both stop the loop.
    await (async () => {
      for await (const _ of client(api).events.mux({}, abort.signal)) {
        if (++count === 2) abort.abort()
      }
    })().catch(() => undefined)
    expect(count).toBe(2)
    // Generator teardown may lag the abort by a microtask; poll briefly.
    await vi.waitFor(() => { expect(implSawAbort).toBe(true) })
  })
})

describe('goals unary surface', () => {
  const ref: GoalRef = { id: 'goal-1' as GoalRef['id'], revision: 1 }
  /** The `{ ref }` acknowledgement every non-clear mutation answers (state travels on the projection). */
  const ack = { ref: { id: 'goal-1' as GoalRef['id'], revision: 2 } }

  it('round-trips every goal method with its own payload and value shape', async () => {
    const seen: { method: string; payload: unknown }[] = []
    const record = recorderInto(seen)
    const api = scriptedApi({
      goals: {
        create: record('goal.create', r => ok(r, ack)),
        edit: record('goal.edit', r => ok(r, { ref: { ...ack.ref, revision: 3 } })),
        pause: record('goal.pause', r => ok(r, ack)),
        resume: record('goal.resume', r => ok(r, ack)),
        complete: record('goal.complete', r => ok(r, ack)),
        clear: record('goal.clear', r => ok(r, { cleared: true as const })),
      },
    })
    const c = client(api)

    const created = await c.goals.create({ sessionId: sid('s1'), objective: 'ship it', maxGoalRounds: 4 })
    expect(created.result).toEqual({ ok: true, value: ack })
    const edited = await c.goals.edit({ sessionId: sid('s1'), ref, objective: 'ship v2' })
    expect(edited.result).toEqual({ ok: true, value: { ref: { ...ack.ref, revision: 3 } } })
    expect((await c.goals.pause({ sessionId: sid('s1'), ref })).result).toEqual({ ok: true, value: ack })
    expect((await c.goals.resume({ sessionId: sid('s1'), ref })).result).toEqual({ ok: true, value: ack })
    expect((await c.goals.complete({ sessionId: sid('s1'), ref })).result).toEqual({ ok: true, value: ack })
    const cleared = await c.goals.clear({ sessionId: sid('s1'), ref })
    expect(cleared.result).toEqual({ ok: true, value: { cleared: true } })

    // The handler dispatched each call through its own route row: payload parsed per method.
    expect(seen.map(s => s.method)).toEqual(['goal.create', 'goal.edit', 'goal.pause', 'goal.resume', 'goal.complete', 'goal.clear'])
    expect(seen[0]?.payload).toEqual({ sessionId: 's1', objective: 'ship it', maxGoalRounds: 4 })
    expect(seen[1]?.payload).toEqual({ sessionId: 's1', ref, objective: 'ship v2' })
  })

  it('passes business errors through as results, not throws', async () => {
    // Default scripted goals impl answers an err result: it must arrive as a result, not a throw.
    const failed = await client(scriptedApi()).goals.pause({ sessionId: sid('s1'), ref })
    expect(failed.result.ok).toBe(false)
    if (!failed.result.ok) expect(failed.result.error.code).toBe('internal')
  })

  it('rejects an invalid goal payload at the handler as bad-request', async () => {
    const response = await client(scriptedApi()).goals.create({ sessionId: sid('s1'), objective: '' })
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) expect(response.result.error.code).toBe('bad-request')

    let editCalls = 0
    const api = scriptedApi({ goals: { edit: (r) => { editCalls++; return ok(r, ack) } } })
    const emptyEdit = await client(api).goals.edit({ sessionId: sid('s1'), ref })
    expect(emptyEdit.result.ok).toBe(false)
    if (!emptyEdit.result.ok) expect(emptyEdit.result.error.code).toBe('bad-request')
    expect(editCalls).toBe(0)
  })
})

describe('respond path', () => {
  it('round-trips a client-response to a receipt', async () => {
    const seen: unknown[] = []
    const api = scriptedApi({
      respond: (message) => {
        seen.push(message)
        return Promise.resolve({ accepted: true as const })
      },
    })
    const receipt = await client(api).respond({ type: 'client-response', rpcId: RpcId('req-1'), result: { ok: true, value: { behavior: 'allow' } } })
    expect(receipt).toEqual({ accepted: true })
    expect(seen).toEqual([{ type: 'client-response', rpcId: 'req-1', result: { ok: true, value: { behavior: 'allow' } } }])
  })

  it('returns bad-response for a malformed client-response without reaching the impl', async () => {
    const respond = vi.fn()
    const handler = toFetchHandler(scriptedApi({ respond }))
    const response = await handler.fetch('http://dsh.internal/api/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-response' }) })
    expect(await response.json()).toEqual({ accepted: false, reason: 'bad-response' })
    expect(respond).not.toHaveBeenCalled()
  })
})

describe('envelope tap', () => {
  it('delivers one microtask batch of full forms per unary call', async () => {
    const api = scriptedApi()
    const tapped = client(api)
    const batches: (readonly RpcMessage[])[] = []
    tapped.subscribeEnvelopes(batch => batches.push(batch))
    await tapped.sessions.list({})
    await vi.waitFor(() => { expect(batches.length).toBeGreaterThan(0) })
    const all = batches.flat()
    expect(all.map(m => m.type)).toEqual(['client-request', 'server-response'])
    expect(all[0]?.rpcId).toBe(all[1]?.rpcId)
  })

  it('isolates a throwing listener and keeps serving the call', async () => {
    const api = scriptedApi()
    const tapped = client(api)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const good: string[] = []
      tapped.subscribeEnvelopes(() => { throw new Error('listener bug') })
      tapped.subscribeEnvelopes(batch => good.push(...batch.map(m => m.type)))
      const response = await tapped.sessions.list({})
      expect(response.result.ok).toBe(true)
      await vi.waitFor(() => { expect(good).toContain('server-response') })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('buffers nothing with zero subscribers and unsubscribes cleanly', async () => {
    const api = scriptedApi()
    const tapped = client(api)
    await tapped.sessions.list({}) // no subscribers: must not accumulate
    const batches: (readonly RpcMessage[])[] = []
    const unsubscribe = tapped.subscribeEnvelopes(batch => batches.push(batch))
    unsubscribe()
    await tapped.sessions.list({})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(batches).toEqual([])
  })
})

describe('config unary surface', () => {
  it('round-trips every settings/credentials/llm method with its own payload and value shape', async () => {
    const seen: { method: string; payload: unknown }[] = []
    const record = recorderInto(seen)
    const view = {
      ns: 'llm-deepseek',
      schema: { uid: 1, refs: { 1: { type: 'object' } } },
      value: { baseURL: 'https://next' },
      user: { baseURL: 'https://next' },
      applies: 'live' as const,
      secrets: [{ path: ['apiKey'], set: true }],
      revision: 0,
    }
    const providerRow = {
      provider: 'openai',
      displayName: 'openai',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      active: false,
    }
    const group = { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }
    const api = scriptedApi({
      settings: {
        describe: record('settings.describe', r => ok(r, { writable: true, hasDocument: false, namespaces: [view] })),
        openDocument: record('settings.openDocument', r => ok(r, { opened: true as const })),
        update: record('settings.update', r => ok(r, view)),
        replace: record('settings.replace', r => ok(r, view)),
        mutate: record('settings.mutate', r => ok(r, view)),
      },
      credentials: {
        describe: record('credentials.describe', r => ok(r, { credentials: { OPENAI_API_KEY: { configured: true, source: 'file', writable: true } } })),
        set: record('credentials.set', r => ok(r, {})),
        unset: record('credentials.unset', r => ok(r, {})),
      },
      llm: {
        providers: record('llm.providers', r => ok(r, { providers: [providerRow] })),
        models: record('llm.models', r => ok(r, { groups: [group], failures: [] })),
        discoverModels: record('llm.discoverModels', r => ok(r, { models: [{ id: 'acme-large', contextWindow: 65536 }] })),
      },
    })
    const c = client(api)

    const described = await c.settings.describe({})
    expect(described.result).toEqual({ ok: true, value: { writable: true, hasDocument: false, namespaces: [view] } })
    expect((await c.settings.openDocument({})).result).toEqual({ ok: true, value: { opened: true } })
    const updated = await c.settings.update({ ns: 'llm-deepseek', patch: { baseURL: 'https://next' } })
    expect(updated.result).toEqual({ ok: true, value: view })
    const replaced = await c.settings.replace({ ns: 'llm-deepseek', section: {} })
    expect(replaced.result).toEqual({ ok: true, value: view })
    const mutated = await c.settings.mutate({
      ns: 'llm-deepseek',
      ops: [{ op: 'unset', path: ['baseURL'] }],
      expectedRevision: 0,
    })
    expect(mutated.result).toEqual({ ok: true, value: view })
    const creds = await c.credentials.describe({ refs: ['OPENAI_API_KEY'] })
    expect(creds.result).toEqual({ ok: true, value: { credentials: { OPENAI_API_KEY: { configured: true, source: 'file', writable: true } } } })
    expect((await c.credentials.set({ ref: 'OPENAI_API_KEY', value: 'sk-x' })).result).toEqual({ ok: true, value: {} })
    expect((await c.credentials.unset({ ref: 'OPENAI_API_KEY' })).result).toEqual({ ok: true, value: {} })
    const providers = await c.llm.providers({})
    expect(providers.result).toEqual({ ok: true, value: { providers: [providerRow] } })
    const models = await c.llm.models({})
    expect(models.result).toEqual({ ok: true, value: { groups: [group], failures: [] } })
    const discovered = await c.llm.discoverModels({
      settingsNs: 'llm-pi-ai',
      baseURL: 'https://gateway.acme.example/v1',
      api: 'openai-completions',
      apiKey: 'probe-key',
    })
    expect(discovered.result).toEqual({ ok: true, value: { models: [{ id: 'acme-large', contextWindow: 65536 }] } })

    expect(seen.map(call => call.method)).toEqual([
      'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
      'credentials.describe', 'credentials.set', 'credentials.unset',
      'llm.providers', 'llm.models', 'llm.discoverModels',
    ])
    expect(seen[2]?.payload).toEqual({ ns: 'llm-deepseek', patch: { baseURL: 'https://next' } })
    expect(seen[4]?.payload)
      .toEqual({ ns: 'llm-deepseek', ops: [{ op: 'unset', path: ['baseURL'] }], expectedRevision: 0 })
    expect(seen[6]?.payload).toEqual({ ref: 'OPENAI_API_KEY', value: 'sk-x' })
    // The draft crosses whole, credential included: the host needs it for this
    // one interrogation and stores none of it.
    expect(seen[10]?.payload).toEqual({
      settingsNs: 'llm-pi-ai',
      baseURL: 'https://gateway.acme.example/v1',
      api: 'openai-completions',
      apiKey: 'probe-key',
    })
  })

  it('rejects an invalid credential reference name at the carrier boundary', async () => {
    const api = scriptedApi()
    const response = await client(api).credentials.set({ ref: 'not a var', value: 'x' })
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('bad-request')
  })
})
