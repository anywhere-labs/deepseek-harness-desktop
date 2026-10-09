import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'

interface JsxNode {
  readonly type: unknown
  readonly props: Record<string, any>
  readonly key?: unknown
}

interface StoreHandle {
  readonly persist: string
  create(): {
    getSnapshot(): Record<string, any>
    actions: Record<string, (...args: any[]) => void>
  }
}

interface BrowserRegistration {
  readonly component: (props: Record<string, any>) => JsxNode
  readonly store: StoreHandle
}

interface HookRuntime {
  render<T>(component: (props: Record<string, any>) => T, props: Record<string, any>): T
  useState<T>(initial: T | (() => T)): [T, (value: T | ((current: T) => T)) => void]
  useRef<T>(initial: T): { current: T }
}

const Fragment = Symbol('Fragment')
const jsx = (type: unknown, props: Record<string, any> | null, key?: unknown): JsxNode => ({
  type,
  props: props ?? {},
  ...(key === undefined ? {} : { key }),
})
const primitiveTypes = new Map<string, symbol>()
const primitiveType = (name: string): symbol => {
  const current = primitiveTypes.get(name)
  if (current !== undefined) return current
  const created = Symbol(name)
  primitiveTypes.set(name, created)
  return created
}
const primitives = new Proxy({}, {
  get: (_target, property) => primitiveType(String(property)),
})

let activeHooks: HookRuntime | undefined
const react = {
  Component: class {},
  createRef: () => ({ current: null }),
  useCallback: <T>(callback: T): T => callback,
  useEffect: (): void => {},
  useMemo: <T>(factory: () => T): T => factory(),
  useRef: <T>(initial: T): { current: T } => {
    if (activeHooks === undefined) throw new Error('hook called outside a component')
    return activeHooks.useRef(initial)
  },
  useState: <T>(initial: T | (() => T)): [T, (value: T | ((current: T) => T)) => void] => {
    if (activeHooks === undefined) throw new Error('hook called outside a component')
    return activeHooks.useState(initial)
  },
}

function hookRuntime(): HookRuntime {
  const state: unknown[] = []
  const refs: Array<{ current: unknown }> = []
  let stateCursor = 0
  let refCursor = 0
  return {
    render<T>(component: (props: Record<string, any>) => T, props: Record<string, any>): T {
      stateCursor = 0
      refCursor = 0
      activeHooks = this
      try {
        return component(props)
      } finally {
        activeHooks = undefined
      }
    },
    useState<T>(initial: T | (() => T)) {
      const index = stateCursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [
        state[index] as T,
        (value: T | ((current: T) => T)) => {
          state[index] = typeof value === 'function'
            ? (value as (current: T) => T)(state[index] as T)
            : value
        },
      ]
    },
    useRef<T>(initial: T) {
      const index = refCursor++
      refs[index] ??= { current: initial }
      return refs[index] as { current: T }
    },
  }
}

function defineStore(spec: {
  init: () => Record<string, any>
  persist: string
  actions: Record<string, (draft: Record<string, any>, ...args: any[]) => void>
}): StoreHandle {
  return {
    persist: spec.persist,
    create: () => {
      const state = spec.init()
      const actions = Object.fromEntries(Object.entries(spec.actions).map(([name, action]) => [
        name,
        (...args: any[]) => { action(state, ...args) },
      ]))
      return { getSnapshot: () => state, actions }
    },
  }
}

function createSnapshotStore<T>(initial: T) {
  let snapshot = initial
  return {
    getSnapshot: () => snapshot,
    set: (next: T) => { snapshot = next },
    subscribe: () => () => {},
  }
}

