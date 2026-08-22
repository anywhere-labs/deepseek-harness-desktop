/** Versioned, bounded JSON-lines RPC used only over the owned WSL stdio channel. */

import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'

const BIN_NAME = 'dsh-plugin-desktop'
const PROTOCOL_VERSION = 1
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024
const METHOD_PATTERN = /^(?:\$\/[a-z][a-z0-9.-]*|[a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9.-]*)*)$/u

interface RequestFrame {
  readonly v: typeof PROTOCOL_VERSION
  readonly kind: 'request'
  readonly id: string
  readonly method: string
  readonly params: unknown
}

interface ResponseFrame {
  readonly v: typeof PROTOCOL_VERSION
  readonly kind: 'response'
  readonly id: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
}

interface EventFrame {
  readonly v: typeof PROTOCOL_VERSION
  readonly kind: 'event'
  readonly method: string
  readonly params: unknown
}

type ControlFrame = RequestFrame | ResponseFrame | EventFrame

/** Handler for one trusted control method. */
export type DesktopControlHandler = (params: unknown, signal: AbortSignal) => unknown | Promise<unknown>

/** Minimal diagnostic sink for transport failures. */
export interface DesktopControlLogger {
  error(message: string): void
}

export interface DesktopControlPeerOptions {
  readonly maxFrameBytes?: number
  readonly logger?: DesktopControlLogger
}

/** Error used when a pending call loses its peer or is explicitly cancelled. */
export class DesktopControlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopControlError'
  }
}

function assertMethod(method: string): void {
  if (!METHOD_PATTERN.test(method) || method.length > 128) {
    throw new DesktopControlError(`${BIN_NAME}: invalid control method`)
  }
}

function frameId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || /[\0\r\n]/u.test(value)) {
    throw new DesktopControlError(`${BIN_NAME}: invalid control frame id`)
  }
  return value
}

function parseFrame(value: unknown): ControlFrame {
  if (value === null || typeof value !== 'object') {
    throw new DesktopControlError(`${BIN_NAME}: control frame must be an object`)
  }
  const frame = value as Record<string, unknown>
  if (frame.v !== PROTOCOL_VERSION) {
    throw new DesktopControlError(`${BIN_NAME}: unsupported control protocol version`)
  }
  if (frame.kind === 'request') {
    const method = typeof frame.method === 'string' ? frame.method : ''
    assertMethod(method)
    return {
      v: PROTOCOL_VERSION,
      kind: 'request',
      id: frameId(frame.id),
      method,
      params: frame.params ?? null,
    }
  }
  if (frame.kind === 'event') {
    const method = typeof frame.method === 'string' ? frame.method : ''
    assertMethod(method)
    return {
      v: PROTOCOL_VERSION,
      kind: 'event',
      method,
      params: frame.params ?? null,
    }
  }
  if (frame.kind === 'response') {
    const id = frameId(frame.id)
    if (typeof frame.ok !== 'boolean') {
      throw new DesktopControlError(`${BIN_NAME}: invalid control response`)
    }
    if (frame.ok) {
      return { v: PROTOCOL_VERSION, kind: 'response', id, ok: true, result: frame.result ?? null }
    }
    if (typeof frame.error !== 'string' || frame.error.length === 0 || frame.error.length > 4096) {
      throw new DesktopControlError(`${BIN_NAME}: invalid control error response`)
    }
    return { v: PROTOCOL_VERSION, kind: 'response', id, ok: false, error: frame.error }
  }
  throw new DesktopControlError(`${BIN_NAME}: unknown control frame kind`)
}

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.length > 4096 ? `${message.slice(0, 4093)}...` : message
}

interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (cause: unknown) => void
  readonly removeAbort?: () => void
}

/**
 * One bidirectional peer. Both Windows and WSL may issue requests, while
 * cancellation and teardown stay tied to the child-process lifetime.
 */
