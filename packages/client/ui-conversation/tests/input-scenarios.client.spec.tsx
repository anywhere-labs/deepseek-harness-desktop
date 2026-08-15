// @vitest-environment jsdom
/**
 * Scenario-chain integration (scenarios A/C/D/H/I): the real per-session
 * InputTriggerController pipeline over a real session scope (SessionRuntime over
 * a listed host session) + a command source implementing the decision
 * table's relevant cells + the real SessionInput machine (scoped-event
 * listeners wired the way the hub does) + the real InputBar. ui-commands
 * itself is not a dependency of this package; the source below is the
 * decision-table contract at the `InputTriggerSource` boundary.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS, SessionRuntime,
} from '@deepseek-ai/dsh-client-runtime/client'
import { InputTriggerService } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ClientSessionContext, CommandClaim, PickOutcome, SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { FakeApiClient, fakeRemote, ok } from '../../runtime/tests/fake-api.client.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { InputBar } from '../src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '../src/client/skeleton/InputBar.tsx'
import { zh } from '../src/client/locales.ts'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

afterEach(cleanup)

/** Directory row driving kind derivation (input? = leadingInput, else execute). */
interface FakeCommand {
  name: string
  description: string
  input?: { hint: string }
}

/** Decision-table source over an in-memory directory (menu/space/enter columns for leadingInput + execute). */
function commandSource(commands: FakeCommand[], execute: (line: string) => Promise<SubmitOutcome>) {
  const resolve = (name: string): FakeCommand | undefined => commands.find(c => c.name === name)
  const leadingClaim = (desc: FakeCommand): CommandClaim => ({
    token: `/${desc.name} `,
    ...(desc.input !== undefined ? { hint: desc.input.hint } : {}),
    submit: args => execute(`/${desc.name} ${args}`),
  })
  const executed: string[] = []
  return {
    executed,
    source: {
      trigger: '/' as const,
      name: 'command',
      candidates: (_session: ClientSessionContext, req: { query: string; position: string }) =>
        Promise.resolve(commands
          .filter(c => c.name.startsWith(req.query))
          .filter(c => req.position === 'leading' || c.input === undefined)
          .map(c => ({ name: c.name, description: c.description, ...(c.input !== undefined ? { hint: c.input.hint } : {}) }))),
      onPick: (pick: { candidate: { name: string } }): PickOutcome => {
        const desc = resolve(pick.candidate.name)
        if (desc === undefined) return undefined
        if (desc.input !== undefined) return { claim: leadingClaim(desc) }
        executed.push(`/${desc.name}`)
        void execute(`/${desc.name}`)
        return 'handled'
      },
      matchSpace: (_session: ClientSessionContext, token: string): PickOutcome => {
        const desc = resolve(token.slice(1))
        if (desc?.input === undefined) return undefined
        return { claim: leadingClaim(desc) }
      },
      matchEnter: (_session: ClientSessionContext, line: string): Promise<PickOutcome> => {
        const trimmed = line.trim()
        const ws = trimmed.search(/\s/)
        const token = ws === -1 ? trimmed : trimmed.slice(0, ws)
        const desc = resolve(token.slice(1))
        if (desc === undefined) return Promise.resolve(undefined)
        if (desc.input !== undefined) return Promise.resolve({ claim: leadingClaim(desc) })
        if (ws !== -1) return Promise.resolve(undefined) // execute with trailing → default sink
        executed.push(trimmed)
        void execute(trimmed)
        return Promise.resolve('handled')
      },
    },
  }
}

const COMMANDS: FakeCommand[] = [
  { name: 'goal', description: '设定目标', input: { hint: '目标内容' } },
  { name: 'compact', description: '压缩上下文' },
]

