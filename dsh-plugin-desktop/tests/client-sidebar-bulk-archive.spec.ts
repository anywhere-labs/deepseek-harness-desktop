// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bulkArchiveZh, installSidebarBulkArchive, sidebarArchiveTargets,
  type DesktopWorkspaceArchiveWindow, type SidebarArchiveCatalog,
} from '../src/client/sidebar-bulk-archive.ts'

const page = window as Window & DesktopWorkspaceArchiveWindow
let dispose = (): void => {}
afterEach(() => {
  dispose(); dispose = () => {}
  delete page.__DSH_DESKTOP_ARCHIVE_WORKSPACE__
  document.body.replaceChildren(); vi.restoreAllMocks()
})

function fixture() {
  const catalog: SidebarArchiveCatalog = {
    sessions: ['a', 'b', 'c', 'hidden', 'archived', 'blank', 'agent'].map(id => ({
      id, title: 'Same title', blank: id === 'blank', ...(id === 'agent' ? { origin: 'subagent' } : {}),
    })),
    workspaces: [{ workspaceId: 'one', sessionIds: ['a', 'b', 'hidden', 'archived', 'blank', 'agent'] },
      { workspaceId: 'two', sessionIds: ['c'] }],
    archivedSessionIds: ['archived'],
  }
  document.body.innerHTML = `<div data-slot="sidebar"><div data-slot="sidebar.workspaces">
    <div data-row-key="workspace:one" role="treeitem">Workspace one</div>
    <div data-row-key="session:a" role="treeitem"><span>Same title</span><button>Rename</button></div>
    <div data-row-key="session:b" role="treeitem">Same title</div>
    <div data-row-key="workspace:two" role="treeitem">Workspace two</div>
    <div data-row-key="session:c" role="treeitem">Same title</div>
  </div></div><input />`
  const archive = vi.fn(async (_id: string): Promise<void> => {})
  let refresh = (): void => {}
  const unsubscribe = vi.fn()
  let targets = sidebarArchiveTargets(catalog)
  dispose = installSidebarBulkArchive({
    archive, targets: () => targets,
    subscribe: listener => { refresh = listener; return unsubscribe },
    t: (key, params) => bulkArchiveZh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name])),
  })
  const row = (id: string): HTMLElement => document.querySelector(`[data-row-key="session:${id}"]`)!
  const choose = (id: string): void => { row(id).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })) }
  const range = (id: string): void => { row(id).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })) }
  const menu = (id: string): void => { row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) }
  const run = (): void => { (document.querySelector('[role="menuitem"]:not(:disabled)') as HTMLButtonElement).click() }
  const marked = (): string[] => [...document.querySelectorAll('[data-dsh-bulk-selected]')].map(el => el.getAttribute('data-row-key')!)
  return { archive, choose, range, menu, run, marked, row, catalog, refresh, unsubscribe,
    replaceTargets: (next: typeof targets) => { targets = next; refresh() } }
}

