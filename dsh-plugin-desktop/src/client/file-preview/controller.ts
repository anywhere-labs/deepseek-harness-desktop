/**
 * Preview controller for the built-in file viewer (design §6.2, §16.7). It is an
 * external store (immutable frozen snapshots, subscribe) driving the
 * displayed state machine closed → loading → ready/error with a monotonically
 * increasing revision and one AbortController per request. Every async commit
 * re-checks the revision, the disposed flag, and the injected current-session
 * callback so a slow earlier request can never overwrite a newer one and a
 * session switch can never commit a cross-session resource. The controller
 * holds no Cordis context; the gateway, registry, surface callbacks, and a
 * current-session reader are injected.
 * @module dsh-plugin-desktop/client/file-preview/controller
 */

import type {
  FilePreviewBinaryResult,
  FilePreviewDescriptor,
  FilePreviewProbeResult,
  FilePreviewResourceId,
  FilePreviewTextResult,
} from '../../file-preview-contract.ts'
import type { FilePreviewGateway, FilePreviewTransportError } from './gateway.ts'
import type { FilePreviewProvider } from './registry.ts'

/** Narrow registry surface the controller resolves providers through. */
export interface FilePreviewRegistryLike {
  resolve(descriptor: FilePreviewDescriptor): FilePreviewProvider | undefined
}

/** Structured error carried by an error snapshot. */
export interface FilePreviewError {
  /** Machine-readable error code. */
  code: string
  /** Human-readable message. */
  message: string
  /** Whether a refresh might resolve the failure. */
  retryable: boolean
}

/** Invariant payload a ready provider renders. */
export type FilePreviewContent =
  | { kind: 'text'; text: string }
  | { kind: 'binary-url'; url: string }
  | { kind: 'metadata-only' }

/** Immutable external-store snapshot of the display state machine. */
export type FilePreviewSnapshot =
  | { status: 'closed' }
  | { status: 'loading'; sessionId: string; path: string; revision: number }
  | {
      status: 'ready'
      sessionId: string
      path: string
      descriptor: FilePreviewDescriptor
      providerId: string
      content: FilePreviewContent
    }
  | { status: 'error'; sessionId: string; path: string; error: FilePreviewError; retryable: boolean }

/** Callbacks the controller uses to drive the hosting surface. */
export interface FilePreviewSurfaceCalls {
  /** Select the file surface (takeover). */
  openFile(): void
  /** Deselect the file surface (close). */
  closeFile(): void
  /** Open a raw path with the system default application. */
  openSystemPath(path: string): Promise<void>
  /** Read the currently active session id, or `undefined` when none. */
  getCurrentSessionId(): string | undefined
}

/** Whether a thrown value indicates an aborted request that must not surface. */
function isAbortError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    return (error as { name?: unknown }).name === 'AbortError'
  }
  return false
}

/** Fold an arbitrary thrown value into a retryable preview error. */
function toPreviewError(error: unknown): FilePreviewError {
  const code = (error as Partial<FilePreviewTransportError>)?.code
  if (typeof code === 'string' && code.length > 0) {
    return { code, message: error instanceof Error ? error.message : String(error), retryable: true }
  }
  if (error instanceof Error) return { code: 'preview-failed', message: error.message, retryable: true }
  return { code: 'preview-failed', message: String(error), retryable: true }
}

/**
 * Preview controller: owns the display state machine, request revision, abort
 * and resource lifecycle. `preview()` returns `'handled'` when the controller
 * owns the click (including takeover on an error) and `'delegate'` when the
 * caller should fall through to the original system open.
 */
export class FilePreviewController {
  private snapshot: FilePreviewSnapshot = Object.freeze({ status: 'closed' })
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private requestController: AbortController | undefined
  /** Resource of the in-flight load; released on supersede/close/suspend/dispose. */
  private outstandingResource: FilePreviewResourceId | undefined
  /** Resource held for a committed binary-url preview; released on replace/close. */
  private heldResource: FilePreviewResourceId | undefined
  private disposed = false

