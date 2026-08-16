/**
 * Host-side gateway for the built-in file viewer: path authorization, format
 * probe, bounded text reads, image token serving, and resource lifecycle
 * (design §16.6). The gateway holds no Cordis context — narrow dependencies (a
 * file-system seam, a workspace-list callback, an optional lineage-trace
 * callback, a logger, the loopback origin, and validated config) are injected
 * so the business methods are unit-testable with fakes. The HTTP image route
 * and the RPC dispatcher are thin adapters over those methods.
 * @module dsh-plugin-desktop/file-preview-gateway
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {
  FilePreviewBinaryResult,
  FilePreviewContentKind,
  FilePreviewDescriptor,
  FilePreviewProbeResult,
  FilePreviewReleaseResult,
  FilePreviewResourceId,
  FilePreviewTextResult,
} from './file-preview-contract.ts'
import {
  FILE_PREVIEW_BINARY_PREFIX,
  FilePreviewResourceId as brandResourceId,
  parseBinaryUrlRequest,
  parseProbeRequest,
  parseReadTextRequest,
  parseReleaseRequest,
} from './file-preview-contract.ts'
import {
  classifyExtensionlessText,
  classifyFileName,
  type FilePreviewFormatDefinition,
} from './file-preview-formats.ts'

/** Opaque FsTarget/version values collected read-only from the fs seam. */
export interface FilePreviewFsTarget {
  targetKey: unknown
  displayPath: string
}

/** Metadata values returned by the fs seam's stat. */
interface FilePreviewFsInfo {
  version: unknown
  type: 'file' | 'directory' | 'other'
  size?: number
}

/** A stat result proven to describe a regular file with a finite size. */
type RegularFileInfo = {
  version: unknown
  type: 'file'
  size: number
}

/**
 * Narrow filesystem seam the gateway runs on. Structurally compatible with
 * `Pick<FileSystem, 'resolve' | 'contains' | 'stat' | 'readBytes'>`; tests
 * supply an in-memory fake and the real Host passes `ctx.fs`.
 */
export interface FilePreviewFsSeam {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FilePreviewFsTarget>
  contains(parent: FilePreviewFsTarget, child: FilePreviewFsTarget): boolean
  stat(target: FilePreviewFsTarget, signal?: AbortSignal): Promise<FilePreviewFsInfo | undefined>
  readBytes(target: FilePreviewFsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
}

/** Minimal logger surface the gateway writes diagnostics to. */
export interface FilePreviewLogger {
  warn(message: unknown, ...args: unknown[]): void
  error(message: unknown, ...args: unknown[]): void
}

/** One workspace membership entry the gateway reads from the registry. */
export interface WorkspaceMembership {
  path: string
  sessionIds: readonly string[]
}

/** Narrow lineage shape the gateway needs for subagent workspace resolution. */
export interface FilePreviewLineageTrace {
  target: { header: { origin?: 'subagent'; parentSession?: string } }
  ancestors: readonly { header: { parentSession?: string; id: string } }[]
}

/** Validated configuration the gateway reads; never defaulted inside a method. */
export interface FilePreviewGatewayConfig {
  /** Inclusive byte cap for text content read from held resources and probes. */
  maxTextBytes: number
  /** Inclusive byte cap for image content served over the binary data plane. */
  maxImageBytes: number
  /** Resource token lifetime in milliseconds. */
  resourceTtlMs: number
  /** Maximum concurrently held resources before oldest-created eviction. */
  maxResources: number
}

/** One held resource entry; FsTarget/version stay Host-side and never serialize. */
interface ResourceRecord {
  sessionId: string
  workspacePath: string
  workspaceRoot: FilePreviewFsTarget
  candidate: FilePreviewFsTarget
  candidatePath: string
  version: unknown
  size: number
  mediaType: string
  contentKind: FilePreviewContentKind
  language?: string
  expiresAt: number
  creationSeq: number
}

/** A read that is currently in flight and abortable on dispose. */
interface ActiveRead {
  controller: AbortController
  removeListener(): void
}

/** Loopback identity parts parsed once from the injected origin. */
interface LoopbackParts {
  origin: string
  host: string
}

/** Parse the loopback origin string into its HTTP identity parts. */
function parseLoopbackOrigin(origin: string): LoopbackParts {
  const url = new URL(origin)
  const port = url.port === '' ? 80 : url.port
  return { origin, host: `${url.hostname}:${port}` }
}

/** One RPC envelope frame the dispatcher returns, error branch shaped for the
 * Connection `RpcResult` bad-request arm. */
type DispatchedRpc =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: 'bad-request'; message: string; details: { issues: never[] } } }

