import { randomUUID } from 'node:crypto'
import type { CatalogQuery, CatalogSnapshot } from '../contracts/index.js'
import { applyScopedCatalogCursor, normalizeCatalogQuery, scopeCatalogCursor } from '../contracts/query.js'
import { parseCatalogSnapshot } from '../contracts/validate.js'
import type { CatalogAdapter, CatalogHttpClient, CatalogMediaRegistry, LocalSourceRecord, ScopedCatalogCursor } from '../contracts/types.js'
import type { MarketCatalogSourceResult, MarketSourceView } from '../api-types.js'
import { DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_ENDPOINT, DSH_1024STORE_KEY, DSH_1024STORE_PROVIDER_ID, dsh1024StoreAdapter } from '../adapters/dsh-1024store.js'
import { DSHFIND_ADAPTER_ID, DSHFIND_ENDPOINT, DSHFIND_KEY, DSHFIND_PROVIDER_ID, dshfindAdapter } from '../adapters/dshfind.js'
import { standardHttpAdapter } from '../adapters/standard-http.js'

export interface BuiltInProviderDefinition {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly providerId: string
  readonly adapterId: string
  readonly endpoint: string
  readonly attribution: {
    readonly name: string
    readonly url: string
    readonly notice?: string
  }
  readonly partnership: boolean
}

export const BUILT_IN_PROVIDERS: readonly BuiltInProviderDefinition[] = [
  {
    key: DSH_1024STORE_KEY,
    name: 'DSH 1024Store',
    description: '合作提供方目录。需要用户明确添加并启用。目录收录不代表插件经过审核或推荐。',
    providerId: DSH_1024STORE_PROVIDER_ID,
    adapterId: DSH_1024STORE_ADAPTER_ID,
    endpoint: DSH_1024STORE_ENDPOINT,
    attribution: {
      name: 'DSH 1024Store',
      url: 'https://deepseek1024.com',
      notice: 'Community catalog data provided by a cooperating provider.',
    },
    partnership: true,
  },
  {
    key: DSHFIND_KEY,
    name: 'dshfind',
    description: '合作提供方目录。需要用户明确添加并启用。目录收录不代表插件经过审核或推荐。',
    providerId: DSHFIND_PROVIDER_ID,
    adapterId: DSHFIND_ADAPTER_ID,
    endpoint: DSHFIND_ENDPOINT,
    attribution: {
      name: 'dshfind',
      url: 'https://dshfind.com',
      notice: 'Community catalog data provided by a cooperating provider.',
    },
    partnership: true,
  },
]

const adapters = new Map<string, CatalogAdapter>([
  [standardHttpAdapter.adapterId, standardHttpAdapter],
  [dsh1024StoreAdapter.adapterId, dsh1024StoreAdapter],
  [dshfindAdapter.adapterId, dshfindAdapter],
])

const MAX_CATALOG_ITEMS = 10_000
const MAX_CATALOG_PAGES = 10_001
const DEFAULT_CATALOG_SCAN_CACHE_TTL_MS = 5 * 60 * 1000

function sourceView(record: LocalSourceRecord): MarketSourceView {
  const builtIn = record.builtInProviderKey === undefined
    ? undefined
    : BUILT_IN_PROVIDERS.find(provider => provider.key === record.builtInProviderKey)
  const description = builtIn?.description ?? record.manifest?.description
  const attribution = builtIn?.attribution ?? record.manifest?.attribution
  return {
    ...record,
    name: builtIn?.name ?? record.manifest?.name ?? record.providerId,
    ...(description === undefined ? {} : { description }),
    endpoint: builtIn?.endpoint
      ?? record.manifest?.transport.endpoint
      ?? (record.manifestUrl === undefined ? record.providerId : new URL(record.manifestUrl).origin),
    ...((record.manifest?.homepage) === undefined ? {} : { homepage: record.manifest.homepage }),
    ...(attribution === undefined ? {} : { attribution }),
    partnership: builtIn?.partnership ?? false,
  }
}

function catalogScanKey(sourceRecordId: string, locale: string | undefined): string {
  return `${sourceRecordId}\0${locale ?? ''}`
}

