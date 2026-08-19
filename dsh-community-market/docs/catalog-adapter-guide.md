# Catalog integration and adapter guide

[中文](catalog-adapter-guide.zh.md)

Status: Implemented public v1 integration guide. The authoritative Schemas and compatibility rules are versioned by the [catalog provider contract](catalog-provider-contract.md).

DSH Community Market is open to every catalog provider and user-owned source. Anyone can use path A immediately by publishing Schema-conforming public HTTPS JSON and sharing the manifest URL; no Market code change or partnership approval is required. Providers that need path B are welcome to propose a reviewed adapter collaboration for their existing public API.

## Choose one integration path

### A. Standard source: no Market code

Use this path when the provider can publish two anonymous HTTPS JSON resources on one origin:

1. a static [`catalog-source` manifest](schemas/catalog-source.schema.json); and
2. one GET `/v1/plugins` endpoint returning [`catalog-provider-page`](schemas/catalog-provider-page.schema.json).

The user registers only the manifest URL. Start with the [minimal manifest](examples/catalog-source.example.json), [minimal query](examples/catalog-query.example.json), and [minimal page](examples/catalog-provider-page.minimal.example.json). The recommended minimum supports `q`, `category`, `cursor`, and `limit`, with example `defaultLimit` and `maxLimit` values of 50. That value is not a global cap: a standard source may declare values through the Schema safety maximum of 100. Repeated `category` values mean OR. Optional metadata and media can be added later without changing the transport.

The current Desktop Host builds a complete local index before serving the UI. It follows the selected source's cursors using the source's effective network page limit, then performs visible search, multi-category OR filtering, category enumeration, and 50-item UI pagination locally. The endpoint query contract remains useful to other consumers and adapter tests, but the current Desktop scan does not send the user's `q` or `category` filters to the provider. A standard source may return up to its declared effective page limit; 50 is the visible UI page size, not a universal provider-response cap.

### B. Existing API: reviewed Host adapter

Use this path when an existing API cannot return the standard page shape. Give the Market team:

- the public endpoint documentation and response schema;
- representative success, empty, pagination, and error responses with secrets removed;
- stable field meanings and pagination rules;
- attribution, rate limits, and the provider's icon ownership semantics.

The adapter is local TypeScript reviewed, tested, and released with Market. It uses the constrained Host HTTP client and returns a validated `CatalogSnapshot`. Open cooperation does not bypass review: a manifest or remote response can never supply JavaScript, mapping expressions, install commands, credentials, or adapter code.

## Copyable adapter skeleton

Place the adapted version in `src/adapters/example-provider.ts`. This skeleton assumes the reviewed API accepts `search`, repeated `tag` values with OR semantics, `after`, and `pageSize`. It uses a default page size of 50 and a reviewed maximum of 100. Change those explicit mappings and constants to match the documented API; do not create a remotely configurable mapper. The 1024Store adapter is intentionally different: one registry request is normalized into Schema-bounded chunks of at most 100 items, after which the Host serves local UI pages of 50.