/** HTTP data-plane read outcome carrying a status code when it fails. */
type HttpReadOutcome =
  | { ok: true; bytes: Uint8Array; mediaType: string }
  | { ok: false; status: number; message: string }

/**
 * Desktop file-preview gateway. Instances are owned by a Cordis Fiber effect;
 * {@link dispose} clears the resource map and aborts in-flight reads, after
 * which every handler call fails as disposed.
 */
export class DesktopFilePreviewGateway {
  private readonly resources = new Map<FilePreviewResourceId, ResourceRecord>()
  private readonly activeReads = new Set<ActiveRead>()
  private creationSeq = 0
  private disposed = false
  private readonly loopback: LoopbackParts

  constructor(
    private readonly fs: FilePreviewFsSeam,
    private readonly list: () => readonly WorkspaceMembership[],
    private readonly traceSession: ((sessionId: string, signal: AbortSignal) => Promise<FilePreviewLineageTrace>) | undefined,
    private readonly logger: FilePreviewLogger,
    loopbackOrigin: string,
    private readonly config: FilePreviewGatewayConfig,
  ) {
    this.loopback = parseLoopbackOrigin(loopbackOrigin)
  }

  /**
   * Probe a session-owned path and produce a descriptor, delegating
   * directories, unauthorized paths, non-regular files, and unsupported
   * formats. Implements the delegation order of design §16.6.
   * @param sessionId - the raw session id from the wire.
   * @param path - the raw path from the wire (relative or absolute).
   * @param signal - cancels the probe.
   * @returns `preview`, `delegate`, or `error`.
   */
  async probe(sessionId: string, path: string, signal: AbortSignal): Promise<FilePreviewProbeResult> {
    this.assertNotDisposed()
    this.purgeExpired()
    SessionId(sessionId)

    const classification = classifyFileName(this.baseNameOf(path))
    // A path with an unknown extension delegates immediately without I/O.
    if (classification.extension !== '' && classification.definition === undefined) {
      return { status: 'delegate' }
    }

    const workspace = await this.resolveWorkspace(sessionId, signal)
    if (workspace === undefined) return { status: 'delegate' }

    const workspaceRoot = await this.fs.resolve(workspace.path, { signal })
    let candidate: FilePreviewFsTarget
    try {
      candidate = await this.fs.resolve(path, { cwd: workspace.path, signal })
    } catch (error) {
      this.logger.warn('dsh-plugin-desktop: file preview resolve failed', error)
      return { status: 'delegate' }
    }
    if (!this.fs.contains(workspaceRoot, candidate)) return { status: 'delegate' }

    let info: FilePreviewFsInfo | undefined
    try {
      info = await this.fs.stat(candidate, signal)
    } catch (error) {
      if (classification.definition === undefined) {
        return { status: 'delegate' }
      }
      this.logger.warn('dsh-plugin-desktop: file preview stat failed', error)
      return { status: 'error', code: 'stat-failed', message: 'unable to stat the file', retryable: true }
    }
    if (!this.isRegularFile(info)) return { status: 'delegate' }

    // Extensionless candidates are content-probed for reliable UTF-8 text.
    if (classification.definition === undefined) {
      return this.probeExtensionless(sessionId, workspace, workspaceRoot, candidate, path, info, signal)
    }

    const definition = classification.definition
    const limitBytes = definition.contentKind === 'text' ? this.config.maxTextBytes : this.config.maxImageBytes
    if (info.size > limitBytes) {
      return {
        status: 'preview',
        descriptor: this.oversizedDescriptor(path, classification.definition, info, limitBytes),
      }
    }

    return {
      status: 'preview',
      descriptor: this.createDescriptor(
        sessionId,
        workspace,
        workspaceRoot,
        candidate,
        path,
        info,
        definition.mediaType,
        definition.contentKind,
        definition.language,
      ),
    }
  }

