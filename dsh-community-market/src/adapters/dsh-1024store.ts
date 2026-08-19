import type { CatalogAdapter, CatalogFetchContext } from '../contracts/types.js'
import type { CatalogQuery } from '../contracts/generated/catalog-query.js'
import type { CatalogSnapshot } from '../contracts/generated/catalog-snapshot.js'
import { parseCatalogSnapshot } from '../contracts/validate.js'
import { normalizeRepositoryIdentity } from '../contracts/identity.js'

export const DSH_1024STORE_KEY = 'dsh-1024store'
export const DSH_1024STORE_ENDPOINT = 'https://deepseek1024.com/api/v2/plugins'
export const DSH_1024STORE_HOSTNAME = 'deepseek1024.com'
export const DSH_1024STORE_PROVIDER_ID = 'com.deepseek1024.catalog'
export const DSH_1024STORE_ADAPTER_ID = 'market.dsh-1024store-v1'

// The reviewed provider publishes a paged v2 registry. The desktop asks for
// exactly one page of the newest entries and never walks the remaining pages:
// the full-registry download is intentionally replaced by a bounded first page
// so overseas refreshes stay small and fast.
const DSH_1024STORE_SOURCE = 'dsh-desktop'
const DSH_1024STORE_LIMIT = 100
const MAX_PLUGIN_ITEMS = 10_000
const EXPECTED_ORIGIN = new URL(DSH_1024STORE_ENDPOINT).origin

function requestUrl(): string {
  const url = new URL(DSH_1024STORE_ENDPOINT)
  url.searchParams.set('limit', String(DSH_1024STORE_LIMIT))
  url.searchParams.set('source', DSH_1024STORE_SOURCE)
  return url.href
}

interface Dsh1024StorePlugin {
  readonly id?: unknown
  readonly name?: unknown
  readonly owner?: unknown
  readonly repository?: unknown
  readonly url?: unknown
  readonly category?: unknown
  readonly description?: unknown
  readonly added?: unknown
  readonly stars?: unknown
  readonly forks?: unknown
  readonly pushedAt?: unknown
  readonly updatedAt?: unknown
  readonly latestReleaseAt?: unknown
  readonly installCount?: unknown
}

interface Dsh1024StoreCatalog {
  readonly plugins?: unknown
  readonly generatedAt?: unknown
}

type CatalogItem = CatalogSnapshot['items'][number]
type CatalogRepository = NonNullable<CatalogItem['repository']>
type CatalogPublisher = NonNullable<CatalogItem['publisher']>
type CatalogMedia = NonNullable<CatalogItem['media']>
type CatalogProvenance = CatalogItem['provenance']

/**
 * The exact normalized shape the 1024Store v2 adapter emits: a browse-only
 * repository item without an npm package identity.
 */
interface BrowseOnlyItem {
  readonly id: string
  readonly name: string
  readonly displayName: string
  readonly summary: string
  readonly description?: string
  readonly categories?: string[]
  readonly repository: CatalogRepository
  readonly publisher?: CatalogPublisher
  readonly updatedAt?: string
  readonly media?: CatalogMedia
  readonly provenance: CatalogProvenance
}

interface RegistryCandidate {
  readonly item: BrowseOnlyItem
  readonly mediaCandidates: readonly MediaCandidate[]
  readonly stars: number
  readonly downloads: number
  readonly updatedAt: number
}

interface MediaCandidate {
  readonly remoteUrl: string
  readonly role: 'plugin-icon' | 'publisher-avatar'
  readonly alt?: string
  readonly allowedHostnames: readonly string[]
}

const GITHUB_OWNER_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/iu
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9._-]{1,100}$/iu

function plainText(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) return fallback
  return value
}

/**
 * Derive canonical GitHub repository identity from the provider's `url` field.
 * The provider item `id` is source-local identity and never the authority for
 * repository location; repository renames and transfers keep the URL canonical.
 */
