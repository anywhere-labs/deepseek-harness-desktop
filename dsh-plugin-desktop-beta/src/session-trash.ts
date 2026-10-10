/** Recoverable, durable Desktop session deletion independent of Archive. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-workspace'
import { watch } from 'node:fs'
import { SessionTrashStore } from './session-trash-store.ts'
import { DESKTOP_SESSION_TRASH_PATH, type DesktopSessionTrashView } from './session-trash-contract.ts'
import { finishJson, isSameOriginLoopbackRequest, isJsonRequest, readJson } from './desktop-settings-route.ts'

export class DesktopSessionTrashError extends Error {
  constructor(readonly code: 'active' | 'unknown' | 'unavailable' | 'foreign-owner', message: string) { super(message) }
}

declare module '@deepseek-ai/cordis' {
  interface Context { desktopSessionTrash: DesktopSessionTrash; desktopSessionTrashRequired: boolean }
}

export class DesktopSessionTrash extends Service {
  static inject = ['profileContext', 'sessionPersistence', 'workspaceRegistry', 'sessionController', 'webServer', 'connection']
  private store?: SessionTrashStore
  private pending = new Set<SessionIdType>()
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private supported = false
  private fault: unknown

  constructor(ctx: Context) { super(ctx, 'desktopSessionTrash') }

  protected async [Service.init](): Promise<void> {
    await Promise.resolve()
    this.supported = (this.ctx.sessionController as unknown as { desktopSessionTrashSupported?: boolean }).desktopSessionTrashSupported === true
    let previous = new Set<string>()
    try {
      this.store = new SessionTrashStore(this.ctx.profileContext.home)
      previous = new Set(this.store.list().map(item => item.sessionId))
    } catch (cause) {
      this.fault = cause
      this.ctx.logger.error('desktop: session trash protection is unavailable', cause)
    }
    this.ctx.effect(() => async () => {
      this.stopped = true
      await this.tail

    }, 'desktop: close session trash')
    let scheduled: ReturnType<typeof setImmediate> | undefined
    const reconcile = async (): Promise<void> => {
      const next = new Set(this.requireStore().list().map(item => item.sessionId))
      for (const id of next) if (!previous.has(id)) this.ctx.emit('api-session/removed', SessionId(id))
      const restored = [...previous].filter(id => !next.has(id))
      previous = next
      if (restored.length > 0) {
        const { items } = await this.ctx.sessionController.list({}, new AbortController().signal)
        for (const item of items) if (restored.includes(item.sessionId)) this.ctx.emit('api-session/added', item)
      }
    }
    this.ctx.effect(() => {
      if (this.fault !== undefined) return () => {}
      let watcher
      try { watcher = watch(this.requireStore().directory, () => {
        scheduled ??= setImmediate(() => {
          scheduled = undefined
          if (!this.stopped) void reconcile().catch(cause => { this.ctx.logger.error('desktop: session trash catalog refresh failed', cause) })
        })
      })
      } catch (cause) { this.fault = cause; this.ctx.logger.error('desktop: session trash watcher failed', cause); return () => {} }
      watcher.on('error', cause => { this.fault = cause; this.ctx.logger.error('desktop: session trash watcher failed', cause) })
      return () => { watcher.close(); if (scheduled !== undefined) clearImmediate(scheduled) }
    }, 'desktop: shared trash catalog updates')
    const origin = `http://127.0.0.1:${String(this.ctx.webServer.port)}`
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact', path: DESKTOP_SESSION_TRASH_PATH,
      handler: async (req, res) => {
        const rejection = this.ctx.connection.requestRejection(req)
        if (rejection !== undefined) { finishJson(res, rejection, { error: 'forbidden' }); return }
        const mutating = req.method === 'POST'
        if (req.method !== 'GET' && !mutating) { finishJson(res, 405, { error: 'method not allowed' }); return }
        if (!isSameOriginLoopbackRequest(req, origin, mutating)) { finishJson(res, 403, { error: 'forbidden' }); return }
        try {
          if (!mutating) { finishJson(res, 200, this.read()); return }
          if (!this.supported) { finishJson(res, 503, { error: 'This runtime cannot safely delete sessions. Update Desktop.', code: 'unsupported' }); return }
          if (!isJsonRequest(req)) { finishJson(res, 415, { error: 'content type must be application/json' }); return }
          let body: unknown
          try { body = await readJson(req) } catch { finishJson(res, 400, { error: 'invalid or oversized JSON' }); return }
          if (!isRequest(body)) { finishJson(res, 400, { error: 'invalid session trash request' }); return }
          const id = SessionId(body.sessionId)
          if (body.action === 'delete') await this.trash(id, body.title)
          else await this.restore(id)
          finishJson(res, 200, this.read())
        } catch (cause) {
          if (cause instanceof DesktopSessionTrashError) { finishJson(res, cause.code === 'unavailable' ? 503 : 409, { error: cause.message, code: cause.code }); return }
          this.ctx.logger.error('desktop: session trash operation failed', cause)
          finishJson(res, 500, { error: 'Session change failed. Your stored history is retained.' })
        }
      },
    }), 'desktop: session trash route')
  }

  /** Committed membership only: failed/in-flight writes never hide catalog rows. */
  has(id: SessionIdType): boolean { return this.requireStore().has(id) }
  /** Admission fence also covers a pending durability barrier. */
  blocks(id: SessionIdType): boolean { return this.pending.has(id) || this.has(id) }
  using<T>(id: SessionIdType, operation: () => Promise<T>): Promise<T> {
    return this.requireStore().using(id, async () => {
      if (this.blocks(id)) throw new RemoteError('session/agent-busy', 'Restore this session from Settings > Deleted sessions before continuing', { reason: 'session is deleted' })
      return operation()
    })
  }
  read(): DesktopSessionTrashView {
    return { supported: this.supported, items: this.requireStore().list() }
  }

  trash(id: SessionIdType, title: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.supported) throw new DesktopSessionTrashError('unavailable', 'This runtime cannot safely delete sessions.')
      if (this.has(id)) return
      // A failed list propagates: it must never become an unknown-session miss.
      const { items } = await this.ctx.sessionController.list({}, new AbortController().signal)
      if (!items.some(item => item.sessionId === id)) throw new DesktopSessionTrashError('unknown', 'This session is no longer available.')
      await this.assertInactive(id)
      this.pending.add(id)
      let leaseProbe: SessionHandle | undefined
      let committed = false
      try {
        // No storage handles or files are taken from their owners. The existing
        // barrier only ensures restored history includes acknowledged events.
        await this.ctx.sessionPersistence.flush()
        await this.assertInactive(id)
        await this.requireStore().set(id, title, true, async () => { await this.assertInactive(id); leaseProbe = await this.assertLocalOwnership(id) })
        committed = true
        try { this.ctx.emit('api-session/removed', id) } catch (cause) { this.ctx.logger.error('desktop: deleted session needs a catalog refresh', cause) }
      } finally {
        this.pending.delete(id)
        try { await leaseProbe?.close() } catch (cause) {
          if (!committed) throw cause
          this.ctx.logger.error('desktop: deleted session ownership release failed', cause)
        }
      }
    })
  }

  restore(id: SessionIdType): Promise<void> {
    return this.enqueue(async () => {
      if (!this.supported) throw new DesktopSessionTrashError('unavailable', 'This runtime cannot safely restore sessions.')
      if (!this.has(id)) return
      await this.requireStore().set(id, '', false)
      // Notify connected catalogs after the durable tombstone has been removed.
      // A failed projection read cannot roll back the committed restoration.
      try {
        const { items } = await this.ctx.sessionController.list({}, new AbortController().signal)
        const summary = items.find(item => item.sessionId === id)
        if (summary !== undefined) this.ctx.emit('api-session/added', summary)
      } catch (cause) { this.ctx.logger.error('desktop: restored session needs a catalog refresh', cause) }
    })
  }

  private async assertLocalOwnership(id: SessionIdType): Promise<SessionHandle | undefined> {
    const local = this.ctx.get('sessions')?.get(id)
    if (local !== undefined && this.ctx.get('agents')?.get(id)?.session === local) return
    const stored = await this.ctx.sessionPersistence.stat(id)
    if (stored === undefined) throw new DesktopSessionTrashError('unknown', 'This session is no longer available.')
    const formatStatus = (stored as { formatStatus?: unknown }).formatStatus
    if (formatStatus !== undefined && formatStatus !== 'current') throw new DesktopSessionTrashError('unavailable', 'Open this session to finish migration before deleting it.')
    try {
      return await this.ctx.sessionPersistence.open(id, 'write')
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'SessionAlreadyOwnedError') {
        throw new DesktopSessionTrashError('foreign-owner', 'This session is in use elsewhere. Close it there before deleting it.')
      }
      throw cause
    }
  }
  private async assertInactive(sessionId: SessionIdType): Promise<void> {
    const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    if (activity.length > 0) throw new DesktopSessionTrashError('active', 'Stop this session and its running work before deleting it.')
  }
  private requireStore() {
    if (this.stopped || this.fault !== undefined || this.store === undefined) throw new DesktopSessionTrashError('unavailable', 'Deleted sessions are unavailable.')
    return this.store
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.reject(new DesktopSessionTrashError('unavailable', 'Deleted sessions are unavailable.'))
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }
}

function isRequest(body: unknown): body is { action: 'delete' | 'restore'; sessionId: string; title: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
  const value = body as Record<string, unknown>
  return Object.keys(value).length === 3 && (value.action === 'delete' || value.action === 'restore')
    && typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 1024 && !value.sessionId.includes('\0')
    && typeof value.title === 'string' && value.title.length <= 4096
}
export default DesktopSessionTrash
