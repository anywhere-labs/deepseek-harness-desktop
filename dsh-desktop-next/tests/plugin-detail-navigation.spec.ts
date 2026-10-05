import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerPluginControls } from '../src/client/plugin-controls.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'button', PluginArtworkDefault: 'svg', Switch: 'input', StateDot: 'span',
  Toast: 'aside', Modal: 'dialog', IconSettingsOutlineRegular: 'svg',
}))

type Node = { type: string | ((props: any) => Node); props: Record<string, any> }
const jsx = (type: Node['type'], props: Node['props']): Node => ({ type, props })
const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes)
  : value && typeof value === 'object' && 'type' in value && 'props' in value
    ? [value as Node, ...nodes((value as Node).props.children)] : []
const component = (tree: Node, name: string): Node | undefined => nodes(tree).find(node => typeof node.type === 'function' && node.type.name === name)
const render = (node: Node): Node => (node.type as (props: Node['props']) => Node)(node.props)

/** Execute the installed official page, replacing only its external services and React hook scheduler. */
function fixture() {
  const hookState: unknown[] = []
  let cursor = 0
  let Page: (props: Record<string, unknown>) => Node
  let navigation: any
  let apply: (context: unknown) => void
  const source = readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-ui-plugin-manager/client'), 'utf8')
  const require = (id: string) => {
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
    if (id === 'react') return {
      useState(initial: unknown) {
        const index = cursor++
        if (!(index in hookState)) hookState[index] = initial
        return [hookState[index], (value: unknown) => { hookState[index] = value }]
      },
      useEffect() {}, useId: () => 'description', useRef: () => ({ current: null }),
    }
    if (id === 'react-dom') return {}
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: (_, name) => (props: Node['props']) => jsx(String(name), props) })
    if (id === '@deepseek-ai/dsh-client-ui-slots') return { resolveSlotLabel: (label: unknown) => label }
    if (id === '@deepseek-ai/dsh-client-store') return {
      createSnapshotStore: (state: unknown) => ({ getSnapshot: () => state }),
      defineStore: ({ init, actions }: any) => ({ create: () => {
        const state = init()
        return { getSnapshot: () => state, actions: Object.fromEntries(Object.entries(actions).map(([name, action]) =>
          [name, (...args: unknown[]) => (action as any)(state, ...args)])) }
      } }),
    }
    throw new Error(`Unexpected browser dependency: ${id}`)
  }
  runInNewContext(source, { window: { __ModuleLoader__: { load: (entry: { factory: (require: unknown) => { apply: typeof apply } }) => { apply = entry.factory(require).apply } } } })
  const noop = () => () => {}
  apply!({ effect: (effect: () => void) => effect(), on: noop,
    locale: { register: noop, bind: () => (key: string) => key }, remote: { $on: noop },
    layout: { panelInfo: { subscribe: noop }, selectPanel: vi.fn() }, reflect: { provide: noop },
    configForms: { describe: () => ({ getSnapshot: () => ({}), subscribe: noop }), get: () => undefined },
    slots: { inject: (_name: string, register: () => unknown) => {
      const result = register()
      if (result && typeof result === 'object' && Symbol.iterator in result) [...result as Iterable<unknown>]
    }, register: (options: { name: string; store?: any }, view: typeof Page) => {
      if (options.name === 'main') { Page = view; navigation = options.store.create() }
      return () => {}
    } },
  })
  const remote = { name: '@agents-anywhere/dsh-bridge-next', enabled: true, installed: false, optional: true,
    version: '0.1.0', description: 'Remote connection', rows: [{ entryId: undefined as string | undefined, rowId: 'bridge', moduleName: 'bridge', enabled: true, phase: 'active' }] }
  const official = { ...remote, name: 'official-team', rows: [] }
  const state = { status: 'ready', packages: [official, remote], busy: [] as string[], notice: null, highlight: null, confirm: null,
    install: { open: false } }
  const item = { id: 'desktop-next-computer-use', label: 'Computer Use' }
  const ledger = { items: [item], bundles: new Set([remote.name]), rows: new Set(),
    hiddenBundles: new Set([remote.name]), hiddenItems: new Set([item.id]) }
  let overview: { onOpenBundle(name: string): void; onOpenItem(id: string): void }
  const setEnabled = vi.fn()
  const setRowEnabled = vi.fn()
  const props = {
    useStore: (select: (state: unknown) => unknown) => select(navigation.getSnapshot()), actions: navigation.actions,
    t: (key: string) => key, ensure: vi.fn(), resolveText: (text: string) => text,
    useConfigurations: () => [], usePluginManager: () => state, useConfigLedger: () => ledger, setEnabled, setRowEnabled,
    renderSlot: (name: string, owner: Record<string, unknown>, options?: unknown) => {
      if (name === 'plugins.overview') overview = owner as typeof overview
      return jsx('slot', { name, owner, options })
    },
  }
  return { state, remote, item, ledger, setEnabled, setRowEnabled,
    page: () => { cursor = 0; return Page!(props) }, overview: () => overview!,
  }
}

