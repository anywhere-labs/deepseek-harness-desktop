/**
 * Shared 1024Store-style catalog adapter factory.
 *
 * Extracted so official `dsh-1024store` and company `company-store` share one
 * parser. Hostname / endpoint / providerId / adapterId are compile-time config
 * only — never taken from remote manifests.
 */
import type { CatalogAdapter, CatalogFetchContext } from '../contracts/types.js'
import type { CatalogQuery } from '../contracts/generated/catalog-query.js'
import type { CatalogSnapshot } from '../contracts/generated/catalog-snapshot.js'
import { parseCatalogSnapshot } from '../contracts/validate.js'
import { normalizeRepositoryIdentity } from '../contracts/identity.js'

export interface Dsh1024StyleStoreConfig {
  readonly key: string
  readonly endpoint: string
  readonly hostname: string
  readonly providerId: string
  readonly adapterId: string
  /** Short label used in thrown Error messages. */
  readonly errorLabel: string
}

export interface Dsh1024StoreRawItem {
  readonly id?: unknown
  readonly name?: unknown
  readonly owner?: unknown
  readonly url?: unknown
  readonly category?: unknown
  readonly description?: unknown
  readonly pushedAt?: unknown
  readonly added?: unknown
  readonly stars?: unknown
  readonly installCount?: unknown
  readonly installMethods?: unknown
  readonly media?: unknown
}

interface Dsh1024StoreInstallMethod {
  readonly kind?: unknown
  readonly spec?: unknown
  readonly command?: unknown
  readonly verification?: unknown
  readonly code?: unknown
  readonly requiresBuildAllowance?: unknown
  readonly revision?: unknown
}

interface Dsh1024StoreMeta {
  readonly updated?: unknown
  readonly generatedAt?: unknown
  readonly revision?: unknown
  readonly total?: unknown
}

interface Dsh1024StoreCatalog {
  readonly packages?: unknown
  readonly meta?: unknown
}

interface RegistryCandidate {
  readonly item: CatalogSnapshot['items'][number]
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

export function createDsh1024StyleStoreAdapter(config: Dsh1024StyleStoreConfig): CatalogAdapter {
  const label = config.errorLabel

const GITHUB_OWNER_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/iu
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9._-]{1,100}$/iu
const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const STABLE_SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u

function plainText(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) return fallback
  return value
}

function completeCatalogQuery(query: CatalogQuery): boolean {
  return query.q === undefined
    && (query.category === undefined || query.category.length === 0)
    && (query.capability === undefined || query.capability.length === 0)
}

/** Public 1024Store registry URL. `q` is the provider's documented search field. */
function storeRegistryUrl(query: Pick<CatalogQuery, 'q'> = {}): string {
  if (query.q === undefined) return config.endpoint
  const url = new URL(config.endpoint)
  url.searchParams.set('q', query.q)
  return url.href
}

function providerTotal(meta: Dsh1024StoreMeta, receivedPackages: number): number | undefined {
  const total = meta.total
  if (total === undefined) return undefined
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total > 10_000) {
    throw new Error(`${label} provider total is inconsistent`)
  }
  if (total < receivedPackages) return undefined
  return total
}

/**
 * Convert only one provider-reviewed npm target into non-executable catalog
 * identity. The Host still revalidates the exact version against the npm
 * registry before it can create an install intent.
 */
function reviewedNpmTarget(item: Dsh1024StoreRawItem): { name: string; version: string } | undefined {
  if (!Array.isArray(item.installMethods)) return undefined
  const targets = new Map<string, { name: string; version: string }>()
  for (const value of item.installMethods) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const method = value as Dsh1024StoreInstallMethod
    if (
      method.kind !== 'npm'
      || method.verification !== 'verified'
      || method.code !== 'repository_backlink'
      || method.requiresBuildAllowance !== false
      || typeof method.spec !== 'string'
      || typeof method.revision !== 'string'
      || !NPM_PACKAGE_PATTERN.test(method.spec)
      || !STABLE_SEMVER_PATTERN.test(method.revision)
    ) continue
    targets.set(`${method.spec}@${method.revision}`, { name: method.spec, version: method.revision })
  }
  return targets.size === 1 ? targets.values().next().value : undefined
}

function repositoryFromItem(item: Dsh1024StoreRawItem): { url: string; subdirectory?: string } | undefined {
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
      // The provider item ID is source-local identity, not repository identity.
      // Repository renames and transfers make the canonical URL authoritative.
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

function explicitIcon(item: Dsh1024StoreRawItem): Omit<MediaCandidate, 'role'> | undefined {
  if (item.media === null || typeof item.media !== 'object' || Array.isArray(item.media)) return undefined
  const icon = (item.media as Record<string, unknown>).icon
  if (icon === null || typeof icon !== 'object' || Array.isArray(icon)) return undefined
  const candidate = icon as Record<string, unknown>
  if (typeof candidate.url !== 'string') return undefined
  try {
    const url = new URL(candidate.url)
    const hostname = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || ![config.hostname, 'github.com', 'avatars.githubusercontent.com'].includes(hostname)) return undefined
    const alt = plainText(candidate.alt, 240, '')
    return {
      remoteUrl: url.href,
      ...(alt ? { alt } : {}),
      allowedHostnames: hostname === 'github.com'
        ? ['github.com', 'avatars.githubusercontent.com']
        : [hostname],
    }
  } catch {
    return undefined
  }
}