function cachedScanView(entry: CatalogFullIndexCacheEntry, cacheStatus: 'fresh' | 'cached'): CatalogFullIndex {
  return {
    source: entry.source,
    snapshots: entry.snapshots,
    scannedAt: new Date(entry.scannedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    ...(entry.providerRevision === undefined ? {} : { providerRevision: entry.providerRevision }),
    cacheStatus,
    ...(entry.locale === undefined ? {} : { locale: entry.locale }),
    scanKey: entry.scanKey,
    sourceGeneration: entry.sourceGeneration,
  }
}

type CatalogItem = CatalogSnapshot['items'][number]

function completeItems(index: CatalogFullIndex): readonly CatalogItem[] {
  return index.snapshots.flatMap(snapshot => snapshot.items)
}

function normalizedSearchText(item: CatalogItem): string {
  return [
    item.id,
    item.name,
    item.displayName,
    item.summary,
    item.description ?? '',
    item.publisher?.name ?? '',
    ...(item.keywords ?? []),
  ].join('\n').toLocaleLowerCase('en-US')
}

function matchesCatalogQuery(item: CatalogItem, query: CatalogQuery): boolean {
  const categories = query.category ?? []
  if (categories.length > 0 && item.categories?.some(value => categories.includes(value)) !== true) return false
  const capabilities = new Set([
    ...(item.capabilities?.required ?? []),
    ...(item.capabilities?.optional ?? []),
  ])
  if ((query.capability ?? []).some(value => !capabilities.has(value))) return false
  const search = query.q?.toLocaleLowerCase('en-US')
  return search === undefined || normalizedSearchText(item).includes(search)
}

function sortCatalogItems(items: readonly CatalogItem[], query: CatalogQuery): readonly CatalogItem[] {
  if (query.sort === undefined || query.sort === 'relevance' || query.sort === 'downloads') return items
  return items.map((item, position) => ({ item, position })).sort((left, right) => {
    const compared = query.sort === 'name'
      ? left.item.displayName.localeCompare(right.item.displayName, query.locale ?? 'en', { sensitivity: 'base' })
      : (Date.parse(right.item.updatedAt ?? '') || 0) - (Date.parse(left.item.updatedAt ?? '') || 0)
    return compared || left.position - right.position
  }).map(value => value.item)
}

function validateCompleteCatalogScan(
  source: LocalSourceRecord,
  values: readonly CatalogSnapshot[],
): { readonly snapshots: readonly CatalogSnapshot[]; readonly providerRevision?: string } {
  if (values.length > MAX_CATALOG_PAGES) throw new Error('catalog scan exceeded the page limit')
  const snapshots: CatalogSnapshot[] = []
  const itemIds = new Set<string>()
  const revisions = new Set<string>()
  let expectedTotal: number | undefined
  let itemCount = 0
  for (const value of values) {
    const snapshot = parseCatalogSnapshot(value)
    if (
      snapshot.source.sourceRecordId !== source.sourceRecordId
      || snapshot.source.providerId !== source.providerId
      || snapshot.source.adapterId !== source.adapterId
      || snapshot.source.registrationKind !== source.registrationKind
    ) throw new Error('catalog scan changed source identity')
    if (snapshot.source.providerRevision !== undefined) revisions.add(snapshot.source.providerRevision)
    if (revisions.size > 1) throw new Error('catalog scan changed provider revision')
    if (snapshot.page.total !== undefined) {
      if (expectedTotal !== undefined && expectedTotal !== snapshot.page.total) {
        throw new Error('catalog scan changed provider total')
      }
      expectedTotal = snapshot.page.total
      if (expectedTotal > MAX_CATALOG_ITEMS) throw new Error('catalog scan exceeded the item limit')
    }
    for (const item of snapshot.items) {
      if (
        item.provenance.sourceRecordId !== source.sourceRecordId
        || item.provenance.providerId !== source.providerId
        || item.provenance.itemId !== item.id
      ) throw new Error('catalog scan changed item provenance')
      if (itemIds.has(item.id)) throw new Error('catalog scan contained duplicate item IDs')
      itemIds.add(item.id)
      itemCount += 1
      if (itemCount > MAX_CATALOG_ITEMS) throw new Error('catalog scan exceeded the item limit')
    }
    snapshots.push(snapshot)
  }
  if (expectedTotal !== undefined && expectedTotal !== itemCount) {
    throw new Error('catalog scan did not reach the provider total')
  }
  const providerRevision = revisions.values().next().value as string | undefined
  return {
    snapshots,
    ...(providerRevision === undefined ? {} : { providerRevision }),
  }
}

export interface CatalogService {
  listSources(): Promise<readonly MarketSourceView[]>
  fetch(
    query: unknown,
    signal: AbortSignal,
    scope?: CatalogFetchScope,
  ): Promise<readonly MarketCatalogSourceResult[]>
  scanCatalog(
    signal: AbortSignal,
    options?: CatalogScanOptions,
  ): Promise<CatalogFullIndex | undefined>
  queryCatalog(
    index: CatalogFullIndex,
    query: unknown,
    scope?: CatalogFetchScope,
  ): readonly MarketCatalogSourceResult[]
  invalidateSource(sourceRecordId: string): void
}

export interface CatalogScanOptions {
  readonly force?: boolean
  readonly locale?: string
  /** Reject a stale or foreign cursor scope before any provider I/O. */
  readonly expectedSourceRecordId?: string
}

/** Complete, Host-normalized active-source scan. Page snapshots remain schema-bounded. */
export interface CatalogFullIndex {
  readonly source: MarketSourceView
  readonly snapshots: readonly CatalogSnapshot[]
  readonly scannedAt: string
  readonly expiresAt: string
  readonly providerRevision?: string
  readonly cacheStatus: 'fresh' | 'cached'
  readonly locale?: string
  /** Opaque identity shared only between the Catalog and install verifier caches. */
  readonly scanKey: string
  /** Host-only generation used to scope pagination tokens. */
  readonly sourceGeneration: number
}

/** A provider cursor may only be replayed against the active source that issued it. */
export interface CatalogFetchScope {
  readonly sourceRecordId: string
  readonly cursor?: string
}

export interface CatalogServiceOptions {
  readonly cacheTtlMs?: number
  readonly cursorTtlMs?: number
  readonly now?: () => number
  readonly maxCacheEntries?: number
  readonly maxCursorEntries?: number
  readonly maxConcurrentSources?: number
  readonly catalogScanCacheTtlMs?: number
  readonly adapterHttpClients?: ReadonlyMap<string, CatalogHttpClient>
  readonly media?: CatalogMediaRegistry
  /** Observe only Host-validated normalized snapshots; used by local capabilities such as install preview. */
  readonly observeSnapshot?: (snapshot: CatalogSnapshot) => void
}

const unavailableMedia: CatalogMediaRegistry = {
  register() {
    throw new Error('catalog media service is unavailable')
  },
  unregisterSource() {},
}

interface CatalogCursorEntry {
  readonly cursor: ScopedCatalogCursor
  readonly generation: number
  readonly savedAt: number
}

interface CatalogFullIndexCacheEntry {
  readonly sourceRecordId: string
  readonly sourceGeneration: number
  readonly scanGeneration: number
  readonly locale?: string
  readonly source: MarketSourceView
  readonly snapshots: readonly CatalogSnapshot[]
  readonly scannedAt: number
  readonly expiresAt: number
  readonly providerRevision?: string
  readonly scanKey: string
}

interface ConcurrencyWaiter {
  readonly signal: AbortSignal
  readonly resolve: () => void
  readonly reject: (cause: unknown) => void
  readonly onAbort: () => void
}

class ConcurrencyGate {
  private active = 0
  private readonly waiting: ConcurrencyWaiter[] = []

  constructor(private readonly limit: number) {}

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
      }
      const waiter: ConcurrencyWaiter = { signal, resolve, reject, onAbort }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(waiter)
    })
  }

  private release(): void {
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
        continue
      }
      waiter.resolve()
      return
    }
    this.active -= 1
  }

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal)
    try {
      return await task()
    } finally {
      this.release()
    }
  }
}