it('opens an overview-owned bundle through the official detail with native header actions, switch, settings and component rows', () => {
  const app = fixture()
  const list = app.page()
  expect(nodes(list).filter(node => node.props['data-plugin-group']).map(node => node.props['data-plugin-group'])).toEqual(['official'])
  expect(nodes(list).find(node => node.props['data-plugin-count'])?.props['data-plugin-count']).toBe(1)
  app.overview().onOpenBundle(app.remote.name)
  const page = app.page()
  expect(nodes(page).some(node => node.props['data-plugin-group'])).toBe(false)
  const detail = component(page, 'PackageDetail')!
  expect(detail.props.pkg.name).toBe(app.remote.name)
  const body = render(detail)
  const top = component(body, 'DetailTop')!
  const header = render(top)
  expect(nodes(header).some(node => Array.isArray(node.props.children) && node.props.children.includes(top.props.actions))).toBe(true)
  expect(nodes(top.props.actions).some(node => node.props.name === 'plugins.detail.actions')).toBe(true)
  const toggle = render(component(top.props.actions, 'EnableSwitch')!)
  toggle.props.onChange(false)
  expect(app.setEnabled).toHaveBeenCalledWith(app.remote.name, false)
  expect(nodes(body).some(node => node.props.name === 'plugins.bundle.config')).toBe(true)
  expect(component(body, 'RowsSection')?.props.rows).toEqual(app.remote.rows)
  top.props.onBack()
  expect(nodes(app.page()).some(node => node.props.name === 'plugins.overview')).toBe(true)
})

it('uses the official item detail without adding Computer Use to the official group or changing its count', () => {
  const app = fixture()
  app.page()
  app.overview().onOpenItem(app.item.id)
  const detail = component(app.page(), 'ItemDetail')!
  const body = render(detail)
  const top = component(body, 'DetailTop')!
  const action = nodes(top.props.actions).find(node => node.props.name === 'plugins.detail.actions')!
  expect(action.props.owner.subject).toEqual({ kind: 'item', id: app.item.id })
  expect(nodes(body).some(node => node.props.name === 'plugins.item' && node.props.owner.view === 'page')).toBe(true)
  top.props.onBack()
  expect(nodes(app.page()).find(node => node.props['data-plugin-count'])?.props['data-plugin-count']).toBe(1)
  app.overview().onOpenItem('missing')
  expect(component(app.page(), 'ItemDetail')).toBeUndefined()
  app.overview().onOpenBundle('missing')
  expect(component(app.page(), 'PackageDetail')).toBeUndefined()
})

it('preserves ordinary official cards and their navigation when no overview entries are hidden', () => {
  const app = fixture()
  app.ledger.hiddenBundles.clear()
  app.ledger.hiddenItems.clear()
  const list = app.page()
  expect(nodes(list).find(node => node.props['data-plugin-count'])?.props['data-plugin-count']).toBe(3)
  const card = nodes(list).find(node => typeof node.type === 'function' && node.type.name === 'PackageCard' && node.props.pkg.name === 'official-team')!
  card.props.onOpen()
  expect(component(app.page(), 'PackageDetail')?.props.pkg.name).toBe('official-team')
})

it('places keyed bundle actions before the native switch without sharing the card navigation target', () => {
  const app = fixture()
  const card = component(app.page(), 'PackageCard')!
  const head = component(render(card), 'CardHead')!
  const controls = nodes(head.props.end)
  const actionIndex = controls.findIndex(node => node.props.name === 'plugins.bundle.actions')
  const toggleIndex = controls.findIndex(node => typeof node.type === 'function' && node.type.name === 'EnableSwitch')
  expect(actionIndex).toBeGreaterThan(-1)
  expect(toggleIndex).toBeGreaterThan(actionIndex)
  expect(controls[actionIndex]!.props.options).toEqual({ entryKey: card.props.pkg.name })
  expect(controls[actionIndex]!.props.owner.subject.pkg.name).toBe(card.props.pkg.name)
  const rendered = render(head)
  const openButton = nodes(rendered).find(node => node.props.onClick === head.props.onOpen)!
  expect(openButton).toBeDefined()
  expect(nodes(openButton).some(node => node.props.name === 'plugins.bundle.actions')).toBe(false)
})

