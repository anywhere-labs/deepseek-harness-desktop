import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDesktopLayout } from '../src/client/layout-service.ts'
import { applyAdvancedShell } from '../src/client/advanced-shell.ts'
import { applyExtendedShell } from '../src/client/extended-shell.ts'
import { DesktopLayoutState } from '../src/client/layout-state.ts'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

interface FakeStyleElement {
  id: string
  name: string
  textContent: string
  dataset: Record<string, string>
  isConnected: boolean
  content: string
  remove(): void
}

function stubDocument() {
  const byId = new Map<string, FakeStyleElement>()
  const dataset: Record<string, string | undefined> = {}
  const rootViewport = { id: 'root', dataset: {} as Record<string, string | undefined> }
  const fakeDocument = {
    getElementById: (id: string) => {
      if (id === 'root') return rootViewport
      return byId.get(id) ?? null
    },
    head: {
      appendChild(child: FakeStyleElement): void {
        byId.set(child.id, child)
      },
    },
    createElement: (_tag: string): FakeStyleElement => ({
      id: '',
      name: '',
      textContent: '',
      dataset: {},
      isConnected: true,
      content: '',
      remove() { byId.delete(this.id) },
    }),
    body: {
      dataset,
      style: { setProperty() {}, removeProperty() {} },
      setAttribute() {},
      removeAttribute() {},
    },
    documentElement: { style: { colorScheme: '', removeProperty() {}, setProperty() {} } },
  }
  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: 'rgb(0, 0, 0)' }))
  return { byId, dataset }
}