function repositoryFromItem(item: Dsh1024StorePlugin): { url: string; subdirectory?: string } | undefined {
  try {
    if (typeof item.url !== 'string') return undefined
    const suppliedUrl = new URL(item.url)
    const suppliedPath = suppliedUrl.pathname.split('/').filter(Boolean)
    if (
      suppliedUrl.protocol !== 'https:'
      || suppliedUrl.hostname.toLowerCase() !== 'github.com'
      || suppliedUrl.username
      || suppliedUrl.password
      || suppliedUrl.search
      || suppliedUrl.hash
      || suppliedPath.length !== 2
    ) return undefined
    const owner = suppliedPath[0]!
    const repository = suppliedPath[1]!.replace(/\.git$/iu, '')
    if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPOSITORY_PATTERN.test(repository)) return undefined
    const parts = typeof item.id === 'string' ? item.id.split('/').filter(Boolean) : []
    const idMatchesRepository = parts.length >= 2
      && parts[0]!.toLowerCase() === owner.toLowerCase()
      && parts[1]!.replace(/\.git$/iu, '').toLowerCase() === repository.toLowerCase()
    return normalizeRepositoryIdentity({
      url: `https://github.com/${owner}/${repository}`,
      ...(idMatchesRepository && parts.length > 2 ? { subdirectory: parts.slice(2).join('/') } : {}),
    })
  } catch {
    return undefined
  }
}

function githubOwner(repositoryUrl: string): string | undefined {
  try {
    const url = new URL(repositoryUrl)
    const owner = url.pathname.split('/').filter(Boolean)[0]
    return owner !== undefined && GITHUB_OWNER_PATTERN.test(owner)
      ? owner.toLowerCase()
      : undefined
  } catch {
    return undefined
  }
}

function mediaCandidates(repositoryUrl: string): readonly MediaCandidate[] {
  const owner = githubOwner(repositoryUrl)
  return owner === undefined ? [] : [{
    remoteUrl: `https://github.com/${owner}.png?size=96`,
    role: 'publisher-avatar' as const,
    alt: owner,
    allowedHostnames: ['github.com', 'avatars.githubusercontent.com'],
  }]
}

function resolvedMedia(
  candidates: readonly MediaCandidate[],
  itemId: string,
  context: CatalogFetchContext,
): CatalogMedia | undefined {
  for (const candidate of candidates) {
    try {
      const assetRef = context.media.register({
        ...candidate,
        sourceRecordId: context.source.sourceRecordId,
        itemId,
      })
      return { icon: { assetRef, role: candidate.role, ...(candidate.alt === undefined ? {} : { alt: candidate.alt }) } }
    } catch {
      // A bad optional image must not make an otherwise valid catalog item disappear.
    }
  }
  return undefined
}

/**
 * Normalize one provider plugin into a browse-only catalog item. The v2
 * registry does not carry an exact stable npm target; its `install` command
 * string is provider input and is therefore never read, displayed as
 * executable, or turned into an install intent.
 */