describe('sidebar bulk archive', () => {
  it('Shift selects the full range across workspaces and keeps the anchor when extending or shrinking', () => {
    const f = fixture()
    f.row('a').click(); f.range('c')
    expect(f.marked()).toEqual(['session:a', 'session:b', 'session:c'])
    f.range('b')
    expect(f.marked()).toEqual(['session:a', 'session:b'])
    f.row('c').click(); f.range('a')
    expect(f.marked()).toEqual(['session:a', 'session:b', 'session:c'])
    expect(f.archive).not.toHaveBeenCalled()
  })

  it('Command toggles individual sessions and Shift starts at the last Command selection', () => {
    const f = fixture()
    const command = (id: string) => f.row(id).dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    command('a'); command('c')
    expect(f.marked()).toEqual(['session:a', 'session:c'])
    command('c')
    expect(f.marked()).toEqual(['session:a'])
    f.range('b')
    expect(f.marked()).toEqual(['session:b', 'session:c'])
  })

  it('Shift without a visible anchor selects only the clicked row', () => {
    const f = fixture()
    f.range('c')
    expect(f.marked()).toEqual(['session:c'])
    f.row('c').remove(); f.range('a')
    expect(f.marked()).toEqual(['session:a'])
  })

  it('selects across workspaces by id, toggles off, and leaves normal clicks alone', () => {
    const f = fixture()
    const open = vi.fn()
    f.row('a').addEventListener('click', open)
    f.choose('a'); f.choose('c')
    expect(f.marked()).toEqual(['session:a', 'session:c'])
    expect(open).not.toHaveBeenCalled()
    f.choose('c')
    expect(f.marked()).toEqual(['session:a'])
    f.row('a').click()
    expect(open).toHaveBeenCalledOnce()
    expect(f.marked()).toEqual([])
    expect(f.archive).not.toHaveBeenCalled()
  })

  it('does not intercept row buttons or workspace header clicks', () => {
    const f = fixture()
    const button = f.row('a').querySelector('button')!
    const rename = vi.fn()
    button.addEventListener('click', rename)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    document.querySelector('[data-row-key="workspace:one"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    expect(rename).toHaveBeenCalledOnce()
    expect(f.marked()).toEqual([])
    expect(f.archive).not.toHaveBeenCalled()
  })

  it('archives exactly the selected set once from the context menu', async () => {
    const f = fixture()
    f.choose('a'); f.choose('c'); f.menu('a')
    expect(document.querySelector('[role="menuitem"]:not(:disabled)')?.textContent).toBe('批量归档 2 条会话')
    expect(document.querySelectorAll('[role="menuitem"]:disabled')).toHaveLength(3)
    for (const button of document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:disabled')) button.click()
    expect(f.archive).not.toHaveBeenCalled()
    f.run()
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe('已归档 2 条会话'))
    expect(f.archive.mock.calls).toEqual([['a'], ['c']])
    expect(f.marked()).toEqual([])
  })

  it('keeps failures selected and continues with the remaining sessions', async () => {
    const f = fixture()
    f.archive.mockImplementation(async id => { if (id === 'a') throw new Error('Session is running') })
    f.choose('a'); f.choose('b'); f.menu('a'); f.run()
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain('1 条未归档'))
    expect(f.archive.mock.calls).toEqual([['a'], ['b']])
    expect(f.marked()).toEqual(['session:a'])
    expect(document.querySelector('.dshBulkArchiveStatus li')?.textContent).toContain('Session is running')
  })

  it('archives full workspace membership including hidden rows, excluding blanks, archived rows and agents', async () => {
    const f = fixture()
    f.choose('c')
    page.__DSH_DESKTOP_ARCHIVE_WORKSPACE__!.archive('one')
    await vi.waitFor(() => expect(f.archive).toHaveBeenCalledTimes(3))
    expect(f.archive.mock.calls).toEqual([['a'], ['b'], ['hidden']])
    expect(page.__DSH_DESKTOP_ARCHIVE_WORKSPACE__!.label()).toBe('工作区归档')
  })

  it('does nothing for unknown workspaces', () => {
    const f = fixture()
    page.__DSH_DESKTOP_ARCHIVE_WORKSPACE__!.archive('missing')
    expect(f.archive).not.toHaveBeenCalled()
  })

  it('does not batch-archive when right-clicking an unselected row or without selection', () => {
    const f = fixture()
    f.menu('a')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    f.choose('a'); f.choose('c'); f.menu('b')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(f.marked()).toEqual([])
  })

  it('lets the original row handle a single selection and right-clicks outside the selected set', () => {
    const f = fixture()
    const original = vi.fn()
    f.row('a').addEventListener('contextmenu', original)
    f.choose('a'); f.menu('a')
    expect(original).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    f.choose('c'); f.menu('a')
    expect(original).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    f.menu('b')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(f.marked()).toEqual([])
  })

  it('drops removed sessions and withdraws an open menu on catalog changes', () => {
    const f = fixture()
    f.choose('a'); f.choose('b'); f.menu('a')
    f.replaceTargets(new Map())
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(f.marked()).toEqual([])
    expect(f.archive).not.toHaveBeenCalled()
  })

  it('prevents duplicate submissions and stops queuing archives when disposed', async () => {
    const f = fixture()
    let resolve!: () => void
    f.archive.mockImplementation(async () => await new Promise<void>(done => { resolve = done }))
    f.choose('a'); f.choose('b'); f.menu('a'); f.run()
    page.__DSH_DESKTOP_ARCHIVE_WORKSPACE__!.archive('two')
    expect(f.archive).toHaveBeenCalledTimes(1)
    dispose(); resolve()
    await Promise.resolve(); await Promise.resolve()
    expect(f.archive).toHaveBeenCalledTimes(1)
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(page.__DSH_DESKTOP_ARCHIVE_WORKSPACE__).toBeUndefined()
    dispose = () => {}
  })

  it('clears with Escape and preserves highlights when React replaces rows', async () => {
    const f = fixture()
    f.choose('a')
    const replacement = f.row('a').cloneNode(true) as HTMLElement
    replacement.removeAttribute('data-dsh-bulk-selected')
    f.row('a').replaceWith(replacement)
    await Promise.resolve()
    expect(f.marked()).toEqual(['session:a'])
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
    expect(f.marked()).toEqual([])
  })
})

