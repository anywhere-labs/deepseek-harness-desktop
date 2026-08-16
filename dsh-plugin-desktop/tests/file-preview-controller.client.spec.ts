import { describe, expect, it } from 'vitest'
import { FilePreviewResourceId as brandResourceId } from '../src/file-preview-contract.ts'
import type {
  FilePreviewBinaryResult,
  FilePreviewDescriptor,
  FilePreviewProbeResult,
  FilePreviewResourceId,
  FilePreviewTextResult,
} from '../src/file-preview-contract.ts'
import { FilePreviewController } from '../src/client/file-preview/controller.ts'
import type { FilePreviewGateway } from '../src/client/file-preview/gateway.ts'
import type { FilePreviewProvider } from '../src/client/file-preview/registry.ts'

/** A manually-resolved promise. */
class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void
  reject!: (error: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

/** A descriptor factory that keys the resource id off the extension (+ index). */
function availableDescriptor(extension: string, index = 0): FilePreviewDescriptor {
  const isImage = extension === '.png' || extension === '.svg' || extension === '.jpg'
  const suffix = index === 0 ? '' : `-${index}`
  return {
    availability: 'available',
    resourceId: brandResourceId(`rid-${extension}${suffix}`),
    displayPath: `sample${extension}`,
    name: `sample${extension}`,
    extension,
    mediaType: isImage ? 'image/png' : 'text/plain',
    contentKind: isImage ? 'image' : 'text',
    size: 8,
  }
}

function probePreview(descriptor: FilePreviewDescriptor): FilePreviewProbeResult {
  return { status: 'preview', descriptor }
}

/** Deterministic fake gateway with controllable deferred calls. */
class FakeGateway implements FilePreviewGateway {
  readonly probeCalls: Array<{ sessionId: string; path: string; signal: AbortSignal }> = []
  readonly readTextCalls: AbortSignal[] = []
  readonly binaryCalls: AbortSignal[] = []
  readonly released: string[] = []
  private readonly probeQueue: Array<Deferred<FilePreviewProbeResult>> = []
  private readonly readTextQueue: Array<Deferred<FilePreviewTextResult>> = []
  private readonly binaryQueue: Array<Deferred<FilePreviewBinaryResult>> = []

  probe(sessionId: string, path: string, signal: AbortSignal): Promise<FilePreviewProbeResult> {
    this.probeCalls.push({ sessionId, path, signal })
    const deferred = new Deferred<FilePreviewProbeResult>()
    this.probeQueue.push(deferred)
    return deferred.promise
  }

  readText(_resourceId: FilePreviewResourceId, signal: AbortSignal): Promise<FilePreviewTextResult> {
    this.readTextCalls.push(signal)
    const deferred = new Deferred<FilePreviewTextResult>()
    this.readTextQueue.push(deferred)
    return deferred.promise
  }

  binaryUrl(_resourceId: FilePreviewResourceId, signal: AbortSignal): Promise<FilePreviewBinaryResult> {
    this.binaryCalls.push(signal)
    const deferred = new Deferred<FilePreviewBinaryResult>()
    this.binaryQueue.push(deferred)
    return deferred.promise
  }

  release(resourceId: FilePreviewResourceId): Promise<void> {
    this.released.push(String(resourceId))
    return Promise.resolve()
  }

  /** Number of pending unconsumed probe results. */
  get probeQueueLength(): number {
    return this.probeQueue.length
  }

  nextProbe(): Deferred<FilePreviewProbeResult> {
    const next = this.probeQueue.shift()
    if (next === undefined) throw new Error('no pending probe')
    return next
  }

  nextReadText(): Deferred<FilePreviewTextResult> {
    const next = this.readTextQueue.shift()
    if (next === undefined) throw new Error('no pending read-text')
    return next
  }

  nextBinary(): Deferred<FilePreviewBinaryResult> {
    const next = this.binaryQueue.shift()
    if (next === undefined) throw new Error('no pending binary-url')
    return next
  }
}

function DummyComponent(): null {
  return null
}

const TEXT_PROVIDER: FilePreviewProvider = {
  id: 'text-provider',
  priority: 100,
  loadMode: 'text',
  supports: () => true,
  Component: DummyComponent,
}

const IMAGE_PROVIDER: FilePreviewProvider = {
  id: 'image-provider',
  priority: 100,
  loadMode: 'binary-url',
  supports: () => true,
  Component: DummyComponent,
}

/** Controller plus its surface-call observation harness. */
function makeHarness(options?: { provider?: FilePreviewProvider; failSystemOpen?: boolean }) {
  const gateway = new FakeGateway()
  const registry = {
    resolve: (): FilePreviewProvider | undefined => options?.provider,
  }
  let currentSession: string | undefined = 'session-a'
  let openFileCount = 0
  let closeFileCount = 0
  const systemPaths: string[] = []
  const controller = new FilePreviewController(gateway, registry, {
    openFile: () => { openFileCount += 1 },
    closeFile: () => { closeFileCount += 1 },
    openSystemPath: async (path: string): Promise<void> => {
      if (options?.failSystemOpen) throw new Error('system failed')
      systemPaths.push(path)
    },
    getCurrentSessionId: () => currentSession,
  })
  return {
    controller,
    gateway,
    registry,
    setSession: (next: string | undefined): void => { currentSession = next },
    get openFileCount(): number { return openFileCount },
    get closeFileCount(): number { return closeFileCount },
    get systemPaths(): string[] { return systemPaths },
  }
}

/** Let resolved gateway deferreds drive the controller's async continuations. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('file-preview-controller', () => {
  it('moves closed -> loading -> ready on a text preview', async () => {
    const { controller, gateway } = makeHarness({ provider: TEXT_PROVIDER })
    expect(controller.getSnapshot()).toEqual({ status: 'closed' })

    const outcome = controller.preview('session-a', '/w/file.ts')
    const probe = gateway.nextProbe()
    // The settled snapshot stays closed while probing (no loading flash).
    expect(controller.getSnapshot()).toEqual({ status: 'closed' })
    probe.resolve(probePreview(availableDescriptor('.ts')))
    // Loading is published only after the provider resolves; flush the awaits.
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot()).toMatchObject({ status: 'loading', sessionId: 'session-a', path: '/w/file.ts' })

    const text = gateway.nextReadText()
    text.resolve({ status: 'ok', text: 'const x = 1', resourceId: brandResourceId('rid-.ts') })
    await expect(outcome).resolves.toBe('handled')
    const ready = controller.getSnapshot()
    if (ready.status !== 'ready') throw new Error('expected ready')
    expect(ready.providerId).toBe('text-provider')
    expect(ready.content).toEqual({ kind: 'text', text: 'const x = 1' })
    // Text releases the resource immediately after success.
    expect(gateway.released).toContain('rid-.ts')
  })

  it('delegate restores the previous settled snapshot without opening', async () => {
    const h = makeHarness({ provider: TEXT_PROVIDER })
    const outcome = h.controller.preview('session-a', '/w/file.ts')
    h.gateway.nextProbe().resolve(probePreview(availableDescriptor('.ts')))
    await flush()
    h.gateway.nextReadText().resolve({ status: 'ok', text: 'hello', resourceId: brandResourceId('rid-.ts') })
    await expect(outcome).resolves.toBe('handled')

    const delegateOutcome = h.controller.preview('session-a', '/w/some.pdf')
    h.gateway.nextProbe().resolve({ status: 'delegate' })
    await expect(delegateOutcome).resolves.toBe('delegate')
    const snapshot = h.controller.getSnapshot()
    if (snapshot.status !== 'ready') throw new Error('expected ready preserved')
    expect(snapshot.content).toEqual({ kind: 'text', text: 'hello' })
    // The panel never flashed to loading (openFile was called once for the first file only).
    expect(h.openFileCount).toBe(1)
  })

  it('publishes an error snapshot and handles the click for a probe error', async () => {
    const h = makeHarness({ provider: TEXT_PROVIDER })
    const outcome = h.controller.preview('session-a', '/w/file.ts')
    h.gateway.nextProbe().resolve({ status: 'error', code: 'stat-failed', message: 'boom', retryable: true })
    await expect(outcome).resolves.toBe('handled')
    const snapshot = h.controller.getSnapshot()
    if (snapshot.status !== 'error') throw new Error('expected error')
    expect(snapshot.error).toEqual({ code: 'stat-failed', message: 'boom', retryable: true })
    expect(snapshot.retryable).toBe(true)
    expect(h.openFileCount).toBe(1)
  })

  it('handles a transport failure during probe as an error snapshot', async () => {
    const h = makeHarness({ provider: TEXT_PROVIDER })
    const outcome = h.controller.preview('session-a', '/w/file.ts')
    h.gateway.nextProbe().reject(Object.assign(new Error('wire down'), { name: 'Error' }))
    await expect(outcome).resolves.toBe('handled')
    const snapshot = h.controller.getSnapshot()
    if (snapshot.status !== 'error') throw new Error('expected error')
    expect(snapshot.error.retryable).toBe(true)
    expect(h.openFileCount).toBe(1)
  })

  it('A/B latest-request-wins: slow A must not overwrite B', async () => {
    const { controller, gateway } = makeHarness({ provider: TEXT_PROVIDER })
    // A publishes loading and begins its read first.
    const promiseA = controller.preview('session-a', '/w/a.ts')
    const probeA = gateway.nextProbe()
    probeA.resolve(probePreview(availableDescriptor('.ts', 1)))
    await flush()
    const textA = gateway.nextReadText()

    // B supersedes A mid-read and completes first.
    const promiseB = controller.preview('session-a', '/w/b.ts')
    const probeB = gateway.nextProbe()
    probeB.resolve(probePreview(availableDescriptor('.ts', 2)))
    await flush()
    const textB = gateway.nextReadText()
    textB.resolve({ status: 'ok', text: 'B content', resourceId: brandResourceId('rid-b') })
    await expect(promiseB).resolves.toBe('handled')
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready' })

    // Late A read resolves; it must never overwrite B and its resource is released.
    textA.resolve({ status: 'ok', text: 'A content', resourceId: brandResourceId('rid-a') })
    await expect(promiseA).resolves.toBe('handled')
    const snapshot = controller.getSnapshot()
    if (snapshot.status !== 'ready') throw new Error('expected B ready')
    expect(JSON.stringify(snapshot.content)).toContain('B content')
    expect(gateway.released).toContain('rid-.ts-1')
  })

  it('close aborts in-flight read and releases resources from a loading state', async () => {
    const h = makeHarness({ provider: TEXT_PROVIDER })
    const promise = h.controller.preview('session-a', '/w/a.ts')
    h.gateway.nextProbe().resolve(probePreview(availableDescriptor('.ts')))
    await flush()
    // Loading was published; the surface was opened.
    const pendingText = h.gateway.nextReadText()
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'loading' })
    h.controller.close()
    expect(h.gateway.readTextCalls[0]?.aborted).toBe(true)
    expect(h.closeFileCount).toBe(1)
    // A late read resolve after close must not change state.
    pendingText.resolve({ status: 'ok', text: 'late', resourceId: brandResourceId('rid-late') })
    await promise
    expect(h.controller.getSnapshot()).toEqual({ status: 'closed' })
  })

  it('dispose cancels in-flight and waits for best-effort release', async () => {
    const h = makeHarness({ provider: TEXT_PROVIDER })
    const promise = h.controller.preview('session-a', '/w/a.ts')
    const probe = h.gateway.nextProbe()
    probe.resolve(probePreview(availableDescriptor('.ts')))
    await flush()
    const pendingText = h.gateway.nextReadText()
    // While the read is in flight the controller is disposed.
    h.controller.dispose()
    expect(h.gateway.probeCalls[0]?.signal.aborted).toBe(true)
    // Dispose aborts the in-flight read; settle it as an abort to release the await.
    pendingText.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await promise
    // Dispose released the outstanding/current resource best-effort.
    expect(h.gateway.released).toContain('rid-.ts')
  })

  it('binary-url token is released only on replace or close', async () => {
    const { controller, gateway } = makeHarness({ provider: IMAGE_PROVIDER })
    const out1 = controller.preview('session-a', '/w/a.png')
    gateway.nextProbe().resolve(probePreview(availableDescriptor('.png', 1)))
    await flush()
    const bin1 = gateway.nextBinary()
    bin1.resolve({ status: 'ok', url: '/desktop-file-preview-content/rid-.png-1' })
    await expect(out1).resolves.toBe('handled')
    expect(gateway.released.includes('rid-.png-1')).toBe(false)

    const out2 = controller.preview('session-a', '/w/b.png')
    gateway.nextProbe().resolve(probePreview(availableDescriptor('.png', 2)))
    await flush()
    const bin2 = gateway.nextBinary()
    // The old token is still held while the new one is loading.
    expect(gateway.released.includes('rid-.png-1')).toBe(false)
    bin2.resolve({ status: 'ok', url: '/desktop-file-preview-content/rid-.png-2' })
    await expect(out2).resolves.toBe('handled')
    // The old (first) image resource was released only after the new one was confirmed.
    expect(gateway.released).toContain('rid-.png-1')

    // Close releases the held (second) image token.
    controller.close()
    expect(gateway.released).toContain('rid-.png-2')
  })

  it('stale text retries exactly once then surfaces a retryable error', async () => {
    const { controller, gateway } = makeHarness({ provider: TEXT_PROVIDER })
    const outcome = controller.preview('session-a', '/w/file.ts')
    gateway.nextProbe().resolve(probePreview(availableDescriptor('.ts')))
    await Promise.resolve()
    gateway.nextReadText().resolve({ status: 'stale' })
    await Promise.resolve()
    // The stale token is released before the retry probes a fresh resource.
    expect(gateway.released).toContain('rid-.ts')
    const reprobe = gateway.nextProbe()
    reprobe.resolve(probePreview(availableDescriptor('.ts')))
    await Promise.resolve()
    gateway.nextReadText().resolve({ status: 'stale' })
    await expect(outcome).resolves.toBe('handled')
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', retryable: true })
    // No additional probe was issued after the second stale.
    expect(gateway.probeQueueLength).toBe(0)
  })

  it('an internal retry that becomes delegate maps to a retryable error', async () => {
    const { controller, gateway } = makeHarness({ provider: TEXT_PROVIDER })
    const outcome = controller.preview('session-a', '/w/file.ts')
    gateway.nextProbe().resolve(probePreview(availableDescriptor('.ts')))
    await Promise.resolve()
    gateway.nextReadText().resolve({ status: 'stale' })
    await Promise.resolve()
    const reprobe = gateway.nextProbe()
    reprobe.resolve({ status: 'delegate' })
    await expect(outcome).resolves.toBe('handled')
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', retryable: true })
  })

  it('converts a stale read to an available refetch that commits', async () => {
    const { controller, gateway } = makeHarness({ provider: TEXT_PROVIDER })
    const outcome = controller.preview('session-a', '/w/file.ts')
    gateway.nextProbe().resolve(probePreview(availableDescriptor('.ts')))
    await Promise.resolve()
    gateway.nextReadText().resolve({ status: 'stale' })
    await Promise.resolve()
    const reprobe = gateway.nextProbe()
    reprobe.resolve(probePreview(availableDescriptor('.ts')))
    await Promise.resolve()
    gateway.nextReadText().resolve({ status: 'ok', text: 'fresh', resourceId: brandResourceId('rid-.ts') })
    await expect(outcome).resolves.toBe('handled')
    const snapshot = controller.getSnapshot()
    if (snapshot.status !== 'ready') throw new Error('expected ready after refetch')
    expect(snapshot.content).toEqual({ kind: 'text', text: 'fresh' })
  })

  it('no provider for a supported descriptor becomes an error that is handled', async () => {
    const { controller, gateway } = makeHarness()
    const outcome = controller.preview('session-a', '/w/file.ts')
    gateway.nextProbe().resolve(probePreview(availableDescriptor('.ts')))
    await expect(outcome).resolves.toBe('handled')
    expect(controller.getSnapshot()).toMatchObject({ status: 'error' })
  })

  it('session change during flight releases the received resource and does not commit', async () => {
    const { controller, gateway, setSession } = makeHarness({ provider: TEXT_PROVIDER })
    const promise = controller.preview('session-a', '/w/file.ts')
    gateway.nextProbe().resolve(probePreview(availableDescriptor('.ts')))
    await Promise.resolve()
    const text = gateway.nextReadText()
    setSession('session-b')
    text.resolve({ status: 'ok', text: 'x', resourceId: brandResourceId('rid-sess') })
    await expect(promise).resolves.toBe('handled')
    // The received resource is released and never committed cross-session.
    expect(gateway.released).toContain('rid-.ts')
    const snapshot = controller.getSnapshot()
    if (snapshot.status === 'ready') throw new Error('cross-session content must not commit')
    expect(snapshot.status).toBe('loading')
  })

  it('suspend closes a published loading snapshot but keeps ready content mounted', async () => {
    const h = makeHarness({ provider: TEXT_PROVIDER })

    const loadingOutcome = h.controller.preview('session-a', '/w/file.ts')
    h.gateway.nextProbe().resolve(probePreview(availableDescriptor('.ts')))
    await flush()
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'loading' })
    h.controller.suspend()
    expect(h.controller.getSnapshot()).toEqual({ status: 'closed' })
    expect(h.closeFileCount).toBe(1)
    // Flush the abandoned read so the pending promise settles.
    const abandonedRead = h.gateway.nextReadText()
    abandonedRead.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await loadingOutcome

    const readyOutcome = h.controller.preview('session-a', '/w/keep.ts')
    h.gateway.nextProbe().resolve(probePreview(availableDescriptor('.ts')))
    await flush()
    h.gateway.nextReadText().resolve({ status: 'ok', text: 'keep', resourceId: brandResourceId('rid-keep') })
    await expect(readyOutcome).resolves.toBe('handled')
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'ready' })
    h.controller.suspend()
    const snapshot = h.controller.getSnapshot()
    if (snapshot.status !== 'ready') throw new Error('expected ready preserved by suspend')
    expect(snapshot.content).toEqual({ kind: 'text', text: 'keep' })
  })

  it('openExternally calls the raw path and surfaces rejections', async () => {
    const { controller, gateway } = makeHarness({ provider: TEXT_PROVIDER, failSystemOpen: true })
    const outcome = controller.preview('session-a', '/w/file.ts')
    gateway.nextProbe().resolve(probePreview(availableDescriptor('.ts')))
    await Promise.resolve()
    gateway.nextReadText().resolve({ status: 'ok', text: 'x', resourceId: brandResourceId('rid-.ts') })
    await outcome
    await expect(controller.openExternally()).rejects.toThrow('system failed')
  })

  it('refresh re-runs preview with the ready snapshot raw path', async () => {
    const { controller, gateway, systemPaths } = makeHarness({ provider: TEXT_PROVIDER })
    const out1 = controller.preview('session-a', '/w/file.ts')
    gateway.nextProbe().resolve(probePreview(availableDescriptor('.ts')))
    await Promise.resolve()
    gateway.nextReadText().resolve({ status: 'ok', text: 'v1', resourceId: brandResourceId('rid-.ts') })
    await expect(out1).resolves.toBe('handled')

    const refreshPromise = controller.refresh()
    expect(gateway.probeCalls.at(-1)?.path).toBe('/w/file.ts')
    const reprobe = gateway.nextProbe()
    reprobe.resolve(probePreview(availableDescriptor('.ts')))
    await Promise.resolve()
    gateway.nextReadText().resolve({ status: 'ok', text: 'v2', resourceId: brandResourceId('rid-.ts') })
    await expect(refreshPromise).resolves.toBe('handled')
    expect(systemPaths).toHaveLength(0)
  })

  it('metadata-only (oversized) descriptor commits without a token', async () => {
    const metadataProvider: FilePreviewProvider = {
      id: 'metadata-provider',
      priority: 100,
      loadMode: 'metadata-only',
      supports: () => true,
      Component: DummyComponent,
    }
    const { controller, gateway } = makeHarness({ provider: metadataProvider })
    const descriptor: FilePreviewDescriptor = {
      availability: 'oversized',
      limitBytes: 1024,
      displayPath: 'big.bin',
      name: 'big.bin',
      extension: '.bin',
      mediaType: 'text/plain',
      contentKind: 'text',
      size: 4096,
    }
    const outcome = controller.preview('session-a', '/w/big.bin')
    gateway.nextProbe().resolve({ status: 'preview', descriptor })
    await expect(outcome).resolves.toBe('handled')
    const snapshot = controller.getSnapshot()
    if (snapshot.status !== 'ready') throw new Error('expected ready metadata-only')
    expect(snapshot.content).toEqual({ kind: 'metadata-only' })
    // No token was ever released because none was held.
    expect(gateway.released).toHaveLength(0)
  })

  it('an oversized descriptor commits metadata-only even for a text provider', async () => {
    const { controller, gateway } = makeHarness({ provider: TEXT_PROVIDER })
    const descriptor: FilePreviewDescriptor = {
      availability: 'oversized',
      limitBytes: 1024,
      displayPath: 'huge.ts',
      name: 'huge.ts',
      extension: '.ts',
      mediaType: 'text/typescript',
      contentKind: 'text',
      size: 4096,
    }
    const outcome = controller.preview('session-a', '/w/huge.ts')
    gateway.nextProbe().resolve({ status: 'preview', descriptor })
    await expect(outcome).resolves.toBe('handled')
    const snapshot = controller.getSnapshot()
    if (snapshot.status !== 'ready') throw new Error('expected ready metadata-only')
    expect(snapshot.content).toEqual({ kind: 'metadata-only' })
    // No token exists, so no read was issued and nothing was released.
    expect(gateway.readTextCalls).toHaveLength(0)
    expect(gateway.released).toHaveLength(0)
  })

  it('no requests are issued after dispose', async () => {
    const { controller, gateway } = makeHarness({ provider: TEXT_PROVIDER })
    await controller.dispose()
    const before = gateway.probeCalls.length
    await expect(controller.preview('session-a', '/w/file.ts')).resolves.toBe('handled')
    controller.refresh()
    controller.close()
    controller.suspend()
    expect(gateway.probeCalls.length).toBe(before)
    void controller.openExternally()
  })
})
