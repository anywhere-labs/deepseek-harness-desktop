import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as jsxRuntime from 'react/jsx-runtime'
import type { ShellCardFace } from '@deepseek-ai/dsh-client-ui-settings-shell/client'
import { describe, expect, it, vi } from 'vitest'

// Run the installed browser factory so the regression covers the shipped patch,
// including the real form model's reads and revision-fenced writes.
function loadShellSettings(): { apply(ctx: object): void } {
  // Only the form model is needed here; the primitives barrel also imports
  // browser styles and icon assets that this headless registration never uses.
  const source = readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-primitives')), 'utf8')
  const model = source.match(/\/\/#region lib\/types\/settings-form\/form-model\.js\n([\s\S]*?)\/\/#endregion/u)?.[1]
  if (model === undefined) throw new Error('installed settings form model changed')
  const primitives: unknown = runInNewContext(`${model}\n({ SettingsFormModel, settingsNumberField })`, {
    createSnapshotStore(initial: unknown) {
      let snapshot = initial
      return { getSnapshot: () => snapshot, set(next: unknown) { snapshot = next } }
    },
  })
  let plugin: { apply(ctx: object): void } | undefined
  runInNewContext(readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-settings-shell/client')), 'utf8'), {
    window: { __ModuleLoader__: { load({ factory }: { factory(require: (name: string) => unknown): typeof plugin }) {
      plugin = factory(name => {
        if (name === 'react/jsx-runtime') return jsxRuntime
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
        throw new Error(`unexpected shell settings import: ${name}`)
      })
    } } },
  })
  if (plugin === undefined) throw new Error('shell settings factory was not loaded')
  return plugin
}

function mount(served: readonly string[]) {
  const disposers: (() => void)[] = []
  const forms = new Map<string, { mutate: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> }>()
  let entry: { id: string; label(): string; inject(): ShellCardFace } | undefined
  const ctx = {
    locale: {
      bind: () => (key: string) => key === 'title' ? '终端' : key,
      register: () => () => {},
    },
    effect(factory: () => () => void) { disposers.push(factory()) },
    configForms: {
      get(ns: string) {
        const mutate = vi.fn(async () => true)
        const unsubscribe = vi.fn()
        forms.set(ns, { mutate, unsubscribe })
        return {
          getSnapshot: () => ({
            status: served.includes(ns) ? 'ready' : 'unavailable',
            value: { timeoutMs: 120_000, maxOutputBytes: 64_000 },
            base: {}, user: {}, writable: true, revision: 7,
          }),
          subscribe: () => unsubscribe,
          mutate,
        }
      },
      whileServed(names: string[], register: (served: Set<string>) => () => void) {
        const matched = names.filter(ns => served.includes(ns))
        return matched.length === 0 ? () => {} : register(new Set(matched))
      },
    },
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register(options: typeof entry) { entry = options; return () => { entry = undefined } },
    },
  }
  loadShellSettings().apply(ctx)
  return { forms, get entry() { return entry }, dispose() { for (const dispose of disposers.reverse()) dispose() } }
}

describe('installed shell settings client', () => {
  it.each([
    ['desktop-windows-pwsh-sandbox'],
    ['pwsh-sandbox'],
    ['bash-sandbox'],
    ['desktop-windows-pwsh-sandbox', 'pwsh-sandbox'],
  ])('binds the terminal card and its writes to the served executor %j', async (...served) => {
    const mounted = mount(served)
    expect(mounted.entry).toMatchObject({ id: 'shell' })
    expect(mounted.entry?.label()).toBe('终端')
    const face = mounted.entry!.inject()
    expect(face.hooks.shellCard.getSnapshot()).toMatchObject({ available: true, timeoutMs: { text: '120000' } })
    face.edit('timeoutMs', '90000')
    await face.save()
    expect(mounted.forms.get(served[0]!)?.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['timeoutMs'], value: 90_000 },
    ], 7)
    for (const [ns, form] of mounted.forms) {
      if (ns !== served[0]) expect(form.mutate).not.toHaveBeenCalled()
    }
    mounted.dispose()
    expect(mounted.entry).toBeUndefined()
    for (const form of mounted.forms.values()) expect(form.unsubscribe).toHaveBeenCalledOnce()
  })

  it('omits the terminal card when no shell executor is served', () => {
    const mounted = mount(['agent-loop'])
    expect(mounted.entry).toBeUndefined()
    mounted.dispose()
  })
})
