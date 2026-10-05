// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Enter through the installed plugin's public settings slot, using the app's
// React runtime. No private component or generated source extraction is used.
function loadSection() {
  let apply: ((ctx: object) => void) | undefined
  let Section: React.ComponentType<Record<string, unknown>> | undefined
  runInNewContext(readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-settings-models/client')), 'utf8'), {
    document, structuredClone, Map, Set,
    window: { __ModuleLoader__: { load({ factory }: { factory(require: (name: string) => unknown): { apply(ctx: object): void } }) {
      apply = factory(name => {
        if (name === 'react') return React
        if (name === 'react/jsx-runtime') return jsxRuntime
        if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: (initial: unknown) => ({ getSnapshot: () => initial }) }
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: () => () => null })
        throw new Error(`unexpected settings dependency: ${name}`)
      }).apply
    } } },
  })
  apply!({
    effect: () => {}, locale: { bind: () => (key: string) => key }, settingsSchema: {},
    configForms: { describe: () => ({}), get: () => ({}) },
    slots: {
      inject: (_name: string, register: () => void) => register(),
      register: (entry: { name: string }, component: typeof Section) => { if (entry.name === 'settings.section') Section = component },
    },
  })
  if (Section === undefined) throw new Error('models settings slot not registered')
  return Section
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose() })

async function settings(native = false) {
  const Section = loadSection()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup.push(async () => { await act(async () => root.unmount()); container.remove() })
  const ns = native ? 'llm-deepseek' : 'llm-pi-ai'
  const path = native ? [] : ['providers', 'gateway']
  let profile: Record<string, unknown> = { baseURL: 'http://first.test/v1', api: 'openai-completions', models: [{ id: 'think' }] }
  const namespace = { ns, value: native ? profile : { providers: { gateway: profile } }, user: native ? profile : { providers: { gateway: profile } }, base: {}, schema: {}, revision: 7 }
  const getPath = (value: unknown, keys: string[]): unknown => keys.reduce<unknown>((current, key) => typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined, value)
  const schema = {
    rehydrate: (value: unknown) => value,
    nodeAtPath: () => ({ type: 'object', meta: {} }), validate: () => undefined,
    getPath, hasPath: (value: unknown, keys: string[]) => getPath(value, keys) !== undefined,
    setPath: (value: object, keys: string[], next: unknown) => {
      const copy = structuredClone(value) as Record<string, unknown>
      let parent = copy
      for (const key of keys.slice(0, -1)) parent = (parent[key] ??= {}) as Record<string, unknown>
      parent[keys.at(-1)!] = next
      return copy
    },
    deletePath: (value: object, keys: string[]) => {
      const copy = structuredClone(value) as Record<string, unknown>
      const parent = getPath(copy, keys.slice(0, -1)) as Record<string, unknown>
      delete parent[keys.at(-1)!]
      return copy
    },
  }
  const discovery = vi.fn(async () => ({ kind: 'found', models: [{ id: 'think', reasoningCapability: { status: 'known', source: native ? 'adapter' : 'endpoint', authoritative: true, efforts: (native ? ['off', 'low', 'high', 'max'] : ['low', 'high']).map(id => ({ id, name: id, wireValue: id })) } }] }))
  const writes = vi.fn(async (_ns: string, ops: { op: string; path: string[]; value?: unknown }[], revision: number) => {
    expect(revision).toBe(namespace.revision)
    for (const op of ops) namespace.user = op.op === 'set' ? schema.setPath(namespace.user, op.path, op.value) as typeof namespace.user : schema.deletePath(namespace.user, op.path) as typeof namespace.user
    profile = getPath(namespace.user, path) as typeof profile
    namespace.value = namespace.user
    namespace.revision++
    return { kind: 'written', view: namespace }
  })
  const snapshot = { status: 'ready', writable: true, error: null, credentialError: null, namespaces: new Map([[ns, namespace]]), rows: [{
    configured: true, removable: !native, entry: { provider: native ? 'deepseek-official' : 'gateway', displayName: 'Gateway', settingsNs: ns, settingsPath: path, active: true, declared: !native },
  }] }
  const render = async () => act(async () => root.render(React.createElement(Section, {
    controller: { load: async () => {} }, useSnapshot: () => snapshot, schema, t: (key: string) => key,
    renderSlot: () => null, operations: { discoverModels: discovery, describeCredential: async () => ({ configured: true }), writeSettings: writes },
  })))
  const click = async (text: string) => {
    const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === text)
    if (!button) throw new Error(`missing button ${text}: ${container.textContent}`)
    await act(async () => button.click())
  }
  const open = async () => { await click('edit'); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="modelAdvanced 1"]')!.click()) }
  await render()
  await open()
  return { container, click, open, discovery, writes, get profile() { return profile } }
}