  constructor(
    private readonly gateway: FilePreviewGateway,
    private readonly registry: FilePreviewRegistryLike,
    surfaceCalls: FilePreviewSurfaceCalls,
  ) {
    this.openFile = surfaceCalls.openFile
    this.closeFile = surfaceCalls.closeFile
    this.openSystemPath = surfaceCalls.openSystemPath
    this.getCurrentSessionId = surfaceCalls.getCurrentSessionId
  }

  private readonly openFile: () => void
  private readonly closeFile: () => void
  private readonly openSystemPath: (path: string) => Promise<void>
  private readonly getCurrentSessionId: () => string | undefined

  /** @returns the immutable current snapshot. */
  getSnapshot(): FilePreviewSnapshot {
    return this.snapshot
  }

  /**
   * Subscribe to snapshot replacements.
   * @param listener - callback notified after each publish.
   * @returns its disposer.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Intercept a file click: probe, resolve a provider, load content, and
   * select the file surface. Never itself launches the system app.
   * @param sessionId - the active session.
   * @param path - the raw requested path.
   * @returns `'handled'` when the controller owns the click, `'delegate'` when
   *   the caller should fall through to the original system open.
   */
  async preview(sessionId: string, path: string): Promise<'handled' | 'delegate'> {
    if (this.disposed) return 'handled'
    const revision = this.startRequest()
    const signal = this.requestController!.signal
    try {
      const probeResult = await this.gateway.probe(sessionId, path, signal)
      if (!this.isCurrent(revision, sessionId)) return 'handled'
      if (probeResult.status === 'delegate') {
        return 'delegate'
      }
      if (probeResult.status === 'error') {
        this.publishError(sessionId, path, FilePreviewController.toError(probeResult), revision)
        return 'handled'
      }
      const descriptor = probeResult.descriptor
      const provider = this.registry.resolve(descriptor)
      if (provider === undefined) {
        this.publishError(sessionId, path, {
          code: 'no-provider',
          message: 'no viewer provider is registered for this file',
          retryable: false,
        }, revision)
        return 'handled'
      }
      if (!this.isCurrent(revision, sessionId)) return 'handled'
      this.publish({ status: 'loading', sessionId, path, revision })
      this.openFile()
      await this.loadContent(descriptor, provider, revision, sessionId, path, true)
      return 'handled'
    } catch (error) {
      if (isAbortError(error)) return 'handled'
      this.releaseBestEffort(this.outstandingResource)
      this.outstandingResource = undefined
      if (!this.isCurrent(revision, sessionId)) return 'handled'
      this.publishError(sessionId, path, toPreviewError(error), revision)
      return 'handled'
    }
  }

  /**
   * Re-run the preview using the settled ready (or error) snapshot's session
   * and raw path, so a refresh shows the latest content of the same file.
   * @returns the same `'handled' | 'delegate'` contract as {@link preview}.
   */
  refresh(): Promise<'handled' | 'delegate'> {
    const snapshot = this.snapshot
    if (snapshot.status !== 'ready' && snapshot.status !== 'error') {
      return Promise.resolve('handled')
    }
    return this.preview(snapshot.sessionId, snapshot.path)
  }

  /**
   * Close the preview immediately: publish `closed`, cancel in-flight work,
   * and background-release any held or loading resource.
   */
  close(): void {
    if (this.disposed) return
    this.revision += 1
    this.abortRequest()
    this.releaseBestEffort(this.outstandingResource)
    this.outstandingResource = undefined
    this.releaseBestEffort(this.heldResource)
    this.heldResource = undefined
    this.publishClosed()
  }

  /**
   * Suspend the surface (e.g. when the layout selects details). Aborts
   * unpublished probes and loading resources and closes a published loading
   * snapshot, while keeping an already-mounted ready preview intact.
   */
  suspend(): void {
    if (this.disposed) return
    this.revision += 1
    this.abortRequest()
    this.releaseBestEffort(this.outstandingResource)
    this.outstandingResource = undefined
    if (this.snapshot.status === 'loading') this.publishClosed()
  }

