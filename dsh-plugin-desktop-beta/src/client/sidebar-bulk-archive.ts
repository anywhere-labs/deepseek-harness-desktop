/** Additive sidebar interaction; the official workspace service owns every archive. */
import type {} from '@deepseek-ai/dsh-client-locale/client'

export interface ArchiveTarget {
  readonly id: string
  readonly title: string
}

export interface SidebarArchiveCatalog {
  readonly sessions: readonly (ArchiveTarget & { readonly blank: boolean; readonly origin?: string })[]
  readonly workspaces: readonly { readonly workspaceId: string; readonly sessionIds: readonly string[] }[]
  readonly archivedSessionIds: readonly string[]
}

/** Resolve row identities from Host membership, never from potentially duplicate titles. */
export function sidebarArchiveTargets(catalog: SidebarArchiveCatalog): Map<string, readonly ArchiveTarget[]> {
  const archived = new Set(catalog.archivedSessionIds)
  const sessions = new Map(catalog.sessions
    .filter(session => !session.blank && session.origin !== 'subagent' && !archived.has(session.id))
    .map(session => [session.id, session] as const))
  const targets = new Map<string, readonly ArchiveTarget[]>()
  for (const session of sessions.values()) targets.set(`session:${session.id}`, [session])
  const accounted = new Set<string>()
  for (const workspace of catalog.workspaces) {
    workspace.sessionIds.forEach(id => accounted.add(id))
    targets.set(`workspace:${workspace.workspaceId}`, workspace.sessionIds.flatMap(id => {
      const session = sessions.get(id)
      return session === undefined ? [] : [session]
    }))
  }
  targets.set('workspace:', [...sessions.values()].filter(session => !accounted.has(session.id)))
  return targets
}

export const bulkArchiveZh = {
  selected: '已选择 {n} 条会话',
  archive: '批量归档 {n} 条会话',
  clear: '取消选择',
  pending: '正在归档 {n} 条会话…',
  done: '已归档 {n} 条会话',
  failed: '已归档 {n} 条，{failed} 条未归档。失败会话仍保持选中，可重试。',
  close: '关闭',
  workspace: '工作区归档',
  pin: '置顶会话',
  rename: '重命名',
  fork: '分叉会话',
}
export const bulkArchiveEn: typeof bulkArchiveZh = {
  selected: '{n} sessions selected',
  archive: 'Archive {n} selected sessions',
  clear: 'Clear selection',
  pending: 'Archiving {n} sessions…',
  done: 'Archived {n} sessions',
  failed: 'Archived {n}; {failed} failed. Failed sessions remain selected for retry.',
  close: 'Dismiss',
  workspace: 'Archive workspace sessions',
  pin: 'Pin session',
  rename: 'Rename',
  fork: 'Fork session',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-desktop-bulk-archive': keyof typeof bulkArchiveZh
  }
}

export interface SidebarBulkArchiveOptions {
  targets(): Map<string, readonly ArchiveTarget[]>
  archive(id: string): Promise<void>
  subscribe(refresh: () => void): () => void
  t(key: keyof typeof bulkArchiveZh, params?: Record<string, number>): string
}

const ROW = '[data-slot="sidebar.workspaces"] [data-row-key^="session:"]'
const MARK = 'data-dsh-bulk-selected'
const CSS = `
[${MARK}="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 18%, transparent) !important;
  box-shadow: inset 3px 0 var(--dsw-alias-brand-primary, #4d6bfe); }
.dshBulkArchive { position: fixed; z-index: 10000; box-sizing: border-box;
  color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l1, #ddd); border-radius: 10px;
  box-shadow: 0 6px 24px #0002; padding: 6px; font: 13px/1.5 system-ui; }
.dshBulkArchive button { border: 0; border-radius: 6px; background: transparent; color: inherit;
  font: inherit; padding: 8px 12px; cursor: pointer; text-align: left; }
.dshBulkArchive button:hover, .dshBulkArchive button:focus-visible { background: #80808020; }
.dshBulkArchive button:disabled { opacity: .5; cursor: not-allowed; }
.dshBulkArchiveStatus { left: 16px; bottom: 16px; max-width: min(520px, calc(100vw - 32px)); }
.dshBulkArchiveStatus span { padding: 0 8px; }
.dshBulkArchiveStatus ul { max-height: 160px; overflow: auto; overflow-wrap: anywhere; margin: 4px 8px; padding-left: 18px; }
`

/** The two pinned UI packages expose one Desktop-only workspace-menu action. */
export interface DesktopWorkspaceArchiveWindow {
  __DSH_DESKTOP_ARCHIVE_WORKSPACE__?: { label(): string; archive(workspaceId: string): void }
}