// Exercise the actual installed, version-patched workspace row. Stubbing its
// rendering primitives lets the test call all three real menu dispatch paths.
describe('published workspace menu adapter', () => {
  it('opens the original session menu on right-click only in Desktop without opening the session', () => {
    const source = readFileSync('node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js', 'utf8')
    const start = source.indexOf('function SessionNodeItem(')
    const end = source.indexOf('\n\t\t//#endregion', start)
    const jsx = (type: string, props: Record<string, unknown>) => ({ type, props })
    const setMenuOpen = vi.fn()
    const render = new Script(`(${source.slice(start, end)})`).runInNewContext({
      window: page,
      react: { useState: () => [false, setMenuOpen], useRef: () => ({ current: null }),
        useMemo: (fn: () => unknown) => fn(), useEffect: () => {} },
      react_jsx_runtime: { jsx, jsxs: jsx }, clsx: () => '', Rows_module_css_default: {},
      _deepseek_ai_dsh_client_ui_primitives: new Proxy({}, { get: (_, name) => String(name) }),
      displayTitle: () => 'Session A', sessionStatuses: () => [{ state: 'idle' }],
      useTitleMarquee: () => ({ enter: () => {}, leave: () => {} }), timeLabel: () => '',
      SessionHoverContent: 'SessionHoverContent', SessionStatusDots: 'SessionStatusDots',
      PinnedIndicator: 'PinnedIndicator', ActiveScheduleIndicator: 'ActiveScheduleIndicator',
    }) as (props: object) => { props: { anchor: { props: { onContextMenu(event: object): void } } } }
    const onOpen = vi.fn()
    const row = render({ node: { id: 'a', title: 'Session A', blank: false }, onOpen,
      renderSlot: () => null, t: (key: string) => key }).props.anchor.props
    const event = { preventDefault: vi.fn() }
    row.onContextMenu(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(setMenuOpen).not.toHaveBeenCalled()
    page.__DSH_DESKTOP_ARCHIVE_WORKSPACE__ = { label: () => '工作区归档', archive: vi.fn() }
    row.onContextMenu(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(setMenuOpen).toHaveBeenCalledExactlyOnceWith(true)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('preserves rename/delete, exposes archive only in Desktop, and passes the workspace id', () => {
    const source = readFileSync('node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js', 'utf8')
    const start = source.indexOf('function ProjectRowItem(')
    const end = source.indexOf('\n\t\tfunction ', start + 1)
    const jsx = (type: string, props: Record<string, unknown>) => ({ type, props })
    const render = new Script(`(${source.slice(start, end)})`).runInNewContext({
      window: page, react: { useState: () => [false, () => {}] },
      react_jsx_runtime: { jsx, jsxs: jsx }, clsx: () => '', Rows_module_css_default: {},
      _deepseek_ai_dsh_client_ui_primitives: new Proxy({}, { get: (_, name) => String(name) }),
    }) as (props: object) => unknown
    const findMenu = (node: unknown): { items: { id: string }[]; onSelect(id: string): void } | undefined => {
      if (node === null || typeof node !== 'object') return undefined
      if (Array.isArray(node)) return node.map(findMenu).find(value => value !== undefined)
      const entry = node as { type: string; props: { children?: unknown } }
      if (entry.type === 'Menu') return entry.props as ReturnType<typeof findMenu>
      return findMenu(entry.props?.children)
    }
    const rename = vi.fn(); const remove = vi.fn(); const archive = vi.fn()
    const props = { group: { key: 'one', workspaceId: 'one', label: 'One', expanded: true },
      actions: { rename, delete: remove }, t: (key: string) => key }
    expect(findMenu(render(props))!.items.map(item => item.id)).toEqual(['rename', 'delete'])
    page.__DSH_DESKTOP_ARCHIVE_WORKSPACE__ = { label: () => '工作区归档', archive }
    const menu = findMenu(render(props))!
    expect(menu.items.map(item => item.id)).toEqual(['rename', 'desktop-archive', 'delete'])
    menu.onSelect('desktop-archive')
    expect(archive).toHaveBeenCalledExactlyOnceWith('one')
    expect(remove).not.toHaveBeenCalled()
    menu.onSelect('rename'); menu.onSelect('delete'); menu.onSelect('unknown')
    expect(rename).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce()
    delete page.__DSH_DESKTOP_ARCHIVE_WORKSPACE__
    expect(source).toContain('"data-row-key": `session:${node.id}`')
  })
})
