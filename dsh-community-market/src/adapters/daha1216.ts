import type { CatalogAdapter, CatalogFetchContext } from '../contracts/types.js'
import type { CatalogQuery } from '../contracts/generated/catalog-query.js'
import type { CatalogSnapshot } from '../contracts/generated/catalog-snapshot.js'
import { normalizeRepositoryIdentity } from '../contracts/identity.js'
import { parseCatalogSnapshot } from '../contracts/validate.js'

export const DAHA1216_KEY = 'daha1216-plugin-collection'
export const DAHA1216_ENDPOINT = 'https://raw.githubusercontent.com/daha1216/dsh-plugin-collection/main/plugins.json'
export const DAHA1216_HOSTNAME = 'raw.githubusercontent.com'
export const DAHA1216_PROVIDER_ID = 'com.daha1216.dsh-plugin-collection'
export const DAHA1216_ADAPTER_ID = 'market.daha1216-plugin-collection-v1'

const DAHA1216_ORIGIN = `https://${DAHA1216_HOSTNAME}`
const MAX_DAHA1216_ITEMS = 10_000
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u
const GITHUB_OWNER_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/iu
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9._-]{1,100}$/iu
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u

type CatalogItem = CatalogSnapshot['items'][number]

export interface Daha1216AdapterOptions {
  readonly now?: () => Date
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || UNSAFE_TEXT_PATTERN.test(value)) {
    throw new Error(`daha1216 ${label} is invalid`)
  }
  if (!allowEmpty && value.length === 0) throw new Error(`daha1216 ${label} is invalid`)
  return value
}

function dateTime(value: unknown, label: string): string {
  const input = text(value, label, 160)
  const timestamp = Date.parse(input)
  if (!Number.isFinite(timestamp)) throw new Error(`daha1216 ${label} is invalid`)
  return new Date(timestamp).toISOString()
}

function repository(value: unknown): {
  readonly repository: NonNullable<CatalogItem['repository']>
  readonly owner: string
} {
  const input = text(value, 'repository', 2048)
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('daha1216 repository is invalid')
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== 'github.com'
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || segments.length !== 2
  ) throw new Error('daha1216 repository is invalid')

  const owner = segments[0]!
  const repositoryName = segments[1]!.replace(/\.git$/iu, '')
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPOSITORY_PATTERN.test(repositoryName)) {
    throw new Error('daha1216 repository is invalid')
  }

  const normalized = normalizeRepositoryIdentity({
    url: `https://github.com/${owner}/${repositoryName}`,
  })
  return { repository: normalized, owner }
}

function normalizeItem(value: unknown, context: CatalogFetchContext): CatalogItem {
  const raw = record(value)
  if (raw === undefined) throw new Error('daha1216 catalog item is invalid')

  const id = text(raw.id, 'item id', 160)
  if (!IDENTIFIER_PATTERN.test(id)) throw new Error('daha1216 item id is invalid')
  const name = text(raw.name, `item ${id} name`, 160)
  const description = text(raw.description, `item ${id} description`, 5_000, true)
  const summary = Array.from(description).slice(0, 1_000).join('') || name
  const version = text(raw.version, `item ${id} version`, 64)
  const identity = repository(raw.source)
  const descriptionWithVersion = description.length === 0
    ? `目录版本：${version}`
    : `${description} | 目录版本：${version}`

  return {
    id,
    name,
    displayName: name,
    summary,
    description: descriptionWithVersion,
    homepage: identity.repository.url,
    repository: identity.repository,
    publisher: {
      name: identity.owner,
      url: `https://github.com/${identity.owner.toLowerCase()}`,
    },
    // The source catalog currently provides GitHub install specs, not a
    // provider-verified npm identity. Keep these entries browse-only until
    // npm identity and repository-backlink evidence are published.
    provenance: {
      sourceRecordId: context.source.sourceRecordId,
      providerId: context.source.providerId,
      itemId: id,
    },
  }
}

function parseCatalog(value: unknown, context: CatalogFetchContext): {
  readonly items: readonly CatalogItem[]
  readonly generatedAt: string
  readonly revision: string
} {
  const raw = record(value)
  if (raw === undefined || raw.catalogVersion !== '1.0.0' || !Array.isArray(raw.plugins)) {
    throw new Error('daha1216 catalog is invalid')
  }
  if (raw.plugins.length > MAX_DAHA1216_ITEMS) throw new Error('daha1216 catalog exceeded the item limit')

  const generatedAt = dateTime(raw.updatedAt, 'catalog updatedAt')
  const items = raw.plugins.map(item => normalizeItem(item, context))
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) throw new Error('daha1216 catalog contains duplicate item IDs')
    ids.add(item.id)
  }

  return {
    items,
    generatedAt,
    revision: text(raw.updatedAt, 'catalog revision', 160),
  }
}

function assertFinalOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('daha1216 final URL is invalid')
  }
  if (url.origin !== DAHA1216_ORIGIN) throw new Error('daha1216 response changed the reviewed provider origin')
  return url.href
}

function snapshot(
  parsed: ReturnType<typeof parseCatalog>,
  responseFinalUrl: string,
  context: CatalogFetchContext,
  now: () => Date,
): CatalogSnapshot {
  return parseCatalogSnapshot({
    schemaVersion: '1.0.0',
    source: {
      sourceRecordId: context.source.sourceRecordId,
      providerId: context.source.providerId,
      adapterId: context.source.adapterId,
      registrationKind: context.source.registrationKind,
      fetchedAt: now().toISOString(),
      finalUrl: responseFinalUrl,
      providerGeneratedAt: parsed.generatedAt,
      providerRevision: parsed.revision,
    },
    items: parsed.items,
    page: { total: parsed.items.length },
  })
}

async function fetchSnapshot(
  _query: CatalogQuery,
  context: CatalogFetchContext,
  now: () => Date,
): Promise<CatalogSnapshot> {
  context.signal.throwIfAborted()
  const response = await context.http.getJson(
    DAHA1216_ENDPOINT,
    context.signal,
    { allowedOrigin: DAHA1216_ORIGIN },
  )
  const finalUrl = assertFinalOrigin(response.finalUrl)
  return snapshot(parseCatalog(response.value, context), finalUrl, context, now)
}

export function createDaha1216Adapter(options: Daha1216AdapterOptions = {}): CatalogAdapter {
  const now = options.now ?? (() => new Date())
  return {
    adapterId: DAHA1216_ADAPTER_ID,
    fetch: async (query, context) => await fetchSnapshot(query, context, now),
    scanCatalog: async (query, context) => [await fetchSnapshot(query, context, now)],
  }
}

export const daha1216Adapter = createDaha1216Adapter()
