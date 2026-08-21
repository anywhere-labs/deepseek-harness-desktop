import type { CatalogQuery, CatalogSnapshot } from '../contracts/index.js'
import { parseCatalogSnapshot } from '../contracts/validate.js'
import type { CatalogHttpClient, CatalogMediaRegistry, LocalSourceRecord, ScopedCatalogCursor } from '../contracts/types.js'
import type { MarketCatalogSourceResult, MarketSourceView } from '../api-types.js'
import { BUILT_IN_PROVIDERS } from './built-in-providers.js'

export const MAX_CATALOG_ITEMS = 10_000
export const MAX_CATALOG_PAGES = 10_001
export const DEFAULT_CATALOG_SCAN_CACHE_TTL_MS = 5 * 60 * 1000

export function sourceView(record: LocalSourceRecord): MarketSourceView {
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

export function catalogScanKey(sourceRecordId: string, locale: string | undefined): string {
  return `${sourceRecordId}\0${locale ?? ''}`
}

export function cachedScanView(entry: CatalogFullIndexCacheEntry, cacheStatus: 'fresh' | 'cached'): CatalogFullIndex {
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

export type CatalogItem = CatalogSnapshot['items'][number]

export function completeItems(index: CatalogFullIndex): readonly CatalogItem[] {
  return index.snapshots.flatMap(snapshot => snapshot.items)
}

export function localSourceFromView(view: MarketSourceView): LocalSourceRecord {
  return {
    sourceRecordId: view.sourceRecordId,
    registrationKind: view.registrationKind,
    adapterId: view.adapterId,
    providerId: view.providerId,
    ...(view.manifestUrl === undefined ? {} : { manifestUrl: view.manifestUrl }),
    ...(view.manifest === undefined ? {} : { manifest: view.manifest }),
    ...(view.builtInProviderKey === undefined ? {} : { builtInProviderKey: view.builtInProviderKey }),
    enabled: view.enabled,
    order: view.order,
  }
}

export function chunkCatalogItems(
  items: readonly CatalogItem[],
  template: CatalogSnapshot,
): readonly CatalogSnapshot[] {
  const total = items.length
  if (total === 0) {
    return [parseCatalogSnapshot({
      schemaVersion: template.schemaVersion,
      source: template.source,
      items: [],
      page: { total: 0 },
    })]
  }
  const snapshots: CatalogSnapshot[] = []
  for (let offset = 0; offset < items.length; offset += 100) {
    snapshots.push(parseCatalogSnapshot({
      schemaVersion: template.schemaVersion,
      source: template.source,
      items: items.slice(offset, offset + 100),
      page: { total },
    }))
  }
  return snapshots
}

export function normalizedSearchText(item: CatalogItem): string {
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

export function matchesCatalogQuery(item: CatalogItem, query: CatalogQuery): boolean {
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

export function sortCatalogItems(items: readonly CatalogItem[], query: CatalogQuery): readonly CatalogItem[] {
  if (query.sort === undefined || query.sort === 'relevance' || query.sort === 'downloads') return items
  return items.map((item, position) => ({ item, position })).sort((left, right) => {
    const compared = query.sort === 'name'
      ? left.item.displayName.localeCompare(right.item.displayName, query.locale ?? 'en', { sensitivity: 'base' })
      : (Date.parse(right.item.updatedAt ?? '') || 0) - (Date.parse(left.item.updatedAt ?? '') || 0)
    return compared || left.position - right.position
  }).map(value => value.item)
}

export function validateCompleteCatalogScan(
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
  /**
   * For 1024Store, merge a provider `q` search page into the cached homepage
   * slice so one-click and market search can resolve packages that are not in
   * the published first page. Does not replace the cached scan.
   */
  mergeProviderSearch?(
    index: CatalogFullIndex,
    query: unknown,
    signal: AbortSignal,
  ): Promise<CatalogFullIndex>
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

export const unavailableMedia: CatalogMediaRegistry = {
  register() {
    throw new Error('catalog media service is unavailable')
  },
  unregisterSource() {},
}

export interface CatalogCursorEntry {
  readonly cursor: ScopedCatalogCursor
  readonly generation: number
  readonly savedAt: number
}

export interface CatalogFullIndexCacheEntry {
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

export interface ConcurrencyWaiter {
  readonly signal: AbortSignal
  readonly resolve: () => void
  readonly reject: (cause: unknown) => void
  readonly onAbort: () => void
}

export class ConcurrencyGate {
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