  /**
   * Open the raw path of the settled ready/error snapshot with the system
   * default application. Rejections are returned to the caller and never
   * written into the shared snapshot.
   * @returns the system-open promise so the caller can surface failures.
   */
  openExternally(): Promise<void> {
    const snapshot = this.snapshot
    if (snapshot.status !== 'ready' && snapshot.status !== 'error') {
      return Promise.resolve()
    }
    return this.openSystemPath(snapshot.path)
  }

  /**
   * Tear the controller down: cancel pending work, release every held/pending/
   * current resource best-effort, and wait for those releases before
   * resolving. After this, no public operation issues further requests.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.requestController?.abort()
    this.requestController = undefined
    const toRelease = [this.outstandingResource, this.heldResource].filter(
      (id): id is FilePreviewResourceId => id !== undefined,
    )
    this.outstandingResource = undefined
    this.heldResource = undefined
    await Promise.all(toRelease.map(id => this.gateway.release(id)))
    this.listeners.clear()
  }

  /** Start a new request: supersede the previous one and bump the revision. */
  private startRequest(): number {
    this.requestController?.abort()
    this.requestController = new AbortController()
    this.releaseBestEffort(this.outstandingResource)
    this.outstandingResource = undefined
    this.revision += 1
    return this.revision
  }

  /** Cancel the current request without touching held resources. */
  private abortRequest(): void {
    this.requestController?.abort()
    this.requestController = undefined
  }

  /** Load a probed descriptor's content according to the provider load mode. */
  private async loadContent(
    descriptor: FilePreviewDescriptor,
    provider: FilePreviewProvider,
    revision: number,
    sessionId: string,
    path: string,
    allowStaleRetry: boolean,
  ): Promise<void> {
    if (!this.isCurrent(revision, sessionId)) return
    const signal = this.requestController?.signal
    if (signal === undefined) return
    // An oversized file has no token: the panel renders metadata and the
    // system-open action instead of provider content.
    if (descriptor.availability === 'oversized' || provider.loadMode === 'metadata-only') {
      this.adoptReady(sessionId, path, descriptor, provider.id, { kind: 'metadata-only' }, undefined)
      return
    }
    const resourceId = descriptor.resourceId
    this.outstandingResource = resourceId
    if (provider.loadMode === 'text') {
      const result: FilePreviewTextResult = await this.gateway.readText(resourceId, signal)
      if (result.status === 'ok') {
        this.outstandingResource = undefined
        void this.gateway.release(resourceId)
        if (!this.isCurrent(revision, sessionId)) {
          // Session switched or superseded: the resource was already released.
          return
        }
        this.adoptReady(sessionId, path, descriptor, provider.id, { kind: 'text', text: result.text }, undefined)
        return
      }
      await this.finishNonFatalLoad(sessionId, path, revision, resourceId, result, allowStaleRetry)
      return
    }
    const result: FilePreviewBinaryResult = await this.gateway.binaryUrl(resourceId, signal)
    if (result.status === 'ok') {
      if (!this.isCurrent(revision, sessionId)) {
        // Session switched or superseded: release the received resource.
        this.outstandingResource = undefined
        void this.gateway.release(resourceId)
        return
      }
      this.outstandingResource = undefined
      this.adoptReady(sessionId, path, descriptor, provider.id, { kind: 'binary-url', url: result.url }, resourceId)
      return
    }
    await this.finishNonFatalLoad(sessionId, path, revision, resourceId, result, allowStaleRetry)
  }