function makeCtx() {
  return {
    inject: vi.fn(),
    reflect: { provide: vi.fn(), get: vi.fn() },
    // Cordis runs effect factories eagerly during the apply walk — mirror
    // that here so registration assertions observe real calls.
    effect: vi.fn((factory: () => unknown) => factory()),
    slots: {
      provideRoot: vi.fn((_props: unknown) => vi.fn()),
      subscribe: vi.fn((_name: string, _listener: () => void) => vi.fn()),
      entries: vi.fn(() => []),
      register: vi.fn(() => ({})),
      inject: vi.fn(),
    },
    theme: { getTheme: vi.fn(() => ({ active: { colorScheme: 'light', tokens: {} } })) },
    on: vi.fn(() => () => {}),
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('installDesktopLayout', () => {
  it('installs ownership when no layout is registered', () => {
    const ctx = makeCtx()
    const dispose = vi.fn()
    ctx.reflect.provide.mockReturnValue(dispose)
    const panels = new Set(['files'])
    const layout = new DesktopLayoutState(id => panels.has(id))

    installDesktopLayout(ctx as never, layout as never)
    expect(ctx.reflect.get).toHaveBeenCalledWith('layout', false)
    expect(ctx.reflect.provide).toHaveBeenCalledWith('layout', layout)
    const { hooks: { panelInfo } } = ctx.slots.provideRoot.mock.calls[0]![0] as {
      hooks: { panelInfo: { getSnapshot(): unknown; subscribe(fn: () => void): () => void } }
    }
    expect(panelInfo).toBe(layout.panelInfo)
    const changed = vi.fn()
    const stop = panelInfo.subscribe(changed)
    layout.selectPanel('files' as MainPanelId)
    expect(panelInfo.getSnapshot()).toEqual({ activePanelId: 'files' })
    panels.clear()
    expect(ctx.slots.subscribe.mock.calls[0]![0]).toBe('main')
    ctx.slots.subscribe.mock.calls[0]![1]()
    expect(panelInfo.getSnapshot()).toEqual({ activePanelId: null })
    expect(changed).toHaveBeenCalledTimes(2)
    stop()

    // The disposal effect must be owned by the fiber so a later unload frees
    // the registration for whoever applies next; the factory result is what
    // cordis registers for uninstall.
    expect(ctx.effect).toHaveBeenCalledWith(expect.any(Function), 'desktop: layout service')
    const disposer = ctx.effect.mock.results[0]?.value
    expect(typeof disposer).toBe('function')
    ;(disposer as () => void)()
    expect(dispose).toHaveBeenCalled()
    expect(ctx.slots.provideRoot.mock.results[0]!.value).toHaveBeenCalledOnce()
    expect(ctx.slots.subscribe.mock.results[0]!.value).toHaveBeenCalledOnce()
  })

  it('registers the official sidebar command after services arrive and disposes it', () => {
    const ctx = makeCtx()
    const layout = new DesktopLayoutState()
    installDesktopLayout(ctx as never, layout)
    expect(ctx.inject).toHaveBeenCalledWith(['shortcuts', 'locale'], expect.any(Function))
    const releaseLabels = vi.fn()
    const releaseCommand = vi.fn()
    const scope = {
      effect: vi.fn((factory: () => unknown) => factory()),
      locale: { register: vi.fn(() => releaseLabels), bind: vi.fn(() => () => 'Toggle left sidebar') },
      shortcuts: { register: vi.fn((_command: unknown) => releaseCommand) },
    }
    ctx.inject.mock.calls[0]![1](scope)
    const command = scope.shortcuts.register.mock.calls[0]![0] as {
      id: string; resolve(): { status: string; run(): void }
    }
    expect(command.id).toBe('sidebar.left.toggle')
    const before = layout.getSnapshot().sidebar
    expect(command.resolve().status).toBe('handled')
    command.resolve().run()
    expect(layout.getSnapshot().sidebar).not.toBe(before)
    for (const result of scope.effect.mock.results) (result.value as () => void)()
    expect(releaseLabels).toHaveBeenCalledOnce()
    expect(releaseCommand).toHaveBeenCalledOnce()
  })

  it('rejects a layout already selected by another entry', () => {
    const ctx = makeCtx()
    ctx.reflect.get.mockReturnValue({ owner: 'third-party-layout' })

    expect(() => installDesktopLayout(ctx as never, {} as never))
      .toThrow('advanced and extended modes require exclusive layout ownership')
    expect(ctx.effect).not.toHaveBeenCalled()
    expect(ctx.reflect.provide).not.toHaveBeenCalled()
  })

  it('propagates registration failures', () => {
    const ctx = makeCtx()
    ctx.reflect.provide.mockImplementation(() => {
      throw new TypeError('cannot read properties of undefined')
    })
    expect(() => installDesktopLayout(ctx as never, {} as never)).toThrow(TypeError)
  })
})

function environmentFor(mode: 'advanced' | 'extended') {
  return { mode, platform: 'win32', material: 'off', version: '2.0.2' }
}

describe('applyAdvancedShell presentation ownership', () => {
  it('owns presentation when the selected layout is available', () => {
    stubDocument()
    const ctx = makeCtx()
    ctx.reflect.provide.mockReturnValue(vi.fn())

    applyAdvancedShell(ctx as never, environmentFor('advanced') as never)

    // layout service + owned styles/markers + theme presenter + root slot
    expect(ctx.effect).toHaveBeenCalledTimes(4)
    expect(ctx.slots.register).toHaveBeenCalledTimes(1)
  })

  it('rejects a conflicting layout before installing partial Desktop state', () => {
    const { dataset } = stubDocument()
    const ctx = makeCtx()
    ctx.reflect.get.mockReturnValue({ owner: 'third-party-layout' })

    expect(() => applyAdvancedShell(ctx as never, environmentFor('advanced') as never))
      .toThrow('advanced and extended modes require exclusive layout ownership')

    expect(ctx.effect).not.toHaveBeenCalled()
    expect(ctx.slots.register).not.toHaveBeenCalled()
    expect(dataset.dshDesktopMode).toBeUndefined()
    expect(dataset.dshDesktopPlatform).toBeUndefined()
  })
})

describe('applyExtendedShell presentation ownership', () => {
  it('owns the extended presentation and frames the selected layout', () => {
    stubDocument()
    const ctx = makeCtx()
    ctx.reflect.provide.mockReturnValue(vi.fn())

    applyExtendedShell(ctx as never, environmentFor('extended') as never)

    // layout + owned styles + presenter + root slot + framed chrome styles
    expect(ctx.effect).toHaveBeenCalledTimes(5)
    expect(ctx.slots.register).toHaveBeenCalledTimes(1)
  })

  it('rejects a conflicting layout before installing the Desktop frame', () => {
    stubDocument()
    const ctx = makeCtx()
    ctx.reflect.get.mockReturnValue({ owner: 'third-party-layout' })

    expect(() => applyExtendedShell(ctx as never, environmentFor('extended') as never))
      .toThrow('advanced and extended modes require exclusive layout ownership')

    expect(ctx.effect).not.toHaveBeenCalled()
    expect(ctx.slots.register).not.toHaveBeenCalled()
    expect(ctx.slots.inject).not.toHaveBeenCalled()
  })
})
