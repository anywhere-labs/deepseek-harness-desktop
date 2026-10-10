/** Private, asynchronous control channel. Web traffic never passes through this channel. */
import { diagnosticOperation } from './developer-logging.ts'

export interface HostPort {
  send(message: unknown): void
  listen(receive: (message: unknown) => void): () => void
}
type Handler = (args: any[], signal: AbortSignal) => unknown | Promise<unknown>
type Pending = { resolve(value: any): void; reject(error: Error): void; cleanup(): void }

export class HostRpc {
  private sequence = 0
  private closed = false
  private readonly pending = new Map<number, Pending>()
  private readonly active = new Map<number, AbortController>()
  private readonly handlers = new Map<string, Handler>()
  private readonly unlisten: () => void
  constructor(private readonly port: HostPort, private readonly timeoutMs = 30_000) {
    this.unlisten = port.listen(message => { void this.receive(message) })
  }
  handle(name: string, handler: Handler): () => void {
    if (this.handlers.has(name)) throw new Error(`Duplicate Host handler: ${name}`)
    this.handlers.set(name, handler)
    return () => { this.handlers.delete(name) }
  }
  call<T = void>(method: string, args: unknown[] = [], signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new Error('DSH Host channel closed'))
    if (signal?.aborted) return Promise.reject(new Error('DSH Host call cancelled'))
    const id = ++this.sequence
    const end = diagnosticOperation('process.ipc', 'call', { method, requestId: id })
    return new Promise<T>((settle, fail) => {
      const resolve = (value: T) => { end(); settle(value) }
      const reject = (error: Error) => { end(error); fail(error) }
      const abort = () => {
        this.pending.delete(id)
        cleanup()
        try { this.port.send({ kind: 'cancel', id }) } catch { /* channel already gone */ }
        reject(new Error('DSH Host call cancelled or timed out'))
      }
      const timer = timeoutMs === 0 ? undefined : setTimeout(abort, timeoutMs)
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      try { this.port.send({ kind: 'call', id, method, args }) }
      catch (cause) {
        this.pending.delete(id); cleanup()
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }
  close(reason = 'DSH Host channel closed'): void {
    if (this.closed) return
    this.closed = true
    this.unlisten()
    for (const item of this.pending.values()) { item.cleanup(); item.reject(new Error(reason)) }
    this.pending.clear()
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
    this.handlers.clear()
  }
  private async receive(value: unknown): Promise<void> {
    if (this.closed || !value || typeof value !== 'object') return
    const message = value as Record<string, any>
    if (!Number.isSafeInteger(message.id) || message.id < 1) return
    const id = message.id as number
    if (message.kind === 'result') {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id); pending.cleanup()
      if (typeof message.error === 'string') pending.reject(new Error(message.error))
      else pending.resolve(message.value)
    } else if (message.kind === 'cancel') {
      this.active.get(id)?.abort()
    } else if (message.kind === 'call' && typeof message.method === 'string' && Array.isArray(message.args)) {
      const end = diagnosticOperation('process.ipc', 'handle', { method: message.method, requestId: id })
      const controller = new AbortController()
      this.active.set(id, controller)
      try {
        const handler = this.handlers.get(message.method)
        if (!handler) throw new Error(`Unknown Host operation: ${message.method}`)
        const result = await handler(message.args, controller.signal)
        end(undefined, { cancelled: controller.signal.aborted })
        if (!this.closed) this.port.send({ kind: 'result', id, value: result })
      } catch (cause) {
        end(cause, { cancelled: controller.signal.aborted })
        if (!this.closed) {
          try { this.port.send({ kind: 'result', id, error: cause instanceof Error ? cause.message : String(cause) }) }
          catch { /* transport owner handles exit */ }
        }
      } finally { this.active.delete(id) }
    }
  }
}