function normalizedItem(
  entry: unknown,
  context: CatalogFetchContext,
  locale: string | undefined,
): RegistryCandidate | undefined {
  try {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const item = entry as Dsh1024StorePlugin
    const id = plainText(item.id, 160, '')
    const name = plainText(item.name, 120, '')
    if (!id || !name || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(id)) return undefined
    const repository = repositoryFromItem(item)
    if (repository === undefined) return undefined
    const descriptionValue = item.description
    const description = descriptionValue !== null && typeof descriptionValue === 'object' && !Array.isArray(descriptionValue)
      ? (descriptionValue as Record<string, unknown>)
      : {}
    const prefersChinese = locale?.toLowerCase().startsWith('zh') ?? false
    const summary = plainText(
      prefersChinese ? description.zh ?? description.en : description.en ?? description.zh,
      1000,
      name,
    )
    const category = typeof item.category === 'string' && /^[a-z0-9][a-z0-9._:-]*$/u.test(item.category)
      ? item.category
      : undefined
    const repositoryOwner = githubOwner(repository.url)
    const suppliedOwner = plainText(item.owner, 120, '')
    const owner = repositoryOwner !== undefined && suppliedOwner.toLowerCase() === repositoryOwner
      ? suppliedOwner
      : repositoryOwner
    const updatedAtValue = item.pushedAt ?? item.updatedAt ?? item.latestReleaseAt
    const updatedAt = typeof updatedAtValue === 'string' && !Number.isNaN(Date.parse(updatedAtValue))
      ? new Date(updatedAtValue).toISOString()
      : undefined
    const addedAt = typeof item.added === 'string' && !Number.isNaN(Date.parse(item.added))
      ? Date.parse(item.added)
      : 0
    const normalized: BrowseOnlyItem = {
      id,
      name,
      displayName: name,
      summary,
      ...(descriptionValue === undefined ? {} : { description: summary }),
      ...(category === undefined ? {} : { categories: [category] }),
      repository,
      ...(owner === undefined ? {} : { publisher: { name: owner, url: `https://github.com/${owner}` } }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      provenance: {
        sourceRecordId: context.source.sourceRecordId,
        providerId: context.source.providerId,
        itemId: id,
      },
    }
    return {
      item: normalized,
      mediaCandidates: mediaCandidates(repository.url),
      stars: typeof item.stars === 'number' && Number.isFinite(item.stars) ? item.stars : 0,
      downloads: typeof item.installCount === 'number' && Number.isFinite(item.installCount) ? item.installCount : 0,
      updatedAt: updatedAt === undefined ? addedAt : Date.parse(updatedAt),
    }
  } catch {
    return undefined
  }
}

function compareCandidates(left: RegistryCandidate, right: RegistryCandidate, query: CatalogQuery): number {
  if (query.sort === 'name') return left.item.displayName.localeCompare(right.item.displayName, 'en', { sensitivity: 'base' })
  if (query.sort === 'updated') return right.updatedAt - left.updatedAt || right.stars - left.stars
  if (query.sort === 'downloads') return right.downloads - left.downloads || right.stars - left.stars
  return right.stars - left.stars || left.item.displayName.localeCompare(right.item.displayName, 'en', { sensitivity: 'base' })
}

function providerGeneratedAt(raw: Dsh1024StoreCatalog): string | undefined {
  const generatedAt = raw.generatedAt
  return typeof generatedAt === 'string' && !Number.isNaN(Date.parse(generatedAt))
    ? new Date(generatedAt).toISOString()
    : undefined
}

function assertProviderOrigin(finalUrl: string): void {
  let finalOrigin: string
  try {
    finalOrigin = new URL(finalUrl).origin
  } catch {
    throw new Error('1024Store final URL is invalid')
  }
  if (finalOrigin !== EXPECTED_ORIGIN) throw new Error('1024Store response changed the reviewed provider origin')
}

function buildSnapshot(value: unknown, context: CatalogFetchContext, finalUrl: string, query: CatalogQuery): CatalogSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('1024Store response is not an object')
  const raw = value as Dsh1024StoreCatalog
  if (!Array.isArray(raw.plugins) || raw.plugins.length > MAX_PLUGIN_ITEMS) throw new Error('1024Store catalog is invalid')
  if (query.cursor !== undefined && !/^\d+$/u.test(query.cursor)) throw new Error('1024Store cursor is invalid')
  const requestedCategories = new Set(query.category ?? [])
  const search = query.q?.toLocaleLowerCase('en-US')
  const candidates = raw.plugins
    .map(entry => normalizedItem(entry, context, query.locale))
    .filter((candidate): candidate is RegistryCandidate => candidate !== undefined)
    .filter(candidate => requestedCategories.size === 0
      || candidate.item.categories?.some(category => requestedCategories.has(category)) === true)
    .filter(() => query.capability === undefined || query.capability.length === 0)
    .filter(candidate => search === undefined || [
      candidate.item.id,
      candidate.item.displayName,
      candidate.item.publisher?.name ?? '',
      candidate.item.summary,
    ].some(value => value.toLocaleLowerCase('en-US').includes(search)))
    .sort((left, right) => compareCandidates(left, right, query))
  const offset = Number(query.cursor ?? 0)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > candidates.length) throw new Error('1024Store cursor is invalid')
  const limit = Math.min(query.limit ?? 50, 50)
  const end = Math.min(offset + limit, candidates.length)
  const generatedAt = providerGeneratedAt(raw)
  return parseCatalogSnapshot({
    schemaVersion: '1.0.0',
    source: {
      sourceRecordId: context.source.sourceRecordId,
      providerId: context.source.providerId,
      adapterId: context.source.adapterId,
      registrationKind: context.source.registrationKind,
      fetchedAt: new Date().toISOString(),
      finalUrl,
      ...(generatedAt === undefined ? {} : { providerGeneratedAt: generatedAt }),
    },
    items: candidates.slice(offset, end).map(candidate => {
      const media = resolvedMedia(candidate.mediaCandidates, candidate.item.id, context)
      return { ...candidate.item, ...(media === undefined ? {} : { media }) }
    }),
    page: end < candidates.length
      ? { nextCursor: String(end), total: candidates.length }
      : { total: candidates.length },
  })
}