/** Shift selects a visible range; Command/Ctrl toggles individual Sessions. */
export function installSidebarBulkArchive(options: SidebarBulkArchiveOptions, doc: Document = document): () => void {
  const selected = new Map<string, ArchiveTarget>()
  let anchorId: string | undefined
  const style = doc.createElement('style')
  style.textContent = CSS
  doc.head.appendChild(style)
  const status = doc.createElement('div')
  status.className = 'dshBulkArchive dshBulkArchiveStatus'
  status.hidden = true
  const message = doc.createElement('span')
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  const dismiss = doc.createElement('button')
  dismiss.type = 'button'
  const errors = doc.createElement('ul')
  status.append(message, dismiss, errors)
  doc.body.appendChild(status)
  let menu: HTMLDivElement | undefined
  let busy = false
  let disposed = false
  let result: string | undefined

  const closeMenu = (): void => { menu?.remove(); menu = undefined }
  const rows = (): HTMLElement[] => [...doc.querySelectorAll<HTMLElement>(ROW)]
  const render = (): void => {
    const targets = options.targets()
    for (const row of rows()) {
      const members = targets.get(row.dataset.rowKey ?? '') ?? []
      const checked = members.length > 0 && members.every(member => selected.has(member.id))
      if (checked) row.setAttribute(MARK, 'true')
      else row.removeAttribute(MARK)
    }
    status.hidden = !busy && selected.size === 0 && result === undefined
    message.textContent = busy ? options.t('pending', { n: selected.size })
      : result ?? options.t('selected', { n: selected.size })
    dismiss.textContent = options.t(selected.size > 0 ? 'clear' : 'close')
    dismiss.disabled = busy
  }
  const clear = (): void => {
    if (busy) return
    selected.clear()
    anchorId = undefined
    result = undefined
    errors.replaceChildren()
    closeMenu()
    render()
  }
  dismiss.addEventListener('click', clear)
  const rowAt = (event: Event): HTMLElement | undefined => {
    if (!(event.target instanceof Element)) return undefined
    return event.target.closest<HTMLElement>(ROW) ?? undefined
  }
  const membersAt = (row: HTMLElement): readonly ArchiveTarget[] => options.targets().get(row.dataset.rowKey ?? '') ?? []
  const isAction = (event: Event): boolean => event.target instanceof Element
    && event.target.closest('button, input, textarea, select, a, [contenteditable="true"]') !== null
  const stop = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation() }
  const pointerDown = (event: PointerEvent): void => {
    if (menu?.contains(event.target as Node) || status.contains(event.target as Node)) return
    closeMenu()
    if (event.button === 0 && (event.shiftKey || event.metaKey || event.ctrlKey) && rowAt(event) !== undefined && !isAction(event)) {
      event.preventDefault() // Prevent native text selection while selecting rows.
    }
  }
  const click = (event: MouseEvent): void => {
    if (menu?.contains(event.target as Node) || status.contains(event.target as Node)) return
    const row = rowAt(event)
    if (row === undefined || isAction(event)) {
      clear()
      return
    }
    const member = membersAt(row)[0]
    if (!event.shiftKey && !event.metaKey && !event.ctrlKey) {
      if (!busy) { clear(); anchorId = member?.id }
      return
    }
    stop(event)
    if (busy) return
    if (member === undefined) return
    if (event.shiftKey) {
      // DOM order matches the visible sidebar order, including workspace boundaries.
      const visible = rows().flatMap(item => membersAt(item))
      const anchor = visible.findIndex(item => item.id === anchorId)
      const end = visible.findIndex(item => item.id === member.id)
      const start = anchor < 0 ? end : anchor
      selected.clear()
      for (const item of visible.slice(Math.min(start, end), Math.max(start, end) + 1)) selected.set(item.id, item)
      if (anchor < 0) anchorId = member.id
    } else {
      if (selected.has(member.id)) selected.delete(member.id)
      else selected.set(member.id, member)
      anchorId = member.id
    }
    result = undefined
    errors.replaceChildren()
    render()
  }
  const archive = async (batch: readonly ArchiveTarget[]): Promise<void> => {
    if (busy || disposed) return
    busy = true
    result = undefined
    errors.replaceChildren()
    closeMenu()
    render()
    let succeeded = 0
    const failed: ArchiveTarget[] = []
    for (const member of batch) {
      if (disposed) break
      try {
        // No stopActivity option: an active Session's existing Host refusal is preserved.
        await options.archive(member.id)
        succeeded++
      } catch (cause) {
        failed.push(member)
        if (!disposed) {
          const item = doc.createElement('li')
          item.textContent = `${member.title}: ${cause instanceof Error ? cause.message : String(cause)}`
          errors.appendChild(item)
        }
      }
    }
    if (disposed) return
    selected.clear()
    failed.forEach(member => selected.set(member.id, member))
    busy = false
    result = failed.length > 0
      ? options.t('failed', { n: succeeded, failed: failed.length })
      : options.t('done', { n: succeeded })
    render()
  }
  const contextMenu = (event: MouseEvent): void => {
    const row = rowAt(event)
    if (row === undefined || isAction(event) || selected.size === 0) return
    const members = membersAt(row)
    if (!members.some(member => selected.has(member.id))) { clear(); return }
    if (selected.size === 1) return // The patched official row opens its unchanged single-session menu.
    stop(event)
    if (busy) return
    closeMenu()
    // Freeze the exact selected ids when opening the menu, including collapsed workspace members.
    const batch = [...selected.values()]
    menu = doc.createElement('div')
    menu.className = 'dshBulkArchive'
    menu.setAttribute('role', 'menu')
    for (const key of ['pin', 'rename', 'fork'] as const) {
      const disabled = doc.createElement('button')
      disabled.type = 'button'
      disabled.setAttribute('role', 'menuitem')
      disabled.disabled = true
      disabled.style.display = 'block'
      disabled.style.width = '100%'
      disabled.textContent = options.t(key)
      menu.appendChild(disabled)
    }
    const button = doc.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.textContent = options.t('archive', { n: batch.length })
    button.addEventListener('click', () => { void archive(batch) })
    menu.appendChild(button)
    doc.body.appendChild(menu)
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(0, Math.min(event.clientX, (doc.defaultView?.innerWidth ?? 1024) - rect.width))}px`
    menu.style.top = `${Math.max(0, Math.min(event.clientY, (doc.defaultView?.innerHeight ?? 768) - rect.height))}px`
    button.focus()
  }
  const keyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && (menu !== undefined || selected.size > 0) && !busy && !isAction(event)) clear()
    else if (event.key === 'Escape' && menu !== undefined) { stop(event); closeMenu() }
    else if (event.key === 'Tab') closeMenu()
  }
  const doubleClick = (event: MouseEvent): void => {
    if ((event.shiftKey || event.metaKey || event.ctrlKey) && rowAt(event) !== undefined && !isAction(event)) stop(event)
  }
  const dragStart = (event: Event): void => {
    if (selected.size > 0 && rowAt(event) !== undefined) stop(event)
  }
  const refresh = (): void => {
    if (disposed) return
    if (!busy) {
      const valid = new Set([...options.targets().values()].flatMap(members => members.map(member => member.id)))
      for (const id of selected.keys()) if (!valid.has(id)) selected.delete(id)
      closeMenu()
    }
    render()
  }
  const page = doc.defaultView as (Window & DesktopWorkspaceArchiveWindow) | null
  const previousWorkspaceArchive = page?.__DSH_DESKTOP_ARCHIVE_WORKSPACE__
  const workspaceArchive = {
    label: (): string => options.t('workspace'),
    archive: (workspaceId: string): void => {
      if (busy || disposed) return
      const batch = options.targets().get(`workspace:${workspaceId}`)
      if (batch === undefined) return
      selected.clear()
      batch.forEach(member => selected.set(member.id, member))
      void archive([...selected.values()])
    },
  }
  if (page !== null) page.__DSH_DESKTOP_ARCHIVE_WORKSPACE__ = workspaceArchive
  const unsubscribe = options.subscribe(refresh)
  // Only row mount/removal needs observation; our own menu and status DOM must not retrigger it.
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target instanceof Element
      && record.target.closest('[data-slot="sidebar"]') !== null)) render()
  })
  observer.observe(doc.body, { childList: true, subtree: true })
  doc.addEventListener('pointerdown', pointerDown, true)
  doc.addEventListener('click', click, true)
  doc.addEventListener('contextmenu', contextMenu, true)
  doc.addEventListener('keydown', keyDown, true)
  doc.addEventListener('dblclick', doubleClick, true)
  doc.addEventListener('dragstart', dragStart, true)
  return () => {
    disposed = true
    if (page?.__DSH_DESKTOP_ARCHIVE_WORKSPACE__ === workspaceArchive) {
      if (previousWorkspaceArchive === undefined) delete page.__DSH_DESKTOP_ARCHIVE_WORKSPACE__
      else page.__DSH_DESKTOP_ARCHIVE_WORKSPACE__ = previousWorkspaceArchive
    }
    unsubscribe()
    observer.disconnect()
    doc.removeEventListener('pointerdown', pointerDown, true)
    doc.removeEventListener('click', click, true)
    doc.removeEventListener('contextmenu', contextMenu, true)
    doc.removeEventListener('keydown', keyDown, true)
    doc.removeEventListener('dblclick', doubleClick, true)
    doc.removeEventListener('dragstart', dragStart, true)
    closeMenu()
    status.remove()
    style.remove()
    for (const row of rows()) row.removeAttribute(MARK)
  }
}
