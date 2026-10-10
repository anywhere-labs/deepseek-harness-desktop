import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as jsxRuntime from 'react/jsx-runtime'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
// Keep this Host-test fixture independent of the browser barrel's CSS and slot augmentations.
interface WebSearchCardFace {
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
  hooks: { webSearchCard: { getSnapshot(): { saving: boolean; failed: boolean; dirty: boolean; apiKeyEnv: { text: string } } } }
}

function loadWebSearchSettings(): { apply(ctx: object): void } {
  const source = readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-primitives')), 'utf8')
  const model = source.match(/\/\/#region lib\/types\/settings-form\/form-model\.js\n([\s\S]*?)\/\/#endregion/u)?.[1]
  if (model === undefined) throw new Error('installed settings form model changed')
  const primitives = runInNewContext(`${model}\n({ SettingsFormModel, settingsTextField, settingsNumberField })`, {
    createSnapshotStore(initial: unknown) {
      let snapshot = initial
      return { getSnapshot: () => snapshot, set(next: unknown) { snapshot = next } }
    },
  }) as Record<string, unknown>
  Object.assign(primitives, { SettingsForm: 'form', SettingsValueField: 'value-field', SettingsSecretField: 'secret-field' })
  let plugin: { apply(ctx: object): void } | undefined
  runInNewContext(readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-settings-web-search/client')), 'utf8'), {
    window: { __ModuleLoader__: { load({ factory }: { factory(require: (name: string) => unknown): typeof plugin }) {
      plugin = factory(name => {
        if (name === 'react/jsx-runtime') return jsxRuntime
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
        throw new Error(`unexpected web-search settings import: ${name}`)
      })
    } } },
  })
  if (plugin === undefined) throw new Error('web-search settings factory was not loaded')
  return plugin
}

function mount(options: { ref?: string; writable?: boolean; accepted?: boolean; lockedRef?: string } = {}) {
  const listeners = new Set<() => void>()
  const credentials = new Map([['DEEPSEEK_API_KEY', 'chat-key'], ['EXISTING_SEARCH_KEY', 'existing-search-key']])
  const writes: string[] = []
  let user: Record<string, unknown> = options.ref ? { apiKeyEnv: options.ref } : {}
  let revision = 7
  let registration: { inject(): WebSearchCardFace } | undefined
  let component: ((props: Record<string, unknown>) => ReactElement) | undefined
  const scope = {
    getSnapshot: () => ({
      status: 'ready', value: { apiKeyEnv: 'DEEPSEEK_API_KEY', ...user },
      base: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, user, writable: options.writable ?? true, revision,
    }),
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    mutate: vi.fn(async (ops: { op: string; path: string[]; value?: unknown }[], expectedRevision: number) => {
      writes.push('settings')
      if (options.accepted === false || expectedRevision !== revision) return false
      for (const op of ops) {
        if (op.op === 'unset') delete user[op.path[0]!]
        else user[op.path[0]!] = op.value
      }
      user = { ...user }; revision++
      for (const listener of listeners) listener()
      return true
    }),
  }
  const set = vi.fn(async (ref: string, value: string) => {
    writes.push(`credential:${ref}`)
    if (ref === options.lockedRef) return { ok: false, error: { code: 'FORBIDDEN', message: 'Read-only credential' } }
    credentials.set(ref, value)
    return { ok: true, value: undefined }
  })
  const ctx = {
    locale: { bind: () => (key: string) => key, register: () => () => {} },
    effect(factory: () => (() => void) | void) { factory() },
    remote: {
      credentials: {
        describe: vi.fn(async (refs: string[]) => ({ ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: credentials.has(ref), writable: ref !== options.lockedRef }])) })),
        set,
      },
      $on: () => () => {},
    },
    configForms: { get: () => scope, whileServed: (_names: string[], register: () => () => void) => register() },
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register(entry: typeof registration, view: typeof component) { registration = entry; component = view; return () => {} },
    },
  }
  loadWebSearchSettings().apply(ctx)
  const face = registration!.inject()
  return { face, scope, credentials, writes, set, component: component! }
}

async function save(face: WebSearchCardFace) {
  face.save()
  await vi.waitFor(() => expect(face.hooks.webSearchCard.getSnapshot().saving).toBe(false))
}