/** Real scope bench: SessionRuntime over one listed session + InputTriggerController + shell listeners (the hub wiring shape). */
async function scopedBench(register?: (inputTriggers: InputTriggerService) => void) {
  const ctx = new Context()
  const api = new FakeApiClient()
  api.onWorkspaceList = () => Promise.resolve(ok({ items: [] }))
  const sessionId = 'scenario-s1' as Parameters<SessionRuntime['open']>[0]
  api.onList = () => Promise.resolve(ok({
    items: [{ sessionId, updatedAt: 1, running: false, blank: false, cwd: '/w/a' }],
  }) as never)
  const sessions = new SessionRuntime(ctx, api, fakeRemote()) // provides 'sessions' itself
  await sessions.refresh()
  await Promise.resolve() // manager notifier flush
  await ctx.plugin(InputTriggerService).await()
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerService
  register?.(inputTriggers)
  const actx = sessions.scope(sessionId)!
  const controller = inputTriggers.sessionOf(actx)
  const sink = vi.fn()
  const shell = new SessionInputShell({ actx, inputTriggers: () => controller, defaultSink: sink })
  // The hub's listener wiring, verbatim.
  actx.on('slash/input-begin-command', req => shell.beginCommand(req.claim, req.span) ? true : undefined)
  actx.on('slash/input-insert-reference', req => shell.insertReference(req.reference, req.span) ? true : undefined)
  actx.on('slash/input-consume-token', req => shell.consumeToken(req.guard) ? true : undefined)
  const wiring = shell
  const sessionStore = createSnapshotStore<ConversationSnapshot>({
    sessionId, views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false,
    promptError: null, blank: false, subagent: null, lastAgentError: null,
  })
  const barProps: InputBarProps = {
    sessionId,
    SessionProvider: ({ children }) => children(sessionId),
    useSession: bindSnapshotSelector(sessionStore),
    useSessions: bindSnapshotSelector(createSnapshotStore({
      ids: [], byId: {}, current: undefined, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore({
      items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    })),
    useProjection: (() => undefined),
    useInput: bindSnapshotSelector(shell.state),
    inputActions: shell.actions,
    keyboard: shell,
    addImages: () => null,
    removeImage: () => {},
    draftImages: () => [],
    resolveSubmitMode: () => 'queue',
    toggleCommandMenu: (selection) => {
      const snapshot = shell.snapshot
      controller.toggleSource('command', {
        trigger: '/',
        query: '',
        position: snapshot.draft.slice(0, selection.start).trim() === '' ? 'leading' : 'inline',
        span: { ...selection, draftRev: snapshot.draftRev },
      })
    },
    clearNotice: () => { shell.clearNotice() },
    useNotices: bindSnapshotSelector(shell.notices),
    useLexicon: bindSnapshotSelector(shell.lexicon),
    useMenuLauncher: bindSnapshotSelector(controller.launcher),
    renderSlot: (() => null) as InputBarProps['renderSlot'],
    stop: vi.fn(),
    command: () => Promise.resolve(true),
    // Mirrors the real lookup chain (conversation namespace, then common).
    t: makeTranslate(zh, commonZh),
    variant: 'composer',
  }
  const view = render(<InputBar {...barProps} />)
  const textarea = view.container.querySelector('textarea')!
  const type = (text: string): void => {
    fireEvent.change(textarea, { target: { value: text } })
  }
  return { ctx, inputTriggers, controller, shell, wiring, view, textarea, type, sink }
}

async function bench(executeImpl?: (line: string) => Promise<SubmitOutcome>) {
  const execute = vi.fn(executeImpl ?? ((line: string) =>
    Promise.resolve({ kind: 'success' as const, text: `已执行 ${line}` })))
  const { source, executed } = commandSource(COMMANDS, execute)
  const base = await scopedBench((inputTriggers) => { inputTriggers.registerSource(source) })
  return { ...base, execute, executed }
}

describe('scenario A: menu-pick /goal, type args, enter submits', () => {
  it('runs the whole claim chain through the real pipeline', async () => {
    const b = await bench()
    b.type('/go')
    // Candidates land async; the menu opens with the goal row.
    await vi.waitFor(() => {
      const menu = b.controller.menu.getSnapshot()
      expect(menu.open).toBe(true)
      expect(menu.groups[0]?.items.map(i => i.name)).toContain('goal')
    })
    // Pointer pick (menu path executes through the bound target inside the pipeline).
    act(() => { b.controller.pick('command', 0) })
    expect(b.shell.snapshot.phase).toBe('claimed')
    expect(b.textarea.value).toBe('/goal ')
    expect(b.view.container.querySelector('[data-decoration="token"]')?.textContent).toBe('/goal ')
    // The zh dictionary owns a hint.goal entry, which overrides the machine's raw hint (production behavior).
    expect(b.view.container.querySelector('[data-decoration="hint"]')?.textContent).toBe('输入目标，智能体将持续执行')
    // Continue typing args; hint drops; claim holds.
    b.type('/goal 发布 v1')
    expect(b.shell.snapshot.phase).toBe('claimed')
    // Enter: submitting → command execute → commit clears.
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledWith('/goal 发布 v1') })
    await vi.waitFor(() => { expect(b.textarea.value).toBe('') })
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.view.getByText('已执行 /goal 发布 v1')).toBeTruthy()
    expect(b.sink).not.toHaveBeenCalled()
  })
})