function mediaCandidates(
  item: Dsh1024StoreRawItem,
  repositoryUrl: string,
): readonly MediaCandidate[] {
  const explicit = explicitIcon(item)
  const owner = githubOwner(repositoryUrl)
  return [
    ...(explicit === undefined ? [] : [{ ...explicit, role: 'plugin-icon' as const }]),
    ...(owner === undefined ? [] : [{
      remoteUrl: `https://github.com/${owner}.png?size=96`,
      role: 'publisher-avatar' as const,
      alt: owner,
      allowedHostnames: ['github.com', 'avatars.githubusercontent.com'],
    }]),
  ]
}

function resolvedMedia(
  candidates: readonly MediaCandidate[],
  itemId: string,
  context: CatalogFetchContext,
): CatalogSnapshot['items'][number]['media'] | undefined {
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

function normalizedItem(
  entry: unknown,
  context: CatalogFetchContext,
  locale: string | undefined,
): RegistryCandidate | undefined {
  try {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const item = entry as Dsh1024StoreRawItem
    const id = plainText(item.id, 160, '')
    const name = plainText(item.name, 120, '')
    if (!id || !name || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(id)) return undefined
    const repository = repositoryFromItem(item)
    if (repository === undefined) return undefined
    const descriptionValue = item.description
    const description = descriptionValue !== null && typeof descriptionValue === 'object'
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
    const pushedAt = typeof item.pushedAt === 'string' && !Number.isNaN(Date.parse(item.pushedAt))
      ? new Date(item.pushedAt).toISOString()
      : undefined
    const npmTarget = reviewedNpmTarget(item)
    const addedAt = typeof item.added === 'string' && !Number.isNaN(Date.parse(item.added))
      ? Date.parse(item.added)
      : 0
    const normalized: CatalogSnapshot['items'][number] = {
      id,
      name,
      displayName: name,
      summary,
      ...(descriptionValue === undefined ? {} : { description: summary }),
      ...(category === undefined ? {} : { categories: [category] }),
      repository,
      ...(npmTarget === undefined ? {} : {
        latestVersion: npmTarget.version,
        package: { registry: 'npm' as const, name: npmTarget.name },
      }),
      ...(owner === undefined ? {} : { publisher: { name: owner, url: `https://github.com/${owner}` } }),
      ...(pushedAt === undefined ? {} : { updatedAt: pushedAt }),
      provenance: {
        sourceRecordId: context.source.sourceRecordId,
        providerId: context.source.providerId,
        itemId: id,
      },
    }
    return {
      item: normalized,
      mediaCandidates: mediaCandidates(item, repository.url),
      stars: typeof item.stars === 'number' && Number.isFinite(item.stars) ? item.stars : 0,
      downloads: typeof item.installCount === 'number' && Number.isFinite(item.installCount) ? item.installCount : 0,
      updatedAt: pushedAt === undefined ? addedAt : Date.parse(pushedAt),
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

function buildSnapshot(value: unknown, context: CatalogFetchContext, finalUrl: string, query: CatalogQuery): CatalogSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} response is not an object`)
  const raw = value as Dsh1024StoreCatalog
  if (!Array.isArray(raw.packages) || raw.packages.length > 10_000) throw new Error(`${label} catalog is invalid`)
  if (query.cursor !== undefined && !/^\d+$/u.test(query.cursor)) throw new Error(`${label} cursor is invalid`)
  const requestedCategories = new Set(query.category ?? [])
  const search = query.q?.toLocaleLowerCase('en-US')
  const candidates = raw.packages
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
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > candidates.length) throw new Error(`${label} cursor is invalid`)
  const limit = Math.min(query.limit ?? 50, 50)
  const end = Math.min(offset + limit, candidates.length)
  const meta = raw.meta !== null && typeof raw.meta === 'object' && !Array.isArray(raw.meta)
    ? raw.meta as Dsh1024StoreMeta
    : {}
  const generatedAt = typeof meta.generatedAt === 'string' ? meta.generatedAt : meta.updated
  const providerGeneratedAt = typeof generatedAt === 'string' && !Number.isNaN(Date.parse(generatedAt))
    ? new Date(generatedAt).toISOString()
    : undefined
  const providerRevision = plainText(meta.revision, 160, '') || undefined
  const advertised = completeCatalogQuery(query)
    ? providerTotal(meta, raw.packages.length)
    : undefined
  // The live registry publishes a homepage slice (packages.length < meta.total)
  // and optional `q` search pages. Advertise only the reachable candidate count
  // so Host scan completeness does not demand the unpublished remainder.
  const total = advertised !== undefined && advertised <= candidates.length
    ? advertised
    : candidates.length
  return parseCatalogSnapshot({
    schemaVersion: '1.0.0',
    source: {
      sourceRecordId: context.source.sourceRecordId,
      providerId: context.source.providerId,
      adapterId: context.source.adapterId,
      registrationKind: context.source.registrationKind,
      fetchedAt: new Date().toISOString(),
      finalUrl,
      ...(providerGeneratedAt === undefined ? {} : { providerGeneratedAt }),
      ...(providerRevision === undefined ? {} : { providerRevision }),
    },
    items: candidates.slice(offset, end).map(candidate => {
      const media = resolvedMedia(candidate.mediaCandidates, candidate.item.id, context)
      return media === undefined ? candidate.item : { ...candidate.item, media }
    }),
    page: end < candidates.length
      ? { nextCursor: String(end), total }
      : { total },
  })
}

function buildCatalogScanSnapshots(
  value: unknown,
  context: CatalogFetchContext,
  finalUrl: string,
  locale: string | undefined,
): readonly CatalogSnapshot[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} response is not an object`)
  }
  const raw = value as Dsh1024StoreCatalog
  if (!Array.isArray(raw.packages) || raw.packages.length > 10_000) {
    throw new Error(`${label} catalog is invalid`)
  }
  context.signal.throwIfAborted()

  const items: CatalogSnapshot['items'][number][] = []
  const seen = new Set<string>()
  for (const entry of raw.packages) {
    const candidate = normalizedItem(entry, context, locale)
    if (candidate === undefined) continue
    if (seen.has(candidate.item.id)) throw new Error(`${label} catalog contains duplicate item IDs`)
    seen.add(candidate.item.id)
    if (
      candidate.item.package?.registry === 'npm'
      && candidate.item.latestVersion !== undefined
      && candidate.item.repository !== undefined
    ) {
      // Registration creates only an opaque Host reference. It does not fetch
      // remote image bytes during the catalog scan. Browse-only items do not
      // consume media references.
      const media = resolvedMedia(candidate.mediaCandidates, candidate.item.id, context)
      const item: CatalogSnapshot['items'][number] = {
        ...candidate.item,
        repository: candidate.item.repository,
        latestVersion: candidate.item.latestVersion,
        package: candidate.item.package,
        ...(media === undefined ? {} : { media }),
      }
      items.push(item)
    } else {
      items.push(candidate.item)
    }
  }

  const meta = raw.meta !== null && typeof raw.meta === 'object' && !Array.isArray(raw.meta)
    ? raw.meta as Dsh1024StoreMeta
    : {}
  const generatedAt = typeof meta.generatedAt === 'string' ? meta.generatedAt : meta.updated
  const providerGeneratedAt = typeof generatedAt === 'string' && !Number.isNaN(Date.parse(generatedAt))
    ? new Date(generatedAt).toISOString()
    : undefined
  const providerRevision = plainText(meta.revision, 160, '') || undefined
  // Validate advertised totals (unsafe integers, >10_000, smaller than the
  // received page) without requiring a full-catalog dump. The public API now
  // returns a homepage slice plus `catalogTotal`, so failing the scan here
  // made Plugin market and one-click install return HTTP 502.
  providerTotal(meta, raw.packages.length)
  const total = items.length
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
        ...(providerGeneratedAt === undefined ? {} : { providerGeneratedAt }),
        ...(providerRevision === undefined ? {} : { providerRevision }),
      },
      items: items.slice(offset, offset + 100),
      page: { total },
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
        ...(providerGeneratedAt === undefined ? {} : { providerGeneratedAt }),
        ...(providerRevision === undefined ? {} : { providerRevision }),
      },
      items: [],
      page: { total: 0 },
    }))
  }
  return snapshots
}