export class DesktopControlPeer {
  private readonly handlers = new Map<string, DesktopControlHandler>()
  private readonly pending = new Map<string, PendingCall>()
  private readonly incoming = new Map<string, AbortController>()
  private readonly maxFrameBytes: number
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private closed = false
  private closeCause: DesktopControlError | undefined

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly options: DesktopControlPeerOptions = {},
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1024) {
      throw new DesktopControlError(`${BIN_NAME}: control frame limit must be at least 1024 bytes`)
    }
    input.on('data', this.onData)
    input.once('end', this.onEnd)
    input.once('error', this.onInputError)
    output.once('error', this.onOutputError)
    this.register('$/cancel', (params) => {
      if (params !== null && typeof params === 'object') {
        const id = (params as { id?: unknown }).id
        if (typeof id === 'string') this.incoming.get(id)?.abort()
      }
      return null
    })
  }

  /** Register one request/event method for this peer's lifetime. */
  register(method: string, handler: DesktopControlHandler): () => void {
    assertMethod(method)
    if (this.handlers.has(method)) {
      throw new DesktopControlError(`${BIN_NAME}: control method is already registered: ${method}`)
    }
    this.handlers.set(method, handler)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.handlers.get(method) === handler) this.handlers.delete(method)
    }
  }

  /** Invoke one remote method and reject if the peer exits or the caller aborts. */
  async call<T = unknown>(method: string, params: unknown = null, signal?: AbortSignal): Promise<T> {
    assertMethod(method)
    this.assertOpen()
    signal?.throwIfAborted()
    const id = randomUUID()
    const result = new Promise<T>((resolve, reject) => {
      let removeAbort: (() => void) | undefined
      if (signal !== undefined) {
        const abort = (): void => {
          const pending = this.pending.get(id)
          if (pending === undefined) return
          this.pending.delete(id)
          pending.removeAbort?.()
          void this.send({
            v: PROTOCOL_VERSION,
            kind: 'event',
            method: '$/cancel',
            params: { id },
          }).catch(() => {})
          reject(signal.reason ?? new DesktopControlError(`${BIN_NAME}: control request aborted`))
        }
        signal.addEventListener('abort', abort, { once: true })
        removeAbort = () => { signal.removeEventListener('abort', abort) }
      }
      this.pending.set(id, { resolve: value => { resolve(value as T) }, reject, ...(removeAbort === undefined ? {} : { removeAbort }) })
    })
    try {
      await this.send({ v: PROTOCOL_VERSION, kind: 'request', id, method, params: params ?? null })
    } catch (cause) {
      const pending = this.pending.get(id)
      this.pending.delete(id)
      pending?.removeAbort?.()
      pending?.reject(cause)
    }
    return await result
  }

  /** Send one fire-and-forget event. Handler failures are logged by the receiver. */
  notify(method: string, params: unknown = null): void {
    assertMethod(method)
    this.assertOpen()
    void this.send({
      v: PROTOCOL_VERSION,
      kind: 'event',
      method,
      params: params ?? null,
    }).catch((cause: unknown) => { this.fail(cause) })
  }

  /** Close locally and reject all pending work without ending a shared stream. */
  close(cause: unknown = new DesktopControlError(`${BIN_NAME}: control peer closed`)): void {
    if (this.closed) return
    this.closed = true
    this.closeCause = cause instanceof DesktopControlError
      ? cause
      : new DesktopControlError(errorMessage(cause))
    this.input.off('data', this.onData)
    this.input.off('end', this.onEnd)
    this.input.off('error', this.onInputError)
    this.output.off('error', this.onOutputError)
    for (const pending of this.pending.values()) {
      pending.removeAbort?.()
      pending.reject(this.closeCause)
    }
    this.pending.clear()
    for (const controller of this.incoming.values()) controller.abort(this.closeCause)
    this.incoming.clear()
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes])
    if (this.buffer.length > this.maxFrameBytes && this.buffer.indexOf(0x0a) === -1) {
      this.fail(new DesktopControlError(`${BIN_NAME}: control frame exceeds byte limit`))
      return
    }
    while (!this.closed) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline === -1) return
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.length === 0) continue
      if (line.length > this.maxFrameBytes) {
        this.fail(new DesktopControlError(`${BIN_NAME}: control frame exceeds byte limit`))
        return
      }
      try {
        const frame = parseFrame(JSON.parse(line.toString('utf8')))
        this.accept(frame)
      } catch (cause) {
        this.fail(cause)
      }
    }
  }

  private readonly onEnd = (): void => {
    if (this.buffer.length > 0) {
      this.fail(new DesktopControlError(`${BIN_NAME}: control channel ended with an incomplete frame`))
    } else {
      this.close(new DesktopControlError(`${BIN_NAME}: control channel ended`))
    }
  }

  private readonly onInputError = (cause: Error): void => { this.fail(cause) }
  private readonly onOutputError = (cause: Error): void => { this.fail(cause) }

  private accept(frame: ControlFrame): void {
    if (frame.kind === 'response') {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      this.pending.delete(frame.id)
      pending.removeAbort?.()
      if (frame.ok) pending.resolve(frame.result)
      else pending.reject(new DesktopControlError(frame.error ?? `${BIN_NAME}: remote control request failed`))
      return
    }
    const handler = this.handlers.get(frame.method)
    if (handler === undefined) {
      if (frame.kind === 'request') {
        void this.respond(frame.id, false, undefined, `${BIN_NAME}: unknown control method: ${frame.method}`)
      }
      return
    }
    if (frame.kind === 'event') {
      void Promise.resolve().then(() => handler(frame.params, new AbortController().signal)).catch((cause: unknown) => {
        this.options.logger?.error(`${BIN_NAME}: control event ${frame.method} failed: ${errorMessage(cause)}`)
      })
      return
    }
    const controller = new AbortController()
    this.incoming.set(frame.id, controller)
    void Promise.resolve()
      .then(() => handler(frame.params, controller.signal))
      .then(
        result => this.respond(frame.id, true, result ?? null),
        cause => this.respond(frame.id, false, undefined, errorMessage(cause)),
      )
      .finally(() => { this.incoming.delete(frame.id) })
  }

  private async respond(id: string, ok: boolean, result?: unknown, error?: string): Promise<void> {
    if (this.closed) return
    try {
      await this.send(ok
        ? { v: PROTOCOL_VERSION, kind: 'response', id, ok: true, result: result ?? null }
        : { v: PROTOCOL_VERSION, kind: 'response', id, ok: false, error: error ?? 'request failed' })
    } catch (cause) {
      this.fail(cause)
    }
  }

  private async send(frame: ControlFrame): Promise<void> {
    this.assertOpen()
    const line = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(line) > this.maxFrameBytes) {
      throw new DesktopControlError(`${BIN_NAME}: control frame exceeds byte limit`)
    }
    await new Promise<void>((resolve, reject) => {
      this.output.write(line, 'utf8', (cause?: Error | null) => {
        if (cause === undefined || cause === null) resolve()
        else reject(cause)
      })
    })
  }

  private assertOpen(): void {
    if (this.closed) throw this.closeCause ?? new DesktopControlError(`${BIN_NAME}: control peer is closed`)
  }

  private fail(cause: unknown): void {
    const error = cause instanceof DesktopControlError
      ? cause
      : new DesktopControlError(`${BIN_NAME}: control transport failed: ${errorMessage(cause)}`)
    this.options.logger?.error(error.message)
    this.close(error)
  }
}
