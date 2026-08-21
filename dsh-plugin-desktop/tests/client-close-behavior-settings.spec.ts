import { describe, expect, it, vi } from 'vitest'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { CloseBehaviorRowState } from '../src/client/close-behavior-settings-state.ts'
import type { CloseBehaviorRowActions } from '../src/client/close-behavior-settings-store.ts'
import {
  CLOSE_BEHAVIOR_SETTINGS_NS,
  registerCloseBehaviorRow,
} from '../src/client/close-behavior-settings.ts'
import { CloseBehaviorRow } from '../src/client/CloseBehaviorRow.tsx'
import { en, zh } from '../src/client/close-behavior-locale.ts'

// The component's `Menu`/icon come from the full primitives bundle, whose
// katex CSS import node vitest cannot load; stub the package so the row
// module resolves without a DOM while the registration assertions stay intact.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Menu: () => null,
  IconChevronDownOutline14: () => null,
}))

type RowHandle = EngineStoreHandle<CloseBehaviorRowState, CloseBehaviorRowActions>
type RegisterOptions = {
  name: string
  id: string
  order: number
  locale: string
  store: RowHandle
  inject: (actions: CloseBehaviorRowActions) => { setCloseBehavior: (value: 'tray' | 'quit') => void }
}

describe('desktop close-behavior settings row', () => {
  it('registers the row, projects the host value, and routes writes back', () => {
    let section: { closeBehavior: 'tray' | 'quit' } | undefined = { closeBehavior: 'quit' }
    let revision = 3
    const host = {
      getSnapshot: () => ({ value: section, revision }),
      subscribe: vi.fn(),
      set: vi.fn(async (_field: string, value: unknown) => {
        section = { closeBehavior: value as 'tray' | 'quit' }
        revision += 1
      }),
    }
    const locale = { register: vi.fn() }
    let registered: { options: RegisterOptions; component: unknown } | undefined
    let declaration: (() => void) | undefined
    const slots = {
      inject: vi.fn((_name: string, fn: () => void) => { declaration = fn }),
      register: vi.fn((options: RegisterOptions, component: unknown) => {
        registered = { options, component }
      }),
    }
    const ctx = {
      settingsScope: { bind: vi.fn(() => host) },
      locale,
      slots,
      effect: vi.fn((cb: () => void) => cb()),
    }
    const syncSpy = vi.fn()
    const createStore = vi.fn((): RowHandle => (({
      create: () => ({
        getSnapshot: () => ({ value: 'tray' as const, revision: -1 }),
        subscribe: vi.fn(),
        actions: { sync: syncSpy },
      }),
    }) as unknown as RowHandle))

    registerCloseBehaviorRow(ctx as never, createStore)

    expect(ctx.settingsScope.bind).toHaveBeenCalledWith({ namespace: expect.any(String) })
    expect(locale.register).toHaveBeenCalledWith(CLOSE_BEHAVIOR_SETTINGS_NS, { zh, en })
    expect(host.subscribe).toHaveBeenCalledTimes(1)
    declaration?.()
    expect(registered?.component).toBe(CloseBehaviorRow)
    expect(registered?.options).toMatchObject({
      name: 'settings.general.item',
      id: 'close-behavior',
      order: 10,
      locale: CLOSE_BEHAVIOR_SETTINGS_NS,
    })

    const face = registered!.options.inject({ sync: syncSpy })
    expect(syncSpy).toHaveBeenCalledWith('quit', 3)
    face.setCloseBehavior('tray')
    expect(host.set).toHaveBeenCalledWith('closeBehavior', 'tray')
  })
})