it('keeps an official optional bundle in the official group with its artwork, badge, native switches and component details under Next composition', () => {
  const app = fixture()
  const ctx = {
    inject: (_services: unknown, callback: (context: unknown) => void) => { callback(ctx) },
    slots: {
      inject: (_name: string, callback: () => unknown) => { callback() },
      register: (options: { name: string; key?: string }) => {
        if (options.name === 'plugins.bundle.hidden') app.ledger.hiddenBundles.add(options.key!)
        return () => {}
      },
    },
  }
  registerPluginControls(ctx as unknown as Context)
  const name = '@deepseek-ai/dsh-experimental-inspector-profile'
  const { meta } = JSON.parse(readFileSync(createRequire(import.meta.url).resolve(`${name}/locale/zh.json`), 'utf8'))
  const inspector = { ...app.remote, name, enabled: false, meta: { ...meta, icon: '/inspector/icon.svg' },
    rows: [{ rowId: 'session-inspector', moduleName: '@deepseek-ai/dsh-experimental-session-inspector', entryId: 'include:session-inspector', enabled: false, phase: 'disabled' }] }
  app.state.packages.push(inspector)
  const findCard = () => nodes(app.page()).find(node => typeof node.type === 'function' && node.type.name === 'PackageCard' && node.props.pkg.name === name)!
  const card = findCard()
  expect(card).toBeDefined()
  expect(nodes(app.page()).find(node => node.props['data-plugin-count'])?.props['data-plugin-count']).toBe(2)
  const head = component(render(card), 'CardHead')!
  expect(head.props.title).toBe('开发者工具')
  expect(head.props.description).toBe(meta.description)
  expect(head.props.icon.props.src).toBe('/inspector/icon.svg')
  expect(nodes(head.props.tags).some(node => node.props.children === 'statusBeta')).toBe(true)
  const toggle = render(component(head.props.end, 'EnableSwitch')!)
  expect(toggle.props.checked).toBe(false)
  toggle.props.onChange(true)
  expect(app.setEnabled).toHaveBeenCalledExactlyOnceWith(name, true)
  inspector.enabled = true
  const activeHead = component(render(findCard()), 'CardHead')!
  expect(render(component(activeHead.props.end, 'EnableSwitch')!).props.checked).toBe(true)
  card.props.onOpen()
  const detail = render(component(app.page(), 'PackageDetail')!)
  expect(component(detail, 'RowsSection')?.props.rows).toEqual(inspector.rows)
  const top = component(detail, 'DetailTop')!
  render(component(top.props.actions, 'EnableSwitch')!).props.onChange(false)
  expect(app.setEnabled).toHaveBeenLastCalledWith(name, false)
})


it('lets composite item details reuse the official component list, live state and row toggles', () => {
  const app = fixture()
  const schedule = { rowId: 'schedule', entryId: 'include:schedule', moduleName: '@deepseek-ai/dsh-schedule', enabled: true, phase: 'active' }
  const unrelated = { entryId: undefined, rowId: 'other', moduleName: 'other-plugin', enabled: true, phase: 'active' }
  app.state.packages.push({ ...app.remote, name: '@deepseek-ai/dsh-web-app', rows: [schedule, unrelated] })
  app.page()
  app.overview().onOpenItem(app.item.id)
  const body = render(component(app.page(), 'ItemDetail')!)
  const pageSlot = nodes(body).find(node => node.props.name === 'plugins.item' && node.props.owner.view === 'page')!
  const rows = pageSlot.props.owner.renderComponents(['@deepseek-ai/dsh-schedule']) as Node
  expect(typeof rows.type === 'function' && rows.type.name).toBe('RowsSection')
  expect(rows.props.rows).toEqual([schedule])
  rows.props.toggle.onSetEnabled(schedule, false)
  expect(app.setRowEnabled).toHaveBeenCalledWith('include:schedule', false)
  app.state.busy.push('row:include:schedule')
  expect(rows.props.toggle.busy(schedule)).toBe(true)
  schedule.enabled = false
  const updatedBody = render(component(app.page(), 'ItemDetail')!)
  const updatedSlot = nodes(updatedBody).find(node => node.props.name === 'plugins.item' && node.props.owner.view === 'page')!
  expect(updatedSlot.props.owner.renderComponents(['@deepseek-ai/dsh-schedule']).props.rows[0].enabled).toBe(false)
})