function buildScanSnapshots(
  value: unknown,
  context: CatalogFetchContext,
  finalUrl: string,
  locale: string | undefined,
): readonly CatalogSnapshot[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('1024Store response is not an object')
  }
  const raw = value as Dsh1024StoreCatalog
  if (!Array.isArray(raw.plugins) || raw.plugins.length > MAX_PLUGIN_ITEMS) {
    throw new Error('1024Store catalog is invalid')
  }
  context.signal.throwIfAborted()

  const items: CatalogItem[] = []
  const seen = new Set<string>()
  for (const entry of raw.plugins) {
    const candidate = normalizedItem(entry, context, locale)
    if (candidate === undefined) continue
    if (seen.has(candidate.item.id)) throw new Error('1024Store catalog contains duplicate item IDs')
    seen.add(candidate.item.id)
    const media = resolvedMedia(candidate.mediaCandidates, candidate.item.id, context)
    items.push({ ...candidate.item, ...(media === undefined ? {} : { media }) })
  }

  const generatedAt = providerGeneratedAt(raw)
  const fetchedAt = new Date().toISOString()
  const snapshots: CatalogSnapshot[] = []
  for (let offset = 0; offset < items.length; offset += 100) {
    snapshots.push(parseCatalogSnapshot({
      schemaVersion: '1.0.0',
      source: {
        sourceRecordId: context.source.sourceRecordId,
        providerId: context.source.providerId,
        adapterId: context.source.adapterId,
        registrationKind: context.source.registrationKind,
        fetchedAt,
        finalUrl,
        ...(generatedAt === undefined ? {} : { providerGeneratedAt: generatedAt }),
      },
      items: items.slice(offset, offset + 100),
      page: { total: items.length },
    }))
  }
  if (snapshots.length === 0) {
    snapshots.push(parseCatalogSnapshot({
      schemaVersion: '1.0.0',
      source: {
        sourceRecordId: context.source.sourceRecordId,
        providerId: context.source.providerId,
        adapterId: context.source.adapterId,
        registrationKind: context.source.registrationKind,
        fetchedAt,
        finalUrl,
        ...(generatedAt === undefined ? {} : { providerGeneratedAt: generatedAt }),
      },
      items: [],
      page: { total: 0 },
    }))
  }
  return snapshots
}

export const dsh1024StoreAdapter: CatalogAdapter = {
  adapterId: DSH_1024STORE_ADAPTER_ID,
  async fetch(queryValue, context) {
    const query = { ...queryValue, limit: Math.min(queryValue.limit ?? 50, 50) }
    const response = await context.http.getJson(requestUrl(), context.signal, { allowedOrigin: EXPECTED_ORIGIN })
    assertProviderOrigin(response.finalUrl)
    return buildSnapshot(response.value, context, response.finalUrl, query)
  },
  async scanCatalog(query, context) {
    const response = await context.http.getJson(requestUrl(), context.signal, { allowedOrigin: EXPECTED_ORIGIN })
    context.signal.throwIfAborted()
    assertProviderOrigin(response.finalUrl)
    return buildScanSnapshots(response.value, context, response.finalUrl, query.locale)
  },
}
