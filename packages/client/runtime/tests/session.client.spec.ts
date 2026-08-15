/**
 * Session orchestration: drive the object through contract calls and injected
 * frames (open → prompt → stream → finalize → cancel → resync) and assert the
 * ConversationSnapshot it settles into. Reference stability is asserted with
 * toBe/not.toBe — it is the React.memo/uSES contract, equal-value output is not
 * enough.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { Session } from '../src/client/sessions/session.ts'
import type {
  ChatConversationViewNode, ChatLocationNodeIndex, ChatNodeStore, ChatSnapshot,
  ConversationEventInput, ConversationNode, ConversationNodeDefinition,
  ConversationRuntime, ConversationSnapshot, ConversationTimelineSnapshot,
  ConversationViewDefinition,
} from '../src/client/index.ts'
import { FakeApiClient, deferred, err, fakeRemote, ok } from './fake-api.client.ts'
import { entries, ev, plainTurn } from './event-script.client.ts'

const SID = 'fk-s1' as SessionId
const PARENT = 'fk-parent' as SessionId

afterEach(() => {
  vi.unstubAllGlobals()
})

const EMPTY: readonly never[] = []

interface TestEventState extends ConversationEventInput {}

class TestNodeStore implements ChatNodeStore {
  private readonly nodes = new Map<string, ChatConversationViewNode>()
  private cache: readonly ChatConversationViewNode[] = EMPTY

  get(key: string): ChatConversationViewNode | undefined {
    return this.nodes.get(key)
  }

  values(): readonly ChatConversationViewNode[] {
    return this.cache
  }

  replace(nodes: readonly ChatConversationViewNode[]): void {
    this.nodes.clear()
    for (const node of nodes) this.nodes.set(node.key, node)
    this.cache = [...this.nodes.values()]
  }

  upsert(nodes: readonly ChatConversationViewNode[]): void {
    if (nodes.length === 0) return
    for (const node of nodes) this.nodes.set(node.key, node)
    this.cache = [...this.nodes.values()]
  }
}

const TEST_LOCATIONS: ChatLocationNodeIndex = {
  getTurn: () => EMPTY,
  getStep: () => EMPTY,
}

function testLegacy(
  nodes: readonly ChatConversationViewNode[],
  timeline: ConversationTimelineSnapshot,
): ChatSnapshot['legacy'] {
  const legacyNodes = nodes.flatMap((node): ConversationNode[] => {
    const event = (node.data as TestEventState).event
    if (event.type === 'user/message') return [{ kind: 'user', seq: event.seq } as ConversationNode]
    if (event.type === 'assistant/message') return [{ kind: 'assistant', seq: event.seq } as ConversationNode]
    return []
  })
  const turnTimings = new Map<number, { startTime: number; endTime?: number }>()
  const turnEnds = new Map<number, number>()
  for (const turn of timeline.turns.values()) {
    if (turn.start !== undefined) {
      turnTimings.set(turn.turn, turn.end === undefined
        ? { startTime: turn.start.time }
        : { startTime: turn.start.time, endTime: turn.end.time })
    }
    if (turn.end !== undefined) turnEnds.set(turn.turn, turn.end.seq)
  }
  return { nodes: legacyNodes, turnTimings, turnEnds, partial: null, runningCalls: EMPTY }
}

function testViewDefinition(): ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot> {
  return {
    target: 'chat',
    create: () => {
      const store = new TestNodeStore()
      let current: ChatSnapshot = {
        order: EMPTY,
        nodes: store,
        locations: TEST_LOCATIONS,
        timeline: { turnOrder: EMPTY, turns: new Map() },
        legacy: testLegacy(EMPTY, { turnOrder: EMPTY, turns: new Map() }),
      }
      const build = (timeline: ConversationTimelineSnapshot): ChatSnapshot => {
        const nodes = [...store.values()].sort((left, right) => left.anchorSeq - right.anchorSeq)
        current = {
          order: nodes.map(node => node.key),
          nodes: store,
          locations: TEST_LOCATIONS,
          timeline,
          legacy: testLegacy(nodes, timeline),
        }
        return current
      }
      return {
        empty: current,
        replace: ({ nodes, timeline }) => {
          store.replace(nodes)
          return build(timeline)
        },
        apply: ({ upserts, timeline }) => {
          store.upsert(upserts)
          return build(timeline)
        },
      }
    },
  }
}

const TEST_EVENT_DEFINITION: ConversationNodeDefinition<TestEventState> = {
  kind: 'runtime-test-event',
  target: 'chat',
  match: event => ({ id: String(event.seq), role: 'start' }),
  start: (_context, match) => ({ event: match.event, view: match.view }),
  update: context => context.state,
  publication: match => match.event.type === 'assistant/chunk' ? 'animation-frame' : 'immediate',
  buildViewNode: (context) => {
    if (context.state === undefined || context.start === undefined) return null
    return {
      key: context.key,
      kind: context.start.event.type === 'command/run' && context.start.event.data.name === 'goal'
        ? 'command-input'
        : context.start.event.type === 'command/run' || context.start.event.type === 'command/done'
          ? 'command'
          : 'runtime-test-event',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}

const TEST_CONVERSATION: ConversationRuntime = {
  events: {
    entries: () => [TEST_EVENT_DEFINITION],
    fallbackEntry: () => undefined,
  } as unknown as ConversationRuntime['events'],
  views: {
    entries: () => [testViewDefinition()],
  } as unknown as ConversationRuntime['views'],
}

function makeSession(api = new FakeApiClient()): { api: FakeApiClient; session: Session } {
  return { api, session: new Session(SID, api, fakeRemote(), { conversation: TEST_CONVERSATION }) }
}

function chatEvents(snapshot: ConversationSnapshot): readonly TestEventState[] {
  return snapshot.chat.order.map(key => snapshot.chat.nodes.get(key)?.data as TestEventState)
}

function chatSeqs(snapshot: ConversationSnapshot): number[] {
  return chatEvents(snapshot).map(item => item.event.seq)
}

function histResponse(events: SessionEvent[], hasMore = false) {
  // history returns HistoryEntry[] ({event, view?}); these tests are view-less.
  return Promise.resolve(ok({ events: entries(events) as never[], hasMore }))
}

describe('open', () => {
  it('keeps a bare Session blank until an authoritative lifecycle signal arrives', () => {
    const { session } = makeSession()
    expect(session.getSnapshot()).toMatchObject({ blank: true, composerPhase: 'blank' })

    session.handleRunning(true)
    expect(session.getSnapshot()).toMatchObject({ blank: false, composerPhase: 'active' })
  })

  it('installs the tail page: cold → loading → open with window and nodes in place', async () => {
    const { api, session } = makeSession()
    const page = plainTurn(10, 3, '问', '答')
    api.onHistory = () => histResponse(page, true)
    expect(session.getSnapshot().openState).toBe('cold')
    const opening = session.open()
    expect(session.getSnapshot().openState).toBe('loading')
    await opening
    const snapshot = session.getSnapshot()
    expect(snapshot.openState).toBe('open')
    expect(snapshot.hasMore).toBe(true)
    expect(snapshot.nodes.map(n => n.kind)).toEqual(['user', 'assistant'])
    expect(snapshot.turnTimings.get(3)).toEqual({
      startTime: 1_700_000_000_010,
      endTime: 1_700_000_000_015,
    })
    expect(snapshot.turnEnds.get(3)).toBe(15)
  })

  it('is idempotent: concurrent opens share one history call, reopening when open is a no-op', async () => {
    const { api, session } = makeSession()
    await Promise.all([session.open(), session.open()])
    await session.open()
    expect(api.callsOf('session.history')).toHaveLength(1)
  })

  it('lands an error result in openState=error with the RpcError kept', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(err({ code: 'session-not-found', message: 'gone', details: { sessionId: SID } }))
    await session.open()
    const snapshot = session.getSnapshot()
    expect(snapshot.openState).toBe('error')
    expect(snapshot.openError?.code).toBe('session-not-found')
  })

  it('folds a transport throw into openState=error / internal', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => Promise.reject(new Error('socket died'))
    await session.open()
    expect(session.getSnapshot().openState).toBe('error')
    expect(session.getSnapshot().openError).toMatchObject({ code: 'internal', message: 'socket died' })
  })

  it('stitches live frames arriving while history is pending, dropping the page overlap', async () => {
    const { api, session } = makeSession()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => gate.promise
    const opening = session.open()
    // Three live frames land mid-open; seq 15 overlaps the page tail (page covers 10..15).
    const page = plainTurn(10, 0, '早', '安')
    session.handleMuxEnvelope('r1' as never, { type: 'session/event', sessionId: SID, event: ev.turnStart(15, 1) })
    session.handleMuxEnvelope('r2' as never, { type: 'session/event', sessionId: SID, event: ev.user(16, '插进来的') })
    gate.resolve(ok({
      events: entries(page) as never[],
      hasMore: false,
      modelSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }))
    await opening
    const seqs = session.getSnapshot().nodes.map(n => n.seq)
    // Overlapping seq-15 frame (== page tail turn/end) was dropped; 16 appended once.
    expect(seqs).toEqual([11, 13, 16])
  })
})


describe('live event path', () => {
  async function opened(events: SessionEvent[] = plainTurn(0, 0, 'a', 'b')) {
    const { api, session } = makeSession()
    api.onHistory = () => histResponse(events)
    await session.open()
    return { api, session }
  }

  it('drops replayed frames at or below the window tail', async () => {
    const { session } = await opened()
    const before = session.getSnapshot()
    session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event: ev.user(3, '重放') })
    await Promise.resolve()
    expect(session.getSnapshot().nodes).toEqual(before.nodes)
  })

  it('acceptHostEvent folds one event and drops a same-seq duplicate', async () => {
    const { session } = await opened()
    // A user-initiated mutation (message edit) returns its event directly;
    // a cold session never broadcasts it, so this is the only writer.
    session.acceptHostEvent(ev.user(6, '已编辑'))
    await Promise.resolve()
    const applied = session.getSnapshot()
    const chatNodes = [...applied.chat.nodes.values()]
    expect(chatNodes.some(node => node.anchorSeq === 6)).toBe(true)
    expect(applied.nodes.length).toBeGreaterThan(0)

    // A concurrent broadcast of the SAME event must be dropped by the seq guard.
    session.acceptHostEvent(ev.user(6, '已编辑'))
    await Promise.resolve()
    expect(session.getSnapshot().nodes).toEqual(applied.nodes)
  })

  it('keeps the authoritative host blank bit across unrelated log events', async () => {
    const { session } = await opened([])
    session.handleBlank(true)
    expect(session.getSnapshot().composerPhase).toBe('blank')
    const feed = (event: SessionEvent) => { session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event }) }
    feed(ev.commandRun(0, 'cmd-perm', 'permission', ' danger-full-access'))
    feed(ev.commandDone(1, 'cmd-perm', 'success', 'preset danger-full-access'))
    const snapshot = session.getSnapshot()
    expect(chatSeqs(snapshot)).toEqual([0, 1])
    expect(snapshot.composerPhase).toBe('blank')
  })

  it('activates a fresh conversation for a command-input View Node without opening a model turn', async () => {
    const { session } = await opened([])
    session.handleBlank(true)
    const feed = (event: SessionEvent) => {
      session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event })
    }
    feed(ev.commandRun(0, 'cmd-goal', 'goal', ' '))
    feed(ev.commandDone(1, 'cmd-goal', 'success', 'No goal is currently set.'))

    expect(session.getSnapshot()).toMatchObject({
      blank: true,
      composerPhase: 'active',
    })
    expect(session.getSnapshot().chat.order.map(
      key => session.getSnapshot().chat.nodes.get(key)?.kind,
    )).toContain('command-input')
  })

  it('publishes animation-frame Definitions once per frame and lets an immediate event supersede the pending frame', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const { session } = await opened()
    const published: number[][] = []
    session.subscribe(() => {
      published.push(chatSeqs(session.getSnapshot()))
    })
    const feed = (event: SessionEvent) => {
      session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event })
    }

    feed(ev.chunkStart(6, 1))
    feed(ev.chunkText(7, 1, '累'))
    feed(ev.chunkText(8, 1, '计'))
    expect(published).toEqual([])
    expect(frames).toHaveLength(1)

    frames.shift()!(0)
    expect(published).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8]])

    feed(ev.chunkText(9, 1, '完成'))
    feed(ev.assistant(10, 1, '累计完成'))
    await Promise.resolve()
    expect(published).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    ])

    frames.shift()!(0)
    expect(published).toHaveLength(2)
  })

  it('publishes a timeline-only boundary even when no Definition claims the event', async () => {
    const api = new FakeApiClient()
    api.onHistory = () => histResponse([])
    const conversation: ConversationRuntime = {
      events: {
        entries: () => [],
        fallbackEntry: () => undefined,
      } as unknown as ConversationRuntime['events'],
      views: {
        entries: () => [testViewDefinition()],
      } as unknown as ConversationRuntime['views'],
    }
    const session = new Session(SID, api, fakeRemote(), { conversation })
    await session.open()
    const snapshots: ConversationSnapshot[] = []
    session.subscribe(() => { snapshots.push(session.getSnapshot()) })

    session.handleMuxEnvelope('timeline' as never, {
      type: 'session/event',
      sessionId: SID,
      event: ev.turnStart(0, 1),
    })
    await Promise.resolve()

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.chat.timeline.turns.get(1)?.status).toBe('open')
  })

  it('repairs a seq gap by repulling the tail page instead of appending a hole', async () => {
    const { api, session } = await opened(plainTurn(0, 0, 'a', 'b')) // tail seq = 5
    const repaired = [...plainTurn(0, 0, 'a', 'b'), ...plainTurn(6, 1, 'c', 'd')]
    api.onHistory = () => histResponse(repaired)
    // seq 9 with tail 5 → gap; the event detours to the buffer and one history refetch fires.
    session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event: ev.assistant(9, 1, 'd') })
    await vi.waitFor(() => {
      expect(api.callsOf('session.history').length).toBe(2)
    })
    await Promise.resolve()
    const seqs = session.getSnapshot().nodes.map(n => n.seq)
    expect(seqs).toEqual([1, 3, 7, 9]) // both turns' user/assistant, no hole, no duplicate 9
  })
})

describe('paging', () => {
  it('prepends an older page and keeps seq continuity', async () => {
    const older = plainTurn(0, 0, '旧问', '旧答')
    const newer = plainTurn(6, 1, '新问', '新答')
    const { api, session } = makeSession()
    api.onHistory = payload => payload.beforeSeq === undefined
      ? histResponse(newer, true)
      : histResponse(older, false)
    await session.open()
    await session.loadOlder()
    const snapshot = session.getSnapshot()
    expect(api.callsOf('session.history')).toMatchObject([{}, { beforeSeq: 6 }].map(p => ({ sessionId: SID, ...p })))
    expect(snapshot.hasMore).toBe(false)
    expect(snapshot.nodes.map(n => n.seq)).toEqual([1, 3, 7, 9])
  })

  it('installs a page without interpreting business replacement metadata', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => histResponse([
      ev.compactSummary(80, '窗外范围的摘要', 3, 40),
      ev.compactCheckpoint(81, 80, 3, 40),
      ev.user(82, '压缩后的新问题'),
    ], true)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await session.open()
      const snapshot = session.getSnapshot()
      expect(snapshot.openState).toBe('open')
      expect(chatSeqs(snapshot)).toEqual([80, 81, 82])
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('drops a discontinuous older page fail-soft (window unchanged, hasMore cleared)', async () => {
    const { api, session } = makeSession()
    api.onHistory = payload => payload.beforeSeq === undefined
      ? histResponse(plainTurn(10, 1, '新', '页'), true)
      : histResponse(plainTurn(0, 0, '断', '层'), true) // tail seq 5, but baseSeq is 10 → hole
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await session.open()
      const nodesBefore = session.getSnapshot().nodes
      await session.loadOlder()
      const snapshot = session.getSnapshot()
      expect(snapshot.nodes).toEqual(nodesBefore)
      expect(snapshot.hasMore).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('ignores loadOlder while one is in flight (single request)', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => histResponse(plainTurn(6, 1, 'x', 'y'), true)
    await session.open()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => gate.promise
    const first = session.loadOlder()
    const second = session.loadOlder()
    gate.resolve(ok({
      events: entries(plainTurn(0, 0, 'a', 'b')) as never[],
      hasMore: false,
      modelSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }))
    await Promise.all([first, second])
    expect(api.callsOf('session.history')).toHaveLength(2) // open + one page, not two
  })
})

describe('prompt and cancel errors', () => {
  it('routes an addressed child through non-activating history, continuation prompt, and interrupt only', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, api, fakeRemote(), {
      address: { parentSessionId: PARENT, childSessionId: SID, mode: 'continuable' },
      parentAvailable: true,
    })
    await session.open()
    const prompted = await session.prompt([{ type: 'text', text: '继续' }], 'queue')
    const cancelled = await session.cancel()

    expect(prompted).toEqual({ ok: true, value: { accepted: true } })
    expect(cancelled).toEqual({ ok: true, value: { accepted: true } })
    expect(api.callsOf('subagent.history')).toEqual([
      { parentSessionId: PARENT, childSessionId: SID, mode: 'continuable', maxMessages: 50 },
    ])
    expect(api.callsOf('subagent.prompt')).toEqual([
      {
        parentSessionId: PARENT, childSessionId: SID, mode: 'continuable',
        content: [{ type: 'text', text: '继续' }],
        clientTimeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    ])
    expect(api.callsOf('subagent.interrupt')).toEqual([
      { parentSessionId: PARENT, childSessionId: SID, mode: 'continuable' },
    ])
    expect(api.callsOf('session.history')).toEqual([])
    expect(api.callsOf('session.prompt')).toEqual([])
    expect(api.callsOf('session.cancel')).toEqual([])
    // A successful interrupt leaves no stop error behind.
    expect(session.getSnapshot().promptError).toBeNull()
    expect(session.getSnapshot().subagent).toEqual({
      address: { parentSessionId: PARENT, childSessionId: SID, mode: 'continuable' },
      parentAvailable: true,
    })
  })

  it('lands an interrupt business failure in promptError with op=stop', async () => {
    const api = new FakeApiClient()
    api.onSubagentInterrupt = () => Promise.resolve(err({
      code: 'subagent-unauthorized', message: 'nope', details: { childSessionId: SID },
    }) as never)
    const session = new Session(SID, api, fakeRemote(), {
      address: { parentSessionId: PARENT, childSessionId: SID, mode: 'continuable' },
      parentAvailable: true,
    })
    await session.open()
    const cancelled = await session.cancel()
    expect(cancelled).toMatchObject({ ok: false, error: { code: 'subagent-unauthorized' } })
    expect(session.getSnapshot().promptError).toMatchObject({
      op: 'stop', error: { code: 'subagent-unauthorized' },
    })
  })

  it('keeps one-shot history readable without exposing prompt or cancel transport', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, api, fakeRemote(), {
      address: { parentSessionId: PARENT, childSessionId: SID, mode: 'one-shot' },
    })
    await session.open()
    const prompted = await session.prompt([{ type: 'text', text: '继续' }], 'queue')
    const cancelled = await session.cancel()

    expect(prompted).toMatchObject({ ok: false, error: { code: 'subagent-not-resumable' } })
    expect(cancelled).toMatchObject({ ok: false, error: { code: 'subagent-delivery-unavailable' } })
    expect(api.callsOf('subagent.history')).toEqual([
      { parentSessionId: PARENT, childSessionId: SID, mode: 'one-shot', maxMessages: 50 },
    ])
    expect(api.callsOf('subagent.prompt')).toEqual([])
    expect(api.callsOf('subagent.interrupt')).toEqual([])
    expect(api.callsOf('session.cancel')).toEqual([])
  })

  it('sends content through session.prompt; composerPhase steps blank → engaging synchronously at send entry', async () => {
    const { api, session } = makeSession()
    session.handleBlank(true)
    // The blank → engaging edge fires before the RPC settles: the first-send
    // flow reads the phase on the session area's first frame to keep the
    // guidance hero from flashing back in.
    expect(session.getSnapshot().composerPhase).toBe('blank')
    const inFlight = session.prompt([{ type: 'text', text: '要发的' }], 'queue')
    expect(session.getSnapshot().composerPhase).toBe('engaging')
    const result = await inFlight
    expect(result.ok).toBe(true)
    // Monotone: settlement alone does not step the phase anywhere.
    expect(session.getSnapshot().composerPhase).toBe('engaging')
    expect(api.callsOf('session.prompt')).toMatchObject([{
      sessionId: SID,
      mode: 'queue',
      content: [{ type: 'text', text: '要发的' }],
      clientTimeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    }])
    // First content lands (running turn): engaging → active.
    session.handleRunning(true)
    expect(session.getSnapshot().composerPhase).toBe('active')
  })

  it('business failure lands in promptError with op=send; the phase stays engaging (retry, no hero bounce)', async () => {
    const { api, session } = makeSession()
    session.handleBlank(true)
    api.onPrompt = () => Promise.resolve(err({ code: 'agent-busy', message: 'busy', details: { reason: 'x' } }))
    const result = await session.prompt([{ type: 'text', text: '失败的' }], 'queue')
    expect(result.ok).toBe(false)
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'send', error: { code: 'agent-busy' } })
    // Failed first prompt: composer + error strip is the retry surface —
    // blank is unreachable once a send was initiated.
    expect(session.getSnapshot().composerPhase).toBe('engaging')
  })

  it('lands cancel failures in promptError with op=stop', async () => {
    const { api, session } = makeSession()
    api.onCancel = () => Promise.reject(new Error('cancel transport down'))
    const result = await session.cancel()
    expect(result.ok).toBe(false)
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'stop', error: { code: 'internal' } })
  })

  it('reads session-authorized attachment bytes and keeps the opaque id on the wire', async () => {
    const { api, session } = makeSession()
    const result = await session.readAttachment('attachment-1' as never)
    expect(result).toEqual({
      ok: true,
      value: {
        attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
        data: Uint8Array.of(0),
      },
    })
    expect(api.callsOf('session.attachment')).toEqual([{
      sessionId: SID, attachmentId: 'attachment-1',
    }])
  })
})

describe('rename', () => {
  it('settles the title projection cell from the unary response (higher-seq-wins vs the push frame)', async () => {
    const { api, session } = makeSession()
    api.onRename = () => Promise.resolve(ok({ title: '正名', seq: 7 }))
    const result = await session.rename('  正名  ')
    expect(result).toMatchObject({ ok: true, value: { title: '正名', seq: 7 } })
    expect(api.callsOf('session.rename')).toMatchObject([{ sessionId: SID, title: '  正名  ' }])
    expect(session.projections.faceOf('title').getSnapshot()).toBe('正名')
    // A stale lower-seq apply (the push-frame path routes into this same
    // store) must not roll the settled value back.
    session.projections.apply('title', '旧名', 3)
    expect(session.projections.faceOf('title').getSnapshot()).toBe('正名')
  })

  it('returns the business error untouched and folds a transport throw to internal', async () => {
    const { api, session } = makeSession()
    api.onRename = () => Promise.resolve(err({ code: 'title-invalid', message: 'empty', details: { sessionId: SID } }))
    const rejected = await session.rename('   ')
    expect(rejected).toMatchObject({ ok: false, error: { code: 'title-invalid' } })
    expect(session.projections.faceOf('title').getSnapshot()).toBeUndefined()
    api.onRename = () => Promise.reject(new Error('rename transport down'))
    const folded = await session.rename('x')
    expect(folded).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
})

describe('pending interactions', () => {
  it('adds approval/question on requested and removes them on resolved', async () => {
    const { session } = makeSession()
    session.handleMuxEnvelope('ra' as never, { type: 'approval/requested', sessionId: SID, approvalId: 'ap1' as never, toolName: 'rm' })
    session.handleMuxEnvelope('rq' as never, { type: 'question/requested', sessionId: SID, questions: [] })
    expect(session.getSnapshot().pending.map(p => p.kind).sort()).toEqual(['approval', 'question'])
    session.handleMuxEnvelope('rx' as never, { type: 'approval/resolved', sessionId: SID, approvalId: 'ap1' as never, outcome: 'approved' as never })
    session.handleMuxEnvelope('ry' as never, { type: 'question/resolved', sessionId: SID, questionRpcId: 'rq' as never, outcome: 'answered' })
    expect(session.getSnapshot().pending).toEqual([])
  })

  it('mints waits whose respond() backfills the requested rpcId into the client-response envelope', async () => {
    const { api, session } = makeSession()
    session.handleMuxEnvelope('rq-answer' as never, { type: 'question/requested', sessionId: SID, questions: [] })
    const wait = session.getSnapshot().pending[0]!
    expect(wait).toMatchObject({ kind: 'question', key: 'q:rq-answer', sessionId: SID, payload: { questions: [] } })
    const receipt = await wait.respond({
      ok: true,
      value: { sessionId: SID, answer: { answers: [{ id: 'mode', selected: ['Fast'] }] } },
    })
    expect(receipt).toEqual({ accepted: true })
    expect(api.callsOf('respond')).toEqual([{
      type: 'client-response', rpcId: 'rq-answer',
      result: {
        ok: true,
        value: { sessionId: SID, answer: { answers: [{ id: 'mode', selected: ['Fast'] }] } },
      },
    }])
  })

  it('settles the wait on the authoritative resolved frame: respond() then throws synchronously', async () => {
    const { api, session } = makeSession()
    session.handleMuxEnvelope('rq1' as never, { type: 'question/requested', sessionId: SID, questions: [] })
    const wait = session.getSnapshot().pending[0]!
    session.handleMuxEnvelope('ry' as never, { type: 'question/resolved', sessionId: SID, questionRpcId: 'rq1' as never, outcome: 'answered' })
    expect(session.getSnapshot().pending).toEqual([])
    expect(() => wait.respond({ ok: false, error: { code: 'internal', message: 'x', details: {} } }))
      .toThrow('already settled')
    expect(api.callsOf('respond')).toEqual([])
  })
})

describe('remaining branches', () => {
  it('prompt transport throw folds to internal promptError', async () => {
    const { api, session } = makeSession()
    api.onPrompt = () => Promise.reject(new Error('prompt wire down'))
    const result = await session.prompt([{ type: 'text', text: 'x' }], 'queue')
    expect(result.ok).toBe(false)
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'send', error: { code: 'internal', message: 'prompt wire down' } })
  })

  it('cancel business error also lands op=stop promptError', async () => {
    const { api, session } = makeSession()
    api.onCancel = () => Promise.resolve(err({ code: 'agent-busy', message: 'nope', details: { reason: 'r' } }))
    await session.cancel()
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'stop', error: { code: 'agent-busy' } })
  })

  it('loadOlder guards: not-open/no-hasMore no-op, err result kept window, empty page updates hasMore, throw fail-soft', async () => {
    const { api, session } = makeSession()
    await session.loadOlder() // cold: no-op, zero calls
    expect(api.calls).toEqual([])
    api.onHistory = () => histResponse(plainTurn(6, 1, 'x', 'y'), true)
    await session.open()
    // err result: window unchanged
    api.onHistory = () => Promise.resolve(err({ code: 'internal', message: 'x', details: {} }))
    await session.loadOlder()
    expect(session.getSnapshot().nodes).toHaveLength(2)
    expect(session.getSnapshot().hasMore).toBe(true)
    // empty page: hasMore adopts the response
    api.onHistory = () => histResponse([], false)
    await session.loadOlder()
    expect(session.getSnapshot().hasMore).toBe(false)
    // hasMore false now: further loadOlder is a guard no-op
    const calls = api.calls.length
    await session.loadOlder()
    expect(api.calls.length).toBe(calls)
    // throw path: fail-soft with console.error
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await session.resync()
      api.onHistory = () => histResponse(plainTurn(6, 1, 'x', 'y'), true)
      await session.resync()
      api.onHistory = () => Promise.reject(new Error('page wire down'))
      await session.loadOlder()
      expect(errorSpy).toHaveBeenCalled()
      expect(session.getSnapshot().loadingOlder).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('subscribe delivers snapshot-change notifications and unsubscribes', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => histResponse(plainTurn(0, 0, 'a', 'b'))
    let notified = 0
    const unsubscribe = session.subscribe(() => { notified++ })
    await session.open()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notified).toBeGreaterThan(0)
    const seen = notified
    unsubscribe()
    session.handleRunning(true) // any snapshot mutation; the listener must stay silent
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notified).toBe(seen)
  })

  it('subscribed baseline past the window tail triggers the second stitch pull in doOpen', async () => {
    const { api, session } = makeSession()
    const full = [...plainTurn(0, 0, 'a', 'b'), ...plainTurn(6, 1, 'c', 'd')]
    let call = 0
    api.onHistory = () => {
      call++
      return histResponse(call === 1 ? plainTurn(0, 0, 'a', 'b') : full)
    }
    // Baseline arrives before open: lastSeq 11 > first page tail 5 → doOpen repulls once.
    session.handleMuxEnvelope('rs' as never, { type: 'session/subscribed', sessionId: SID, lastSeq: 11 })
    await session.open()
    expect(call).toBe(2)
    expect(session.getSnapshot().nodes.map(n => n.seq)).toEqual([1, 3, 7, 9])
  })

  it('a failed second stitch pull keeps the first window and still opens', async () => {
    const { api, session } = makeSession()
    let call = 0
    api.onHistory = () => {
      call++
      return call === 1
        ? histResponse(plainTurn(0, 0, 'a', 'b'))
        : Promise.resolve(err({ code: 'internal', message: 'stitch pull down', details: {} }))
    }
    session.handleMuxEnvelope('rs' as never, { type: 'session/subscribed', sessionId: SID, lastSeq: 11 })
    await session.open()
    expect(call).toBe(2)
    const snapshot = session.getSnapshot()
    expect(snapshot.openState).toBe('open') // stitch-pull failure is not an open failure
    expect(snapshot.nodes.map(n => n.seq)).toEqual([1, 3]) // first window kept
  })

  it('approval frame with callId/reason keeps the optional fields; duplicate resolved is a no-op', () => {
    const { session } = makeSession()
    session.handleMuxEnvelope('ra' as never, {
      type: 'approval/requested', sessionId: SID, approvalId: 'ap2' as never, toolName: 'rm', callId: 'c1' as never, reason: '危险',
    })
    expect(session.getSnapshot().pending[0]).toMatchObject({ kind: 'approval', payload: { callId: 'c1', reason: '危险' } })
    session.handleMuxEnvelope('rx' as never, { type: 'approval/resolved', sessionId: SID, approvalId: 'ap2' as never, outcome: 'approved' as never })
    session.handleMuxEnvelope('rx2' as never, { type: 'approval/resolved', sessionId: SID, approvalId: 'ap2' as never, outcome: 'approved' as never })
    session.handleMuxEnvelope('ry2' as never, { type: 'question/resolved', sessionId: SID, questionRpcId: 'never-was' as never, outcome: 'cancelled' })
    expect(session.getSnapshot().pending).toEqual([])
  })

  it('ignores unknown mux frame types and repeated running flips (documented defaults)', () => {
    const { session } = makeSession()
    const before = session.getSnapshot()
    session.handleMuxEnvelope('rz' as never, { type: 'future/frame' } as never)
    session.handleRunning(false) // already false: dedup branch
    expect(session.getSnapshot()).toBe(before)
    session.handleRemoved()
    expect(session.getSnapshot().removed).toBe(true)
  })

  it('drops live events while cold/error (no window upkeep)', async () => {
    const { api, session } = makeSession()
    session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event: ev.user(0, '冷态帧') })
    expect(session.getSnapshot().nodes).toEqual([])
    api.onHistory = () => Promise.resolve(err({ code: 'internal', message: 'x', details: {} }))
    await session.open()
    session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event: ev.user(0, '错态帧') })
    expect(session.getSnapshot().nodes).toEqual([])
  })

  it('repairGap failure logs and clears stitching; concurrent gaps coalesce into one repair', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => histResponse(plainTurn(0, 0, 'a', 'b'))
    await session.open()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    let repairs = 0
    api.onHistory = () => {
      repairs++
      return gate.promise
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      session.handleMuxEnvelope('r1' as never, { type: 'session/event', sessionId: SID, event: ev.user(9, '洞一') })
      session.handleMuxEnvelope('r2' as never, { type: 'session/event', sessionId: SID, event: ev.user(10, '洞二') }) // stitching: detours, no second repair
      expect(repairs).toBe(1)
      gate.reject(new Error('repair wire down'))
      await vi.waitFor(() => { expect(errorSpy).toHaveBeenCalled() })
      // Window unchanged; a later successful repull still lands the buffered frames.
      expect(session.getSnapshot().nodes).toHaveLength(2)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('doOpen transport throw of a stale generation is swallowed (generation guard in catch)', async () => {
    const { api, session } = makeSession()
    const stale = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => stale.promise
    const opening = session.open()
    api.onHistory = () => histResponse(plainTurn(0, 0, 'a', 'b'))
    const resynced = session.resync()
    stale.reject(new Error('stale wire'))
    await Promise.all([opening, resynced])
    expect(session.getSnapshot().openState).toBe('open') // stale catch did not write error
  })

  it('drops a stale doOpen whose history resolved successfully after resync superseded it', async () => {
    const { api, session } = makeSession()
    const stale = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => stale.promise
    const opening = session.open()
    api.onHistory = () => histResponse(plainTurn(6, 1, '新', '代'))
    const resynced = session.resync()
    stale.resolve(ok({
      events: entries(plainTurn(0, 0, '旧', '代')) as never[],
      hasMore: false,
      modelSelection: { provider: 'deepseek-official', model: 'stale' },
    })) // success, but its generation is gone
    await Promise.all([opening, resynced])
    expect(session.getSnapshot().nodes.map(n => n.seq)).toEqual([7, 9]) // only the fresh generation's window
  })

  it('drops a stale stitch pull (second doOpen fetch) superseded mid-flight by resync', async () => {
    const { api, session } = makeSession()
    const secondPull = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    let call = 0
    api.onHistory = () => {
      call++
      if (call === 1) return histResponse(plainTurn(0, 0, 'a', 'b')) // first page: tail 5
      if (call === 2) return secondPull.promise // gap-stitch pull: held
      return histResponse(plainTurn(6, 1, 'c', 'd'))
    }
    session.handleMuxEnvelope('rs' as never, { type: 'session/subscribed', sessionId: SID, lastSeq: 11 })
    const opening = session.open() // triggers the second pull, which parks
    await vi.waitFor(() => { expect(call).toBe(2) })
    const resynced = session.resync()
    secondPull.resolve(ok({
      events: entries([...plainTurn(0, 0, 'a', 'b'), ...plainTurn(6, 1, 'c', 'd')]) as never[],
      hasMore: false,
      modelSelection: { provider: 'deepseek-official', model: 'stale' },
    }))
    await Promise.all([opening, resynced])
    expect(session.getSnapshot().openState).toBe('open')
  })

  it('drops a gap repair superseded by a full resync while its pull was in flight', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => histResponse(plainTurn(0, 0, 'a', 'b'))
    await session.open()
    const repairPull = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => repairPull.promise
    session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event: ev.user(9, '洞') }) // starts repairGap
    api.onHistory = () => histResponse(plainTurn(6, 1, 'c', 'd'))
    const resynced = session.resync() // bumps the generation
    repairPull.resolve(ok({
      events: entries(plainTurn(0, 0, '旧', '页')) as never[],
      hasMore: false,
      modelSelection: { provider: 'deepseek-official', model: 'stale' },
    })) // repair result: stale, dropped
    await resynced
    expect(session.getSnapshot().nodes.map(n => n.seq)).toEqual([7, 9])
  })

  it('successful cancel leaves no promptError', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => histResponse(plainTurn(0, 0, 'a', 'b'))
    await session.open()
    const result = await session.cancel()
    expect(result.ok).toBe(true)
    expect(session.getSnapshot().promptError).toBeNull()
  })

  it('dispose is a reserved no-op on resident instances', () => {
    const { session } = makeSession()
    expect(() => { session.dispose() }).not.toThrow()
  })

  it('carries history-entry and mux-frame views into the business-neutral Event input', async () => {
    const { api, session } = makeSession()
    const callView = { for: 'call', view: { card: 'generic', title: '历史卡' } }
    api.onHistory = () => Promise.resolve(ok({
      events: [
        ...entries(plainTurn(0, 0, 'a', 'b')),
        { event: ev.toolCall(6, 1, 'h1', 'bash', '{}'), view: callView },
        { event: ev.toolResult(7, 1, 'h1', 'done'), view: { for: 'result', view: { card: 'generic', title: '历史果' } } },
      ] as never[],
      hasMore: false,
      modelSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }))
    await session.open()
    expect(chatEvents(session.getSnapshot()).slice(-2).map(item => item.view)).toEqual([
      callView,
      { for: 'result', view: { card: 'generic', title: '历史果' } },
    ])
    session.handleMuxEnvelope('rv1' as never, {
      type: 'session/event', sessionId: SID, event: ev.toolCall(8, 2, 'l1', 'write', '{}'),
      view: { for: 'call', view: { card: 'generic', title: '直播卡' } },
    } as never)
    expect(chatEvents(session.getSnapshot()).at(-1)?.view).toEqual({
      for: 'call', view: { card: 'generic', title: '直播卡' },
    })
    session.handleMuxEnvelope('rv2' as never, {
      type: 'session/event', sessionId: SID, event: ev.toolResult(9, 2, 'l1', 'ok'),
      view: { for: 'result', view: { card: 'generic', title: '直播果' } },
    } as never)
    expect(chatEvents(session.getSnapshot()).at(-1)?.view).toEqual({
      for: 'result', view: { card: 'generic', title: '直播果' },
    })
  })
})

describe('resync', () => {
  it('rebuilds the window and clears pending; cold instances no-op', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => histResponse(plainTurn(0, 0, 'a', 'b'))
    await session.open()
    session.handleMuxEnvelope('ra' as never, { type: 'approval/requested', sessionId: SID, approvalId: 'ap1' as never, toolName: 'rm' })
    api.onHistory = () => histResponse([...plainTurn(0, 0, 'a', 'b'), ...plainTurn(6, 1, 'c', 'd')])
    await session.resync()
    const snapshot = session.getSnapshot()
    expect(snapshot.openState).toBe('open')
    expect(snapshot.pending).toEqual([]) // baseline replay re-sends still-pending frames
    expect(snapshot.nodes).toHaveLength(4)

    const cold = makeSession()
    await cold.session.resync()
    expect(cold.api.calls).toEqual([]) // never opened: no traffic
  })

  it('re-mints a replayed requested frame as a fresh wait with the same key (old reference superseded)', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => histResponse(plainTurn(0, 0, 'a', 'b'))
    await session.open()
    session.handleMuxEnvelope('rq-replay' as never, { type: 'question/requested', sessionId: SID, questions: [] })
    const before = session.getSnapshot().pending[0]!
    await session.resync()
    session.handleMuxEnvelope('rq-replay' as never, { type: 'question/requested', sessionId: SID, questions: [] })
    const after = session.getSnapshot().pending[0]!
    expect(after).not.toBe(before)
    expect(after.key).toBe(before.key)
    // Superseded ≠ settled: an in-flight respond on the stale reference still reaches the host.
    await before.respond({ ok: false, error: { code: 'internal', message: 'x', details: {} } })
    expect(api.callsOf('respond')).toMatchObject([{ rpcId: 'rq-replay' }])
  })

  it('drops a stale in-flight open superseded by resync (generation guard)', async () => {
    const { api, session } = makeSession()
    const stale = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => stale.promise
    const firstOpen = session.open()
    api.onHistory = () => histResponse(plainTurn(6, 1, '新', '代'))
    const resynced = session.resync()
    stale.reject(new Error('dead connection')) // the doomed pre-disconnect request fails late
    await firstOpen
    await resynced
    const snapshot = session.getSnapshot()
    expect(snapshot.openState).toBe('open') // stale failure did not settle the fresh generation into error
    expect(snapshot.nodes.map(n => n.seq)).toEqual([7, 9])
  })

})

describe('reference stability (the memo contract)', () => {
  it('keeps unchanged node references across an append and swaps the snapshot object', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => histResponse(plainTurn(0, 0, '稳', '定'))
    await session.open()
    const before = session.getSnapshot()
    const firstKey = before.chat.order[0]!
    const secondKey = before.chat.order[1]!
    const first = before.chat.nodes.get(firstKey)
    const second = before.chat.nodes.get(secondKey)
    session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event: ev.user(6, '追加') })
    const after = session.getSnapshot()
    expect(after).not.toBe(before) // top-level swap on change
    expect(after.chat.nodes.get(firstKey)).toBe(first)
    expect(after.chat.nodes.get(secondKey)).toBe(second)
    expect(after.chat.order).toHaveLength(7)
    // No change → same snapshot reference.
    expect(session.getSnapshot()).toBe(after)
  })

  it('keeps unrelated Session arrays and settled Chat Nodes stable across Event updates', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => histResponse(plainTurn(0, 0, '底', '座'))
    await session.open()
    const feed = (event: SessionEvent) => { session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event }) }
    feed(ev.turnStart(6, 1))
    feed(ev.stepStart(7, 1))
    feed(ev.toolCall(8, 1, 'c1', 'echo', '{}'))
    session.handleMuxEnvelope('ra' as never, { type: 'approval/requested', sessionId: SID, approvalId: 'ap1' as never, toolName: 'rm' })
    const before = session.getSnapshot()
    const settledKey = before.chat.order[0]!
    const settledNode = before.chat.nodes.get(settledKey)
    feed(ev.chunkStart(9, 1))
    feed(ev.chunkText(10, 1, '与工具无关的流式'))
    const after = session.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.runningCalls).toBe(before.runningCalls)
    expect(after.pending).toBe(before.pending)
    expect(after.chat.nodes.get(settledKey)).toBe(settledNode)
    feed(ev.toolResult(11, 1, 'c1', 'ECHO'))
    const resolved = session.getSnapshot()
    expect(resolved.pending).toBe(after.pending)
    expect(resolved.chat.nodes.get(settledKey)).toBe(settledNode)
    feed(ev.assistant(12, 1, '完成'))
    expect(session.getSnapshot()).not.toBe(resolved)
  })
})