export class DefaultCatalogService implements CatalogService {
  private readonly catalogScanCache = new Map<string, CatalogFullIndexCacheEntry>()
  private readonly cursors = new Map<string, CatalogCursorEntry>()
  private readonly sourceGenerations = new Map<string, number>()
  private readonly catalogScanGenerations = new Map<string, number>()
  private readonly catalogScanControllers = new Map<string, Set<AbortController>>()
  private readonly catalogScanGates = new Map<string, ConcurrencyGate>()
  private readonly cursorTtlMs: number
  private readonly maxCursorEntries: number
  private readonly catalogScanCacheTtlMs: number
  private readonly sourceConcurrency: ConcurrencyGate
  private readonly now: () => number
  private readonly adapterHttpClients: ReadonlyMap<string, CatalogHttpClient>
  private readonly media: CatalogMediaRegistry
  private readonly observeSnapshot: ((snapshot: CatalogSnapshot) => void) | undefined

  constructor(
    private readonly store: { load(): Promise<readonly LocalSourceRecord[]> },
    private readonly http: CatalogHttpClient,
    options: CatalogServiceOptions = {},
  ) {
    this.cursorTtlMs = options.cursorTtlMs ?? 30 * 60 * 1000
    this.maxCursorEntries = options.maxCursorEntries ?? 512
    this.catalogScanCacheTtlMs = options.catalogScanCacheTtlMs ?? options.cacheTtlMs ?? DEFAULT_CATALOG_SCAN_CACHE_TTL_MS
    const maxConcurrentSources = options.maxConcurrentSources ?? 4
    const maxCacheEntries = options.maxCacheEntries ?? 256
    if (!Number.isSafeInteger(maxCacheEntries) || maxCacheEntries < 1) {
      throw new TypeError('invalid catalog cache entry limit')
    }
    if (!Number.isSafeInteger(this.maxCursorEntries) || this.maxCursorEntries < 1) {
      throw new TypeError('invalid catalog cursor entry limit')
    }
    if (!Number.isFinite(this.cursorTtlMs) || this.cursorTtlMs <= 0) {
      throw new TypeError('invalid catalog cursor TTL')
    }
    if (!Number.isFinite(this.catalogScanCacheTtlMs) || this.catalogScanCacheTtlMs <= 0) {
      throw new TypeError('invalid catalog scan cache TTL')
    }
    if (!Number.isSafeInteger(maxConcurrentSources) || maxConcurrentSources < 1) {
      throw new TypeError('invalid catalog source concurrency limit')
    }
    this.sourceConcurrency = new ConcurrencyGate(maxConcurrentSources)
    this.now = options.now ?? Date.now
    this.adapterHttpClients = options.adapterHttpClients ?? new Map()
    this.media = options.media ?? unavailableMedia
    this.observeSnapshot = options.observeSnapshot
  }