  /**
   * Read the bounded UTF-8 text of a held resource, returning `stale` when the
   * file changed after probe.
   * @param resourceId - the held resource token.
   * @param signal - cancels the read.
   * @returns `ok`, `stale`, or `error`.
   */
  async readText(resourceId: FilePreviewResourceId, signal: AbortSignal): Promise<FilePreviewTextResult> {
    this.assertNotDisposed()
    this.purgeExpired()
    const resource = this.resources.get(resourceId)
    if (resource === undefined || resource.contentKind !== 'text') return { status: 'stale' }

    if (!(await this.resourceBindingIntact(resource, signal))) return { status: 'stale' }

    const read = this.beginRead(signal)
    try {
      let bytes: Uint8Array
      try {
        bytes = await this.fs.readBytes(resource.candidate, read.controller.signal, this.config.maxTextBytes)
      } catch (error) {
        return this.mapReadError(error)
      }
      const after = await this.fs.stat(resource.candidate, read.controller.signal)
      if (!this.isRegularFile(after) || after.version !== resource.version
        || after.size !== resource.size) {
        return { status: 'stale' }
      }
      if (bytes.includes(0)) return { status: 'stale' }
      const text = this.decodeUtf8Fatal(bytes)
      if (text === undefined) return { status: 'stale' }
      return { status: 'ok', text, resourceId }
    } finally {
      read.end()
    }
  }

  /**
   * Return the relative HTTP URL of a held image resource, re-validating its
   * binding so a changed file surfaces as `stale`.
   * @param resourceId - the held resource token.
   * @param signal - cancels the validation.
   * @returns `ok` with a relative URL, `stale`, or `error`.
   */
  async binaryUrl(resourceId: FilePreviewResourceId, signal: AbortSignal): Promise<FilePreviewBinaryResult> {
    this.assertNotDisposed()
    this.purgeExpired()
    const resource = this.resources.get(resourceId)
    if (resource === undefined || resource.contentKind !== 'image') return { status: 'stale' }
    if (!(await this.resourceBindingIntact(resource, signal))) return { status: 'stale' }
    return { status: 'ok', url: `${FILE_PREVIEW_BINARY_PREFIX}/${String(resourceId)}` }
  }

  /**
   * Idempotently release a held resource.
   * @param resourceId - the held resource token.
   * @returns `true` when the resource was released, `false` when the gateway
   *   is already disposed.
   */
  release(resourceId: FilePreviewResourceId): FilePreviewReleaseResult {
    this.purgeExpired()
    if (this.disposed) return { released: false }
    this.resources.delete(resourceId)
    return { released: true }
  }

