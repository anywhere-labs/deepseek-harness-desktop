/**
 * JSONL durable session-persistence backend. It stores a header and contiguous
 * events in one append-only file per session, and delegates orchestration to
 * {@link PersistenceCoordinator}. Its side-effect-free locator returns the
 * absolute per-session log target before materialization.
 * @module @deepseek-ai/dsh-session-persistence-jsonl
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readdirSync } from 'node:fs'
import { open, mkdir, readFile, readdir, realpath, link, rm, stat, truncate, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, MAX_WRITE_BATCH_DELAY_MS,
  SessionPersistence, SessionPersistenceRevision, PersistenceCoordinator, SessionFormatUnsupportedError,
  type PersistenceBackend, type SessionLocation, type SessionPersistenceSnapshot,
  type SessionInspection, type SessionPersistenceRevision as PersistenceRevision, type SessionRawArtifact,
  type StoredPrefix,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionId, SessionHeader, SessionPreparation } from '@deepseek-ai/dsh-session'
import {
  encodeSegment, eventLines, logPath, logSuffix, parseHeaderMeta, projectDir, scanLog, sessionDir,
  SessionLogScanner, toHeaderLine,
  type JsonlCompression,
} from './format.ts'
import {
  compressZstdFrame, createZstdFrameDecoder, decompressZstdFrame, decompressZstdPrefix, scanZstdFrames,
} from './zstd.ts'
import { ensureDurableDirectoryWin32, publishNewFileWin32 } from './win32.ts'

export type { JsonlCompression } from './format.ts'

const DEFAULT_PACK_CHUNKS = true
const DEFAULT_COMPRESSION: JsonlCompression = 'zstd'
/**
 * Internal scheduling constant, not deployment configuration: balance
 * frame-boundary event-loop yields against `setImmediate` overhead. One frame
 * remains an indivisible synchronous decode.
 */
const ZSTD_DECODE_YIELD_INTERVAL_MS = 500

/** Assert that the independently decodable first frame contains only the header record. */
function assertZstdHeaderFrame(plaintext: Buffer): void {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
}

/** Loader schema for the JSONL artifact's physical encoding. */
export const JsonlCompressionSchema: z<JsonlCompression> = z.union([
  z.const('zstd'),
  z.const('none'),
]).default(DEFAULT_COMPRESSION)

/** Plugin config: where the JSONL backend keeps its session logs, and the packed-row write switch. */
export interface Config {
  /**
   * Root directory for all session files. Required (no default): a default of
   * `process.cwd()` would scatter session files as the process's cwd changes
   * (bash calls, subprocesses). Sessions group under human-readable project
   * directories, then per-session directories. An existing root must be a
   * readable directory; an absent root is created on first materialization.
   */
  root: string
  /**
   * Write runs of consecutive `assistant/chunk` delta events as packed
   * `text-chunks`/`reasoning-chunks`/`tool-call-chunks` rows (lossless,
   * ~60% smaller logs measured on a real session). Defaults to true; false
   * keeps one `SessionEvent` per line for diagnostics. Reading packed rows is
   * unconditional: a log's layout never depends on this switch.
   */
  packChunks?: boolean
  /** Physical encoding; defaults to checksummed Zstandard frames. */
  compression?: JsonlCompression
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
}

/** Opaque coordinator token for replacing bytes recovered from a torn frame. */
interface JsonlTornMarker {
  truncateTo: number
  recoveredEvents: SessionEvent[]
}

interface FileRevisionIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