  async listSources(): Promise<readonly MarketSourceView[]> {
    const records = await this.store.load()
    return [...records].sort((left, right) => left.order - right.order).map(sourceView)
  }

  invalidateSource(sourceRecordId: string): void {
    this.sourceGenerations.set(sourceRecordId, (this.sourceGenerations.get(sourceRecordId) ?? 0) + 1)
    for (const [key, controllers] of this.catalogScanControllers) {
      if (!key.startsWith(`${sourceRecordId}\0`)) continue
      for (const controller of controllers) {
        controller.abort(new DOMException('Catalog source was disabled or removed', 'AbortError'))
      }
      this.catalogScanControllers.delete(key)
    }
    for (const [key, entry] of this.catalogScanCache) {
      if (entry.sourceRecordId === sourceRecordId) this.catalogScanCache.delete(key)
    }
    this.revokeSourceCursors(sourceRecordId)
    this.media.unregisterSource(sourceRecordId)
  }

  private purgeExpiredCursors(): void {
    const now = this.now()
    for (const [token, entry] of this.cursors) {
      if (now - entry.savedAt >= this.cursorTtlMs) this.cursors.delete(token)
    }
  }

  private issueCursor(
    rawCursor: string,
    sourceRecordId: string,
    query: CatalogQuery,
    generation: number,
  ): string {
    this.purgeExpiredCursors()
    let token = randomUUID()
    while (this.cursors.has(token)) token = randomUUID()
    this.cursors.set(token, {
      cursor: scopeCatalogCursor(rawCursor, sourceRecordId, query),
      generation,
      savedAt: this.now(),
    })
    while (this.cursors.size > this.maxCursorEntries) {
      const oldest = this.cursors.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.cursors.delete(oldest)
    }
    return token
  }

