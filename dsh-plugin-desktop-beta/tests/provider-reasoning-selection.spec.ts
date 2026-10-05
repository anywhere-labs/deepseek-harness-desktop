// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as Cordis from '@deepseek-ai/cordis'
import * as React from 'react'
import * as ReactDom from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('keeps a historical invalid effort visible and offers only enabled replacements', async () => {
  let plugin: { apply(ctx: object): void } | undefined
  let Seat: React.ComponentType<Record<string, unknown>> | undefined
  const Surface = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => React.createElement('div', { ...props, ref }))
  Object.assign(window, { __ModuleLoader__: { load({ factory }: { factory(require: (name: string) => unknown): typeof plugin }) {
    plugin = factory(name => {
      if (name === 'react') return React
      if (name === 'react-dom') return ReactDom
      if (name === 'react/jsx-runtime') return jsxRuntime
      if (name === '@deepseek-ai/cordis') return Cordis
      if (name === '@deepseek-ai/dsh-client-store') return {}
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({
        MenuSurface: Surface, MenuGroup: Surface,
        rankByName: (list: unknown[]) => list,
        observeStickyMenuGroups: () => () => {},
      }, { get: (target, key) => Reflect.get(target, key) ?? (() => null) })
      throw new Error(`unexpected selection dependency: ${name}`)
    })
  } } })
  runInNewContext(readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-model-selection/client')), 'utf8'), { window, document, Node, Map, Set, structuredClone, queueMicrotask })
  const scope = {
    effect: () => {}, get: () => ({}), sessions: {}, modelDirectories: {},
    slots: {
      inject: (_name: string, register: () => void) => register(),
      register: (_entry: object, component: typeof Seat) => { Seat = component },
    },
  }
  plugin!.apply({ ...scope, plugin: () => {}, locale: { bind: () => (key: string) => key }, inject: (_keys: string[], callback: (child: typeof scope) => void) => callback(scope) })
  if (Seat === undefined) throw new Error('conversation model seat was not registered')
  const ModelSeat = Seat
  const current = { provider: 'gateway', model: 'think', reasoningEffort: 'high' }
  const snapshot = {
    status: 'ready', current, retainedEffort: null, pending: null, error: null, failures: [],
    groups: [{ id: 'gateway', name: 'Gateway', models: [{ provider: 'gateway', id: 'think', name: 'Think', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }] }],
  }
  const select = vi.fn(async () => ({ ok: true }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(React.createElement(ModelSeat, { available: true, locked: false, directory: { subscribe: () => () => {}, getSnapshot: () => snapshot }, load: () => {}, select, t: (key: string) => key })))
    expect(container.textContent).toContain('high — effort.correctionRequired')
    expect(current.reasoningEffort).toBe('high')
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    const effortEntry = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(button => button.textContent?.includes('menu.effort'))!
    await act(async () => effortEntry.click())
    const choices = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    expect(choices.map(button => button.textContent)).toEqual(['Low'])
    await act(async () => choices[0]!.click())
    expect(select).toHaveBeenCalledWith({ provider: 'gateway', model: 'think', reasoningEffort: 'low' })
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