  /**
   * Global teardown: clear the resource map and abort any in-flight reads.
   * Idempotent.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const read of this.activeReads) read.controller.abort()
    this.activeReads.clear()
    this.resources.clear()
  }

  /**
   * Serve one image resource request over the loopback data plane, applying
   * the Host/Origin/Sec-Fetch-Site trust fence and validating the magic bytes
   * of the served content.
   * @param req - the node:http request.
   * @param res - the node:http response.
   */
  async handleImageRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    if (!this.trustedImageRequest(req)) {
      res.writeHead(404).end()
      return
    }
    const id = this.imageResourceIdFromUrl(req.url)
    if (id === undefined) {
      res.writeHead(404).end()
      return
    }
    const controller = new AbortController()
    const onClose = (): void => controller.abort()
    res.on('close', onClose)
    try {
      const outcome = await this.readImageResource(id, controller.signal)
      if (!outcome.ok) {
        if (!res.destroyed && !res.writableEnded) res.writeHead(outcome.status).end(outcome.message)
        return
      }
      if (res.destroyed || res.writableEnded) return
      res.writeHead(200, this.imageResponseHeaders(outcome.mediaType, outcome.bytes.byteLength))
      res.end(outcome.bytes)
    } finally {
      res.off('close', onClose)
    }
  }

  /**
   * RPC dispatch entry: map an endpoint to its handler with structured
   * bad-request responses for unknown endpoints and malformed payloads.
   * @param endpoint - the channel-relative endpoint name.
   * @param payload - the decoded JSON payload.
   * @param signal - cancels the request.
   * @returns the RPC envelope frame.
   */
  async dispatch(endpoint: string, payload: unknown, signal: AbortSignal): Promise<DispatchedRpc> {
    const badRequest = (message: string): DispatchedRpc => ({
      ok: false,
      error: { code: 'bad-request', message, details: { issues: [] } },
    })
    if (this.disposed) return badRequest('file-preview gateway is disposed')
    switch (endpoint) {
      case 'probe': {
        const request = parseProbeRequest(payload)
        if (!request.ok) return badRequest(request.message)
        return { ok: true, value: await this.probe(request.value.sessionId, request.value.path, signal) }
      }
      case 'read-text': {
        const request = parseReadTextRequest(payload)
        if (!request.ok) return badRequest(request.message)
        return { ok: true, value: await this.readText(request.value, signal) }
      }
      case 'binary-url': {
        const request = parseBinaryUrlRequest(payload)
        if (!request.ok) return badRequest(request.message)
        return { ok: true, value: await this.binaryUrl(request.value, signal) }
      }
      case 'release': {
        const request = parseReleaseRequest(payload)
        if (!request.ok) return badRequest(request.message)
        return { ok: true, value: this.release(request.value) }
      }
      default:
        return badRequest(`unknown file-preview endpoint "${endpoint}"`)
    }
  }

  /** Resolve the workspace that authorizes a session, via membership or lineage. */
  private async resolveWorkspace(sessionId: string, signal: AbortSignal): Promise<WorkspaceMembership | undefined> {
    const memberships = this.list()
    let matched = memberships.find(membership => membership.sessionIds.includes(sessionId))
    if (matched !== undefined) return matched
    if (this.traceSession === undefined) return undefined
    let trace: FilePreviewLineageTrace
    try {
      trace = await this.traceSession(sessionId, signal)
    } catch (error) {
      // An absent target or a failing corpus listing leaves no authoritative
      // ancestor membership; the path keeps its native system-open behavior.
      this.logger.warn('dsh-plugin-desktop: file preview lineage trace failed', error)
      return undefined
    }
    if (trace.target.header.origin !== 'subagent') return undefined
    for (const ancestor of trace.ancestors) {
      matched = memberships.find(membership => membership.sessionIds.includes(ancestor.header.id))
      if (matched !== undefined) return matched
    }
    return undefined
  }

  /** Verify a held resource still binds to the same live workspace and file. */
  private async resourceBindingIntact(resource: ResourceRecord, signal: AbortSignal): Promise<boolean> {
    const workspace = await this.resolveWorkspace(resource.sessionId, signal)
    if (workspace?.path !== resource.workspacePath) return false
    let workspaceRoot: FilePreviewFsTarget
    try {
      workspaceRoot = await this.fs.resolve(resource.workspacePath, { signal })
    } catch {
      return false
    }
    if (workspaceRoot.targetKey !== resource.workspaceRoot.targetKey) return false
    let candidate: FilePreviewFsTarget
    try {
      candidate = await this.fs.resolve(resource.candidatePath, { cwd: resource.workspacePath, signal })
    } catch {
      return false
    }
    if (candidate.targetKey !== resource.candidate.targetKey) return false
    if (!this.fs.contains(workspaceRoot, candidate)) return false
    const info = await this.fs.stat(candidate, signal)
    if (!this.isRegularFile(info) || info.version !== resource.version || info.size !== resource.size) return false
    return true
  }

  /** Probe an extensionless candidate's content for reliable UTF-8 text. */
  private async probeExtensionless(
    sessionId: string,
    workspace: WorkspaceMembership,
    workspaceRoot: FilePreviewFsTarget,
    candidate: FilePreviewFsTarget,
    path: string,
    info: RegularFileInfo,
    signal: AbortSignal,
  ): Promise<FilePreviewProbeResult> {
    if (info.size > this.config.maxTextBytes) return { status: 'delegate' }
    const read = this.beginRead(signal)
    try {
      let bytes: Uint8Array
      try {
        bytes = await this.fs.readBytes(candidate, read.controller.signal, this.config.maxTextBytes)
      } catch {
        return { status: 'delegate' }
      }
      const classified = classifyExtensionlessText(this.baseNameOf(path), bytes)
      if (classified === undefined) return { status: 'delegate' }
      const after = await this.fs.stat(candidate, read.controller.signal)
      if (!this.isRegularFile(after)) return { status: 'delegate' }
      return {
        status: 'preview',
        descriptor: this.createDescriptor(
          sessionId,
          workspace,
          workspaceRoot,
          candidate,
          path,
          after,
          classified.mediaType,
          classified.contentKind,
        ),
      }
    } finally {
      read.end()
    }
  }

  /** Map a `readBytes` failure into a text read result. */
  private mapReadError(error: unknown): FilePreviewTextResult {
    if (error instanceof FsError) {
      if (error.code === 'FS_TOO_LARGE') return { status: 'stale' }
      if (error.code === 'FS_ABORTED') throw error
      this.logger.warn('dsh-plugin-desktop: file preview text read failed', error)
      return { status: 'error', code: error.code, message: error.message, retryable: false }
    }
    if (isAbortError(error)) throw error
    this.logger.warn('dsh-plugin-desktop: file preview text read failed', error)
    return { status: 'error', code: 'read-failed', message: String(error), retryable: true }
  }

  /** Read and validate image bytes for a held resource over the data plane. */
  private async readImageResource(resourceId: FilePreviewResourceId, signal: AbortSignal): Promise<HttpReadOutcome> {
    this.purgeExpired()
    if (this.disposed) return { ok: false, status: 410, message: 'gone' }
    const resource = this.resources.get(resourceId)
    if (resource === undefined || resource.contentKind !== 'image') return { ok: false, status: 404, message: 'not found' }
    let intact: boolean
    try {
      intact = await this.resourceBindingIntact(resource, signal)
    } catch {
      return { ok: false, status: 404, message: 'not found' }
    }
    if (!intact) return { ok: false, status: 404, message: 'not found' }
    const read = this.beginRead(signal)
    try {
      let bytes: Uint8Array
      try {
        bytes = await this.fs.readBytes(resource.candidate, read.controller.signal, this.config.maxImageBytes)
      } catch (error) {
        if (isAbortError(error) || (error instanceof FsError && error.code === 'FS_ABORTED')) {
          return { ok: false, status: 499, message: 'aborted' }
        }
        return { ok: false, status: 500, message: 'read failed' }
      }
      const after = await this.fs.stat(resource.candidate, read.controller.signal)
      if (!this.isRegularFile(after) || after.version !== resource.version
        || after.size !== resource.size) {
        return { ok: false, status: 404, message: 'changed' }
      }
      if (!validateImageSignature(resource.mediaType, bytes)) return { ok: false, status: 415, message: 'unsupported media type' }
      return { ok: true, bytes, mediaType: resource.mediaType }
    } finally {
      read.end()
    }
  }

  /** Build an available descriptor and mint its resource token. */
  private createDescriptor(
    sessionId: string,
    workspace: WorkspaceMembership,
    workspaceRoot: FilePreviewFsTarget,
    candidate: FilePreviewFsTarget,
    path: string,
    info: RegularFileInfo,
    mediaType: string,
    contentKind: FilePreviewContentKind,
    language?: string,
  ): FilePreviewDescriptor {
    const record: ResourceRecord = {
      sessionId,
      workspacePath: workspace.path,
      workspaceRoot,
      candidate,
      candidatePath: path,
      version: info.version,
      size: info.size,
      mediaType,
      contentKind,
      ...(language === undefined ? {} : { language }),
      expiresAt: Date.now() + this.config.resourceTtlMs,
      creationSeq: this.creationSeq++,
    }
    const id = this.mintId()
    this.evictIfOverCapacity(id, record)
    return {
      availability: 'available',
      resourceId: id,
      displayPath: candidate.displayPath,
      name: this.baseNameOf(path),
      extension: classifyFileName(this.baseNameOf(path)).extension,
      mediaType,
      contentKind,
      size: info.size,
      ...(language === undefined ? {} : { language }),
    }
  }

  /** Build an oversized descriptor with no token. */
  private oversizedDescriptor(path: string, definition: FilePreviewFormatDefinition, info: RegularFileInfo, limitBytes: number): FilePreviewDescriptor {
    return {
      availability: 'oversized',
      limitBytes,
      displayPath: path,
      name: this.baseNameOf(path),
      extension: classifyFileName(this.baseNameOf(path)).extension,
      mediaType: definition.mediaType,
      contentKind: definition.contentKind,
      ...(definition.language === undefined ? {} : { language: definition.language }),
      size: info.size,
    }
  }

  /** Enforce the max-resources bound, evicting the oldest-created record. */
  private evictIfOverCapacity(id: FilePreviewResourceId, record: ResourceRecord): void {
    while (this.resources.size >= this.config.maxResources) {
      let oldestKey: FilePreviewResourceId | undefined
      let oldestSeq = Number.POSITIVE_INFINITY
      for (const [key, existing] of this.resources) {
        if (existing.creationSeq < oldestSeq) {
          oldestKey = key
          oldestSeq = existing.creationSeq
        }
      }
      if (oldestKey === undefined) break
      this.resources.delete(oldestKey)
    }
    this.resources.set(id, record)
  }

  /** Mint an opaque, high-entropy, URL-safe resource token (256 bit). */
  private mintId(): FilePreviewResourceId {
    return brandResourceId(randomBytes(32).toString('base64url'))
  }

  /** Remove expired resources lazily before a probe/read/binary/release. */
  private purgeExpired(): void {
    const now = Date.now()
    for (const [key, record] of this.resources) {
      if (record.expiresAt <= now) this.resources.delete(key)
    }
  }

  /** Assert the gateway has not been disposed. */
  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('dsh-plugin-desktop: file preview gateway is disposed')
  }

  /** Register a read that dispose may abort, returning its end callback. */
  private beginRead(signal: AbortSignal): { controller: AbortController; end(): void } {
    const controller = new AbortController()
    let finished = false
    const onAbort = (): void => controller.abort()
    if (signal.aborted) {
      controller.abort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const active: ActiveRead = {
      controller,
      removeListener: () => signal.removeEventListener('abort', onAbort),
    }
    this.activeReads.add(active)
    return {
      controller,
      end: () => {
        if (finished) return
        finished = true
        this.activeReads.delete(active)
        active.removeListener()
      },
    }
  }

  /** Decode bytes as fatal UTF-8, stripping a leading BOM; undefined on failure. */
  private decodeUtf8Fatal(bytes: Uint8Array): string | undefined {
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const withoutBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
      return decoder.decode(withoutBom)
    } catch {
      return undefined
    }
  }

  /** Apply the loopback data-plane trust fence to one image request. */
  private trustedImageRequest(req: IncomingMessage): boolean {
    if (req.headers.host !== this.loopback.host) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = req.headers.origin
    if (origin !== undefined && origin !== this.loopback.origin) return false
    return true
  }

  /** Build response headers for a validated image payload. */
  private imageResponseHeaders(mediaType: string, byteLength: number): Record<string, string> {
    return {
      'Content-Type': mediaType,
      'Content-Length': String(byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...(mediaType === 'image/svg+xml'
        ? { 'Content-Security-Policy': "default-src 'none'; style-src 'none'" }
        : {}),
    }
  }

  /** Extract the resource id segment out of an image data-plane URL. */
  private imageResourceIdFromUrl(rawUrl: string | undefined): FilePreviewResourceId | undefined {
    if (rawUrl === undefined) return undefined
    const pathname = new URL(rawUrl, 'http://x').pathname
    const prefix = `${FILE_PREVIEW_BINARY_PREFIX}/`
    if (!pathname.startsWith(prefix)) return undefined
    const id = pathname.slice(prefix.length)
    if (id.length === 0 || id.includes('/')) return undefined
    return brandResourceId(id)
  }

  /** Base name of a path; the last path segment or the path itself when empty. */
  private baseNameOf(path: string): string {
    const normalized = path.replace(/\\/g, '/')
    const index = normalized.lastIndexOf('/')
    return index === -1 ? normalized : normalized.slice(index + 1)
  }

  /** Whether metadata describes a regular file with a finite non-negative size. */
  private isRegularFile(info: FilePreviewFsInfo | undefined): info is RegularFileInfo {
    return info !== undefined && info.type === 'file'
      && typeof info.size === 'number' && Number.isFinite(info.size) && info.size >= 0
  }
}

/** Whether a thrown value is an abort signal (DOM AbortError or fs FS_ABORTED). */
function isAbortError(error: unknown): boolean {
  if (error instanceof FsError) return error.code === 'FS_ABORTED'
  if (typeof error === 'object' && error !== null) {
    const record = error as { name?: unknown }
    return record.name === 'AbortError'
  }
  return false
}

/** Validate the magic bytes of a served image against its declared media type. */
function validateImageSignature(mediaType: string, bytes: Uint8Array): boolean {
  switch (mediaType) {
    case 'image/png':
      return bytes.length >= 8
        && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'image/gif':
      return bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
        && bytes[3] === 0x38
    case 'image/webp':
      return bytes.length >= 12
        && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    case 'image/svg+xml':
      return probeSvgRoot(bytes)
    default:
      return false
  }
}

/** Probe whether bytes are an SVG whose root element is `<svg`. */
function probeSvgRoot(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text
  const withoutDeclaration = withoutBom.replace(/^<\?xml[\s\S]*?\?>\s*/i, '')
  return /^<svg(?:\s|>)/i.test(withoutDeclaration.trimStart())
}