  private applyCursor(
    token: string,
    sourceRecordId: string,
    query: CatalogQuery,
    generation: number,
  ): CatalogQuery {
    this.purgeExpiredCursors()
    const entry = this.cursors.get(token)
    if (entry === undefined || entry.generation !== generation) {
      if (entry !== undefined) this.cursors.delete(token)
      throw new Error('catalog cursor is unknown or expired')
    }
    return applyScopedCatalogCursor(entry.cursor, sourceRecordId, query)
  }

  private exposeSnapshot(
    snapshot: CatalogSnapshot,
    sourceRecordId: string,
    query: CatalogQuery,
    generation: number,
  ): CatalogSnapshot {
    const rawCursor = snapshot.page.nextCursor
    if (rawCursor === undefined) return snapshot
    return {
      ...snapshot,
      page: {
        ...snapshot.page,
        nextCursor: this.issueCursor(rawCursor, sourceRecordId, query, generation),
      },
    }
  }

  private revokeSourceCursors(sourceRecordId: string): void {
    for (const [token, entry] of this.cursors) {
      if (entry.cursor.sourceRecordId === sourceRecordId) this.cursors.delete(token)
    }
  }

  private resetCatalogScan(key: string, sourceRecordId: string): number {
    const generation = (this.catalogScanGenerations.get(key) ?? 0) + 1
    this.catalogScanGenerations.set(key, generation)
    this.catalogScanCache.delete(key)
    for (const controller of this.catalogScanControllers.get(key) ?? []) {
      controller.abort(new DOMException('Catalog refresh replaced this scan', 'AbortError'))
    }
    this.catalogScanControllers.delete(key)
    this.revokeSourceCursors(sourceRecordId)
    return generation
  }