return {
  adapterId: config.adapterId,
  async fetch(queryValue, context) {
    const query = { ...queryValue, limit: Math.min(queryValue.limit ?? 50, 50) }
    const expectedOrigin = new URL(config.endpoint).origin
    const response = await context.http.getJson(
      storeRegistryUrl(query),
      context.signal,
      { allowedOrigin: expectedOrigin },
    )
    let finalOrigin: string
    try { finalOrigin = new URL(response.finalUrl).origin }
    catch { throw new Error(`${label} final URL is invalid`) }
    if (finalOrigin !== expectedOrigin) throw new Error(`${label} response changed the reviewed provider origin`)
    return buildSnapshot(response.value, context, response.finalUrl, query)
  },
  async scanCatalog(query, context) {
    const expectedOrigin = new URL(config.endpoint).origin
    const response = await context.http.getJson(
      storeRegistryUrl(query),
      context.signal,
      { allowedOrigin: expectedOrigin },
    )
    context.signal.throwIfAborted()
    let finalOrigin: string
    try { finalOrigin = new URL(response.finalUrl).origin }
    catch { throw new Error(`${label} final URL is invalid`) }
    if (finalOrigin !== expectedOrigin) throw new Error(`${label} response changed the reviewed provider origin`)
    return buildCatalogScanSnapshots(response.value, context, response.finalUrl, query.locale)
  },
}
}
