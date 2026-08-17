import type { CatalogAdapter, CatalogFetchContext } from '../contracts/types.js'
import type { CatalogQuery } from '../contracts/generated/catalog-query.js'
import type { CatalogSnapshot } from '../contracts/generated/catalog-snapshot.js'
import { parseCatalogSnapshot } from '../contracts/validate.js'
import { normalizeRepositoryIdentity } from '../contracts/identity.js'

export const DSH_1024STORE_KEY = 'dsh-1024store'
export const DSH_1024STORE_ENDPOINT = 'https://api.deepseek1024.com/v1/plugins/search'
export const DSH_1024STORE_PROVIDER_ID = 'com.deepseek1024.catalog'
export const DSH_1024STORE_ADAPTER_ID = 'market.dsh-1024store-v1'

export interface Dsh1024StoreRawItem {
  readonly id?: unknown
  readonly name?: unknown
  readonly owner?: unknown
  readonly url?: unknown
  readonly category?: unknown
  readonly description?: unknown
  readonly pushedAt?: unknown
}

function plainText(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) return fallback
  return value
}

function repositoryFromItem(item: Dsh1024StoreRawItem): { url: string; subdirectory?: string } | undefined {
  if (typeof item.url !== 'string' || !/^https:\/\/github\.com\//iu.test(item.url)) return undefined
  const parts = typeof item.id === 'string' ? item.id.split('/').filter(Boolean) : []
  if (parts.length < 2) return undefined
  try {
    return normalizeRepositoryIdentity({
      url: `https://github.com/${parts[0]}/${parts[1]}`,
      ...(parts.length > 2 ? { subdirectory: parts.slice(2).join('/') } : {}),
    })
  } catch {
    return undefined
  }
}

function buildSnapshot(value: unknown, source: CatalogFetchContext['source'], finalUrl: string, query: CatalogQuery): CatalogSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('1024Store response is not an object')
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.results) || raw.results.length > Math.min(query.limit ?? 20, 100)) {
    throw new Error('1024Store response exceeds the requested limit')
  }
  const page = typeof raw.page === 'number' && Number.isInteger(raw.page) ? raw.page : 1
  const totalPages = typeof raw.totalPages === 'number' && Number.isInteger(raw.totalPages) ? raw.totalPages : page
  const total = typeof raw.total === 'number' && Number.isInteger(raw.total) && raw.total >= 0 ? raw.total : undefined
  const items = raw.results.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`1024Store item ${index} is invalid`)
    const item = entry as Dsh1024StoreRawItem
    const id = plainText(item.id, 160, '')
    const name = plainText(item.name, 160, '')
    if (!id || !name) throw new Error(`1024Store item ${index} has no identity`)
    const repository = repositoryFromItem(item)
    if (repository === undefined) throw new Error(`1024Store item ${index} has no supported repository`)
    const descriptionValue = item.description
    const description = descriptionValue !== null && typeof descriptionValue === 'object'
      ? (descriptionValue as Record<string, unknown>)
      : {}
    const summary = plainText(description.zh ?? description.en, 1000, name)
    const category = typeof item.category === 'string' && /^[a-z0-9][a-z0-9._:-]*$/u.test(item.category)
      ? item.category
      : undefined
    const owner = plainText(item.owner, 120, 'Unknown publisher')
    const pushedAt = typeof item.pushedAt === 'string' && !Number.isNaN(Date.parse(item.pushedAt))
      ? new Date(item.pushedAt).toISOString()
      : undefined
    return {
      id,
      name,
      displayName: name,
      summary,
      ...(descriptionValue === undefined ? {} : { description: summary }),
      ...(category === undefined ? {} : { categories: [category] }),
      repository,
      publisher: { name: owner, url: `https://github.com/${owner}` },
      ...(pushedAt === undefined ? {} : { updatedAt: pushedAt }),
      provenance: {
        sourceRecordId: source.sourceRecordId,
        providerId: source.providerId,
        itemId: id,
      },
    }
  })
  return parseCatalogSnapshot({
    schemaVersion: '1.0.0',
    source: {
      sourceRecordId: source.sourceRecordId,
      providerId: source.providerId,
      adapterId: source.adapterId,
      registrationKind: source.registrationKind,
      fetchedAt: new Date().toISOString(),
      finalUrl,
    },
    items,
    page: page < totalPages ? { nextCursor: String(page + 1), ...(total === undefined ? {} : { total }) } : { ...(total === undefined ? {} : { total }) },
  })
}

export const dsh1024StoreAdapter: CatalogAdapter = {
  adapterId: DSH_1024STORE_ADAPTER_ID,
  async fetch(queryValue, context) {
    const query = { ...queryValue, q: queryValue.q ?? 'plugin', limit: Math.min(queryValue.limit ?? 20, 20) }
    const url = new URL(DSH_1024STORE_ENDPOINT)
    url.searchParams.set('q', query.q)
    url.searchParams.set('limit', String(query.limit))
    if (query.cursor !== undefined && /^\d+$/u.test(query.cursor)) url.searchParams.set('page', query.cursor)
    if (query.category?.[0] !== undefined) url.searchParams.set('category', query.category[0])
    url.searchParams.set('sortBy', query.sort === 'updated' ? 'recent' : 'stars')
    const response = await context.http.getJson(url.href, context.signal)
    return buildSnapshot(response.value, context.source, response.finalUrl, query)
  },
}
