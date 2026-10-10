/** Desktop Delete / Deleted sessions surfaces over an authenticated private API. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DESKTOP_SESSION_TRASH_PATH, type DesktopSessionTrashView } from '../session-trash-contract.ts'
import './session-trash.css'

const en = {
  delete: 'Delete session', nav: 'Deleted sessions', restore: 'Restore', cancel: 'Cancel',
  confirm: 'Delete this session?',
  body: 'The session will be removed from ordinary and archived lists and search. Restore it in Settings → Deleted sessions. Its history stays on disk to protect branch sessions.',
  description: 'Deleted sessions can be restored. Their history remains on disk for branches; Delete and Restore do not change Archive status.',
  empty: 'No deleted sessions.', loading: 'Loading…', retry: 'Retry',
  foreign: 'This session is in use elsewhere. Close it there before deleting it.',
  active: 'Stop this session and its running work before deleting it.',
  failed: 'The session change failed. Your stored history is retained.',
  unavailable: 'Deleted-session protection is unavailable. Restart in recovery mode.',
  unsupported: 'This runtime cannot safely delete sessions. Update Desktop.',
} as const
const zh: Record<keyof typeof en, string> = {
  delete: '删除会话', nav: '已删除的会话', restore: '恢复', cancel: '取消', confirm: '删除这个会话？',
  body: '会话将从普通列表、归档列表和搜索中移除。可在设置 → 已删除的会话中恢复。历史记录仍保留在磁盘上，以保护分支会话。',
  description: '可恢复已删除的会话。历史记录仍保留在磁盘上供分支使用，删除和恢复操作不会更改归档状态。',
  unavailable: '已删除会话的保护状态不可用，请重启进入恢复模式。',
  unsupported: '当前运行时不支持安全删除会话，请更新 Desktop。',
  empty: '没有已删除的会话。', loading: '加载中…', retry: '重试',
  foreign: '此会话正在其他位置使用，请先在那里关闭会话。',
  active: '请先停止这个会话及其运行中的任务，再删除。', failed: '会话变更失败，已保存的历史记录仍保留。',
}
const namespace = 'desktop.session-trash'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'desktop.session-trash': keyof typeof en }
}
type Translate = (key: keyof typeof en) => string
class TrashRequestError extends Error { constructor(readonly code?: string) { super('session trash request failed') } }

export async function sessionTrashRequest(action?: 'delete' | 'restore', sessionId = '', title = ''): Promise<DesktopSessionTrashView> {
  const response = await fetch(DESKTOP_SESSION_TRASH_PATH, {
    method: action === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    ...(action === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, sessionId, title }) }),
  })
  const value: unknown = await response.json()
  if (!response.ok) throw new TrashRequestError(typeof value === 'object' && value !== null && 'code' in value ? String(value.code) : undefined)
  if (typeof value !== 'object' || value === null || !('items' in value) || !Array.isArray(value.items)
    || !('supported' in value) || typeof value.supported !== 'boolean'
    || value.items.some(item => typeof item !== 'object' || item === null || typeof item.sessionId !== 'string' || typeof item.title !== 'string' || typeof item.updatedAt !== 'string')) {
    throw new TrashRequestError()
  }
  return value as DesktopSessionTrashView
}

interface TrashSelection { readonly sessionId: SessionId; readonly title: string }
interface TrashSnapshot { readonly supported: boolean; readonly capability: 'loading' | 'ready' | 'unsupported' | 'unavailable'; readonly selection?: TrashSelection; readonly busy: boolean; readonly error?: 'active' | 'foreign' | 'failed' | 'unavailable' }
export class SessionTrashClient {
  private snapshot: TrashSnapshot = { busy: false, supported: false, capability: 'loading' }
  private listeners = new Set<() => void>()
  constructor(private readonly remove: (selection: TrashSelection) => Promise<void>) {}
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  setSupported(supported: boolean): void { this.publish({ ...this.snapshot, supported, capability: supported ? 'ready' : 'unsupported' }) }
  setUnavailable(): void { this.publish({ ...this.snapshot, supported: false, capability: 'unavailable' }) }
  request(selection: TrashSelection): void { if (this.snapshot.supported && !this.snapshot.busy) this.publish({ selection, busy: false, supported: true, capability: 'ready' }) }
  cancel(): void { if (!this.snapshot.busy) this.publish({ busy: false, supported: this.snapshot.supported, capability: this.snapshot.capability }) }
  async confirm(): Promise<void> {
    const selection = this.snapshot.selection
    if (selection === undefined || this.snapshot.busy) return
    this.publish({ selection, busy: true, supported: true, capability: 'ready' })
    try { await this.remove(selection); this.publish({ busy: false, supported: this.snapshot.supported, capability: this.snapshot.capability }) }
    catch (cause) { this.publish({ selection, busy: false, supported: true, capability: 'ready', error: cause instanceof TrashRequestError && cause.code === 'active' ? 'active' : cause instanceof TrashRequestError && cause.code === 'foreign-owner' ? 'foreign' : cause instanceof TrashRequestError && cause.code === 'unavailable' ? 'unavailable' : 'failed' }) }
  }
  private publish(snapshot: TrashSnapshot): void { this.snapshot = snapshot; for (const listener of this.listeners) listener() }
}

export function SessionTrashConfirmation({ control, t }: { control: SessionTrashClient; t: Translate }) {
  const state = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (state.selection === undefined) return
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [state.selection])
  if (state.selection === undefined) return null
  return <dialog ref={dialog} className="dshDesktopTrashDialog" aria-labelledby="dsh-trash-title" aria-describedby="dsh-trash-body"
    onCancel={event => { event.preventDefault(); control.cancel() }}>
    <h2 id="dsh-trash-title">{t('confirm')}</h2>
    <p className="dshDesktopTrashSessionTitle">{state.selection.title || state.selection.sessionId}</p>
    <p id="dsh-trash-body">{t('body')}</p>
    {state.error !== undefined && <p role="alert">{t(state.error)}</p>}
    <div className="dshDesktopTrashActions">
      <button type="button" disabled={state.busy} onClick={() => { control.cancel() }}>{t('cancel')}</button>
      <button type="button" disabled={state.busy} onClick={() => { void control.confirm() }}>{t('delete')}</button>
    </div>
  </dialog>
}

export function DeletedSessions({ t }: { t: Translate }) {
  const [view, setView] = useState<DesktopSessionTrashView>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const load = async (): Promise<void> => {
    setBusy(true); setFailed(false)
    try { setView(await sessionTrashRequest()) } catch { setFailed(true) } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [])
  return <section className="dshDesktopDeletedSessions">
    <h2>{t('nav')}</h2><p>{t('description')}</p>
    {view?.supported === false && <p role="status">{t('unsupported')}</p>}
    {failed && <p role="alert">{t(view === undefined ? 'unavailable' : 'failed')} <button type="button" disabled={busy} onClick={() => { void load() }}>{t('retry')}</button></p>}
    {view === undefined && !failed && <p>{t('loading')}</p>}
    {view?.items.length === 0 && <p>{t('empty')}</p>}
    {view?.items.map(item => <div className="dshDesktopTrashRow" key={item.sessionId}>
      <div><span>{item.title || item.sessionId}</span><small>{item.sessionId}</small></div>
      <button type="button" disabled={busy || view.supported === false} onClick={() => {
        setBusy(true); setFailed(false)
        void sessionTrashRequest('restore', item.sessionId).then(setView, () => { setFailed(true) }).finally(() => { setBusy(false) })
      }}>{t('restore')}</button>
    </div>)}
  </section>
}

type MenuProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> & PropsLocale<'desktop.session-trash'> & InjectFace<{ control: SessionTrashClient }>
function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, control, t }: MenuProps) {
  const [, setOpen] = useMenuOpenState()
  const state = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot)
  const capability = state.supported
  return <button type="button" role="menuitem" className="dshDesktopDeleteMenuItem" disabled={!capability} title={capability ? undefined : t(state.capability === 'loading' ? 'loading' : state.capability === 'unavailable' ? 'unavailable' : 'unsupported')} onClick={() => { control.request({ sessionId, title: displayTitle }); setOpen(false) }}>{t('delete')}</button>
}

/** Add public slot entries; the official Compatibility client retains ownership. */
export function applySessionTrash(ctx: Context): void {
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'desktop: deleted sessions labels')
  const control = new SessionTrashClient(async selection => {
    await sessionTrashRequest('delete', selection.sessionId, selection.title)
    // Existing public navigation creates/reuses a fresh blank in the same
    // Workspace; no private Session-reference disposer is borrowed.
    if ((ctx.sessions.retainInfo(selection.sessionId).getSnapshot().retainedBy.mainView ?? 0) > 0) ctx.uiWorkspace.startSession()
    try { await ctx.sessions.refresh() } catch (cause) { console.error('Deleted session needs a catalog refresh', cause) }
  })
  void sessionTrashRequest().then(view => { control.setSupported(view.supported) }).catch(() => { control.setUnavailable() })
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item', id: 'desktop-delete', order: 500, locale: namespace,
    inject: () => ({ control }),
  }, DeleteSessionMenuItem))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'desktop-delete-confirmation', order: 500, inject: () => ({ control, t }),
  }, SessionTrashConfirmation))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'desktop-deleted-sessions', order: 110, label: () => t('nav'), inject: () => ({ t }),
  }, DeletedSessions))
}