describe('installed provider reasoning settings', () => {
  it.each([false, true])('persists subset and independent default and keeps unchecked candidates (%s native)', async native => {
    const editor = await settings(native)
    if (!native) await editor.click('fetchModels')
    const defaultSelect = editor.container.querySelector<HTMLSelectElement>('[aria-label="reasoningDefault 1"]')!
    await act(async () => { defaultSelect.value = 'low'; defaultSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => editor.container.querySelector<HTMLInputElement>('[aria-label="reasoning high 1"]')!.click())
    await editor.click('apply')
    expect(editor.writes).toHaveBeenCalled()
    expect(editor.profile).toMatchObject({ models: [{ reasoningConfig: { defaultEffort: 'low', selected: native ? ['off', 'low', 'max'] : ['low'] } }] })
    await editor.open()
    expect(editor.container.querySelector<HTMLInputElement>('[aria-label="reasoning high 1"]')?.checked).toBe(false)
  })

  it('retains selection on refresh, leaves additions unchecked and exposes authoritative withdrawal', async () => {
    const editor = await settings()
    await editor.click('fetchModels')
    await editor.click('fetchModels')
    editor.discovery.mockResolvedValue({ kind: 'found', models: [{ id: 'think', reasoningCapability: { status: 'known', source: 'endpoint', authoritative: true, efforts: ['low', 'max'].map(id => ({ id, name: id, wireValue: id })) } }] })
    await editor.click('fetchModels')
    expect(editor.container.querySelector<HTMLInputElement>('[aria-label="reasoning max 1"]')?.checked).toBe(false)
    expect(editor.container.querySelector<HTMLInputElement>('[aria-label="reasoning high 1"]')?.checked).toBe(true)
    expect(editor.container.querySelector('[role="alert"]')?.textContent).toBe('modelReasoningInvalid')
    const apply = Array.from(editor.container.querySelectorAll('button')).find(button => button.textContent === 'apply')!
    expect(apply.disabled).toBe(true)
  })

  it('discards a discovery response after the connection changes and still allows saving unknown capabilities', async () => {
    const editor = await settings()
    let release: ((answer: Awaited<ReturnType<typeof editor.discovery>>) => void) | undefined
    editor.discovery.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await editor.click('fetchModels')
    const endpoint = editor.container.querySelector<HTMLInputElement>('[aria-label="baseUrl"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(endpoint, 'http://second.test/v1')
      endpoint.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => release!({ kind: 'found', models: [{ id: 'think', reasoningCapability: { status: 'known', source: 'endpoint', authoritative: true, efforts: ['high'].map(id => ({ id, name: id, wireValue: id })) } }] }))
    expect(editor.container.querySelector('[aria-label="reasoning high 1"]')).toBeNull()
    expect(editor.container.textContent).toContain('reasoningUnknown')
    await editor.click('apply')
    expect(editor.profile.baseURL).toBe('http://second.test/v1')
    expect(editor.profile.models).toEqual([{ id: 'think' }])
  })

  it('preserves a manual wire mapping through refresh and requires explicit conflict resolution', async () => {
    const editor = await settings()
    await editor.click('reasoningConfigureManual')
    await editor.click('reasoningAddManual')
    editor.discovery.mockResolvedValue({ kind: 'found', models: [{ id: 'think', reasoningCapability: {
      status: 'known', source: 'endpoint', authoritative: true, efforts: [{ id: 'high', name: 'high', wireValue: 'different' }],
    } }] })
    await editor.click('fetchModels')
    expect(editor.container.querySelector('[role="alert"]')?.textContent).toBe('modelReasoningInvalid')
    await editor.click('reasoningKeepManual')
    editor.discovery.mockRejectedValue(new Error('temporary lookup failure'))
    await editor.click('fetchModels')
    await editor.click('apply')
    expect(editor.profile).toMatchObject({ models: [{ reasoningConfig: {
      selected: ['high'], manualAcknowledged: true, manualEfforts: [{ id: 'high', wireValue: 'high' }],
    } }] })
  })
})