/** Build the source-qualified revision shared by full and lightweight reads. */
function fileRevision(identity: FileRevisionIdentity): PersistenceRevision {
  return SessionPersistenceRevision([
    identity.dev,
    identity.ino,
    identity.size,
    identity.mtimeNs,
    identity.ctimeNs,
  ].join(':'))
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * The JSONL persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and (via the coordinator) installs the write-path
 * listeners. Its torn-tail marker carries the byte offset and any events
 * recovered from an incomplete final Zstandard frame.
 */
export class JsonlSessionPersistence extends SessionPersistence implements PersistenceBackend<JsonlTornMarker> {
  override readonly supportsRawArtifacts = true

  static inject = ['sessions']

  static Config: z<Config> = z.object({
    root: z.string().required(),
    packChunks: z.boolean().default(DEFAULT_PACK_CHUNKS),
    compression: JsonlCompressionSchema,
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  /**
   * Backend label for coordinator diagnostics and effects. It shadows
   * `Service.name` without changing the service key captured by the base
   * constructor.
   */
  override readonly name = 'session-persistence-jsonl'

  private root: string
  private packChunks: boolean
  private compression: JsonlCompression
  private coordinator: PersistenceCoordinator<JsonlTornMarker>
  private rootEncodingCheck: Promise<void> | undefined

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Resolve once so later process.cwd() changes cannot split one backend across roots.
    this.root = resolve(config.root)
    // Programmatic wrappers may construct the backend without Schemastery normalization.
    const preparedSessionCacheSize = config.preparedSessionCacheSize
      ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE
    const writeBatchMaxDelayMs = config.writeBatchMaxDelayMs
      ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS
    this.packChunks = config.packChunks ?? DEFAULT_PACK_CHUNKS
    this.compression = config.compression ?? DEFAULT_COMPRESSION
    this.assertUsableRoot()
    this.coordinator = new PersistenceCoordinator<JsonlTornMarker>(this.ctx, this, {
      preparedSessionCacheSize,
      writeBatchMaxDelayMs,
    })
  }

  // Each backend keeps the typed service API beside its storage hooks;
  // extracting these trivial forwards would add an inheritance layer.
  /* jscpd:ignore-start */
  // --- SessionPersistence service API (delegated to the coordinator) ---

  /** Resolve the absolute target path without touching the filesystem. */
  locate(meta: SessionHeader): SessionLocation {
    return { kind: 'jsonl', path: logPath(this.root, meta.cwd, meta.id, this.compression) }
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  truncate(id: SessionId, toSeq: number): Promise<void> {
    return this.coordinator.truncate(id, toSeq)
  }

  remove(id: SessionId): Promise<void> {
    return this.coordinator.remove(id)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  // JSONL is sequential media: no loadStoredFrom hook, so the coordinator
  // parses the stored prefix (both encodings) and skips forward to fromSeq.
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  // One method serves both public `list` and the backend hook; delegating it to
  // the coordinator would call this hook recursively.

  /* jscpd:ignore-end */
  // --- PersistenceBackend hooks (the file-bytes storage primitives) ---

  /** Read a stored prefix by id across all project directories when cwd is unknown. */
  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<JsonlTornMarker> | undefined> {
    signal?.throwIfAborted()
    await this.ensureRootEncoding()
    signal?.throwIfAborted()
    const path = await this.findLog(id, signal)
    if (path === undefined) return undefined
    return this.readPrefix(path, id, signal)
  }

  /**
   * Read one log's stat-derived revision without loading its event bytes.
   * Resolving an id with unknown cwd still scans the project directories.
   */
  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    signal?.throwIfAborted()
    await this.ensureRootEncoding()
    signal?.throwIfAborted()
    const path = await this.findLog(id, signal)
    if (path === undefined) return undefined
    try {
      const identity = await stat(path, { bigint: true })
      signal?.throwIfAborted()
      return fileRevision(identity)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  /**
   * Read a session's stored artifact text verbatim: the durable file bytes
   * decoded from this backend's physical encoding (complete zstd frames
   * concatenated, or UTF-8 plaintext). The content is the exact JSONL text the
   * backend wrote — never a reconstruction from parsed events — so packed-
   * chunk rows, key order, and line breaks survive byte-for-byte. A torn
   * final frame is omitted, matching the committed-prefix semantics of every
   * other read.
   * @param id - the persisted session to read.
   * @param signal - optional cancellation for the stat/read/decode work.
   * @returns the raw artifact text plus the header parsed from its own first
   * line, or `undefined` when the session has no stored artifact.
   */
  override async readRaw(id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined> {
    signal?.throwIfAborted()
    await this.ensureRootEncoding()
    signal?.throwIfAborted()
    const path = await this.findLog(id, signal)
    if (path === undefined) return undefined
    const { buffer } = await this.readStableFile(path, signal)
    let content: string
    if (this.compression === 'zstd') {
      const { frames } = scanZstdFrames(buffer)
      if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
      const decoder = createZstdFrameDecoder()
      const plaintexts: Buffer[] = []
      // The decoder yields views into a reused buffer; copy each frame's
      // plaintext immediately so a later concat cannot read overwritten memory.
      for (const plaintext of decoder.decode(buffer, frames)) {
        signal?.throwIfAborted()
        plaintexts.push(Buffer.from(plaintext))
      }
      content = Buffer.concat(plaintexts).toString('utf8')
    } else {
      content = buffer.toString('utf8')
    }
    const meta = parseHeaderMeta(content.split('\n', 1)[0] as string)
    if (meta === undefined || meta.id !== id) {
      throw new Error(`corrupt session log: invalid header line in "${path}"`)
    }
    // The logical artifact name is `session.jsonl` regardless of the physical
    // encoding suffix (`.jsonl.zstd` marks compression only).
    return { meta, filename: 'session.jsonl', content }
  }

  /**
   * Read a file's bytes under a revision-stable loop: a writer appending
   * between stat and readFile would yield a torn physical file, so retry
   * while the stat revision changes.
   * @param path - the artifact file to read.
   * @param signal - optional cancellation for the stat/read work.
   * @returns the stable bytes and the revision that matched both stats.
   */
  private async readStableFile(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ buffer: Buffer; revision: PersistenceRevision }> {
    for (;;) {
      signal?.throwIfAborted()
      const before = fileRevision(await stat(path, { bigint: true }))
      const buffer = await readFile(path, { signal })
      signal?.throwIfAborted()
      const after = fileRevision(await stat(path, { bigint: true }))
      if (before === after) return { buffer, revision: after }
    }
  }

  /**
   * Read a stored prefix and convert torn-tail state to the opaque marker the
   * coordinator can round-trip without knowing the physical encoding.
   */
  private async readPrefix(
    path: string,
    expectedId?: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix<JsonlTornMarker>> {
    const { buffer, revision } = await this.readStableFile(path, signal)
    let prefix: Omit<StoredPrefix<JsonlTornMarker>, 'revision'>
    try {
      if (this.compression === 'zstd') {
        prefix = await this.readZstdPrefix(buffer, signal)
      } else {
        signal?.throwIfAborted()
        const { meta, events, committedBytes } = scanLog(buffer)
        signal?.throwIfAborted()
        prefix = {
          meta,
          events,
          ...committedBytes < buffer.byteLength
            ? { tornMarker: { truncateTo: committedBytes, recoveredEvents: [] } }
            : {},
        }
      }
    } catch (error: unknown) {
      // A parse-time format refusal predates any SessionHeader, so the
      // coordinator's locate-based enrichment cannot run; attach the artifact
      // this read actually refused.
      if (error instanceof SessionFormatUnsupportedError && error.location === undefined) {
        throw new SessionFormatUnsupportedError(`${error.message} (raw log: ${path})`, { kind: 'jsonl', path })
      }
      throw error
    }
    signal?.throwIfAborted()
    await this.assertStoredIdentity(path, prefix.meta, expectedId, signal)
    signal?.throwIfAborted()
    return { ...prefix, revision }
  }

  /** Decode complete frames and retain complete JSONL records from a torn final frame. */
  private async readZstdPrefix(
    buffer: Buffer,
    signal?: AbortSignal,
  ): Promise<Omit<StoredPrefix<JsonlTornMarker>, 'revision'>> {
    signal?.throwIfAborted()
    const { frames, tornStart } = scanZstdFrames(buffer)
    signal?.throwIfAborted()
    if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')

    const decoder = createZstdFrameDecoder()
    let yieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS
    try {
      const decodedFrames = decoder.decode(buffer, frames)
      signal?.throwIfAborted()
      const headerFrame = decodedFrames.next()
      signal?.throwIfAborted()
      /* v8 ignore next -- a non-empty structural frame list makes the decoder yield its first frame or throw. */
      if (headerFrame.done) throw new Error('empty or header-less Zstandard session log')
      assertZstdHeaderFrame(headerFrame.value)
      const scanner = new SessionLogScanner(headerFrame.value)

      let remainingFrames = frames.length - 1
      for (const plaintext of decodedFrames) {
        signal?.throwIfAborted()
        scanner.write(plaintext)
        remainingFrames -= 1
        if (remainingFrames > 0 && performance.now() >= yieldDeadline) {
          await scheduler.yield()
          signal?.throwIfAborted()
          yieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS
        }
      }
      signal?.throwIfAborted()
      const complete = scanner.checkpoint()
      if (complete.committedBytes !== complete.inputBytes) {
        throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
      }
      if (tornStart === undefined) {
        const prefix = scanner.finish()
        return { meta: prefix.meta, events: prefix.events }
      }

      let recoveredPlaintext: Buffer = Buffer.alloc(0)
      try {
        signal?.throwIfAborted()
        recoveredPlaintext = await decompressZstdPrefix(buffer.subarray(tornStart))
      } catch {
        /* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
        if (signal?.aborted) signal.throwIfAborted()
        // A structurally incomplete final frame may end before Node's decoder can
        // emit any plaintext; the complete prior frames remain recoverable.
      }
      signal?.throwIfAborted()
      scanner.write(recoveredPlaintext)
      const recoveredPrefix = scanner.finish()
      signal?.throwIfAborted()
      return {
        meta: recoveredPrefix.meta,
        events: recoveredPrefix.events,
        tornMarker: {
          truncateTo: tornStart,
          recoveredEvents: recoveredPrefix.events.slice(complete.eventCount),
        },
      }
    } catch (error) {
      /* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
      if (signal?.aborted) signal.throwIfAborted()
      throw error
    } finally {
      decoder.close()
    }
  }

  /** Durably append a batch, lazily materializing the file when not yet present. */
  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    await this.ensureRootEncoding()
    if (isMaterialized) {
      await this.appendLines(meta, events)
    } else {
      await this.materialize(meta, events)
    }
  }

  /**
   * Make a crash repair durable: truncate a torn tail, restore complete events
   * decoded from it, then append synthetic closers. Two fsync'd steps — the seam
   * does not require this to be atomic.
   */
  async commitRepair(
    meta: SessionHeader,
    tornMarker: JsonlTornMarker | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    if (tornMarker !== undefined) await this.repair(meta, tornMarker.truncateTo)
    const repairedEvents = [...(tornMarker?.recoveredEvents ?? []), ...closers]
    if (repairedEvents.length > 0) await this.appendLines(meta, repairedEvents)
  }

  /**
   * Truncate the stored log to the events with `seq < toSeq` by rewriting the
   * artifact atomically: decode the committed prefix, drop the suffix,
   * re-encode, and publish over the existing file (POSIX rename replaces
   * atomically; Windows removes then publishes the staged file).
   * @param meta - the stored session header.
   * @param toSeq - first event seq to drop; validated by the coordinator.
   */
  async truncateAt(meta: SessionHeader, toSeq: number): Promise<void> {
    await this.ensureRootEncoding()
    const path = logPath(this.root, meta.cwd, meta.id, this.compression)
    const stored = await this.readPrefix(path, meta.id)
    if (toSeq > stored.events.length) {
      throw new Error(
        `truncate toSeq ${toSeq} exceeds stored event count ${stored.events.length} for "${meta.id}"`,
      )
    }
    const prefix = stored.events.filter(event => event.seq < toSeq)
    const content = await this.encodeMaterialization(meta, prefix)
    const tmp = await this.writeSyncedTempFile(path, content)
    try {
      /* v8 ignore next -- native Windows coverage exercises this platform dispatch; Linux covers the POSIX peer */
      if (process.platform === 'win32') {
        await rm(path, { force: true })
        await publishNewFileWin32(tmp, path)
      } else {
        await rename(tmp, path)
        await this.syncDirPosix(dirname(path))
      }
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }

  /** List valid unique stored sessions' metadata (header line only — no full-log parse). */
  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return (await this.listArtifacts(signal)).map(artifact => artifact.header)
  }

  /**
   * Delete one stored session's artifact: remove its session directory under
   * every project scope that could hold it (the coordinator resolves identity
   * by id alone, so the physical log may live under any cwd).
   * @param id - persisted session to remove.
   */
  async removeStored(id: SessionId): Promise<void> {
    await this.ensureRootEncoding()
    let removed = false
    for (const project of await this.listProjectDirs()) {
      await this.rejectLegacyFlatArtifact(project, id)
      const dir = join(project, encodeSegment(id))
      if (await this.exists(dir)) {
        await rm(dir, { recursive: true, force: true })
        /* v8 ignore next -- native Windows coverage exercises this platform dispatch; Linux covers the POSIX peer */
        if (process.platform !== 'win32') await this.syncDirPosix(project)
        removed = true
      }
    }
    if (!removed) throw new Error(`session "${id}" not found`)
  }

  /** List metadata plus a stat-derived identity for each append-only log. */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    const snapshots: SessionPersistenceSnapshot[] = []
    for (const artifact of await this.listArtifacts(signal)) {
      signal?.throwIfAborted()
      try {
        const identity = await stat(artifact.path, { bigint: true })
        signal?.throwIfAborted()
        snapshots.push({
          header: artifact.header,
          revision: fileRevision(identity),
        })
      } catch (error: unknown) {
        signal?.throwIfAborted()
        if (!isENOENT(error)) throw error
      }
    }
    signal?.throwIfAborted()
    return snapshots
  }

  private async listArtifacts(signal?: AbortSignal): Promise<Array<{ header: SessionHeader; path: string }>> {
    signal?.throwIfAborted()
    await this.ensureRootEncoding()
    signal?.throwIfAborted()
    const artifacts: Array<{ header: SessionHeader; path: string }> = []
    const ids = new Set<SessionId>()
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted()
      for (const dir of await this.listSessionDirs(project, signal)) {
        signal?.throwIfAborted()
        const opposite = join(dir, `session${logSuffix(this.oppositeCompression())}`)
        const oppositeExists = await this.exists(opposite)
        signal?.throwIfAborted()
        if (oppositeExists) throw this.encodingMismatch(opposite)
        const path = join(dir, `session${logSuffix(this.compression)}`)
        const pathExists = await this.exists(path)
        signal?.throwIfAborted()
        if (!pathExists) continue
        // Read only headers so listing scales with session count, not log size.
        const first = this.compression === 'zstd'
          ? await this.readFirstZstdLine(path, signal)
          : await this.readFirstLine(path, signal)
        signal?.throwIfAborted()
        if (first === undefined) continue // empty/half-written file
        const meta = parseHeaderMeta(first)
        if (meta === undefined) continue // not a session header
        await this.assertStoredIdentity(path, meta, undefined, signal)
        signal?.throwIfAborted()
        if (ids.has(meta.id)) {
          throw new Error(`duplicate JSONL session id "${meta.id}" appears in multiple project directories`)
        }
        ids.add(meta.id)
        artifacts.push({ header: meta, path })
      }
    }
    signal?.throwIfAborted()
    return artifacts
  }

  // --- materialization / append / repair (file mechanics) ---

  /** Atomically write the header line + first batch (temp-write, fsync, publish). */
  private async materialize(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const project = projectDir(this.root, meta.cwd)
    const dir = sessionDir(this.root, meta.cwd, meta.id)
    const finalPath = logPath(this.root, meta.cwd, meta.id, this.compression)
    await this.rejectOppositeArtifact(meta.cwd, meta.id)
    const content = await this.encodeMaterialization(meta, events)
    /* v8 ignore next -- native Windows coverage exercises this platform dispatch; Linux covers the POSIX peer */
    if (process.platform === 'win32') {
      await this.materializeWin32(project, dir, finalPath, meta.id, content)
    } else {
      await this.materializePosix(project, dir, finalPath, meta.id, content)
    }
  }

  /* v8 ignore start -- Windows uses the Win32 durable-publish path; POSIX coverage exercises this peer. */
  private async materializePosix(
    project: string,
    dir: string,
    finalPath: string,
    id: SessionId,
    content: Buffer | string,
  ): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(dirname(this.root))
    await mkdir(project, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(this.root)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(project)
    await this.rejectExistingLog(finalPath, id)
    const tmp = await this.writeSyncedTempFile(finalPath, content)
    // Publish via link()+unlink(), NOT rename(): link fails with EEXIST if the
    // final path already exists, so two processes materializing the same id
    // concurrently cannot clobber each other. rename() would silently overwrite.
    let linked = false
    try {
      await link(tmp, finalPath)
      linked = true
    } finally {
      // Remove an unpublished temp on failure. After publication, defer cleanup
      // until the directory entry is durable so cleanup cannot reject a live log.
      /* v8 ignore next -- link failure is the TOCTOU/IO race guarded above; not reachable in test */
      if (!linked) await rm(tmp, { force: true })
    }
    // link() succeeded — the log is published. fsync the directory so the new
    // entry survives a power loss: the new link is not crash-durable until the
    // parent directory's metadata is synced.
    await this.syncDirPosix(dir)
    // Best-effort temp cleanup: the log is already published and durable, so a
    // failure to remove the (now-redundant) temp hard link must NOT reject the
    // append. Swallow only the rm failure; nothing else of consequence runs here.
    try {
      await rm(tmp, { force: true })
    } catch {
      /* v8 ignore next -- redundant temp link; publish already durable, rm failure is an unreachable IO edge */
    }
  }
  /* v8 ignore stop */

  /* v8 ignore start -- native Windows coverage exercises this integration path */
  private async materializeWin32(
    project: string,
    dir: string,
    finalPath: string,
    id: SessionId,
    content: Buffer | string,
  ): Promise<void> {
    await ensureDurableDirectoryWin32(this.root)
    await ensureDurableDirectoryWin32(project)
    await ensureDurableDirectoryWin32(dir)
    await this.rejectExistingLog(finalPath, id)
    const tmp = await this.writeSyncedTempFile(finalPath, content)
    try {
      await publishNewFileWin32(tmp, finalPath)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }
  /* v8 ignore stop */

  private async rejectExistingLog(finalPath: string, id: SessionId): Promise<void> {
    // Never publish over an existing committed log: materialize is the first
    // write of a session the backend believes is new. A file here means a
    // different session shares this id on disk — reject loudly. (createCore
    // already guards the create path, so this is unreachable-in-practice TOCTOU
    // defense.)
    /* v8 ignore next 3 -- createCore guards collisions before materialize; this is a TOCTOU backstop */
    if (await this.exists(finalPath)) {
      throw new Error(`refusing to materialize "${id}": a log already exists on disk (load/resume it instead)`)
    }
  }

  private async writeSyncedTempFile(finalPath: string, content: Buffer | string): Promise<string> {
    const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return tmp
  }

  /** Encode the header and first batch without combining their frame boundaries. */
  private async encodeMaterialization(meta: SessionHeader, events: readonly SessionEvent[]): Promise<Buffer | string> {
    const header = JSON.stringify(toHeaderLine(meta)) + '\n'
    const body = eventLines(events, this.packChunks) + '\n'
    if (this.compression === 'none') return header + body
    const headerFrame = await compressZstdFrame(header)
    const eventFrame = await compressZstdFrame(body)
    return Buffer.concat([headerFrame, eventFrame])
  }

  /** Encode one durable append batch in the configured physical representation. */
  private async encodeEventBatch(events: readonly SessionEvent[]): Promise<Buffer | string> {
    const body = eventLines(events, this.packChunks) + '\n'
    return this.compression === 'zstd' ? compressZstdFrame(body) : body
  }

  /** fsync a POSIX directory so a just-created/renamed entry is crash-durable. */
  /* v8 ignore start -- Windows uses write-through namespace operations; POSIX coverage exercises directory fsync. */
  private async syncDirPosix(dir: string): Promise<void> {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  /* v8 ignore stop */

  /**
   * Append and fsync event lines. On a partial write or sync failure, restore the
   * previous size before rethrowing because the unchanged cursor will retry the
   * batch; leaving partial bytes would create duplicate sequence numbers.
   */
  private async appendLines(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const content = await this.encodeEventBatch(events)
    const path = logPath(this.root, meta.cwd, meta.id, this.compression)
    const handle = await open(path, 'a')
    let closed = false
    const closeAppendHandle = async (): Promise<void> => {
      if (closed) return
      closed = true
      await handle.close()
    }

    try {
      const { size: before } = await handle.stat()
      try {
        await handle.writeFile(content)
        await handle.sync()
      } catch (error) {
        try {
          await closeAppendHandle()
          await this.rollbackAppend(path, before)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `failed to roll back append to "${path}"`)
        }
        throw error
      }
    } finally {
      await closeAppendHandle()
    }
  }

  private async rollbackAppend(path: string, size: number): Promise<void> {
    const handle = await open(path, 'r+')
    try {
      await handle.truncate(size)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /** Truncate the log file to `offset` bytes and fsync (discard the crash tail). */
  private async repair(meta: SessionHeader, offset: number): Promise<void> {
    const path = logPath(this.root, meta.cwd, meta.id, this.compression)
    await truncate(path, offset)
    const handle = await open(path, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  // --- discovery helpers ---

  /**
   * Read the first newline-terminated line of a file without loading the whole
   * file. Returns undefined if the file is empty or has no complete first line.
   * Reads in bounded chunks so a huge log costs only the header read.
   */
  private async readFirstLine(path: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const handle = await open(path, 'r')
    try {
      signal?.throwIfAborted()
      const chunks: Buffer[] = []
      const buf = Buffer.alloc(8192)
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buf, 0, buf.length, null)
        signal?.throwIfAborted()
        if (bytesRead === 0) return undefined // EOF with no newline → no complete line
        const slice = buf.subarray(0, bytesRead)
        const nl = slice.indexOf(0x0a)
        if (nl !== -1) {
          chunks.push(slice.subarray(0, nl))
          signal?.throwIfAborted()
          return Buffer.concat(chunks).toString('utf8')
        }
        chunks.push(Buffer.from(slice))
      }
    } finally {
      await handle.close()
    }
  }

  /** Read and validate only the independently compressed header frame. */
  private async readFirstZstdLine(path: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const handle = await open(path, 'r')
    try {
      signal?.throwIfAborted()
      let content = Buffer.alloc(0)
      const chunk = Buffer.alloc(8192)
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        signal?.throwIfAborted()
        if (bytesRead === 0) return undefined
        signal?.throwIfAborted()
        content = Buffer.concat([content, chunk.subarray(0, bytesRead)])
        signal?.throwIfAborted()
        const first = scanZstdFrames(content, 1).frames[0]
        signal?.throwIfAborted()
        if (first === undefined) continue
        let plaintext: Buffer
        try {
          signal?.throwIfAborted()
          plaintext = await decompressZstdFrame(content.subarray(first.start, first.end))
        } catch (error) {
          /* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
          if (signal?.aborted) signal.throwIfAborted()
          throw new Error('corrupt Zstandard session log: header frame failed validation', { cause: error })
        }
        signal?.throwIfAborted()
        assertZstdHeaderFrame(plaintext)
        return plaintext.subarray(0, -1).toString('utf8')
      }
    } finally {
      await handle.close()
    }
  }

  /** Find the unique physical log for an id across every project directory. */
  private async findLog(id: SessionId, signal?: AbortSignal): Promise<string | undefined> {
    const matches: string[] = []
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted()
      await this.rejectLegacyFlatArtifact(project, id, signal)
      signal?.throwIfAborted()
      const dir = join(project, encodeSegment(id))
      const path = join(dir, `session${logSuffix(this.compression)}`)
      const opposite = join(dir, `session${logSuffix(this.oppositeCompression())}`)
      const oppositeExists = await this.exists(opposite)
      signal?.throwIfAborted()
      if (oppositeExists) throw this.encodingMismatch(opposite)
      const pathExists = await this.exists(path)
      signal?.throwIfAborted()
      if (pathExists) matches.push(path)
    }
    if (matches.length > 1) {
      throw new Error(`duplicate JSONL session id "${id}" appears in multiple project directories`)
    }
    signal?.throwIfAborted()
    return matches[0]
  }

  /** Require an existing configured root to be a readable directory. */
  private assertUsableRoot(): void {
    try {
      readdirSync(this.root)
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
  }

  /** Reject metadata that does not identify the selected physical log. */
  private async assertStoredIdentity(
    path: string,
    meta: SessionHeader,
    expectedId?: SessionId,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    if (expectedId !== undefined && meta.id !== expectedId) {
      throw new Error(`corrupt session log "${path}": requested id "${expectedId}" does not match header id "${meta.id}"`)
    }
    let expectedPath: string
    try {
      expectedPath = logPath(this.root, meta.cwd, meta.id, this.compression)
    } catch (error) {
      throw new Error(`corrupt session log "${path}": header id cannot name a storage path`, { cause: error })
    }
    if (path !== expectedPath && !await this.sameFile(path, expectedPath, signal)) {
      throw new Error(`corrupt session log "${path}": header id "${meta.id}" and cwd identify "${expectedPath}"`)
    }
    signal?.throwIfAborted()
  }

  /**
   * Whether two path spellings resolve to the same physical file. This admits
   * case aliases on case-insensitive filesystems without weakening identity
   * checks on case-sensitive stores.
   */
  private async sameFile(path: string, expectedPath: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    try {
      const [actual, expected] = await Promise.all([realpath(path), realpath(expectedPath)])
      signal?.throwIfAborted()
      return actual === expected
    } catch (error) {
      signal?.throwIfAborted()
      /* v8 ignore else -- non-ENOENT realpath failures require an external permission or I/O fault */
      if (isENOENT(error)) return false
      /* v8 ignore next -- non-ENOENT realpath failures are external I/O faults, propagated unchanged */
      throw error
    }
  }

  /** The human-readable project directories under the configured root. */
  private async listProjectDirs(signal?: AbortSignal): Promise<string[]> {
    try {
      signal?.throwIfAborted()
      const entries = await readdir(this.root, { withFileTypes: true })
      signal?.throwIfAborted()
      return entries.filter(e => e.isDirectory()).map(e => join(this.root, e.name))
    } catch (error) {
      // Only an absent root means no sessions; rethrow every other I/O failure.
      if (isENOENT(error)) return []
      throw error
    }
  }

  /** List session-owned directories and reject the obsolete flat-file layout. */
  private async listSessionDirs(project: string, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted()
    const entries = await readdir(project, { withFileTypes: true })
    signal?.throwIfAborted()
    const legacy = entries.find(entry =>
      entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')))
    if (legacy !== undefined) throw this.legacyLayout(join(project, legacy.name))
    return entries.filter(entry => entry.isDirectory()).map(entry => join(project, entry.name))
  }

  /** Reject a root that already belongs to the other physical encoding. */
  private ensureRootEncoding(): Promise<void> {
    this.rootEncodingCheck ??= this.checkRootEncoding()
    return this.rootEncodingCheck
  }

  private async checkRootEncoding(): Promise<void> {
    for (const project of await this.listProjectDirs()) {
      for (const dir of await this.listSessionDirs(project)) {
        const incompatible = join(dir, `session${logSuffix(this.oppositeCompression())}`)
        if (await this.exists(incompatible)) throw this.encodingMismatch(incompatible)
      }
    }
  }

  private async rejectLegacyFlatArtifact(
    project: string,
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const encoded = encodeSegment(id)
    for (const compression of ['zstd', 'none'] as const) {
      const path = join(project, encoded + logSuffix(compression))
      const artifactExists = await this.exists(path)
      signal?.throwIfAborted()
      if (artifactExists) throw this.legacyLayout(path)
    }
  }

  private async rejectOppositeArtifact(cwd: string | undefined, id: SessionId): Promise<void> {
    const path = logPath(this.root, cwd, id, this.oppositeCompression())
    if (await this.exists(path)) throw this.encodingMismatch(path)
  }

  private oppositeCompression(): JsonlCompression {
    return this.compression === 'zstd' ? 'none' : 'zstd'
  }

  private encodingMismatch(path: string): Error {
    return new Error(
      `session artifact ${JSON.stringify(path)} uses ${logSuffix(this.oppositeCompression())}, `
      + `but this backend is configured for compression ${JSON.stringify(this.compression)}; `
      + 'use a separate root or select the matching compression mode',
    )
  }

  private legacyLayout(path: string): Error {
    return new Error(
      `session artifact ${JSON.stringify(path)} uses the unsupported flat-file layout; `
      + 'use a separate root or move it into a project/session directory before loading',
    )
  }

  private async exists(path: string): Promise<boolean> {
    try {
      const handle = await open(path, 'r')
      await handle.close()
      return true
    } catch (error) {
      // Only ENOENT means absent. A permission/I/O error must surface rather
      // than letting load or collision checks proceed under false absence.
      // Windows reports ENOENT, not ENOTDIR, for `regular-file/child`; verify
      // the immediate parent so a blocked session directory remains a storage fault.
      /* v8 ignore else -- Windows reports file-valued parents as ENOENT; POSIX covers direct ENOTDIR. */
      if (isENOENT(error)) {
        await this.assertLogParentAllowsAbsence(path)
        return false
      }
      /* v8 ignore next -- Windows repairs ENOTDIR from ENOENT above; POSIX covers direct ENOTDIR. */
      throw error
    }
  }

  /* v8 ignore start -- native Windows coverage exercises this repair; POSIX open reports ENOTDIR before this point. */
  private async assertLogParentAllowsAbsence(path: string): Promise<void> {
    try {
      const parent = dirname(path)
      const info = await stat(parent)
      if (info.isDirectory()) return
      const error = new Error(`ENOTDIR: parent path exists but is not a directory: ${parent}`) as NodeJS.ErrnoException
      error.code = 'ENOTDIR'
      error.path = parent
      throw error
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
  }
  /* v8 ignore stop */
}

export default JsonlSessionPersistence