describe('installed web-search credential-reference control', () => {
  it('renders an editable credential-reference field', () => {
    const { face, component } = mount()
    const tree = component({ view: 'settings', t: (key: string) => key, useWebSearchCard: (read: (state: unknown) => unknown) => read(face.hooks.webSearchCard.getSnapshot()), ...face })
    const children = (tree.props as { children: ReactElement<{ id: string; disabled: boolean; onEdit(text: string): void }>[] }).children
    const field = children.find(child => child.props.id === 'plugin-config-web-search-reference')
    expect(field).toBeDefined()
    expect(field!.props.disabled).toBe(false)
    field!.props.onEdit('DEEPSEEK_SEARCH_API_KEY')
    expect(face.hooks.webSearchCard.getSnapshot().apiKeyEnv.text).toBe('DEEPSEEK_SEARCH_API_KEY')
  })

  it('commits the search reference before writing its new key, even when the key was edited first', async () => {
    const { face, credentials, writes, set } = mount()
    face.edit('apiKey', 'official-search-key')
    face.edit('apiKeyEnv', 'DEEPSEEK_SEARCH_API_KEY')
    await save(face)
    expect(writes).toEqual(['settings', 'credential:DEEPSEEK_SEARCH_API_KEY'])
    expect(set).toHaveBeenCalledWith('DEEPSEEK_SEARCH_API_KEY', 'official-search-key')
    expect(credentials.get('DEEPSEEK_API_KEY')).toBe('chat-key')
    expect(face.hooks.webSearchCard.getSnapshot().failed).toBe(false)
  })

  it('does not migrate or copy keys when only the reference changes', async () => {
    const { face, credentials, set } = mount()
    face.edit('apiKeyEnv', 'EXISTING_SEARCH_KEY')
    await save(face)
    expect(set).not.toHaveBeenCalled()
    expect(credentials.get('DEEPSEEK_API_KEY')).toBe('chat-key')
    expect(credentials.get('EXISTING_SEARCH_KEY')).toBe('existing-search-key')
  })

  it('keeps both keys untouched if the reference write is rejected', async () => {
    const { face, credentials, set } = mount({ accepted: false })
    face.edit('apiKeyEnv', 'DEEPSEEK_SEARCH_API_KEY')
    face.edit('apiKey', 'official-search-key')
    await save(face)
    expect(set).not.toHaveBeenCalled()
    expect(credentials.get('DEEPSEEK_API_KEY')).toBe('chat-key')
    expect(credentials.has('DEEPSEEK_SEARCH_API_KEY')).toBe(false)
    expect(face.hooks.webSearchCard.getSnapshot().failed).toBe(true)
  })

  it('retains the key draft when an existing read-only credential rejects the write', async () => {
    const { face, credentials } = mount({ lockedRef: 'EXISTING_SEARCH_KEY' })
    face.edit('apiKey', 'replacement-search-key')
    face.edit('apiKeyEnv', 'EXISTING_SEARCH_KEY')
    await save(face)
    expect(credentials.get('EXISTING_SEARCH_KEY')).toBe('existing-search-key')
    expect(credentials.get('DEEPSEEK_API_KEY')).toBe('chat-key')
    expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({ failed: true, dirty: true })
  })

  it('discards an edited reference without modifying settings or credentials', () => {
    const { face, scope, set } = mount()
    face.edit('apiKeyEnv', 'DEEPSEEK_SEARCH_API_KEY')
    face.discard()
    expect(scope.mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(face.hooks.webSearchCard.getSnapshot().dirty).toBe(false)
  })

  it('explicitly resetting the reference restores the shared default without copying a key', async () => {
    const { face, scope, credentials, set } = mount({ ref: 'EXISTING_SEARCH_KEY' })
    face.resetField('apiKeyEnv')
    await save(face)
    expect(scope.getSnapshot().value.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
    expect(set).not.toHaveBeenCalled()
    expect(credentials.get('EXISTING_SEARCH_KEY')).toBe('existing-search-key')
  })

  it('refuses writes in read-only deployments', async () => {
    const { face, scope, set } = mount({ writable: false })
    face.edit('apiKeyEnv', 'DEEPSEEK_SEARCH_API_KEY')
    face.edit('apiKey', 'official-search-key')
    await save(face)
    expect(scope.mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })
})