  async scanCatalog(
    signal: AbortSignal,
    options: CatalogScanOptions = {},
  ): Promise<CatalogFullIndex | undefined> {
    if (options.force !== undefined && typeof options.force !== 'boolean') {
      throw new TypeError('invalid catalog scan options')
    }
    if (
      options.expectedSourceRecordId !== undefined
      && (typeof options.expectedSourceRecordId !== 'string' || options.expectedSourceRecordId.length === 0)
    ) {
      throw new TypeError('invalid catalog scan options')
    }
    const scanQuery = normalizeCatalogQuery({
      limit: 100,
      ...(options.locale === undefined ? {} : { locale: options.locale }),
    })
    const locale = scanQuery.locale
    signal.throwIfAborted()
    const sourceGenerationsAtLoadStart = new Map(this.sourceGenerations)
    const records = [...await this.store.load()].sort((left, right) => left.order - right.order)
    signal.throwIfAborted()
    const source = records.find(record => record.enabled)
    if (
      options.expectedSourceRecordId !== undefined
      && source?.sourceRecordId !== options.expectedSourceRecordId
    ) {
      throw new Error('catalog source is not active')
    }
    if (source === undefined) return undefined
    const sourceGeneration = sourceGenerationsAtLoadStart.get(source.sourceRecordId) ?? 0
    if ((this.sourceGenerations.get(source.sourceRecordId) ?? 0) !== sourceGeneration) {
      throw new Error('catalog source changed during scan setup')
    }
    const key = catalogScanKey(source.sourceRecordId, locale)
    let scanGate = this.catalogScanGates.get(key)
    if (scanGate === undefined) {
      scanGate = new ConcurrencyGate(1)
      this.catalogScanGates.set(key, scanGate)
    }
    const scanGeneration = options.force === true
      ? this.resetCatalogScan(key, source.sourceRecordId)
      : this.catalogScanGenerations.get(key) ?? 0
    const cached = this.catalogScanCache.get(key)
    if (
      options.force !== true
      && cached !== undefined
      && cached.sourceGeneration === sourceGeneration
      && cached.scanGeneration === scanGeneration
      && this.now() < cached.expiresAt
    ) return cachedScanView(cached, 'cached')
    if (cached !== undefined) {
      if (this.now() >= cached.expiresAt) this.revokeSourceCursors(source.sourceRecordId)
      this.catalogScanCache.delete(key)
    }

    return await scanGate.run(signal, async () => await this.sourceConcurrency.run(signal, async () => {
      signal.throwIfAborted()
      if (
        (this.sourceGenerations.get(source.sourceRecordId) ?? 0) !== sourceGeneration
        || (this.catalogScanGenerations.get(key) ?? 0) !== scanGeneration
      ) throw new Error('catalog source changed while waiting to scan')
      const cachedAfterWait = this.catalogScanCache.get(key)
      if (
        options.force !== true
        && cachedAfterWait !== undefined
        && cachedAfterWait.sourceGeneration === sourceGeneration
        && cachedAfterWait.scanGeneration === scanGeneration
        && this.now() < cachedAfterWait.expiresAt
      ) return cachedScanView(cachedAfterWait, 'cached')
      if (cachedAfterWait !== undefined) {
        if (this.now() >= cachedAfterWait.expiresAt) this.revokeSourceCursors(source.sourceRecordId)
        this.catalogScanCache.delete(key)
      }
      const adapter = adapters.get(source.adapterId)
      if (adapter === undefined) throw new Error('catalog adapter unavailable')
      const invalidationController = new AbortController()
      const controllers = this.catalogScanControllers.get(key) ?? new Set<AbortController>()
      controllers.add(invalidationController)
      this.catalogScanControllers.set(key, controllers)
      const sourceSignal = AbortSignal.any([signal, invalidationController.signal])
      const delegate = this.adapterHttpClients.get(source.adapterId) ?? this.http
      const http: CatalogHttpClient = {
        getJson: async (url, requestSignal, policy = {}) => await delegate.getJson(
          url,
          requestSignal,
          options.force === true ? { ...policy, cacheMode: 'reload' } : policy,
        ),
      }
      const context = { signal: sourceSignal, source, http, media: this.media }
      try {
        let rawSnapshots: readonly CatalogSnapshot[]
        if (adapter.scanCatalog !== undefined) {
          rawSnapshots = await adapter.scanCatalog(scanQuery, context)
        } else {
          const pages: CatalogSnapshot[] = []
          const cursors = new Set<string>()
          let query: CatalogQuery = scanQuery
          while (true) {
            sourceSignal.throwIfAborted()
            if (pages.length >= MAX_CATALOG_PAGES) {
              throw new Error('catalog scan exceeded the page limit')
            }
            const snapshot = parseCatalogSnapshot(await adapter.fetch(query, context))
            pages.push(snapshot)
            const itemCount = pages.reduce((total, page) => total + page.items.length, 0)
            if (itemCount > MAX_CATALOG_ITEMS) {
              throw new Error('catalog scan exceeded the item limit')
            }
            const cursor = snapshot.page.nextCursor
            if (cursor === undefined) break
            if (cursors.has(cursor)) throw new Error('catalog scan cursor repeated')
            cursors.add(cursor)
            query = { ...scanQuery, cursor }
          }
          rawSnapshots = pages
        }
        sourceSignal.throwIfAborted()
        if (
          (this.sourceGenerations.get(source.sourceRecordId) ?? 0) !== sourceGeneration
          || (this.catalogScanGenerations.get(key) ?? 0) !== scanGeneration
        ) throw new Error('catalog source changed during scan')
        const complete = validateCompleteCatalogScan(source, rawSnapshots)
        const scannedAt = this.now()
        const entry: CatalogFullIndexCacheEntry = {
          sourceRecordId: source.sourceRecordId,
          sourceGeneration,
          scanGeneration,
          ...(locale === undefined ? {} : { locale }),
          source: sourceView(source),
          snapshots: complete.snapshots,
          scannedAt,
          expiresAt: scannedAt + this.catalogScanCacheTtlMs,
          ...(complete.providerRevision === undefined ? {} : { providerRevision: complete.providerRevision }),
          scanKey: randomUUID(),
        }
        this.catalogScanCache.set(key, entry)
        for (const snapshot of entry.snapshots) {
          try { this.observeSnapshot?.(snapshot) } catch { /* installation is optional; catalog browsing remains available */ }
        }
        return cachedScanView(entry, 'fresh')
      } finally {
        controllers.delete(invalidationController)
        if (controllers.size === 0 && this.catalogScanControllers.get(key) === controllers) {
          this.catalogScanControllers.delete(key)
        }
      }
    }))
  }