```ts
import type { CatalogQuery, CatalogSnapshot } from '../contracts/index.js'
import type { CatalogAdapter, CatalogFetchContext } from '../contracts/types.js'
import { parseCatalogSnapshot } from '../contracts/validate.js'

const ADAPTER_ID = 'market.example-provider-v1'
const ENDPOINT = 'https://catalog.example.org/api/plugins'
const ORIGIN = new URL(ENDPOINT).origin
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100

interface RawPlugin {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly npm: string
  readonly categories?: readonly string[]
}

interface RawPage {
  readonly plugins: readonly RawPlugin[]
  readonly next?: string
  readonly total?: number
}

function readRawPage(value: unknown, effectiveLimit: number): RawPage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('example provider response is not an object')
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.plugins) || record.plugins.length > effectiveLimit) {
    throw new Error('example provider page is invalid')
  }
  const plugins = record.plugins.map((entry): RawPlugin => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('example provider item is invalid')
    }
    const item = entry as Record<string, unknown>
    if (
      typeof item.id !== 'string'
      || typeof item.title !== 'string'
      || typeof item.summary !== 'string'
      || typeof item.npm !== 'string'
      || (item.categories !== undefined
        && (!Array.isArray(item.categories) || item.categories.some(value => typeof value !== 'string')))
    ) {
      throw new Error('example provider item fields are invalid')
    }
    return {
      id: item.id,
      title: item.title,
      summary: item.summary,
      npm: item.npm,
      ...(item.categories === undefined ? {} : { categories: item.categories as string[] }),
    }
  })
  if (record.next !== undefined && (typeof record.next !== 'string' || record.next.length === 0)) {
    throw new Error('example provider cursor is invalid')
  }
  if (record.total !== undefined && (
    typeof record.total !== 'number'
    || !Number.isSafeInteger(record.total)
    || record.total < 0
  )) {
    throw new Error('example provider total is invalid')
  }
  return {
    plugins,
    ...(record.next === undefined ? {} : { next: record.next as string }),
    ...(record.total === undefined ? {} : { total: record.total as number }),
  }
}

function requestUrl(query: CatalogQuery, effectiveLimit: number): URL {
  const url = new URL(ENDPOINT)
  if (query.q !== undefined) url.searchParams.set('search', query.q)
  for (const category of query.category ?? []) url.searchParams.append('tag', category)
  if (query.cursor !== undefined) url.searchParams.set('after', query.cursor)
  url.searchParams.set('pageSize', String(effectiveLimit))
  return url
}

function snapshot(
  raw: RawPage,
  responseFinalUrl: string,
  context: CatalogFetchContext,
): CatalogSnapshot {
  return parseCatalogSnapshot({
    schemaVersion: '1.0.0',
    source: {
      sourceRecordId: context.source.sourceRecordId,
      providerId: context.source.providerId,
      adapterId: context.source.adapterId,
      registrationKind: context.source.registrationKind,
      fetchedAt: new Date().toISOString(),
      finalUrl: responseFinalUrl,
    },
    items: raw.plugins.map(item => ({
      id: item.id,
      name: item.npm,
      displayName: item.title,
      summary: item.summary,
      ...(item.categories === undefined ? {} : { categories: [...item.categories] }),
      package: { registry: 'npm', name: item.npm },
      provenance: {
        sourceRecordId: context.source.sourceRecordId,
        providerId: context.source.providerId,
        itemId: item.id,
      },
    })),
    page: {
      ...(raw.next === undefined ? {} : { nextCursor: raw.next }),
      ...(raw.total === undefined ? {} : { total: raw.total }),
    },
  })
}

export const exampleProviderAdapter: CatalogAdapter = {
  adapterId: ADAPTER_ID,
  async fetch(query, context) {
    const effectiveLimit = Math.min(query.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT)
    const response = await context.http.getJson(
      requestUrl(query, effectiveLimit).href,
      context.signal,
      { allowedOrigin: ORIGIN },
    )
    if (new URL(response.finalUrl).origin !== ORIGIN) {
      throw new Error('example provider response changed the reviewed origin')
    }
    return snapshot(readRawPage(response.value, effectiveLimit), response.finalUrl, context)
  },
}
```

Register it only in the static Host adapter map and add a reviewed built-in provider definition. This is a code review change, never provider data:

```ts
import { exampleProviderAdapter } from '../adapters/example-provider.js'

const adapters = new Map<string, CatalogAdapter>([
  [standardHttpAdapter.adapterId, standardHttpAdapter],
  [dsh1024StoreAdapter.adapterId, dsh1024StoreAdapter],
  [exampleProviderAdapter.adapterId, exampleProviderAdapter],
])
```

## Review checklist

- The endpoint and allowed origin are compile-time reviewed constants.
- The adapter parses and bounds the provider response before mapping it.
- Search, repeated-category OR filtering, cursor ownership, the default page size, the reviewed maximum, and response-over-limit rejection have explicit tests.
- Every item has a package or normalized repository identity and Host-injected provenance.
- Provider commands, HTML, scripts, credentials, and unknown fields never enter the snapshot.
- Optional icons use `context.media.register()` with exact reviewed hostnames; the Renderer receives only `assetRef`.
- Timeout, redirect, response-size, cancellation, and selected-source reset tests pass.
- The adapter and built-in provider definition ship in the same reviewed Market release.

The Market team, not the remote provider, owns the adapter's behavior and release lifecycle.
