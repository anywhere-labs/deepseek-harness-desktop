// @vitest-environment jsdom
// apply inject factories exercised end to end against the terminal thin
// API: the strict session API (views triple, draft mirror), the
// provide-channel input face (machine-sink submit choreography incl.
// optimistic clear + failure restore), the resident API (selectWorkspace
// draft carrying), the composer-bar stop face, openDetails = select action +
// layout orchestration, and the closeDetails details API. Complements
// chat-apply.spec.tsx (registration) and selection-survival.spec.tsx (store
// axis). History opening is NOT an inject concern — the runtime sessions
// service opens on watch (sessions-service.spec.ts owns that behavior).
//
// The inject APIs are read off the ledger entries deliberately (typed at
// this spec's own contract): these cases pin factory choreography the UI
// guards would mask. Rendering-path acceptance lives in
// chat-toolview-slot.spec.tsx.

import { describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime, usePinnedBrowserLanguages, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionBehaviorOverrides } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISession, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ChatViewInjected, ComposerBarInjected, ConversationInjected, ConversationSessionHeaderInjected,
  ConversationSessionInjected, DetailsInjected,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createChatStore } from '../src/client/stores.ts'
import * as forkFlags from '../src/client/fork-flags.ts'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

const ROOT = 'root-1' as SessionId

type ChatInstance = ReturnType<ReturnType<typeof createChatStore>['create']>
type ChatActions = ChatInstance['actions']

/** ISession verb mocks, typed against the production face (['prompt'] etc. keep vitest mock ergonomics). */
function sessionFakeFor() {
  return {
    open: vi.fn(() => Promise.resolve()),
    loadOlder: vi.fn<ISession['loadOlder']>(() => Promise.resolve()),
    prompt: vi.fn<ISession['prompt']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
    cancel: vi.fn<ISession['cancel']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
  } satisfies SessionBehaviorOverrides
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
  // The plugin injects both; these specs exercise no settings path.
  runtime.provide('remote', { $on: () => () => {} })
  runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const sessionFake = sessionFakeFor()
  await runtime.sessions.add({
    id: ROOT,
    summary: { title: 'R', displayTitle: 'R', cwd: '/proj' },
    session: sessionFake,
  })
  const layoutFake = { openDetails: vi.fn(), closeDetails: vi.fn() }
  runtime.provide('layout', layoutFake)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)

  // The AppFrame role: the conversation-package slots must be declared by a
  // live entry before apply can contribute into them.
  await runtime.root.declare({
    'conversation': { kind: 'single', scope: 'session-maybe' },
    'details': { kind: 'single', scope: 'session' },
  }, (_p: { renderSlot?: unknown }) => null)

  const feature = await runtime.mount({ inject: [...inject], apply })

  // The host face (store resolution) exists only inside the installed
  // renderer, so materialize it the way the shell does.
  runtime.renderRoot()
  const entryOf = (key: 'conversation' | 'conversation.session' | 'conversation.session.header' | 'conversation.composer.bar' | 'conversation.view' | 'details') =>
    runtime.slots.entries(key)[0]!
  /** Resolve store instance + call the inject the way the outlet would. */
  const conversationApi = (id: SessionId) => {
    const entry = entryOf('conversation.session')
    const instance = runtime.storeOf('conversation.session', id) as ChatInstance
    const injected = (entry.inject as unknown as (sessionId: SessionId, actions: ChatActions) => ConversationSessionInjected)(
      id, instance.actions)
    return { instance, injected }
  }
  const conversationHeaderApi = (id: SessionId) => {
    const entry = entryOf('conversation.session.header')
    const instance = runtime.storeOf('conversation.session.header', id) as ChatInstance
    const injected = (entry.inject as unknown as (sessionId: SessionId, actions: ChatActions) => ConversationSessionHeaderInjected)(
      id, instance.actions)
    return { instance, injected }
  }
  const residentApi = (id: SessionId | undefined) => {
    const entry = entryOf('conversation')
    return (entry.inject as unknown as (sessionId: SessionId | undefined) => ConversationInjected)(id)
  }
  const composerApi = (id: SessionId | undefined) => {
    const entry = entryOf('conversation.composer.bar')
    return (entry.inject as unknown as (sessionId: SessionId | undefined) => ComposerBarInjected)(id)
  }
  /** Same resolution for the chat entry riding the view ring. */
  const chatViewApi = (id: SessionId) => {
    const entry = entryOf('conversation.view')
    const instance = runtime.storeOf('conversation.view', id) as ChatInstance
    const injected = (entry.inject as unknown as (sessionId: SessionId, actions: ChatActions) => ChatViewInjected)(
      id, instance.actions)
    return { instance, injected }
  }
  /** Materialize the input provide contribution the way the runtime does. */
  const inputApi = (id: SessionId) => {
    const info = runtime.sessions.provideInfo(id)!
    const state = info.hooks['input'] as {
      getSnapshot: () => { draft: string }
      subscribe: (fn: () => void) => () => void
    }
    const actions = info.props['inputActions'] as {
      setDraft: (text: string) => void
      submit: () => void
    }
    return { state, actions }
  }
  return {
    runtime, feature, slots: runtime.slots, entryOf,
    conversationApi, conversationHeaderApi, residentApi, composerApi, chatViewApi, inputApi,
    sessionFake, layoutFake,
  }
}