  queryCatalog(
    index: CatalogFullIndex,
    value: unknown,
    scope?: CatalogFetchScope,
  ): readonly MarketCatalogSourceResult[] {
    if (scope !== undefined && (
      typeof scope.sourceRecordId !== 'string'
      || scope.sourceRecordId.length === 0
      || scope.cursor !== undefined && (
        typeof scope.cursor !== 'string'
        || scope.cursor.length === 0
      )
    )) {
      throw new Error('catalog source scope is invalid')
    }
    const baseQuery = normalizeCatalogQuery(value)
    if (baseQuery.cursor !== undefined) {
      throw new Error('catalog cursor requires an explicit source scope')
    }
    if (scope !== undefined && index.source.sourceRecordId !== scope.sourceRecordId) {
      throw new Error('catalog source is not active')
    }
    if ((this.sourceGenerations.get(index.source.sourceRecordId) ?? 0) !== index.sourceGeneration) {
      throw new Error('catalog source is no longer active')
    }
    if (baseQuery.locale !== index.locale) throw new Error('catalog index locale does not match the query')
    const query = scope?.cursor === undefined
      ? baseQuery
      : this.applyCursor(scope.cursor, scope.sourceRecordId, baseQuery, index.sourceGeneration)
    const filtered = sortCatalogItems(
      completeItems(index).filter(item => matchesCatalogQuery(item, query)),
      query,
    )
    const rawCursor = query.cursor ?? '0'
    if (!/^\d+$/u.test(rawCursor)) throw new Error('catalog cursor is invalid')
    const offset = Number(rawCursor)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > filtered.length) {
      throw new Error('catalog cursor is invalid')
    }
    const limit = Math.min(
      query.limit ?? 50,
      index.source.adapterId === DSH_1024STORE_ADAPTER_ID ? 50 : 100,
    )
    const end = Math.min(offset + limit, filtered.length)
    const baseSnapshot = index.snapshots[0]
    if (baseSnapshot === undefined) return [{ source: index.source, stale: false }]
    const snapshot = parseCatalogSnapshot({
      schemaVersion: '1.0.0',
      source: baseSnapshot.source,
      items: filtered.slice(offset, end),
      page: {
        total: filtered.length,
        ...(end < filtered.length ? { nextCursor: String(end) } : {}),
      },
    })
    return [{
      source: index.source,
      snapshot: this.exposeSnapshot(snapshot, index.source.sourceRecordId, baseQuery, index.sourceGeneration),
      stale: false,
    }]
  }

  async fetch(
    value: unknown,
    signal: AbortSignal,
    scope?: CatalogFetchScope,
  ): Promise<readonly MarketCatalogSourceResult[]> {
    const query = normalizeCatalogQuery(value)
    if (query.cursor !== undefined) throw new Error('catalog cursor requires an explicit source scope')
    const index = await this.scanCatalog(signal, {
      ...(query.locale === undefined ? {} : { locale: query.locale }),
      ...(scope === undefined ? {} : { expectedSourceRecordId: scope.sourceRecordId }),
    })
    signal.throwIfAborted()
    return index === undefined ? [] : this.queryCatalog(index, query, scope)
  }
}
