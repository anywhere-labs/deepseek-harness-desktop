/**
 * Browser Client gateway for the built-in file viewer. Thin adapter over the
 * loopback Connection RPC caller that issues the four file-preview endpoints and
 * validates every wire response against the shared contract parsers so the
 * controller never trusts an `unknown` payload (design §16.7 "Connection
 * Gateway"). Holds no React state; the only injected dependency is the generic
 * RPC caller plus an optional debug logger.
 * @module dsh-plugin-desktop/client/file-preview/gateway
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import {
  FILE_PREVIEW_BINARY_URL,
  FILE_PREVIEW_PROBE,
  FILE_PREVIEW_READ_TEXT,
  FILE_PREVIEW_RELEASE,
  FILE_PREVIEW_RPC_CHANNEL,
  parseBinaryResult,
  parseProbeResult,
  parseReleaseResult,
  parseTextResult,
  type FilePreviewBinaryResult,
  type FilePreviewBinaryUrlRequest,
  type FilePreviewProbeResult,
  type FilePreviewProbeRequest,
  type FilePreviewReadTextRequest,
  type FilePreviewReleaseRequest,
  type FilePreviewResourceId,
  type FilePreviewTextResult,
} from '../../file-preview-contract.ts'

/**
 * Error thrown when the outer RPC envelope reports a transport, payload, or
 * handler failure, or when a response fails wire validation. Carries the
 * machine code and a human message so the controller can surface a panel error.
 */
export class FilePreviewTransportError extends Error {
  /** Machine-readable error code (an RPC code or `invalid-response`). */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'FilePreviewTransportError'
    this.code = code
  }
}

/** Optional debug logger for best-effort operations such as `release`. */
export interface FilePreviewDebugLogger {
  debug(message: unknown, ...args: unknown[]): void
}

/** Narrow gateway surface the controller (and fakes) depend on (§16.7). */
export interface FilePreviewGateway {
  probe(sessionId: string, path: string, signal: AbortSignal): Promise<FilePreviewProbeResult>
  readText(resourceId: FilePreviewResourceId, signal: AbortSignal): Promise<FilePreviewTextResult>
  binaryUrl(resourceId: FilePreviewResourceId, signal: AbortSignal): Promise<FilePreviewBinaryResult>
  release(resourceId: FilePreviewResourceId): Promise<void>
}

/**
 * Client gateway that encodes each call as a Connection RPC request and decodes
 * the response through the shared contract. Aborts and RPC `ok:false` envelope
 * failures surface as thrown errors; business `error` arms come back untouched.
 */
export class ConnectionFilePreviewGateway implements FilePreviewGateway {
  constructor(
    private readonly rpc: ClientConnectionRpc,
    private readonly logger: FilePreviewDebugLogger | undefined = undefined,
  ) {}

  /**
   * Probe a session-owned path.
   * @param sessionId - current session identity.
   * @param path - raw requested path.
   * @param signal - caller cancellation.
   * @returns the validated probe result (`preview`, `delegate`, or `error`).
   */
  async probe(sessionId: string, path: string, signal: AbortSignal): Promise<FilePreviewProbeResult> {
    const payload: FilePreviewProbeRequest = { sessionId, path }
    const envelope = await this.call(FILE_PREVIEW_PROBE, payload, signal)
    const result = parseProbeResult(envelope)
    if (result === undefined) {
      throw new FilePreviewTransportError('invalid-response', 'invalid file-preview probe response')
    }
    return result
  }

  /**
   * Read the bounded UTF-8 text of a held resource.
   * @param resourceId - held resource token.
   * @param signal - caller cancellation.
   * @returns the validated text-read result (`ok`, `stale`, or `error`).
   */
  async readText(resourceId: FilePreviewResourceId, signal: AbortSignal): Promise<FilePreviewTextResult> {
    const payload: FilePreviewReadTextRequest = { resourceId }
    const envelope = await this.call(FILE_PREVIEW_READ_TEXT, payload, signal)
    const result = parseTextResult(envelope)
    if (result === undefined) {
      throw new FilePreviewTransportError('invalid-response', 'invalid file-preview read-text response')
    }
    return result
  }

  /**
   * Obtain the relative HTTP URL of a held image resource.
   * @param resourceId - held resource token.
   * @param signal - caller cancellation.
   * @returns the validated binary-url result (`ok`, `stale`, or `error`).
   */
  async binaryUrl(resourceId: FilePreviewResourceId, signal: AbortSignal): Promise<FilePreviewBinaryResult> {
    const payload: FilePreviewBinaryUrlRequest = { resourceId }
    const envelope = await this.call(FILE_PREVIEW_BINARY_URL, payload, signal)
    const result = parseBinaryResult(envelope)
    if (result === undefined) {
      throw new FilePreviewTransportError('invalid-response', 'invalid file-preview binary-url response')
    }
    return result
  }

  /**
   * Idempotently release a held resource. Best-effort: a transport or request
   * failure is logged and swallowed so a tidy-up path never interferes with the
   * preview the user is currently viewing.
   * @param resourceId - held resource token.
   */
  async release(resourceId: FilePreviewResourceId): Promise<void> {
    const payload: FilePreviewReleaseRequest = { resourceId }
    try {
      const envelope = await this.call(FILE_PREVIEW_RELEASE, payload, undefined)
      if (parseReleaseResult(envelope) === undefined) {
        this.logger?.debug('dsh-plugin-desktop: invalid file-preview release response')
      }
    } catch (error) {
      this.logger?.debug('dsh-plugin-desktop: file preview release failed', error)
    }
  }

  /**
   * Perform one generic Connection RPC call and surface an envelope failure as
   * a {@link FilePreviewTransportError}. Abort signals propagate: the caller
   * (or the controller) detects an AbortError by name and treats it as
   * cancellation rather than a panel error.
   * @param endpoint - channel-relative endpoint.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the response value when the envelope reports success.
   */
  private async call(endpoint: string, payload: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    const envelope = await this.rpc.call(FILE_PREVIEW_RPC_CHANNEL, endpoint, payload, signal)
    if (!envelope.ok) {
      throw new FilePreviewTransportError(envelope.error.code, envelope.error.message)
    }
    return envelope.value
  }
}
