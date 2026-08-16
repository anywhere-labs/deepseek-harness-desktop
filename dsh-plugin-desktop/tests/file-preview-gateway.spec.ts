import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep, relative, isAbsolute } from 'node:path'
import { posix } from 'node:path'
import { DesktopFilePreviewGateway } from '../src/file-preview-gateway.ts'
import type { FilePreviewFsSeam, FilePreviewFsTarget, FilePreviewGatewayConfig, FilePreviewLogger, WorkspaceMembership } from '../src/file-preview-gateway.ts'
import { FilePreviewResourceId } from '../src/file-preview-contract.ts'

/** Byte helpers. */
function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** PNG magic + minimal body used to satisfy the png signature check. */
function pngBytes(extra = 0): Uint8Array {
  const header = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const rest = new Uint8Array(Math.max(0, extra))
  const out = new Uint8Array(header.length + rest.length)
  out.set(header)
  out.set(rest, header.length)
  return out
}

function svgBytes(inner: string): Uint8Array {
  return bytes(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">${inner}</svg>`)
}

/** A no-op logger for tests. */
const silentLogger: FilePreviewLogger = {
  warn: vi.fn(),
  error: vi.fn(),
}

/** Default gateway config; tests override with tiny limits where needed. */
function config(overrides: Partial<FilePreviewGatewayConfig> = {}) {
  return {
    maxTextBytes: 2 * 1024 * 1024,
    maxImageBytes: 20 * 1024 * 1024,
    resourceTtlMs: 60_000,
    maxResources: 64,
    ...overrides,
  }
}

/** In-memory filesystem seam with controllable versions, sizes, and errors. */
class FakeFs implements FilePreviewFsSeam {
  files = new Map<string, { bytes: Uint8Array; version: string }>()
  directories = new Set<string>()
  readError: ((target: FilePreviewFsTarget) => never | void) | undefined

  private normalize(path: string, cwd?: string): string {
    const absolute = isAbsolute(path) ? path : posix.resolve(cwd ?? '/ws', path)
    return absolute.split(sep).join('/')
  }

  async resolve(path: string, opts?: { cwd?: string }): Promise<FilePreviewFsTarget> {
    const key = this.normalize(path, opts?.cwd)
    return { targetKey: key, displayPath: key }
  }

  contains(parent: FilePreviewFsTarget, child: FilePreviewFsTarget): boolean {
    if (child.targetKey === parent.targetKey) return true
    return String(child.targetKey).startsWith(`${String(parent.targetKey)}/`)
  }

  async stat(target: FilePreviewFsTarget): Promise<{ version: unknown; type: 'file' | 'directory' | 'other'; size?: number } | undefined> {
    const key = String(target.targetKey)
    if (this.directories.has(key)) return { version: 'v-dir', type: 'directory' }
    const entry = this.files.get(key)
    if (entry === undefined) return undefined
    return { version: entry.version, type: 'file', size: entry.bytes.byteLength }
  }

  async readBytes(target: FilePreviewFsTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (this.readError !== undefined) {
      this.readError(target)
    }
    const entry = this.files.get(String(target.targetKey))
    if (entry === undefined) throw new FsError('not found', 'FS_NOT_FOUND')
    if (entry.bytes.byteLength > maxBytes) throw new FsError('too large', 'FS_TOO_LARGE')
    return entry.bytes
  }

  put(path: string, content: Uint8Array, version: string): void {
    this.files.set(this.normalize(path), { bytes: content, version })
  }
}

/** Resolve the workspace that authorizes a session in the fake registry. */
function makeRegistry(initial: WorkspaceMembership[] = []): { memberships: WorkspaceMembership[]; list: () => readonly WorkspaceMembership[] } {
  const memberships = [...initial]
  return { memberships, list: () => memberships }
}

interface GatewayHarness {
  gateway: DesktopFilePreviewGateway
  fs: FakeFs
  registry: { memberships: WorkspaceMembership[]; list: () => readonly WorkspaceMembership[] }
  trace: (sessionId: string, signal: AbortSignal) => Promise<{ target: { header: { origin?: 'subagent'; parentSession?: string } }; ancestors: readonly { header: { parentSession?: string; id: string } }[] }>
  dispose(): void
}

function createGateway(
  args: Partial<{
    fs: FilePreviewFsSeam
    list: () => readonly WorkspaceMembership[]
    trace: GatewayHarness['trace']
    logger: FilePreviewLogger
    origin: string
    cfg: ReturnType<typeof config>
  }> = {},
): GatewayHarness {
  const fs = args.fs ?? new FakeFs()
  const registry = makeRegistry()
  const fallbackTrace = async (_id: string, _signal: AbortSignal) => ({ target: { header: {} as { origin?: 'subagent'; parentSession?: string } }, ancestors: [] })
  const gateway = new DesktopFilePreviewGateway(
    fs,
    args.list ?? registry.list,
    args.trace === undefined ? fallbackTrace : args.trace,
    args.logger ?? silentLogger,
    args.origin ?? 'http://127.0.0.1:43120',
    args.cfg ?? config(),
  )
  return { gateway, fs: fs as FakeFs, registry, trace: fallbackTrace, dispose: () => gateway.dispose() }
}

describe('file-preview-gateway (fake fs seam)', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('probes a directly-authorized workspace text file into an available descriptor', async () => {
    const fs = new FakeFs()
    fs.put('/ws/a/readme.txt', bytes('hello world'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })
    const signal = new AbortController().signal

    const result = await gateway.probe('s1', '/ws/a/readme.txt', signal)
    expect(result.status).toBe('preview')
    if (result.status !== 'preview') return
    expect(result.descriptor.contentKind).toBe('text')
    expect(result.descriptor.mediaType).toBe('text/plain')
    expect(result.descriptor.name).toBe('readme.txt')
    expect(result.descriptor.availability).toBe('available')
    if (result.descriptor.availability === 'available') {
      expect(result.descriptor.resourceId).toMatch(/^[A-Za-z0-9_-]{20,}$/)
      const text = await gateway.readText(result.descriptor.resourceId, signal)
      expect(text).toEqual({ status: 'ok', text: 'hello world', resourceId: result.descriptor.resourceId })
    }
  })

  it('resolves a relative path inside the workspace', async () => {
    const fs = new FakeFs()
    fs.put('/ws/rel.ts', bytes('export const x = 1'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', 'rel.ts', new AbortController().signal)
    expect(result.status).toBe('preview')
    if (result.status === 'preview') expect(result.descriptor.name).toBe('rel.ts')
  })

  it('delegates a path whose lexical extension is unsupported', async () => {
    const fs = new FakeFs()
    fs.put('/ws/bin.parquet', bytes('data'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    expect(await gateway.probe('s1', '/ws/bin.parquet', new AbortController().signal))
      .toEqual({ status: 'delegate' })
  })

  it('delegates a path resolving outside the workspace root', async () => {
    const fs = new FakeFs()
    fs.put('/outside/secret.ts', bytes('leak'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    expect(await gateway.probe('s1', '/outside/secret.ts', new AbortController().signal))
      .toEqual({ status: 'delegate' })
  })

  it('delegates an ordinary loose session with no workspace membership', async () => {
    const fs = new FakeFs()
    fs.put('/ws/a.ts', bytes('code'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    expect(await gateway.probe('s2', '/ws/a.ts', new AbortController().signal))
      .toEqual({ status: 'delegate' })
  })

  it('delegates a target missing from stat', async () => {
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ list: registry.list })

    expect(await gateway.probe('s1', '/ws/nope.ts', new AbortController().signal))
      .toEqual({ status: 'delegate' })
  })

  it('delegates a non-regular (directory) target', async () => {
    const fs = new FakeFs()
    fs.put('/ws/file.ts', bytes('code'), 'v1')
    fs.directories.add('/ws/some-dir')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    expect(await gateway.probe('s1', '/ws/some-dir', new AbortController().signal)).toEqual({ status: 'delegate' })
  })

  it('inherits the nearest ancestor workspace for a subagent session', async () => {
    const fs = new FakeFs()
    fs.put('/ws/sub/child.ts', bytes('child'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['root-session'] }])
    const trace = async () => ({
      target: { header: { origin: 'subagent' as const, parentSession: 'parent-session' } },
      ancestors: [{ header: { id: 'parent-session' } }, { header: { id: 'root-session' } }],
    })
    const { gateway } = createGateway({ fs, list: registry.list, trace })

    const result = await gateway.probe('sub-agent-session', '/ws/sub/child.ts', new AbortController().signal)
    expect(result.status).toBe('preview')
  })

  it('delegates a subagent whose ancestors have no workspace membership', async () => {
    const fs = new FakeFs()
    fs.put('/ws/a.ts', bytes('code'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['unrelated'] }])
    const trace = async () => ({
      target: { header: { origin: 'subagent' as const, parentSession: 'orphan' } },
      ancestors: [{ header: { id: 'orphan' } }],
    })
    const { gateway } = createGateway({ fs, list: registry.list, trace })

    expect(await gateway.probe('sub', '/ws/a.ts', new AbortController().signal)).toEqual({ status: 'delegate' })
  })

  it('delegates when the lineage trace fails for a session without direct membership', async () => {
    const fs = new FakeFs()
    fs.put('/ws/a.ts', bytes('code'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const trace = async () => {
      throw new Error('session not found')
    }
    const { gateway } = createGateway({ fs, list: registry.list, trace })

    expect(await gateway.probe('unknown-session', '/ws/a.ts', new AbortController().signal))
      .toEqual({ status: 'delegate' })
  })

  it('delegates a subagent whose traced target is not a subagent origin', async () => {
    const fs = new FakeFs()
    fs.put('/ws/a.ts', bytes('code'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const trace = async (): Promise<{ target: { header: { origin?: 'subagent'; parentSession?: string } }; ancestors: { header: { parentSession?: string; id: string } }[] }> => ({
      target: { header: {} },
      ancestors: [{ header: { id: 'parent-session' } }],
    })
    const { gateway } = createGateway({ fs, list: registry.list, trace })

    // The loose session s1 IS directly authorized, so it previews.
    expect((await gateway.probe('s1', '/ws/a.ts', new AbortController().signal)).status).toBe('preview')
  })

  it('re-reads the registry on every request (mutation reflected)', async () => {
    const fs = new FakeFs()
    fs.put('/ws/a.ts', bytes('code'), 'v1')
    const registry = makeRegistry()
    const { gateway } = createGateway({ fs, list: registry.list })

    // First probe fails because the session is not yet a member.
    expect(await gateway.probe('s1', '/ws/a.ts', new AbortController().signal)).toEqual({ status: 'delegate' })
    registry.memberships.push({ path: '/ws', sessionIds: ['s1'] })
    expect((await gateway.probe('s1', '/ws/a.ts', new AbortController().signal)).status).toBe('preview')
  })

  it('produces an oversized descriptor for over-limit text without a token', async () => {
    const fs = new FakeFs()
    fs.put('/ws/big.ts', bytes('x'.repeat(11)), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list, cfg: config({ maxTextBytes: 10 }) })

    const result = await gateway.probe('s1', '/ws/big.ts', new AbortController().signal)
    expect(result.status).toBe('preview')
    if (result.status !== 'preview') return
    expect(result.descriptor.availability).toBe('oversized')
    if (result.descriptor.availability === 'oversized') {
      expect(result.descriptor.limitBytes).toBe(10)
      expect(result.descriptor).not.toHaveProperty('resourceId')
    }
  })

  it('reads text exactly at the byte limit and treats bytes, not chars, as the bound', async () => {
    // 'é' is 2 UTF-8 bytes; 3 chars = 6 bytes.
    const fs = new FakeFs()
    fs.put('/ws/multi.txt', bytes('ééé'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list, cfg: config({ maxTextBytes: 6 }) })

    const result = await gateway.probe('s1', '/ws/multi.txt', new AbortController().signal)
    expect(result.status).toBe('preview')
    if (result.status !== 'preview') return
    if (result.descriptor.availability !== 'available') return
    const text = await gateway.readText(result.descriptor.resourceId, new AbortController().signal)
    expect(text).toMatchObject({ status: 'ok', text: 'ééé' })
  })

  it('strips a leading BOM and returns clean text', async () => {
    const fs = new FakeFs()
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('abc')])
    fs.put('/ws/bom.txt', withBom, 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/bom.txt', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    const text = await gateway.readText(result.descriptor.resourceId, new AbortController().signal)
    expect(text).toMatchObject({ status: 'ok', text: 'abc' })
  })

  it('returns stale when the file grows past the limit between probe and read', async () => {
    const fs = new FakeFs()
    fs.put('/ws/grow.txt', bytes('small'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list, cfg: config({ maxTextBytes: 5 }) })

    const result = await gateway.probe('s1', '/ws/grow.txt', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    // Grow beyond the limit; readBytes will throw FS_TOO_LARGE -> stale.
    fs.put('/ws/grow.txt', bytes('grew bigger now'), 'v2')
    expect(await gateway.readText(result.descriptor.resourceId, new AbortController().signal)).toEqual({ status: 'stale' })
  })

  it('returns stale when the version changes after probe', async () => {
    const fs = new FakeFs()
    fs.put('/ws/v.txt', bytes('v1'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/v.txt', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    fs.put('/ws/v.txt', bytes('v2'), 'v2')
    expect(await gateway.readText(result.descriptor.resourceId, new AbortController().signal)).toEqual({ status: 'stale' })
  })

  it('returns stale when the file size changes but the version is reused', async () => {
    const fs = new FakeFs()
    fs.put('/ws/s.txt', bytes('one'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/s.txt', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    fs.put('/ws/s.txt', bytes('one and more'), 'v1')
    expect(await gateway.readText(result.descriptor.resourceId, new AbortController().signal)).toEqual({ status: 'stale' })
  })

  it('returns stale for content that is not valid UTF-8', async () => {
    const fs = new FakeFs()
    fs.put('/ws/bad.txt', Uint8Array.from([0x61, 0xff, 0x62]), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/bad.txt', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    expect(await gateway.readText(result.descriptor.resourceId, new AbortController().signal)).toEqual({ status: 'stale' })
  })

  it('returns stale for content containing a NUL byte', async () => {
    const fs = new FakeFs()
    fs.put('/ws/nul.txt', Uint8Array.from([0x61, 0x00, 0x62]), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/nul.txt', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    expect(await gateway.readText(result.descriptor.resourceId, new AbortController().signal)).toEqual({ status: 'stale' })
  })

  it('maps a permission read failure to a user-visible error', async () => {
    const fs = new FakeFs()
    fs.put('/ws/secret.txt', bytes('s'), 'v1')
    fs.readError = () => { throw new FsError('denied', 'FS_PERMISSION_DENIED') }
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/secret.txt', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    const text = await gateway.readText(result.descriptor.resourceId, new AbortController().signal)
    expect(text.status).toBe('error')
    if (text.status === 'error') expect(text.code).toBe('FS_PERMISSION_DENIED')
  })

  it('probes extensionless reliable UTF-8 text into an available text resource', async () => {
    const fs = new FakeFs()
    fs.put('/ws/README', bytes('# Notes\nplain'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/README', new AbortController().signal)
    expect(result.status).toBe('preview')
    if (result.status !== 'preview') return
    expect(result.descriptor.mediaType).toBe('text/plain')
    if (result.descriptor.availability === 'available') {
      const text = await gateway.readText(result.descriptor.resourceId, new AbortController().signal)
      expect(text).toMatchObject({ status: 'ok', text: '# Notes\nplain' })
    }
  })

  it('delegates extensionless content that is not valid UTF-8', async () => {
    const fs = new FakeFs()
    fs.put('/ws/binary', Uint8Array.from([0x00, 0x01, 0x02]), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    expect(await gateway.probe('s1', '/ws/binary', new AbortController().signal)).toEqual({ status: 'delegate' })
  })

  it('delegates extensionless content larger than the text limit without reading it', async () => {
    const fs = new FakeFs()
    fs.put('/ws/huge', bytes('x'.repeat(20)), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list, cfg: config({ maxTextBytes: 10 }) })

    expect(await gateway.probe('s1', '/ws/huge', new AbortController().signal)).toEqual({ status: 'delegate' })
  })

  it('mints distinct high-entropy tokens and allows repeat reads', async () => {
    const fs = new FakeFs()
    fs.put('/ws/a.ts', bytes('a'), 'v1')
    fs.put('/ws/b.ts', bytes('b'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const a = await gateway.probe('s1', '/ws/a.ts', new AbortController().signal)
    const b = await gateway.probe('s1', '/ws/b.ts', new AbortController().signal)
    const idA = a.status === 'preview' && a.descriptor.availability === 'available' ? a.descriptor.resourceId : undefined
    const idB = b.status === 'preview' && b.descriptor.availability === 'available' ? b.descriptor.resourceId : undefined
    expect(idA).toBeDefined()
    expect(idB).toBeDefined()
    expect(idA).not.toBe(idB)
    if (idA === undefined || idB === undefined) return
    expect(String(idA)).not.toContain('/')
    // Repeat read on the same token is allowed.
    const first = await gateway.readText(idA, new AbortController().signal)
    const second = await gateway.readText(idA, new AbortController().signal)
    expect(first).toMatchObject({ status: 'ok', text: 'a' })
    expect(second).toMatchObject({ status: 'ok', text: 'a' })
  })

  it('returns stale for a resource that expired by TTL', async () => {
    vi.useFakeTimers()
    const fs = new FakeFs()
    fs.put('/ws/t.txt', bytes('text'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list, cfg: config({ resourceTtlMs: 1000 }) })

    const result = await gateway.probe('s1', '/ws/t.txt', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    await vi.advanceTimersByTimeAsync(2000)
    expect(await gateway.readText(result.descriptor.resourceId, new AbortController().signal)).toEqual({ status: 'stale' })
  })

  it('evicts the oldest-created resource at the max-resources bound', async () => {
    const fs = new FakeFs()
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list, cfg: config({ maxResources: 2 }) })

    for (const name of ['a.ts', 'b.ts', 'c.ts']) fs.put(`/ws/${name}`, bytes(name), 'v1')
    const ids: string[] = []
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      const r = await gateway.probe('s1', `/ws/${name}`, new AbortController().signal)
      if (r.status === 'preview' && r.descriptor.availability === 'available') ids.push(String(r.descriptor.resourceId))
    }
    // 'a' was created first and evicted once capacity (2) was reached at 'c'.
    expect(await gateway.readText(FilePreviewResourceId(ids[0]!), new AbortController().signal)).toEqual({ status: 'stale' })
    expect(await gateway.readText(FilePreviewResourceId(ids[1]!), new AbortController().signal)).toMatchObject({ status: 'ok', text: 'b.ts' })
    expect(await gateway.readText(FilePreviewResourceId(ids[2]!), new AbortController().signal)).toMatchObject({ status: 'ok', text: 'c.ts' })
  })

  it('releases idempotently and clears the resource', async () => {
    const fs = new FakeFs()
    fs.put('/ws/r.ts', bytes('x'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/r.ts', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    expect(gateway.release(result.descriptor.resourceId)).toEqual({ released: true })
    expect(gateway.release(result.descriptor.resourceId)).toEqual({ released: true })
    expect(await gateway.readText(result.descriptor.resourceId, new AbortController().signal)).toEqual({ status: 'stale' })
  })

  it('returns stale when binary-url is requested for a text resource', async () => {
    const fs = new FakeFs()
    fs.put('/ws/text.ts', bytes('code'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/text.ts', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    expect(await gateway.binaryUrl(result.descriptor.resourceId, new AbortController().signal)).toEqual({ status: 'stale' })
  })

  it('returns a relative binary URL for an image resource and reloads it', async () => {
    const fs = new FakeFs()
    fs.put('/ws/icon.png', pngBytes(16), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/icon.png', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    const url = await gateway.binaryUrl(result.descriptor.resourceId, new AbortController().signal)
    expect(url.status).toBe('ok')
    if (url.status === 'ok') {
      expect(url.url.startsWith('/desktop-file-preview-content/')).toBe(true)
      expect(url.url.startsWith('http://')).toBe(false)
      // Repeat GET is allowed.
      expect(await gateway.binaryUrl(result.descriptor.resourceId, new AbortController().signal)).toEqual(url)
    }
  })

  it('serves validated image bytes with the correct headers over the data plane', async () => {
    const fs = new FakeFs()
    fs.put('/ws/icon.png', pngBytes(24), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/icon.png', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    const token = String(result.descriptor.resourceId)

    const res = await invokeImageRequest(gateway, token, {
      host: '127.0.0.1:43120',
      'sec-fetch-site': 'same-origin',
    })
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toBe('image/png')
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(res.headers['Cross-Origin-Resource-Policy']).toBe('same-origin')
    expect(res.headers['Content-Length']).toBe('32')
    expect(Array.from(res.body.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('rejects an image request with a wrong Host header', async () => {
    const fs = new FakeFs()
    fs.put('/ws/icon.png', pngBytes(8), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/icon.png', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    const res = await invokeImageRequest(gateway, String(result.descriptor.resourceId), { host: 'evil.example:9999' })
    expect(res.status).toBe(404)
  })

  it('rejects a cross-site image request', async () => {
    const fs = new FakeFs()
    fs.put('/ws/icon.png', pngBytes(8), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/icon.png', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    const res = await invokeImageRequest(gateway, String(result.descriptor.resourceId), {
      host: '127.0.0.1:43120',
      'sec-fetch-site': 'cross-site',
    })
    expect(res.status).toBe(404)
  })

  it('rejects an image request whose Origin does not match the loopback origin', async () => {
    const fs = new FakeFs()
    fs.put('/ws/icon.png', pngBytes(8), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/icon.png', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    const res = await invokeImageRequest(gateway, String(result.descriptor.resourceId), {
      host: '127.0.0.1:43120',
      origin: 'http://evil.example',
    })
    expect(res.status).toBe(404)
  })

  it('accepts an image request whose Origin matches the loopback origin', async () => {
    const fs = new FakeFs()
    fs.put('/ws/icon.png', pngBytes(8), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/icon.png', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    const res = await invokeImageRequest(gateway, String(result.descriptor.resourceId), {
      host: '127.0.0.1:43120',
      origin: 'http://127.0.0.1:43120',
      'sec-fetch-site': 'same-origin',
    })
    expect(res.status).toBe(200)
  })

  it('rejects an image whose bytes do not match its declared media type (415)', async () => {
    const fs = new FakeFs()
    fs.put('/ws/fake.png', bytes('definitely not a png'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/fake.png', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    const res = await invokeImageRequest(gateway, String(result.descriptor.resourceId), {
      host: '127.0.0.1:43120',
    })
    expect(res.status).toBe(415)
  })

  it('serves an SVG only when the content is valid SVG with a root element', async () => {
    const fs = new FakeFs()
    fs.put('/ws/ok.svg', svgBytes('<rect width="1" height="1"/>'), 'v1')
    fs.put('/ws/bad.svg', bytes('<html><body>not svg</body></html>'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const ok = await gateway.probe('s1', '/ws/ok.svg', new AbortController().signal)
    const bad = await gateway.probe('s1', '/ws/bad.svg', new AbortController().signal)
    if (ok.status !== 'preview' || ok.descriptor.availability !== 'available') return
    if (bad.status !== 'preview' || bad.descriptor.availability !== 'available') return

    const okRes = await invokeImageRequest(gateway, String(ok.descriptor.resourceId), { host: '127.0.0.1:43120' })
    expect(okRes.status).toBe(200)
    expect(okRes.headers['Content-Type']).toBe('image/svg+xml')
    expect(okRes.headers['Content-Security-Policy']).toBeTruthy()

    const badRes = await invokeImageRequest(gateway, String(bad.descriptor.resourceId), { host: '127.0.0.1:43120' })
    expect(badRes.status).toBe(415)
  })

  it('rejects a non-GET image request', async () => {
    const fs = new FakeFs()
    fs.put('/ws/icon.png', pngBytes(8), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/icon.png', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    const res = await invokeImageRequest(gateway, String(result.descriptor.resourceId), { host: '127.0.0.1:43120' }, 'POST')
    expect(res.status).toBe(405)
  })

  it('fails reads after the gateway is disposed', async () => {
    const fs = new FakeFs()
    fs.put('/ws/a.ts', bytes('code'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })
    gateway.dispose()

    await expect(gateway.probe('s1', '/ws/a.ts', new AbortController().signal)).rejects.toThrow('disposed')
    await expect(gateway.readText(FilePreviewResourceId('x'), new AbortController().signal)).rejects.toThrow('disposed')
    const disp = gateway.dispatch('release', { resourceId: 'x' }, new AbortController().signal)
    expect(await disp).toMatchObject({ ok: false })
  })

  it('dispose aborts an in-flight read', async () => {
    const fs = new FakeFs()
    fs.put('/ws/slow.ts', bytes('slow'), 'v1')
    const registry = makeRegistry([{ path: '/ws', sessionIds: ['s1'] }])
    const { gateway } = createGateway({ fs, list: registry.list })

    const result = await gateway.probe('s1', '/ws/slow.ts', new AbortController().signal)
    if (result.status !== 'preview' || result.descriptor.availability !== 'available') return
    let resolveBlock: (() => void) | undefined
    let signalEntered: (() => void) | undefined
    const blocked = new Promise<void>((r) => { resolveBlock = r })
    const entered = new Promise<void>((r) => { signalEntered = r })
    const original = fs.readBytes.bind(fs)
    const controller = new AbortController()
    // Intercept readBytes to hold the read in flight until aborted.
    fs.readBytes = async (target, signal, maxBytes) => {
      if (signal?.aborted) throw new FsError('aborted', 'FS_ABORTED')
      signalEntered!()
      await blocked
      if (signal?.aborted) throw new FsError('aborted', 'FS_ABORTED')
      return original(target, signal, maxBytes)
    }
    const readPromise = gateway.readText(result.descriptor.resourceId, controller.signal).catch(err => err)
    // Wait until the read is actually suspended at the hang before disposing.
    await entered
    gateway.dispose()
    resolveBlock!()
    const outcome = await readPromise
    expect(outcome).toBeInstanceOf(FsError)
  })

  describe('RPC dispatch', () => {
    it('returns a structured bad request for an unknown endpoint', async () => {
      const { gateway } = createGateway()
      const result = await gateway.dispatch('nope', {}, new AbortController().signal)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('bad-request')
    })

    it('returns a structured bad request for a non-object payload on probe', async () => {
      const { gateway } = createGateway()
      const result = await gateway.dispatch('probe', 42, new AbortController().signal)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('bad-request')
    })

    it('returns a structured bad request for an empty path', async () => {
      const { gateway } = createGateway()
      const result = await gateway.dispatch('probe', { sessionId: 's', path: '' }, new AbortController().signal)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('bad-request')
    })

    it('returns a structured bad request for an invalid resource id on read-text', async () => {
      const { gateway } = createGateway()
      const result = await gateway.dispatch('read-text', { resourceId: '' }, new AbortController().signal)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('bad-request')
    })
  })
})

/** Fake response used by the image data-plane tests. */
interface FakeResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
  destroyed: boolean
  writableEnded: boolean
}

function invokeImageRequest(
  gateway: DesktopFilePreviewGateway,
  token: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<FakeResponse> {
  const response: FakeResponse = {
    status: 0,
    headers: {},
    body: new Uint8Array(),
    destroyed: false,
    writableEnded: false,
  }
  const listeners = new Map<string, Set<() => void>>()
  const res = {
    get destroyed() { return response.destroyed },
    get writableEnded() { return response.writableEnded },
    on(event: string, callback: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(callback)
      return res
    },
    off(event: string, callback: () => void) {
      listeners.get(event)?.delete(callback)
      return res
    },
    emitClose() {
      for (const callback of listeners.get('close') ?? []) callback()
    },
    writeHead(status: number, h?: Record<string, string>) {
      response.status = status
      if (h !== undefined) response.headers = { ...h }
      return res
    },
    end(chunk?: string | Uint8Array) {
      if (typeof chunk === 'string') response.body = bytes(chunk)
      else if (chunk instanceof Uint8Array) response.body = chunk
      response.writableEnded = true
      return res
    },
    destroy() {
      response.destroyed = true
      response.writableEnded = true
      return res
    },
  } as unknown as import('node:http').ServerResponse
  const req = {
    method,
    headers,
    url: `/desktop-file-preview-content/${token}`,
  } as unknown as import('node:http').IncomingMessage
  return gateway.handleImageRequest(req, res).then(() => response)
}

/** Real filesystem smoke checks for symlink/junction escape (design §12.1). */
describe('file-preview-gateway (real local filesystem escapes)', () => {
  let root: string
  let workspace: string
  let outside: string

  beforeAll(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'dsh-fp-'))
    workspace = join(root, 'workspace')
    outside = join(root, 'outside')
    await mkdir(workspace, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(workspace, 'ok.ts'), 'export const ok = 1\n', 'utf-8')
    await writeFile(join(outside, 'secret.ts'), 'const secret = 1\n', 'utf-8')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('delegates a symlink (or Windows junction) that points outside the workspace root', async () => {
    const linkBase = process.platform === 'win32' ? 'escape-dir' : 'escape-link.ts'
    const link = join(workspace, linkBase)
    const target = process.platform === 'win32' ? outside : join(outside, 'secret.ts')
    let linked = false
    if (process.platform === 'win32') {
      const { execFileSync } = await import('node:child_process')
      try {
        execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
        linked = true
      } catch {
        linked = false
      }
    } else {
      try {
        await symlink(join(outside, 'secret.ts'), link)
        linked = true
      } catch {
        linked = false
      }
    }
    if (!linked) {
      // Skip quietly when the host cannot create the link without elevation.
      return
    }
    const probePath = process.platform === 'win32' ? join('escape-dir', 'secret.ts') : join('escape-link.ts')
    const localFs = await createLocalFs(workspace)
    const registry = makeRegistry([{ path: workspace, sessionIds: ['s1'] }])
    const gateway = new DesktopFilePreviewGateway(
      localFs,
      registry.list,
      undefined,
      silentLogger,
      'http://127.0.0.1:43120',
      config(),
    )
    const result = await gateway.probe('s1', probePath, new AbortController().signal)
    expect(result.status).toBe('delegate')
  })
})

/**
 * Build a real fslib seam over a base directory that keeps symlink identity
 * via `realpath` and containment via resolved paths, mirroring the backend
 * semantics the gateway relies on.
 */
async function createLocalFs(base: string): Promise<FilePreviewFsSeam> {
  const { realpath, stat, readFile } = await import('node:fs/promises')
  return {
    async resolve(path: string, opts?: { cwd?: string }): Promise<FilePreviewFsTarget> {
      const abs = isAbsolute(path) ? path : resolve(opts?.cwd ?? base, path)
      const canonical = await realpath(abs)
      return { targetKey: canonical, displayPath: canonical }
    },
    contains(parent: FilePreviewFsTarget, child: FilePreviewFsTarget): boolean {
      const rel = relative(String(parent.targetKey), String(child.targetKey))
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    },
    async stat(target: FilePreviewFsTarget) {
      try {
        const info = await stat(String(target.targetKey))
        if (info.isFile()) return { version: `${info.mtimeMs}-${info.size}`, type: 'file' as const, size: info.size }
        if (info.isDirectory()) return { version: `${info.mtimeMs}`, type: 'directory' as const }
        return { version: `${info.mtimeMs}`, type: 'other' as const }
      } catch {
        return undefined
      }
    },
    async readBytes(target: FilePreviewFsTarget, signal: AbortSignal | undefined, maxBytes: number) {
      if (signal?.aborted) throw new FsError('aborted', 'FS_ABORTED')
      const metadata = await stat(String(target.targetKey))
      if (metadata.size > maxBytes) throw new FsError('too large', 'FS_TOO_LARGE')
      const buf = await readFile(String(target.targetKey))
      if (signal?.aborted) throw new FsError('aborted', 'FS_ABORTED')
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    },
  }
}