describe('scenario C: pasted /goal xxx + enter (menu never opened)', () => {
  it('adjudicates on enter, claims and submits in one stroke', async () => {
    const b = await bench()
    // Paste lands whole; caret at end means detectTrigger sees no token under
    // the caret mid-whitespace — menu stays closed; enter runs adjudication.
    act(() => { b.shell.setDraft('/goal 尽快发布') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledWith('/goal 尽快发布') })
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    expect(b.textarea.value).toBe('')
    expect(b.sink).not.toHaveBeenCalled()
  })
})

describe('scenario D: execute-kind /compact', () => {
  it('menu pick executes immediately without touching the draft machine phase', async () => {
    const b = await bench()
    b.type('/comp')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    act(() => { b.controller.pick('command', 0) })
    // 'handled': no claim, machine still plain; the source ran the detached execute.
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.executed).toContain('/compact')
  })

  it('bare /compact + enter executes; trailing text falls to the default sink (scenario I twin)', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('/compact') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.executed).toContain('/compact') })
    // 'handled' flows back as the adjudicated event one microtask later.
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    cleanup()
    const b2 = await bench()
    act(() => { b2.shell.setDraft('/compact 现在') })
    fireEvent.keyDown(b2.textarea, { key: 'Enter' })
    // execute with trailing → matchEnter answers undefined → default sink.
    await vi.waitFor(() => { expect(b2.sink).toHaveBeenCalledWith('/compact 现在', [], 'queue') })
    expect(b2.executed).toHaveLength(0)
  })
})

describe('scenario H: backspace breaks the token', () => {
  it('claim releases automatically; the enter after that goes through adjudication again', async () => {
    const b = await bench()
    b.type('/goal')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    // Space adjudication claims (space column, leadingInput).
    fireEvent.keyDown(b.textarea, { key: ' ' })
    expect(b.shell.snapshot.phase).toBe('claimed')
    // Backspace into the token: watch break → plain, visuals gone.
    b.type('/goa ')
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.view.container.querySelector('[data-decoration="token"]')).toBeNull()
  })
})

describe('scenario: reference decoration lights up when the lexicon settles', () => {
  it('a typed /name token gains the text-ref mark without further input once the roll goes hot', async () => {
    let roll: readonly string[] | undefined
    let notify: (() => void) | undefined
    const b = await scopedBench((inputTriggers) => {
      inputTriggers.registerSource({
        trigger: '/', name: 'skill',
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        lexicon: () => roll,
        subscribeLexicon: (_session: ClientSessionContext, listener: () => void) => {
          notify = listener
          return () => { notify = undefined }
        },
      } as never)
    })
    // Typed before the catalog settled: a plain token, no decoration.
    b.type('/deploy now')
    expect(b.view.container.querySelector('[data-decoration="text-ref"]')).toBeNull()
    // The catalog settles (ui-skill's settle path fires the same notification).
    act(() => {
      roll = ['deploy']
      notify?.()
    })
    const mark = b.view.container.querySelector('[data-decoration="text-ref"]')
    expect(mark?.textContent).toBe('/deploy')
  })
})

describe('scenario I: unknown /xyz + enter', () => {
  it('adjudication misses in one hop and the whole line rides the default sink', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('/xyz 干点啥') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.sink).toHaveBeenCalledWith('/xyz 干点啥', [], 'queue') })
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('adjudication failure (source warmup throw) notices and keeps the draft', async () => {
    const b = await scopedBench((inputTriggers) => {
      inputTriggers.registerSource({
        trigger: '/', name: 'command',
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        matchEnter: () => Promise.reject(new Error('目录预热失败')),
      } as never)
    })
    act(() => { b.shell.setDraft('/plan 上线') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.view.getByText('目录预热失败')).toBeTruthy() })
    // Never a silent downgrade: draft retained, sink untouched.
    expect(b.textarea.value).toBe('/plan 上线')
    expect(b.sink).not.toHaveBeenCalled()
  })
})
