import type { CatalogQuery, CatalogSnapshot } from '../contracts/index.js'
import { normalizeCatalogQuery } from '../contracts/query.js'
import { parseCatalogSnapshot } from '../contracts/validate.js'
import type { CatalogAdapter, CatalogHttpClient, LocalSourceRecord } from '../contracts/types.js'
import type { MarketCatalogSourceResult, MarketSourceView } from '../api-types.js'
import { DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_ENDPOINT, DSH_1024STORE_KEY, DSH_1024STORE_PROVIDER_ID, dsh1024StoreAdapter } from '../adapters/dsh-1024store.js'
import { standardHttpAdapter } from '../adapters/standard-http.js'

export interface BuiltInProviderDefinition {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly providerId: string
  readonly adapterId: string
  readonly endpoint: string
  readonly partnership: boolean
}

export const BUILT_IN_PROVIDERS: readonly BuiltInProviderDefinition[] = [{
  key: DSH_1024STORE_KEY,
  name: 'DSH 1024Store',
  description: '合作提供方目录。需要用户明确添加并启用。目录收录不代表插件经过审核或推荐。',
  providerId: DSH_1024STORE_PROVIDER_ID,
  adapterId: DSH_1024STORE_ADAPTER_ID,
  endpoint: DSH_1024STORE_ENDPOINT,
  partnership: true,
}]

const adapters = new Map<string, CatalogAdapter>([
  [standardHttpAdapter.adapterId, standardHttpAdapter],
  [dsh1024StoreAdapter.adapterId, dsh1024StoreAdapter],
])

function sourceView(record: LocalSourceRecord): MarketSourceView {
  const builtIn = record.builtInProviderKey === undefined
    ? undefined
    : BUILT_IN_PROVIDERS.find(provider => provider.key === record.builtInProviderKey)
  return {
    ...record,
    name: builtIn?.name ?? record.providerId,
    ...(builtIn?.description === undefined ? {} : { description: builtIn.description }),
    endpoint: builtIn?.endpoint ?? (record.manifestUrl === undefined ? record.providerId : new URL(record.manifestUrl).origin),
    partnership: builtIn?.partnership ?? false,
  }
}

function cacheKey(source: LocalSourceRecord, query: CatalogQuery): string {
  return `${source.sourceRecordId}:${JSON.stringify(query)}`
}

function safeError(cause: unknown): string {
  if (cause instanceof Error && cause.message.startsWith('catalog request failed: ')) return cause.message.slice(23)
  if (cause instanceof Error && cause.name === 'CatalogContractError') return 'invalid catalog data'
  return 'source unavailable'
}

export interface CatalogService {
  listSources(): Promise<readonly MarketSourceView[]>
  fetch(query: unknown, signal: AbortSignal): Promise<readonly MarketCatalogSourceResult[]>
}

export interface CatalogServiceOptions {
  readonly cacheTtlMs?: number
  readonly now?: () => number
}

export class DefaultCatalogService implements CatalogService {
  private readonly cache = new Map<string, { snapshot: CatalogSnapshot; savedAt: number }>()
  private readonly cacheTtlMs: number
  private readonly now: () => number

  constructor(
    private readonly store: { load(): Promise<readonly LocalSourceRecord[]> },
    private readonly http: CatalogHttpClient,
    options: CatalogServiceOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000
    this.now = options.now ?? Date.now
  }

  async listSources(): Promise<readonly MarketSourceView[]> {
    const records = await this.store.load()
    return [...records].sort((left, right) => left.order - right.order).map(sourceView)
  }

  async fetch(value: unknown, signal: AbortSignal): Promise<readonly MarketCatalogSourceResult[]> {
    const query = normalizeCatalogQuery(value)
    const records = (await this.store.load()).filter(record => record.enabled).sort((left, right) => left.order - right.order)
    return await Promise.all(records.map(async source => {
      const key = cacheKey(source, query)
      const adapter = adapters.get(source.adapterId)
      if (adapter === undefined) return { source: sourceView(source), stale: false, error: 'adapter unavailable' }
      try {
        const snapshot = parseCatalogSnapshot(await adapter.fetch(query, { signal, source, http: this.http }))
        this.cache.set(key, { snapshot, savedAt: this.now() })
        return { source: sourceView(source), snapshot, stale: false }
      } catch (cause) {
        const cached = this.cache.get(key)
        if (cached !== undefined && this.now() - cached.savedAt < this.cacheTtlMs) {
          return { source: sourceView(source), snapshot: cached.snapshot, stale: true, error: safeError(cause) }
        }
        this.cache.delete(key)
        return { source: sourceView(source), stale: false, error: safeError(cause) }
      }
    }))
  }
}