function allNodes(value: unknown, seen = new Set<object>()): JsxNode[] {
  if (Array.isArray(value)) return value.flatMap(item => allNodes(item, seen))
  if (value === null || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  const record = value as Record<string, unknown>
  const own = 'type' in record && 'props' in record ? [value as JsxNode] : []
  return [...own, ...Object.values(record).flatMap(item => allNodes(item, seen))]
}

const workspace = (workspaceId: string) => ({
  workspaceId,
  path: `/projects/${workspaceId}`,
  title: workspaceId,
  sessionIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const sessionState = {
  ids: [],
  byId: {},
  current: undefined,
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
}

let registration: BrowserRegistration
let dictionaries: Record<'en' | 'zh', Record<string, string>>

beforeAll(async () => {
  let definition: {
    factory: (require: (name: string) => unknown) => { apply: (ctx: Record<string, any>) => void }
  } | undefined
  ;(globalThis as Record<string, any>).window = {
    __ModuleLoader__: {
      load: (next: typeof definition) => { definition = next },
    },
  }
  const clientUrl = pathToFileURL(
    process.env.DSH_WORKSPACE_BUNDLE ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js', import.meta.url)),
  )
  await import(`${clientUrl.href}?workspace-pinning-test`)
  delete (globalThis as Record<string, any>).window
  if (definition === undefined) throw new Error('workspace client bundle did not register')

  const module = definition.factory((name) => {
    if (name === '@deepseek-ai/dsh-client-store') return { defineStore, createSnapshotStore }
    if (name === '@deepseek-ai/cordis') return { Service: class { constructor(readonly ctx: unknown) {} } }
    if (name === 'react/jsx-runtime') return { Fragment, jsx, jsxs: jsx }
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected workspace bundle dependency: ${name}`)
  })
  const registrations = new Map<string, BrowserRegistration>()
  const list = createSnapshotStore({ ...sessionState, phase: 'loading' })
  const workspaces = { list: createSnapshotStore({ items: [], pinnedSessionIds: [], archivedSessionIds: [], phase: 'loading' }) }
  module.apply({
    effect: (effect: () => unknown, label?: string) => label?.includes('navigation policy') ? undefined : effect(),
    get: (name: string) => name === 'sessions' ? { list } : workspaces,
    sessions: { list },
    remote: { directoryPicker: {}, $host: { home: '/home/test' } },
    on: () => () => {},
    shortcuts: { register: () => () => {}, catalog: createSnapshotStore([]) },
    layout: { panelInfo: createSnapshotStore({ activePanelId: null }) },
    locale: {
      bind: () => (key: string) => key,
      register: (_namespace: string, next: typeof dictionaries) => {
        dictionaries = next
        return () => {}
      },
    },
    slots: {
      entries: () => [],
      subscribe: () => () => {},
      provideRoot: () => {},
      inject: (_name: string, effect: () => unknown) => effect(),
      register: (
        spec: { name: string; store?: StoreHandle },
        component: BrowserRegistration['component'],
      ) => {
        if (spec.store !== undefined) registrations.set(spec.name, { component, store: spec.store })
        return () => {}
      },
    },
  })
  const browser = registrations.get('sidebar.workspaces')
  if (browser === undefined) throw new Error('workspace browser did not register')
  registration = browser
})

function translate(locale: 'en' | 'zh') {
  return (key: string, values?: Record<string, unknown>): string => {
    let value = dictionaries[locale][key] ?? key
    for (const [name, replacement] of Object.entries(values ?? {})) {
      value = value.replace(`{${name}}`, String(replacement))
    }
    return value
  }
}

function browserProps(
  items: Array<ReturnType<typeof workspace>>,
  pinnedWorkspaceIds: string[],
  overrides: Record<string, any> = {},
) {
  const state = {
    groupBy: 'workspace',
    orderBy: 'manual',
    groupExpansion: {},
    pinnedWorkspaceIds,
    sessionOrderByAccount: {},
    sessionUpdatedAtByAccount: {},
  }
  return {
    wide: true,
    expandSidebar: vi.fn(),
    useSessions: (selector: (snapshot: typeof sessionState) => unknown) => selector(sessionState),
    useWorkspaces: (selector: (snapshot: Record<string, unknown>) => unknown) => selector({
      items,
      archivedSessionIds: [],
      pinnedSessionIds: [],
      phase: 'ready',
      state: 'ready',
    }),
    useSessionStatus: (selector: (snapshot: Record<string, unknown>) => unknown) => selector({}),
    usePanelInfo: (selector: (snapshot: Record<string, unknown>) => unknown) => selector({ activePanelId: null }),
    useHostInfo: (selector: (snapshot: Record<string, unknown>) => unknown) => selector({ home: '/home/test' }),
    useShortcuts: (selector: (snapshot: unknown[]) => unknown) => selector([]),
    useWorkspaceShortcuts: (selector: (snapshot: Record<string, unknown>) => unknown) => selector({ addRequested: false, searchRequest: 0, directoryBusy: false, forkError: null }),
    useStore: (selector: (snapshot: typeof state) => unknown) => selector(state),
    actions: {
      retainAccountKeys: vi.fn(),
      setGroupExpanded: vi.fn(),
      syncSessionOrderAccount: vi.fn(),
      setSessionOrder: vi.fn(),
      toggleWorkspacePin: vi.fn(),
    },
    startSession: vi.fn(),
    open: vi.fn(),
    renameSession: vi.fn(),
    forkSession: vi.fn(),
    renameWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    insertWorkspaceBefore: vi.fn(async () => {}),
    archiveSession: vi.fn(),
    insertSessionBefore: vi.fn(),
    createWorkspace: vi.fn(),
    searchSessions: vi.fn(),
    searchResultLimit: 20,
    requestSearch: vi.fn(),
    requestAddWorkspace: vi.fn(),
    closeAddWorkspace: vi.fn(),
    setDirectoryBusy: vi.fn(),
    dismissForkError: vi.fn(),
    useDirectoryFlow: (selector: (occupied: boolean) => unknown) => selector(true),
    renderSlot: vi.fn(),
    t: translate('en'),
    ...overrides,
  }
}

function sessionTreeElement(props: Record<string, any>): JsxNode {
  const browser = hookRuntime().render(registration.component, props)
  const sessionTree = allNodes(browser).find(node => (
    typeof node.type === 'function' && node.type.name === 'SessionTree'
  ))
  if (sessionTree === undefined) throw new Error('grouped SessionTree was not rendered')
  return sessionTree
}

function projectRows(tree: JsxNode): JsxNode[] {
  return allNodes(tree).filter(node => (
    typeof node.type === 'function'
    && node.type.name === 'ProjectRowItem'
    && node.props.group.workspaceId !== undefined
  ))
}

function projectMenu(project: JsxNode, locale: 'en' | 'zh' = 'en'): JsxNode {
  const row = hookRuntime().render(project.type as (props: Record<string, any>) => JsxNode, {
    ...project.props,
    t: translate(locale),
  })
  const menu = allNodes(row).find(node => node.type === primitiveType('Menu'))
  if (menu === undefined) throw new Error('workspace row menu was not rendered')
  return menu
}

function groupSection(tree: JsxNode, workspaceId: string): JsxNode {
  const section = allNodes(tree).find(node => (
    typeof node.props.onDrop === 'function'
    && projectRows(node).some(project => project.props.group.workspaceId === workspaceId)
  ))
  if (section === undefined) throw new Error(`workspace group ${workspaceId} was not rendered`)
  return section
}

function drop(section: JsxNode, half: 'before' | 'after'): void {
  section.props.onDrop({
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clientY: half === 'before' ? 10 : 30,
    currentTarget: {
      getBoundingClientRect: () => ({ top: 0, height: 40 }),
    },
  })
}

describe('workspace pinning bundle patch', () => {
  it('persists pin toggles and prunes deleted Workspace ids', () => {
    const store = registration.store.create()
    expect(registration.store.persist).toBe('dsh.workspace.view.v5')
    expect(store.getSnapshot().pinnedWorkspaceIds).toEqual([])

    store.actions.toggleWorkspacePin!('alpha')
    store.actions.toggleWorkspacePin!('deleted')
    expect(store.getSnapshot().pinnedWorkspaceIds).toEqual(['alpha', 'deleted'])

    store.actions.retainAccountKeys!(['', '__flat_session_order__', 'alpha'])
    expect(store.getSnapshot().pinnedWorkspaceIds).toEqual(['alpha'])
    store.actions.toggleWorkspacePin!('alpha')
    expect(store.getSnapshot().pinnedWorkspaceIds).toEqual([])

    delete store.getSnapshot().pinnedWorkspaceIds
    store.actions.toggleWorkspacePin!('alpha')
    expect(store.getSnapshot().pinnedWorkspaceIds).toEqual(['alpha'])
    store.actions.retainAccountKeys!([])
    expect(store.getSnapshot().pinnedWorkspaceIds).toEqual([])
  })

  it('renders pinned Workspaces first and exposes localized Pin and Unpin commands above Rename', () => {
    const items = ['ordinary-a', 'pinned-a', 'ordinary-b', 'pinned-b'].map(workspace)
    const props = browserProps(items, ['pinned-a', 'pinned-b'])
    const treeElement = sessionTreeElement(props)
    const tree = hookRuntime().render(
      treeElement.type as (props: Record<string, any>) => JsxNode,
      treeElement.props,
    )
    const projects = projectRows(tree)
    expect(projects.map(project => project.props.group.workspaceId)).toEqual([
      'pinned-a', 'pinned-b', 'ordinary-a', 'ordinary-b',
    ])

    const pinnedMenu = projectMenu(projects[0]!)
    expect(pinnedMenu.props.items.map((item: { label: string }) => item.label)).toEqual([
      'Unpin workspace', 'Rename', 'Delete workspace',
    ])
    pinnedMenu.props.onSelect('pin')
    expect(props.actions.toggleWorkspacePin).toHaveBeenCalledWith('pinned-a')

    const ordinaryMenu = projectMenu(projects[2]!, 'zh')
    expect(ordinaryMenu.props.items.map((item: { label: string }) => item.label)).toEqual([
      '置顶工作区', '重命名', '删除工作区',
    ])
    ordinaryMenu.props.onSelect('pin')
    expect(props.actions.toggleWorkspacePin).toHaveBeenCalledWith('ordinary-a')
    expect(projectMenu(projects[0]!, 'zh').props.items[0].label).toBe('取消置顶工作区')
    expect(projectMenu(projects[2]!, 'en').props.items[0].label).toBe('Pin workspace')
  })

  it('keeps nested Workspaces under their parent and partitions siblings independently', () => {
    const items = [
      workspace('parent'),
      { ...workspace('child-ordinary'), path: '/projects/parent/ordinary' },
      { ...workspace('child-pinned'), path: '/projects/parent/pinned' },
      workspace('ordinary-root'),
      workspace('pinned-root'),
    ]
    const props = browserProps(items, ['child-pinned', 'pinned-root'])
    const originalUseStore = props.useStore
    props.useStore = selector => originalUseStore(state => selector({
      ...state,
      groupBy: 'workspace-tree',
      groupExpansion: { parent: true },
    }))
    const treeElement = sessionTreeElement(props)
    const tree = hookRuntime().render(
      treeElement.type as (props: Record<string, any>) => JsxNode,
      treeElement.props,
    )
    expect(projectRows(tree).map(project => project.props.group.workspaceId)).toEqual([
      'pinned-root', 'parent', 'child-pinned', 'child-ordinary', 'ordinary-root',
    ])
  })

  it('reorders inside a pin partition and rejects cross-partition drops', () => {
    const items = ['ordinary-a', 'pinned-a', 'ordinary-b', 'pinned-b'].map(workspace)
    const insertWorkspaceBefore = vi.fn(async () => {})
    const treeElement = sessionTreeElement(browserProps(
      items,
      ['pinned-a', 'pinned-b'],
      { insertWorkspaceBefore },
    ))

    const pinnedRuntime = hookRuntime()
    let tree = pinnedRuntime.render(
      treeElement.type as (props: Record<string, any>) => JsxNode,
      treeElement.props,
    )
    projectRows(tree).find(project => project.props.group.workspaceId === 'pinned-a')?.props.drag.start()
    tree = pinnedRuntime.render(
      treeElement.type as (props: Record<string, any>) => JsxNode,
      treeElement.props,
    )
    drop(groupSection(tree, 'pinned-b'), 'after')
    expect(insertWorkspaceBefore).toHaveBeenCalledWith('pinned-a', undefined)

    insertWorkspaceBefore.mockClear()
    const crossRuntime = hookRuntime()
    tree = crossRuntime.render(
      treeElement.type as (props: Record<string, any>) => JsxNode,
      treeElement.props,
    )
    projectRows(tree).find(project => project.props.group.workspaceId === 'pinned-b')?.props.drag.start()
    tree = crossRuntime.render(
      treeElement.type as (props: Record<string, any>) => JsxNode,
      treeElement.props,
    )
    drop(groupSection(tree, 'ordinary-a'), 'before')
    expect(insertWorkspaceBefore).not.toHaveBeenCalled()

    const ordinaryRuntime = hookRuntime()
    tree = ordinaryRuntime.render(
      treeElement.type as (props: Record<string, any>) => JsxNode,
      treeElement.props,
    )
    projectRows(tree).find(project => project.props.group.workspaceId === 'ordinary-a')?.props.drag.start()
    tree = ordinaryRuntime.render(
      treeElement.type as (props: Record<string, any>) => JsxNode,
      treeElement.props,
    )
    drop(groupSection(tree, 'ordinary-b'), 'after')
    expect(insertWorkspaceBefore).toHaveBeenCalledWith('ordinary-a', undefined)

    insertWorkspaceBefore.mockClear()
    const noOpRuntime = hookRuntime()
    tree = noOpRuntime.render(
      treeElement.type as (props: Record<string, any>) => JsxNode,
      treeElement.props,
    )
    projectRows(tree).find(project => project.props.group.workspaceId === 'pinned-a')?.props.drag.start()
    tree = noOpRuntime.render(
      treeElement.type as (props: Record<string, any>) => JsxNode,
      treeElement.props,
    )
    drop(groupSection(tree, 'pinned-b'), 'before')
    expect(insertWorkspaceBefore).not.toHaveBeenCalled()
  })
})