describe('conversation slot inject API', () => {
  it('assembles the thin API side-effect-free', async () => {
    const b = await bench()
    const { injected } = b.conversationApi(ROOT)
    // Assembly has no session side effects: opening the event window belongs
    // to the runtime watch path, not the inject factory.
    expect(b.sessionFake.open).not.toHaveBeenCalled()
    expect(injected.views.list().map(v => v.id)).toEqual(['chat'])

    const chatView = b.chatViewApi(ROOT)
    chatView.injected.loadOlder()
    expect(b.sessionFake.loadOlder).toHaveBeenCalledTimes(1)
    chatView.injected.forkAt(17)
    await vi.waitFor(() => {
      expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [ROOT] })
    })
    expect(b.runtime.sessions.calls).toContainEqual({
      method: 'fork', args: [{ sessionId: ROOT, atSeq: 17, increaseTitle: true }],
    })
    await b.runtime.dispose()
  })

  it('the provide-channel input face submits through the machine sink: trim, optimistic clear, failure restore without clobber', async () => {
    const b = await bench()
    const { injected } = b.conversationApi(ROOT)
    const { state, actions } = b.inputApi(ROOT)
    // Whitespace-only: the machine treats it as empty — no prompt, draft kept.
    actions.setDraft('   ')
    actions.submit()
    expect(b.sessionFake.prompt).not.toHaveBeenCalled()
    expect(state.getSnapshot().draft).toBe('   ')
    // Success: cleared and stays cleared.
    actions.setDraft('hello')
    actions.submit()
    expect(state.getSnapshot().draft).toBe('')
    await Promise.resolve()
    expect(b.sessionFake.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'queue')
    // Failure: restored (draft still empty when the rejection lands).
    b.sessionFake.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'b', details: { reason: 'b' } } })
    actions.setDraft('retry me')
    actions.submit()
    await vi.waitFor(() => {
      expect(state.getSnapshot().draft).toBe('retry me')
    })
    // Failure landing after new typing: no clobber (restore fills empty only).
    b.sessionFake.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'b', details: { reason: 'b' } } })
    actions.submit()
    actions.setDraft('typed during flight')
    await new Promise(r => setTimeout(r, 0))
    expect(state.getSnapshot().draft).toBe('typed during flight')
    // The provide contribution is idempotent per session: one shell identity.
    expect(b.inputApi(ROOT).state).toBe(state)
    // The draft mirror rides the conversation inject face.
    const mirrored: string[] = []
    const unbind = injected.bindDraftMirror(text => mirrored.push(text))
    actions.setDraft('mirrored text')
    expect(mirrored).toEqual(['mirrored text'])
    unbind()
    // Stop failure is swallowed (promptError owns the display).
    b.sessionFake.cancel.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'x', details: {} } })
    b.composerApi(ROOT).stop!()
    await new Promise(r => setTimeout(r, 0))
    expect(b.sessionFake.cancel).toHaveBeenCalledTimes(1)
    await b.runtime.dispose()
  })

  it('inject fails loud when the session resolves no binding or the scope lacks the service', async () => {
    const b = await bench()
    const entry = b.entryOf('conversation.composer.bar')
    const injectFn = entry.inject as unknown as (sessionId: SessionId | undefined) => ComposerBarInjected
    // Unknown session: the keyboard face's binding resolution answers nothing.
    expect(() => { injectFn('ghost' as SessionId).stop!() }).toThrow(/resolved no binding/)
    // No session (session-maybe absent side): machine faces absent, static
    // hooks compartment still present so the render side's hook order holds.
    const absent = injectFn(undefined)
    expect(absent.keyboard).toBeUndefined()
    expect(absent.toggleCommandMenu).toBeUndefined()
    expect(absent.stop).toBeUndefined()
    expect(absent.hooks.notices.getSnapshot()).toBeNull()
    expect(absent.hooks.lexicon.getSnapshot().size).toBe(0)
    expect(absent.hooks.menuLauncher.getSnapshot()).toBeNull()
    // A scope whose service tree lost 'conversation' (the feature fiber
    // unloaded while a retained inject closure re-runs): fails loud too.
    const stop = injectFn(ROOT).stop!
    await b.feature.dispose()
    expect(() => { stop() }).toThrow(/unavailable through the session scope/)
    await b.runtime.dispose()
  })

  it('openDetails (chat view face) writes the selection through the store actions and opens the panel', async () => {
    const b = await bench()
    const { instance, injected } = b.chatViewApi(ROOT)
    injected.openDetails({ turnSeq: 2, callId: 'c1' })
    expect(instance.store.getSnapshot().selection).toEqual({ turnSeq: 2, callId: 'c1' })
    expect(b.layoutFake.openDetails).toHaveBeenCalledTimes(1)
    // The chat view shares the conversation entry's store instance: selection
    // writes land where the skeleton and details read.
    const conv = b.conversationApi(ROOT)
    expect(conv.instance).toBe(instance)
    await b.runtime.dispose()
  })

  it('openFile (chat view face) resolves against session cwd, calls workspaces.openPath, and reports success on the composer notice channel', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(ROOT)
    injected.openFile('src/a.ts')
    await vi.waitFor(() => {
      expect(b.runtime.workspaces.calls).toContainEqual({ method: 'openPath', args: ['/proj/src/a.ts'] })
    })
    // Success copy is honest: the Host cannot tell a silently discarded
    // request from a real open, so the notice says "handed to the OS".
    const notices = b.composerApi(ROOT).hooks.notices
    await vi.waitFor(() => {
      const notice = notices.getSnapshot()
      if (notice === null) throw new Error('no open notice yet')
      expect(notice.level).toBe('info')
      expect(notice.text).toBe('已将 a.ts 交给系统打开；若未弹出窗口或选择软件对话框，说明该文件类型已有默认程序但未能打开此路径，请更换默认程序或手动打开 /proj/src/a.ts')
      expect(typeof notice.seq).toBe('number')
    })
    await b.runtime.dispose()
  })

  it('openFile surfaces the Host reason on the composer notice channel when opening fails', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(ROOT)
    b.runtime.workspaces.stub('openPath', () => Promise.reject(new Error('path open failed: spawn powershell.exe ENOENT')))
    injected.openFile('src/a.ts')
    const notices = b.composerApi(ROOT).hooks.notices
    await vi.waitFor(() => {
      const notice = notices.getSnapshot()
      if (notice === null) throw new Error('no open notice yet')
      expect(notice.level).toBe('error')
      expect(notice.text).toBe('打开 a.ts 失败：path open failed: spawn powershell.exe ENOENT')
      expect(typeof notice.seq).toBe('number')
    })
    await b.runtime.dispose()
  })

  it('openFile with the feedback patch disabled keeps the official silent behavior (no notice)', async () => {
    const b = await bench()
    const spy = vi.spyOn(forkFlags, 'feedbackPatchEnabled').mockReturnValue(false)
    try {
      const { injected } = b.chatViewApi(ROOT)
      injected.openFile('src/a.ts')
      await vi.waitFor(() => {
        expect(b.runtime.workspaces.calls).toContainEqual({ method: 'openPath', args: ['/proj/src/a.ts'] })
      })
      // Official behavior: the open runs and its outcome stays silent.
      expect(b.composerApi(ROOT).hooks.notices.getSnapshot()).toBeNull()
    } finally {
      spy.mockRestore()
      await b.runtime.dispose()
    }
  })

  it('routes workspace switching through the runtime owner, carrying the draft', async () => {
    const b = await bench()
    const resident = b.residentApi(ROOT)
    // Same-session connect (the picked workspace resolves to this session):
    // no draft movement, plain re-open.
    b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(ROOT))
    const { state, actions } = b.inputApi(ROOT)
    actions.setDraft('carry me')
    void resident.selectWorkspace('workspace-1' as never)
    await vi.waitFor(() => {
      expect(b.runtime.sessions.calls.filter(c => c.method === 'open')).toHaveLength(1)
    })
    expect(b.runtime.workspaces.calls).toContainEqual({ method: 'connectWorkspace', args: ['workspace-1'] })
    expect(state.getSnapshot().draft).toBe('carry me')
    // Cross-session connect: the draft MOVES — the old machine empties, the
    // new session's machine receives the text, then navigation lands there.
    const OTHER = 'other-1' as SessionId
    await b.runtime.sessions.add({ id: OTHER }, { current: false })
    b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
    void resident.selectWorkspace('workspace-2' as never)
    await vi.waitFor(() => {
      expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [OTHER] })
    })
    expect(state.getSnapshot().draft).toBe('')
    expect(b.inputApi(OTHER).state.getSnapshot().draft).toBe('carry me')
    await b.runtime.dispose()
  })

  it('selectWorkspace edge arms: no-session resident, empty-draft move, connect failure retryable', async () => {
    const b = await bench()
    // No-session resident (hero before any session): connect resolves and
    // navigation proceeds without any draft choreography.
    const noSession = b.residentApi(undefined)
    b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(ROOT))
    void noSession.selectWorkspace('workspace-0' as never)
    await vi.waitFor(() => {
      expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [ROOT] })
    })

    // Cross-session connect with an EMPTY draft: no move, no clearing.
    const OTHER = 'b9-other' as SessionId
    await b.runtime.sessions.add({ id: OTHER }, { current: false })
    const resident = b.residentApi(ROOT)
    const { state } = b.inputApi(ROOT)
    expect(state.getSnapshot().draft).toBe('')
    b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
    void resident.selectWorkspace('workspace-3' as never)
    await vi.waitFor(() => {
      expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [OTHER] })
    })
    expect(b.inputApi(OTHER).state.getSnapshot().draft).toBe('')

    // Connect failure: the rejection propagates to the caller (the view owns
    // the rollback) and no further navigation happens.
    const opens = b.runtime.sessions.calls.filter(c => c.method === 'open').length
    b.runtime.workspaces.stub('connectWorkspace', () => Promise.reject(new Error('offline')))
    await expect(resident.selectWorkspace('workspace-4' as never)).rejects.toThrow('offline')
    expect(b.runtime.sessions.calls.filter(c => c.method === 'open')).toHaveLength(opens)
    await b.runtime.dispose()
  })

  it('scopedConversation fails loud when the session resolves no scope', async () => {
    const b = await bench()
    // The chat-view inject resolves the scoped conversation service at inject
    // time: an unlisted session hits the scope() === undefined throw directly.
    const entry = b.entryOf('conversation.view')
    const injectFn = entry.inject as unknown as (sessionId: SessionId, actions: unknown) => unknown
    expect(() => injectFn('never-listed' as SessionId, {})).toThrow(/resolved no scope/)
    await b.runtime.dispose()
  })

  it('views read face projects the ring ledger (subscribe/version through ctx.slots)', async () => {
    const b = await bench()
    const { injected } = b.conversationApi(ROOT)
    const before = injected.views.version()
    const listener = vi.fn()
    const unsub = injected.views.subscribe(listener)
    // A second ring rider (what ui-trajectory does in production).
    const off = b.slots.register(
      { name: 'conversation.view', id: 'chat2', order: 5, label: 'X' } as never, (() => null) as never)
    await Promise.resolve() // ledger notifications batch per microtask
    expect(listener).toHaveBeenCalled()
    expect(injected.views.version()).toBeGreaterThan(before)
    expect(injected.views.list().map(v => v.id)).toEqual(['chat', 'chat2'])
    // Label falls back to the id when a rider declares none.
    const off2 = b.slots.register(
      { name: 'conversation.view', id: 'bare', order: 6 } as never, (() => null) as never)
    expect(injected.views.list().map(v => v.label)).toEqual(['对话', 'X', 'bare'])
    off()
    off2()
    unsub()
    await b.runtime.dispose()
  })
})

describe('details inject API', () => {
  it('details injects the one layout callback; selection rides the shared store instead', async () => {
    const b = await bench()
    const entry = b.entryOf('details')
    const injected = (entry.inject as unknown as () => DetailsInjected)()
    expect(Object.keys(injected)).toEqual(['closeDetails'])
    injected.closeDetails()
    expect(b.layoutFake.closeDetails).toHaveBeenCalledTimes(1)
    // The shared handle: details resolves the SAME instance conversation writes.
    const conv = b.runtime.storeOf('conversation.session', ROOT)
    const details = b.runtime.storeOf('details', ROOT)
    expect(details).toBe(conv)
    await b.runtime.dispose()
  })
})