  /** Handle a stale or business-error load result for a completed read. */
  private async finishNonFatalLoad(
    sessionId: string,
    path: string,
    revision: number,
    resourceId: FilePreviewResourceId,
    result: FilePreviewTextResult | FilePreviewBinaryResult,
    allowStaleRetry: boolean,
  ): Promise<void> {
    this.outstandingResource = undefined
    if (result.status === 'stale') {
      // The old token no longer binds to the current file; release it before
      // the retry probes a fresh resource.
      void this.gateway.release(resourceId)
      if (allowStaleRetry) {
        await this.reprobeAfterStale(sessionId, path, revision)
      } else {
        this.publishError(sessionId, path, {
          code: 'file-changed',
          message: 'the file changed while reading; refresh to retry',
          retryable: true,
        }, revision)
      }
      return
    }
    // Business error arm.
    if (result.status !== 'error') return
    void this.gateway.release(resourceId)
    if (!this.isCurrent(revision, sessionId)) return
    this.publishError(sessionId, path, FilePreviewController.toError(result), revision)
  }

  /** Re-probe after a stale read, loading the refreshed descriptor once more. */
  private async reprobeAfterStale(sessionId: string, path: string, revision: number): Promise<void> {
    if (!this.isCurrent(revision, sessionId)) return
    const signal = this.requestController?.signal
    if (signal === undefined) return
    const probeResult: FilePreviewProbeResult = await this.gateway.probe(sessionId, path, signal)
    if (!this.isCurrent(revision, sessionId)) return
    if (probeResult.status === 'preview') {
      const provider = this.registry.resolve(probeResult.descriptor)
      if (provider === undefined) {
        this.publishError(sessionId, path, { code: 'no-provider', message: 'no viewer provider is registered for this file', retryable: false }, revision)
        return
      }
      await this.loadContent(probeResult.descriptor, provider, revision, sessionId, path, false)
      return
    }
    // A delegate or error from the retry becomes a retryable error; we already
    // took over, so we never launch the system app after this point.
    this.publishError(sessionId, path, { code: 'file-changed', message: 'the file changed; refresh to retry', retryable: true }, revision)
  }

  /** Commit a ready snapshot, releasing any previously held image resource. */
  private adoptReady(
    sessionId: string,
    path: string,
    descriptor: FilePreviewDescriptor,
    providerId: string,
    content: FilePreviewContent,
    heldResource: FilePreviewResourceId | undefined,
  ): void {
    const oldHeld = this.heldResource
    if (oldHeld !== heldResource) this.releaseBestEffort(oldHeld)
    this.heldResource = heldResource
    this.publish({ status: 'ready', sessionId, path, descriptor, providerId, content })
  }

  /** Publish an error snapshot and select the file surface. */
  private publishError(
    sessionId: string,
    path: string,
    error: FilePreviewError,
    revision: number,
  ): void {
    if (!this.isCurrent(revision, sessionId)) return
    this.publish({ status: 'error', sessionId, path, error, retryable: error.retryable })
    this.openFile()
  }

  /** Normalize a contract error value (which may carry a `status` discriminant). */
  private static toError(input: { code: string; message: string; retryable: boolean }): FilePreviewError {
    return { code: input.code, message: input.message, retryable: input.retryable }
  }

  /** Publish the closed snapshot and deselect the file surface. */
  private publishClosed(): void {
    if (this.snapshot.status === 'closed') return
    this.publish({ status: 'closed' })
    this.closeFile()
  }

  /** Whether a request identified by revision/session may still commit. */
  private isCurrent(revision: number, sessionId: string): boolean {
    return !this.disposed && revision === this.revision && this.getCurrentSessionId() === sessionId
  }

  /** Release a resource fire-and-forget; the gateway swallows transport errors. */
  private releaseBestEffort(resourceId: FilePreviewResourceId | undefined): void {
    if (resourceId === undefined || this.disposed) return
    void this.gateway.release(resourceId)
  }

  /** Replace the snapshot (always a fresh frozen object) and notify listeners. */
  private publish(next: FilePreviewSnapshot): void {
    this.snapshot = Object.freeze(next)
    for (const listener of this.listeners) listener()
  }
}
