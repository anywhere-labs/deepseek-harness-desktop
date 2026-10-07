import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { describe, expect, it, vi } from 'vitest'
import {
  dsh1024StoreAdapter,
  DSH_1024STORE_ADAPTER_ID,
  DSH_1024STORE_KEY,
  DSH_1024STORE_LEGACY_ADAPTER_ID,
  DSH_1024STORE_PROVIDER_ID,
} from '../src/adapters/dsh-1024store.js'
import { DSHFIND_ADAPTER_ID, DSHFIND_KEY, DSHFIND_PROVIDER_ID } from '../src/adapters/dshfind.js'
import { standardHttpAdapter } from '../src/adapters/standard-http.js'
import { DefaultCatalogService, type CatalogFullIndex } from '../src/catalog/service.js'
import { MemoryCatalogSourceStore, PersistentCatalogSourceStore } from '../src/catalog/source-store.js'
import { MemoryMarketStateStore, type MarketStateStore } from '../src/catalog/state-store.js'
import type {
  CatalogHttpClient,
  CatalogHttpResponse,
  CatalogProviderPage,
  CatalogSourceManifest,
  LocalSourceRecord,
} from '../src/contracts/index.js'
import type { CatalogHttpRequestPolicy } from '../src/contracts/types.js'
import {
  createMarketSourceMutator,
  marketMutationAllowed,
  marketRequestAllowed,
  marketRoutes,
  type MarketInstallServiceProvider,
  readStandardSourceManifest,
  registerMarketRoutes,
} from '../src/host/routes.js'
import {
  CatalogNetworkError,
  createCachedCatalogHttpClient,
  createRestrictedHttpClient,
  pinnedLookupResult,
  restrictedHttpClient,
} from '../src/network/restricted-http.js'

const source = (overrides: Partial<LocalSourceRecord> = {}): LocalSourceRecord => ({
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'built-in',
  adapterId: DSH_1024STORE_ADAPTER_ID,
  providerId: DSH_1024STORE_PROVIDER_ID,
  builtInProviderKey: DSH_1024STORE_KEY,
  enabled: true,
  order: 0,
  ...overrides,
})

const publisherAssetRef = 'mktimg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const pluginAssetRef = 'mktimg_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const renamedAssetRef = 'mktimg_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'
const fixtureAssetRef = 'mktimg_EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE'

const rawPlugin = {
  id: 'anywhere-labs/deepseek-harness-desktop/dsh-plugin-desktop',
  name: 'deepseek-harness-desktop',
  owner: 'anywhere-labs',
  url: 'https://github.com/anywhere-labs/deepseek-harness-desktop',
  category: 'dev',
  description: { en: 'Desktop shell', zh: '桌面外壳' },
  pushedAt: '2026-08-17T05:45:19Z',
  stars: 11_402,
  installCount: 7,
  install: 'dsh plugin --profile web add deepseek-harness-desktop',
}

function catalogPage(
  plugins: readonly Record<string, unknown>[],
  limit = 100,
  options: {
    readonly page?: number
    readonly total?: number
    readonly catalogTotal?: number
    readonly categories?: readonly { readonly id: string; readonly count: number }[]
    readonly generatedAt?: string
  } = {},
) {
  const total = options.total ?? plugins.length
  const catalogTotal = options.catalogTotal ?? total
  const categories = options.categories ?? [...plugins.reduce((counts, plugin) => {
    const category = typeof plugin.category === 'string' ? plugin.category : 'unclassified'
    counts.set(category, (counts.get(category) ?? 0) + 1)
    return counts
  }, new Map<string, number>())].map(([id, count]) => ({ id, count }))
  return {
    plugins,
    page: options.page ?? 1,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    catalogTotal,
    categories: categories.map(category => ({ ...category, en: category.id, zh: category.id })),
    generatedAt: options.generatedAt ?? '2026-08-17T15:49:53.062Z',
    source: 'fixture',
  }
}

const rawCatalog = catalogPage([rawPlugin])

function catalogIndex(record: LocalSourceRecord = source()): CatalogFullIndex {
  return {
    source: {
      ...record,
      name: 'DSH 1024Store',
      endpoint: 'https://deepseek1024.com/api/v2/plugins',
      partnership: true,
    },
    snapshots: [],
    scannedAt: '2026-08-18T00:00:00.000Z',
    expiresAt: '2026-08-18T00:05:00.000Z',
    providerRevision: '2026-08-17T15:49:53.062Z',
    cacheStatus: 'fresh',
    scanKey: 'fixture-scan',
    sourceGeneration: 0,
  }
}

function contractFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../docs/examples/${name}.json`, import.meta.url), 'utf8')) as unknown
}

type MarketRouteHandler = (
  req: EventEmitter & Record<string, any>,
  res: EventEmitter & Record<string, any>,
) => Promise<void>

async function requestMarketCatalog(
  records: readonly LocalSourceRecord[],
  url: string,
  route = marketRoutes.catalog,
  installProvider?: MarketInstallServiceProvider,
): Promise<{ readonly statusCode: number; readonly body: Record<string, any> }> {
  const handlers = new Map<string, MarketRouteHandler>()
  const ctx = {
    webServer: {
      port: 43_120,
      register: vi.fn((route: { path: string; handler: MarketRouteHandler }) => {
        handlers.set(route.path, route.handler)
        return vi.fn()
      }),
    },
  }
  const state: MarketStateStore = {
    getSources: () => records,
    setSources: vi.fn(async () => {}),
    getCatalogCache: () => undefined,
    setCatalogCache: vi.fn(async () => {}),
  }
  const dispose = registerMarketRoutes(ctx as never, state, installProvider)
  const request = Object.assign(new EventEmitter(), {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:43120' },
    socket: { remoteAddress: '127.0.0.1' },
  })
  let bodyText: string | undefined
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    statusCode: 0,
    setHeader: vi.fn(),
    removeHeader: vi.fn(),
    end: vi.fn((body?: string) => {
      bodyText = body
      response.writableEnded = true
    }),
  })

  try {
    await handlers.get(route)!(request, response)
  } finally {
    dispose()
  }
  if (bodyText === undefined) throw new Error('catalog route did not return a JSON body')
  return {
    statusCode: response.statusCode,
    body: JSON.parse(bodyText) as Record<string, any>,
  }
}

/**
 * A state store whose registry writes are observable, so a test can hold one
 * write open and assert how the mutator serializes around it.
 */
function observedStateStore(
  backing: MemoryMarketStateStore,
  setSources: MarketStateStore['setSources'],
): MarketStateStore {
  return {
    getSources: () => backing.getSources(),
    setSources,
    getCatalogCache: () => backing.getCatalogCache(),
    setCatalogCache: cache => backing.setCatalogCache(cache),
  }
}

describe('1024Store adapter', () => {
  it('represents a valid empty remote page explicitly', async () => {
    const snapshot = await dsh1024StoreAdapter.fetch({}, {
      source: source(),
      signal: new AbortController().signal,
      http: {
        getJson: vi.fn(async () => ({
          value: catalogPage([], 50),
          finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=100',
        })),
      },
      media: { register: vi.fn() },
    })

    expect(snapshot).toMatchObject({ items: [], page: { total: 0 } })
  })

  it('projects reviewed fields and never forwards remote install strings', async () => {
    const http: CatalogHttpClient = {
      getJson: vi.fn(async (url: string) => ({ value: catalogPage([rawPlugin], 50), finalUrl: url })),
    }
    const register = vi.fn(() => publisherAssetRef)
    const snapshot = await dsh1024StoreAdapter.fetch(
      { locale: 'en-US' },
      { source: source(), signal: new AbortController().signal, http, media: { register } },
    )

    expect(snapshot.items[0]).toMatchObject({
      id: rawPlugin.id,
      summary: 'Desktop shell',
      repository: {
        url: 'https://github.com/anywhere-labs/deepseek-harness-desktop',
        subdirectory: 'dsh-plugin-desktop',
      },
      package: { registry: 'npm', name: 'deepseek-harness-desktop' },
      media: { icon: { assetRef: publisherAssetRef, role: 'publisher-avatar', alt: 'anywhere-labs' } },
      provenance: { sourceRecordId: source().sourceRecordId },
    })
    expect(JSON.stringify(snapshot)).not.toContain('dsh plugin --profile')
    expect(snapshot.source).toMatchObject({
      providerGeneratedAt: '2026-08-17T15:49:53.062Z',
      providerRevision: '2026-08-17T15:49:53.062Z',
    })
    expect(register).toHaveBeenCalledWith({
      remoteUrl: 'https://github.com/anywhere-labs.png?size=96',
      role: 'publisher-avatar',
      alt: 'anywhere-labs',
      sourceRecordId: source().sourceRecordId,
      itemId: rawPlugin.id,
      allowedHostnames: ['github.com', 'avatars.githubusercontent.com'],
    })
    expect(http.getJson).toHaveBeenCalledWith(
      'https://deepseek1024.com/api/v2/plugins?page=1&limit=50',
      expect.any(AbortSignal),
      { allowedOrigin: 'https://deepseek1024.com' },
    )
  })

  it('prefers an explicit provider icon over the GitHub publisher avatar fallback', async () => {
    const item = {
      ...rawPlugin,
      media: { icon: { url: 'https://avatars.githubusercontent.com/u/1?v=4', alt: 'Plugin logo' } },
    }
    const http: CatalogHttpClient = {
      getJson: vi.fn(async (url: string) => ({
        value: catalogPage([item], 50),
        finalUrl: url,
      })),
    }
    const register = vi.fn(() => pluginAssetRef)
    const snapshot = await dsh1024StoreAdapter.fetch(
      {},
      { source: source(), signal: new AbortController().signal, http, media: { register } },
    )

    expect(snapshot.items[0]?.media).toEqual({
      icon: { assetRef: pluginAssetRef, role: 'plugin-icon', alt: 'Plugin logo' },
    })
    expect(register).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      remoteUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      role: 'plugin-icon',
    }))
  })

  it('rejects a 1024Store response that leaves the reviewed provider origin', async () => {
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({ value: catalogPage([rawPlugin], 50), finalUrl: 'https://attacker.example/api/v2/plugins' })),
    }
    await expect(dsh1024StoreAdapter.fetch({}, {
      source: source(),
      signal: new AbortController().signal,
      http,
      media: { register: () => publisherAssetRef },
    })).rejects.toThrow(/reviewed provider origin/u)
  })

  it('uses the canonical repository URL after a provider item ID rename', async () => {
    const item = {
      ...rawPlugin,
      id: 'former-owner/former-repository',
      owner: 'current-owner',
      url: 'https://github.com/current-owner/current-repository',
    }
    const http: CatalogHttpClient = {
      getJson: vi.fn(async (url: string) => ({
        value: catalogPage([item], 50),
        finalUrl: url,
      })),
    }
    const register = vi.fn(() => renamedAssetRef)

    const snapshot = await dsh1024StoreAdapter.fetch({}, {
      source: source(),
      signal: new AbortController().signal,
      http,
      media: { register },
    })

    expect(snapshot.items[0]).toMatchObject({
      id: 'former-owner/former-repository',
      repository: { url: 'https://github.com/current-owner/current-repository' },
      publisher: { name: 'current-owner', url: 'https://github.com/current-owner' },
    })
    expect(snapshot.items[0]?.repository).not.toHaveProperty('subdirectory')
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      remoteUrl: 'https://github.com/current-owner.png?size=96',
      role: 'publisher-avatar',
    }))
  })

  it('keeps legacy GitHub owners that end in a hyphen', async () => {
    const item = {
      ...rawPlugin,
      id: 'tianxia--/fixture',
      owner: 'tianxia--',
      url: 'https://github.com/tianxia--/fixture',
    }
    const http: CatalogHttpClient = {
      getJson: vi.fn(async (url: string) => ({
        value: catalogPage([item], 50),
        finalUrl: url,
      })),
    }
    const register = vi.fn(() => 'mktimg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC')

    const snapshot = await dsh1024StoreAdapter.fetch({}, {
      source: source(),
      signal: new AbortController().signal,
      http,
      media: { register },
    })

    expect(snapshot.items[0]?.publisher).toEqual({
      name: 'tianxia--',
      url: 'https://github.com/tianxia--',
    })
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      remoteUrl: 'https://github.com/tianxia--.png?size=96',
    }))
  })

  it('uses v2 provider ordering and page cursors instead of locally browsing a bounded v1 body', async () => {
    const low = {
      ...rawPlugin,
      id: 'example/low-plugin',
      name: 'Low Plugin',
      owner: 'example',
      url: 'https://github.com/example/low-plugin',
      category: 'tools',
      stars: 1,
    }
    const high = {
      ...rawPlugin,
      id: 'example/high-plugin',
      name: 'High Plugin',
      owner: 'example',
      url: 'https://github.com/example/high-plugin',
      category: 'tools',
      stars: 100,
    }
    const http: CatalogHttpClient = {
      getJson: vi.fn(async (urlValue: string) => {
        const url = new URL(urlValue)
        expect(url.searchParams.get('q')).toBe('plugin')
        const page = Number(url.searchParams.get('page'))
        return {
          value: catalogPage(page === 1 ? [high] : [low], 1, {
            page,
            total: 2,
            catalogTotal: 2,
            categories: [{ id: 'tools', count: 2 }],
          }),
          finalUrl: url.href,
        }
      }),
    }

    const first = await dsh1024StoreAdapter.fetch(
      { q: 'plugin', category: ['tools'], limit: 1, locale: 'en-US' },
      { source: source(), signal: new AbortController().signal, http, media: { register: () => fixtureAssetRef } },
    )
    const second = await dsh1024StoreAdapter.fetch(
      {
        q: 'plugin',
        category: ['tools'],
        limit: 1,
        ...(first.page.nextCursor === undefined ? {} : { cursor: first.page.nextCursor }),
        locale: 'en-US',
      },
      { source: source(), signal: new AbortController().signal, http, media: { register: () => fixtureAssetRef } },
    )

    expect(first.items.map(item => item.id)).toEqual(['example/high-plugin'])
    expect(first.page).toEqual({ nextCursor: 'page:2', total: 2 })
    expect(second.items.map(item => item.id)).toEqual(['example/low-plugin'])
    expect(second.page).toEqual({ total: 2 })
  })

  it('rejects a v2 response whose page length does not match its pagination metadata', async () => {
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: catalogPage([rawPlugin], 50, {
          total: 7_635,
          catalogTotal: 7_635,
          categories: [{ id: 'dev', count: 7_635 }],
        }),
        finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=50',
      })),
    }

    await expect(dsh1024StoreAdapter.fetch(
      { limit: 100 },
      { source: source(), signal: new AbortController().signal, http, media: { register: () => fixtureAssetRef } },
    )).rejects.toThrow(/page limit|page length/u)
  })

  it('fails a v2 page when the provider omits catalog entries', async () => {
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: catalogPage([rawPlugin], 100, {
          total: 2,
          catalogTotal: 2,
          categories: [{ id: 'dev', count: 2 }],
        }),
        finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=100',
      })),
    }

    await expect(dsh1024StoreAdapter.fetch(
      { limit: 100 },
      { source: source(), signal: new AbortController().signal, http, media: { register: () => fixtureAssetRef } },
    )).rejects.toThrow(/page length/u)
  })

  it('uses the v2 page-size ceiling of 100 for discovery', async () => {
    const plugins = Array.from({ length: 101 }, (_, index) => ({
      ...rawPlugin,
      id: `anywhere-labs/plugin-${index}`,
      name: `plugin-${index}`,
      url: `https://github.com/anywhere-labs/plugin-${index}`,
    }))
    const http: CatalogHttpClient = {
      getJson: vi.fn(async (url: string) => ({
        value: catalogPage(plugins.slice(0, 100), 100, {
          total: plugins.length,
          catalogTotal: plugins.length,
          categories: [{ id: 'dev', count: plugins.length }],
        }),
        finalUrl: url,
      })),
    }

    const snapshot = await dsh1024StoreAdapter.fetch(
      { limit: 100 },
      { source: source(), signal: new AbortController().signal, http, media: { register: () => fixtureAssetRef } },
    )

    expect(snapshot.items).toHaveLength(100)
    expect(snapshot.page).toEqual({ nextCursor: 'page:2', total: 101 })
  })

  it('carries the complete v2 category facets through the Host provider result', async () => {
    const uiPlugin = {
      ...rawPlugin,
      id: 'anywhere-labs/ui-plugin',
      name: 'ui-plugin',
      url: 'https://github.com/anywhere-labs/ui-plugin',
      category: 'ui',
    }
    const plugins = [rawPlugin, uiPlugin]
    const categories = [{ id: 'dev', count: 1 }, { id: 'ui', count: 1 }]
    const getJson = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue)
      const limit = Number(url.searchParams.get('limit'))
      return {
        value: catalogPage(plugins.slice(0, limit), limit, {
          total: plugins.length,
          catalogTotal: plugins.length,
          categories,
        }),
        finalUrl: url.href,
      }
    })
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const service = new DefaultCatalogService(store, { getJson })

    const [result] = await service.fetchProvider(
      { limit: 50 },
      new AbortController().signal,
      { sourceRecordId: source().sourceRecordId },
    )

    expect(getJson).toHaveBeenCalledTimes(2)
    expect(result?.categories).toEqual(['dev', 'ui'])
    expect(result?.snapshot?.items).toHaveLength(2)
  })
})

describe('standard catalog adapter media boundary', () => {
  const standardAssetRef = 'mktimg_ssssssssssssssssssssssssssssssss'
  const standardSource = (): LocalSourceRecord => ({
    sourceRecordId: '038f1f77-a5c4-7b73-a9ae-0242ac120004',
    registrationKind: 'user-added',
    adapterId: standardHttpAdapter.adapterId,
    providerId: 'org.example.community-catalog',
    manifestUrl: 'https://plugins.example.org/catalog-source.json',
    manifest: contractFixture('catalog-source.example') as CatalogSourceManifest,
    enabled: true,
    order: 0,
  })

  it('turns a same-origin provider icon into an opaque Host asset reference', async () => {
    const http: CatalogHttpClient = {
      getJson: vi.fn()
        .mockResolvedValueOnce({ value: contractFixture('catalog-source.example'), finalUrl: standardSource().manifestUrl! })
        .mockResolvedValueOnce({ value: contractFixture('catalog-provider-page.example'), finalUrl: 'https://plugins.example.org/v1/plugins?limit=20' }),
    }
    const register = vi.fn(() => standardAssetRef)

    const snapshot = await standardHttpAdapter.fetch({}, {
      source: standardSource(),
      signal: new AbortController().signal,
      http,
      media: { register },
    })

    expect(snapshot.items[0]?.media).toEqual({
      icon: { assetRef: standardAssetRef, role: 'plugin-icon', alt: 'Better Sidebar plugin icon' },
    })
    expect(register).toHaveBeenCalledWith({
      remoteUrl: 'https://plugins.example.org/assets/better-sidebar.png',
      role: 'plugin-icon',
      alt: 'Better Sidebar plugin icon',
      sourceRecordId: standardSource().sourceRecordId,
      itemId: 'better-sidebar',
      allowedHostnames: ['plugins.example.org'],
    })
    expect(JSON.stringify(snapshot)).not.toContain('better-sidebar.png')
  })

  it('writes the canonical repository identity into the normalized snapshot', async () => {
    const page = contractFixture('catalog-provider-page.example') as CatalogProviderPage
    page.items[0]!.repository = { url: 'https://github.com/Example/DSH-Plugin-Better-Sidebar.git/' }
    const http: CatalogHttpClient = {
      getJson: vi.fn()
        .mockResolvedValueOnce({ value: contractFixture('catalog-source.example'), finalUrl: standardSource().manifestUrl! })
        .mockResolvedValueOnce({ value: page, finalUrl: 'https://plugins.example.org/v1/plugins?limit=20' }),
    }

    const snapshot = await standardHttpAdapter.fetch({}, {
      source: standardSource(),
      signal: new AbortController().signal,
      http,
      media: { register: () => standardAssetRef },
    })

    expect(snapshot.items[0]?.repository).toEqual({
      url: 'https://github.com/example/dsh-plugin-better-sidebar',
    })
  })

  it('omits an invalid cross-origin icon without dropping the catalog item', async () => {
    const page = contractFixture('catalog-provider-page.example') as {
      items: Array<{ media?: { icon: { url: string; alt?: string } } }>
    }
    page.items[0]!.media!.icon.url = 'https://tracker.example/icon.png'
    const http: CatalogHttpClient = {
      getJson: vi.fn()
        .mockResolvedValueOnce({ value: contractFixture('catalog-source.example'), finalUrl: standardSource().manifestUrl! })
        .mockResolvedValueOnce({ value: page, finalUrl: 'https://plugins.example.org/v1/plugins?limit=20' }),
    }
    const register = vi.fn()

    const snapshot = await standardHttpAdapter.fetch({}, {
      source: standardSource(),
      signal: new AbortController().signal,
      http,
      media: { register },
    })

    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]?.media).toBeUndefined()
    expect(register).not.toHaveBeenCalled()
  })

  it('uses provider defaultLimit when the manifest does not support a limit parameter', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    manifest.query.supported = manifest.query.supported.filter(field => field !== 'limit')
    manifest.query.defaultLimit = 1
    const page = contractFixture('catalog-provider-page.example') as CatalogProviderPage
    const second = structuredClone(page.items[0]!)
    second.id = 'second-plugin'
    second.name = 'second-plugin'
    second.displayName = 'Second Plugin'
    page.items.push(second)
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: manifest, finalUrl: standardSource().manifestUrl! })
      .mockResolvedValueOnce({ value: page, finalUrl: 'https://plugins.example.org/v1/plugins' })

    await expect(standardHttpAdapter.fetch({ limit: 100 }, {
      source: standardSource(),
      signal: new AbortController().signal,
      http: { getJson },
      media: { register: () => standardAssetRef },
    })).rejects.toThrow(/effective query limit of 1/u)

    expect(getJson).toHaveBeenCalledTimes(2)
    expect(getJson.mock.calls[1]?.[0]).toBe('https://plugins.example.org/v1/plugins')
  })

  it('allows a standard source to use its declared limit up to the shared safety cap', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    manifest.query.defaultLimit = 100
    manifest.query.maxLimit = 100
    const page = contractFixture('catalog-provider-page.example') as CatalogProviderPage
    page.items = Array.from({ length: 51 }, (_, index) => {
      const item = structuredClone(page.items[0]!)
      item.id = `standard-plugin-${index}`
      item.name = `standard-plugin-${index}`
      item.displayName = `Standard Plugin ${index}`
      return item
    })
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: manifest, finalUrl: standardSource().manifestUrl! })
      .mockResolvedValueOnce({ value: page, finalUrl: 'https://plugins.example.org/v1/plugins?limit=100' })

    const snapshot = await standardHttpAdapter.fetch({ limit: 100 }, {
      source: standardSource(),
      signal: new AbortController().signal,
      http: { getJson },
      media: { register: () => standardAssetRef },
    })

    expect(snapshot.items).toHaveLength(51)
    expect(new URL(getJson.mock.calls[1]?.[0] as string).searchParams.get('limit')).toBe('100')
  })

  it('respects a standard source default above 50 when it does not support limit', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    manifest.query.supported = manifest.query.supported.filter(field => field !== 'limit')
    manifest.query.defaultLimit = 60
    manifest.query.maxLimit = 100
    const page = contractFixture('catalog-provider-page.example') as CatalogProviderPage
    page.items = Array.from({ length: 51 }, (_, index) => {
      const item = structuredClone(page.items[0]!)
      item.id = `default-plugin-${index}`
      item.name = `default-plugin-${index}`
      item.displayName = `Default Plugin ${index}`
      return item
    })
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: manifest, finalUrl: standardSource().manifestUrl! })
      .mockResolvedValueOnce({ value: page, finalUrl: 'https://plugins.example.org/v1/plugins' })

    const snapshot = await standardHttpAdapter.fetch({ limit: 50 }, {
      source: standardSource(),
      signal: new AbortController().signal,
      http: { getJson },
      media: { register: () => standardAssetRef },
    })

    expect(snapshot.items).toHaveLength(51)
    expect(getJson.mock.calls[1]?.[0]).toBe('https://plugins.example.org/v1/plugins')
  })

  it('rejects a manifest whose provider identity drifts after registration', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    manifest.providerId = 'org.example.changed-catalog'
    const getJson = vi.fn().mockResolvedValueOnce({
      value: manifest,
      finalUrl: standardSource().manifestUrl!,
    })

    await expect(standardHttpAdapter.fetch({}, {
      source: standardSource(),
      signal: new AbortController().signal,
      http: { getJson },
      media: { register: () => standardAssetRef },
    })).rejects.toThrow(/provider identity changed/u)
    expect(getJson).toHaveBeenCalledOnce()
  })

  it.each([
    ['manifest final URL', 'manifest-final', 1],
    ['manifest endpoint', 'endpoint', 1],
    ['provider page final URL', 'page-final', 2],
  ] as const)('rejects a cross-origin %s', async (_label, variant, expectedRequests) => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    if (variant === 'endpoint') manifest.transport.endpoint = 'https://other.example/v1/plugins'
    const getJson = vi.fn().mockResolvedValueOnce({
      value: manifest,
      finalUrl: variant === 'manifest-final'
        ? 'https://other.example/catalog-source.json'
        : standardSource().manifestUrl!,
    })
    if (variant === 'page-final') {
      getJson.mockResolvedValueOnce({
        value: contractFixture('catalog-provider-page.example'),
        finalUrl: 'https://other.example/v1/plugins?limit=20',
      })
    }

    await expect(standardHttpAdapter.fetch({}, {
      source: standardSource(),
      signal: new AbortController().signal,
      http: { getJson },
      media: { register: () => standardAssetRef },
    })).rejects.toThrow(/changed the registered source origin/u)
    expect(getJson).toHaveBeenCalledTimes(expectedRequests)
  })
})

describe('standard source registration trust boundary', () => {
  it('pins the manifest response and endpoint to the user-approved origin', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: manifest,
        finalUrl: 'https://plugins.example.org/redirected/catalog-source.json',
      })),
    }

    await expect(readStandardSourceManifest(
      'https://plugins.example.org/catalog-source.json',
      new AbortController().signal,
      http,
    )).resolves.toMatchObject({ providerId: 'org.example.community-catalog' })

    await expect(readStandardSourceManifest(
      'https://plugins.example.org/catalog-source.json',
      new AbortController().signal,
      {
        getJson: vi.fn(async () => ({
          value: manifest,
          finalUrl: 'https://attacker.example/catalog-source.json',
        })),
      },
    )).rejects.toThrow(/changed the registered source origin/u)
  })

  it('rejects a nonstandard manifest port before making a request', async () => {
    const getJson = vi.fn()
    await expect(readStandardSourceManifest(
      'https://plugins.example.org:8443/catalog-source.json',
      new AbortController().signal,
      { getJson },
    )).rejects.toThrow(/standard HTTPS port 443/u)
    expect(getJson).not.toHaveBeenCalled()
  })
})

describe('catalog Host route pagination boundary', () => {
  it.each([
    ['timeout', 504, 'catalog-timeout'],
    ['response', 502, 'catalog-invalid-response'],
    ['http', 502, 'catalog-unavailable'],
  ] as const)('returns a bounded %s failure code for catalog diagnostics', async (networkCode, status, code) => {
    const fetchProvider = vi.spyOn(DefaultCatalogService.prototype, 'fetchProvider')
      .mockRejectedValue(new CatalogNetworkError(networkCode))
    try {
      const response = await requestMarketCatalog(
        [source()],
        `${marketRoutes.catalog}?sourceRecordId=${source().sourceRecordId}`,
      )

      expect(response.statusCode).toBe(status)
      expect(response.body).toEqual({
        error: networkCode === 'timeout'
          ? 'catalog request timed out'
          : networkCode === 'response' ? 'catalog response was invalid' : 'catalog source unavailable',
        code,
      })
    } finally {
      fetchProvider.mockRestore()
    }
  })

  it('uses the Host limit of 50 and preserves repeated category parameters', async () => {
    const index = catalogIndex()
    const scanCatalog = vi.spyOn(DefaultCatalogService.prototype, 'scanCatalog').mockResolvedValue(index)
    const queryCatalog = vi.spyOn(DefaultCatalogService.prototype, 'queryCatalog').mockReturnValue([])
    try {
      const response = await requestMarketCatalog(
        [],
        `${marketRoutes.catalog}?category=dev&category=tools`,
      )

      expect(response.statusCode).toBe(200)
      expect(response.body.query).toEqual({ category: ['dev', 'tools'], limit: 50 })
      expect(scanCatalog).toHaveBeenCalledWith(expect.any(AbortSignal), { force: false })
      expect(queryCatalog).toHaveBeenCalledWith(
        index,
        { category: ['dev', 'tools'], limit: 50 },
        undefined,
      )
      expect(response.body).toMatchObject({
        categories: [],
        metadata: { cacheStatus: 'fresh', providerRevision: '2026-08-17T15:49:53.062Z' },
      })
    } finally {
      scanCatalog.mockRestore()
      queryCatalog.mockRestore()
    }
  })

  it('allows an initial request to bind itself to the current active source', async () => {
    const active = source()
    const fetchProvider = vi.spyOn(DefaultCatalogService.prototype, 'fetchProvider').mockResolvedValue([{
      source: catalogIndex(active).source,
      categories: ['ui', 'dev'],
      stale: false,
    }])
    try {
      const response = await requestMarketCatalog(
        [active],
        `${marketRoutes.catalog}?sourceRecordId=${active.sourceRecordId}`,
      )

      expect(response.statusCode).toBe(200)
      expect(fetchProvider).toHaveBeenCalledWith(
        { limit: 50 },
        expect.any(AbortSignal),
        { sourceRecordId: active.sourceRecordId },
        { force: false },
      )
      expect(response.body.categories).toEqual(['dev', 'ui'])
    } finally {
      fetchProvider.mockRestore()
    }
  })

  it('routes 1024Store searches directly through provider pagination', async () => {
    const active = source()
    const fetchProvider = vi.spyOn(DefaultCatalogService.prototype, 'fetchProvider').mockResolvedValue([{
      source: catalogIndex(active).source,
      snapshot: {
        schemaVersion: '1.0.0',
        source: {
          sourceRecordId: active.sourceRecordId,
          providerId: active.providerId,
          adapterId: active.adapterId,
          registrationKind: active.registrationKind,
          fetchedAt: '2026-08-26T00:00:00.000Z',
          finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=50&q=appshot',
        },
        items: [],
        page: { total: 0 },
      },
      stale: false,
    }])
    const scanCatalog = vi.spyOn(DefaultCatalogService.prototype, 'scanCatalog')
    try {
      const response = await requestMarketCatalog([active], `${marketRoutes.catalog}?q=appshot`)

      expect(response.statusCode).toBe(200)
      expect(fetchProvider).toHaveBeenCalledWith(
        { limit: 50, q: 'appshot' },
        expect.any(AbortSignal),
        undefined,
        { force: false },
      )
      expect(scanCatalog).not.toHaveBeenCalled()
    } finally {
      fetchProvider.mockRestore()
      scanCatalog.mockRestore()
    }
  })

  it('accepts an explicit page size up to the shared 200-item safety cap', async () => {
    const response = await requestMarketCatalog([], `${marketRoutes.catalog}?limit=200`)

    expect(response.statusCode).toBe(200)
    expect(response.body.query).toEqual({ limit: 200 })
  })

  it.each([
    `${marketRoutes.catalog}?cursor=page-2`,
    `${marketRoutes.catalog}?sourceRecordId=${source().sourceRecordId}&sourceRecordId=${source().sourceRecordId}&cursor=page-2&cursor=page-2`,
  ])('rejects unpaired or ambiguous source cursor parameters: %s', async (url) => {
    const response = await requestMarketCatalog([], url)

    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual({ error: 'invalid catalog query' })
  })

  const active = source()
  const inactive = source({
    sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
    enabled: false,
    order: 1,
  })
  it.each([
    ['unknown', [active], '038f1f77-a5c4-7b73-a9ae-0242ac120004'],
    ['inactive', [active, inactive], inactive.sourceRecordId],
  ] as const)('rejects a cursor scoped to an %s source before fetching', async (_label, records, sourceRecordId) => {
    const fetchProvider = vi.spyOn(DefaultCatalogService.prototype, 'fetchProvider')
      .mockRejectedValue(new Error('invalid cursor scope reached the catalog adapter'))
    try {
      const response = await requestMarketCatalog(
        records,
        `${marketRoutes.catalog}?sourceRecordId=${sourceRecordId}&cursor=page-2`,
      )

      expect(response.statusCode).toBe(400)
      expect(response.body).toEqual({ error: 'invalid catalog query' })
      expect(fetchProvider).not.toHaveBeenCalled()
    } finally {
      fetchProvider.mockRestore()
    }
  })
})

describe('installable Host route pagination boundary', () => {
  it('filters one provider page without scanning the complete 1024Store catalog', async () => {
    const active = source()
    const sourceView = catalogIndex(active).source
    const snapshot = {
      schemaVersion: '1.0.0' as const,
      source: {
        sourceRecordId: active.sourceRecordId,
        providerId: active.providerId,
        adapterId: active.adapterId,
        registrationKind: active.registrationKind,
        fetchedAt: '2026-08-26T00:00:00.000Z',
        finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=50',
      },
      items: [],
      page: { total: 10_681, nextCursor: 'host-page-2' },
    }
    const fetchProvider = vi.spyOn(DefaultCatalogService.prototype, 'fetchProvider').mockResolvedValue([{
      source: sourceView,
      snapshot,
      categories: ['dev', 'tools'],
      stale: false,
    }])
    const scanCatalog = vi.spyOn(DefaultCatalogService.prototype, 'scanCatalog')
      .mockRejectedValue(new Error('complete scan must not run'))
    const listInstallablePage = vi.fn(() => ({
      source: sourceView,
      items: [],
      categories: ['dev', 'tools'],
      manualInstall: [],
      nextCursor: 'host-page-2',
      fetchedAt: '2026-08-26T00:00:00.000Z',
    }))
    const installProvider = {
      get: () => ({ listInstallablePage } as never),
    }
    try {
      const response = await requestMarketCatalog(
        [active],
        `${marketRoutes.installable}?locale=zh-CN&q=sidebar&category=tools`,
        marketRoutes.installable,
        installProvider,
      )

      expect(response.statusCode).toBe(200)
      expect(response.body).toMatchObject({ nextCursor: 'host-page-2', items: [] })
      expect(fetchProvider).toHaveBeenCalledWith(
        { limit: 200, q: 'sidebar', category: ['tools'], locale: 'zh-CN' },
        expect.any(AbortSignal),
        { sourceRecordId: active.sourceRecordId },
        { force: false },
      )
      expect(scanCatalog).not.toHaveBeenCalled()
      expect(listInstallablePage).toHaveBeenCalledWith(
        sourceView,
        snapshot,
        ['dev', 'tools'],
        expect.any(AbortSignal),
        undefined,
      )
    } finally {
      fetchProvider.mockRestore()
      scanCatalog.mockRestore()
    }
  })
})

describe('catalog active-source reads', () => {
  it('keeps existing v1 adapter records readable through the reviewed v2 implementation', async () => {
    const legacy = source({ adapterId: DSH_1024STORE_LEGACY_ADAPTER_ID })
    const store = new MemoryCatalogSourceStore()
    await store.save([legacy])
    const getJson = vi.fn(async () => ({
      value: rawCatalog,
      finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200',
    }))
    const service = new DefaultCatalogService(store, { getJson })

    const results = await service.fetch({}, new AbortController().signal)

    expect(getJson).toHaveBeenCalledOnce()
    expect(results[0]?.snapshot?.source.adapterId).toBe(DSH_1024STORE_LEGACY_ADAPTER_ID)
    expect(results[0]?.snapshot?.items).toHaveLength(1)
  })

  it('exchanges a Host cursor token only for its original active source and query', async () => {
    const first = source()
    const second = source({
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      order: 1,
    })
    const store = new MemoryCatalogSourceStore()
    await store.save([first, second])
    const secondItem = {
      ...rawPlugin,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const getJson = vi.fn(async () => ({
      value: catalogPage([rawPlugin, secondItem]),
      finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200',
    }))
    const service = new DefaultCatalogService(store, { getJson })

    const firstPage = await service.fetch(
      { category: ['dev', 'tools'], limit: 1 },
      new AbortController().signal,
      { sourceRecordId: first.sourceRecordId },
    )
    const token = firstPage[0]?.snapshot?.page.nextCursor
    expect(token).toEqual(expect.any(String))
    expect(token).not.toBe('1')

    const results = await service.fetch(
      { category: ['dev', 'tools'], limit: 1 },
      new AbortController().signal,
      { sourceRecordId: first.sourceRecordId, cursor: token! },
    )

    expect(getJson).toHaveBeenCalledOnce()
    expect(results).toHaveLength(1)
    expect(results[0]?.source.sourceRecordId).toBe(first.sourceRecordId)
    expect(results[0]?.snapshot?.items).toHaveLength(1)
    expect(results[0]?.snapshot?.page.nextCursor).toBeUndefined()
  })

  it('rejects a cursor token replayed with a different effective query', async () => {
    const record = source()
    const store = new MemoryCatalogSourceStore()
    await store.save([record])
    const secondItem = {
      ...rawPlugin,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const getJson = vi.fn(async () => ({
      value: catalogPage([rawPlugin, secondItem]),
      finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200',
    }))
    const service = new DefaultCatalogService(store, { getJson })
    const [firstPage] = await service.fetch(
      { category: ['dev'], limit: 1 },
      new AbortController().signal,
      { sourceRecordId: record.sourceRecordId },
    )
    const token = firstPage?.snapshot?.page.nextCursor

    await expect(service.fetch(
      { category: ['tools'], limit: 1 },
      new AbortController().signal,
      { sourceRecordId: record.sourceRecordId, cursor: token! },
    )).rejects.toThrow(/does not belong/u)
    expect(getJson).toHaveBeenCalledOnce()
  })

  it('rejects a cursor token replayed against a different selected source', async () => {
    const first = source()
    const second = source({
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      enabled: false,
      order: 1,
    })
    const store = new MemoryCatalogSourceStore()
    await store.save([first, second])
    const secondItem = {
      ...rawPlugin,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const getJson = vi.fn(async () => ({
      value: catalogPage([rawPlugin, secondItem]),
      finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200',
    }))
    const service = new DefaultCatalogService(store, { getJson })
    const [firstPage] = await service.fetch(
      { limit: 1 },
      new AbortController().signal,
      { sourceRecordId: first.sourceRecordId },
    )
    const token = firstPage?.snapshot?.page.nextCursor
    await store.save([{ ...first, enabled: false }, { ...second, enabled: true }])

    await expect(service.fetch(
      { limit: 1 },
      new AbortController().signal,
      { sourceRecordId: second.sourceRecordId, cursor: token! },
    )).rejects.toThrow(/does not belong/u)
    expect(getJson).toHaveBeenCalledTimes(2)
  })

  it('rejects unknown and expired Host cursor tokens before provider I/O', async () => {
    const record = source()
    const store = new MemoryCatalogSourceStore()
    await store.save([record])
    const secondItem = {
      ...rawPlugin,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const getJson = vi.fn(async () => ({
      value: catalogPage([rawPlugin, secondItem]),
      finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200',
    }))
    let now = 1_000
    const service = new DefaultCatalogService(store, { getJson }, {
      cursorTtlMs: 60_000,
      now: () => now,
    })
    const [firstPage] = await service.fetch(
      { limit: 1 },
      new AbortController().signal,
      { sourceRecordId: record.sourceRecordId },
    )
    const token = firstPage?.snapshot?.page.nextCursor

    await expect(service.fetch(
      { limit: 1 },
      new AbortController().signal,
      { sourceRecordId: record.sourceRecordId, cursor: 'unknown-token' },
    )).rejects.toThrow(/unknown or expired/u)
    now += 60_000
    await expect(service.fetch(
      { limit: 1 },
      new AbortController().signal,
      { sourceRecordId: record.sourceRecordId, cursor: token! },
    )).rejects.toThrow(/unknown or expired/u)
    expect(getJson).toHaveBeenCalledOnce()
  })

  it('rejects an unscoped cursor instead of broadcasting it', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const getJson = vi.fn()
    const service = new DefaultCatalogService(store, { getJson })

    await expect(service.fetch(
      { cursor: 'page-2' },
      new AbortController().signal,
    )).rejects.toThrow(/explicit source scope/u)
    expect(getJson).not.toHaveBeenCalled()
  })

  it('globally bounds overlapping locale-index builds for the active source', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([
      source(),
      source({ sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003', order: 1 }),
      source({ sourceRecordId: '038f1f77-a5c4-7b73-a9ae-0242ac120004', order: 2 }),
    ])
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const getJson = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>(resolve => { releases.push(resolve) })
      active -= 1
      return { value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200' }
    })
    const service = new DefaultCatalogService(store, { getJson }, { maxConcurrentSources: 2 })

    const first = service.fetch({ locale: 'en-US' }, new AbortController().signal)
    const second = service.fetch({ locale: 'zh-CN' }, new AbortController().signal)
    await vi.waitFor(() => { expect(getJson).toHaveBeenCalledTimes(2) })
    expect(peak).toBe(2)
    releases.splice(0).forEach(release => release())
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.any(Array),
      expect.any(Array),
    ])
    expect(peak).toBe(2)
  })

  it('performs zero network requests with no configured sources', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([])
    const http: CatalogHttpClient = { getJson: vi.fn() }
    const service = new DefaultCatalogService(store, http)

    await expect(service.fetch({}, new AbortController().signal)).resolves.toEqual([])
    expect(http.getJson).not.toHaveBeenCalled()
  })

  it('performs zero network requests when configured sources have no explicit selection', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([{ ...source(), enabled: false }])
    const http: CatalogHttpClient = { getJson: vi.fn() }
    const service = new DefaultCatalogService(store, http)

    await expect(service.fetch({}, new AbortController().signal)).resolves.toEqual([])
    expect(http.getJson).not.toHaveBeenCalled()
  })

  it('queries only the selected source when several sources are configured', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([
      source(),
      source({ sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003', order: 1 }),
    ])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200' })
    const service = new DefaultCatalogService(store, { getJson })
    const results = await service.fetch({}, new AbortController().signal)

    expect(getJson).toHaveBeenCalledOnce()
    expect(results).toHaveLength(1)
    expect(results[0]?.snapshot?.items).toHaveLength(1)
  })

  it('uses the v2 provider path for 1024Store searches outside the Host route', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const appshot = {
      ...rawPlugin,
      id: 'TaurusWood/dsh-plugin-appshot',
      name: 'dsh-plugin-appshot',
      owner: 'TaurusWood',
      url: 'https://github.com/TaurusWood/dsh-plugin-appshot',
    }
    const getJson = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue)
      const limit = Number(url.searchParams.get('limit'))
      return {
        value: catalogPage(url.searchParams.get('q') === 'appshot' ? [appshot] : [rawPlugin], limit),
        finalUrl: url.href,
      }
    })
    const service = new DefaultCatalogService(store, { getJson })
    const scanCatalog = vi.spyOn(service, 'scanCatalog')

    try {
      const results = await service.fetch({ q: 'appshot' }, new AbortController().signal)

      expect(scanCatalog).not.toHaveBeenCalled()
      expect(getJson).toHaveBeenCalledOnce()
      const requestedUrl = new URL(getJson.mock.calls[0]![0])
      expect(requestedUrl.pathname).toBe('/api/v2/plugins')
      expect(requestedUrl.searchParams.get('q')).toBe('appshot')
      expect(results[0]?.snapshot?.items.map(item => item.id)).toEqual(['TaurusWood/dsh-plugin-appshot'])
    } finally {
      scanCatalog.mockRestore()
    }
  })

  it('reuses only an unexpired complete index and reports explicit cache status', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200' })
    const service = new DefaultCatalogService(store, { getJson })

    const first = await service.scanCatalog(new AbortController().signal)
    const second = await service.scanCatalog(new AbortController().signal)

    expect(first).toMatchObject({ cacheStatus: 'fresh', providerRevision: '2026-08-17T15:49:53.062Z' })
    expect(second).toMatchObject({ cacheStatus: 'cached', scanKey: first?.scanKey })
    expect(getJson).toHaveBeenCalledOnce()
  })

  it('coalesces concurrent first scans for the same source and locale', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    let release: ((value: { value: typeof rawCatalog; finalUrl: string }) => void) | undefined
    const getJson = vi.fn(() => new Promise<{ value: typeof rawCatalog; finalUrl: string }>(resolve => {
      release = resolve
    }))
    const service = new DefaultCatalogService(store, { getJson })

    const firstPending = service.scanCatalog(new AbortController().signal, { locale: 'zh-CN' })
    const secondPending = service.scanCatalog(new AbortController().signal, { locale: 'zh-CN' })
    await vi.waitFor(() => expect(getJson).toHaveBeenCalledOnce())
    release?.({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200' })
    const [first, second] = await Promise.all([firstPending, secondPending])

    expect(getJson).toHaveBeenCalledOnce()
    expect(first).toMatchObject({ cacheStatus: 'fresh', locale: 'zh-CN' })
    expect(second).toMatchObject({ cacheStatus: 'cached', locale: 'zh-CN', scanKey: first?.scanKey })
  })

  it('evicts the least recently used scan index when the cache entry limit is reached', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const getJson = vi.fn()
      .mockResolvedValue({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
    const service = new DefaultCatalogService(store, { getJson }, { maxCacheEntries: 2 })

    await service.scanCatalog(new AbortController().signal, { locale: 'en' })
    await service.scanCatalog(new AbortController().signal, { locale: 'zh-CN' })
    // Touch 'en' again so 'zh-CN' becomes the least recently used entry.
    await service.scanCatalog(new AbortController().signal, { locale: 'en' })
    expect(getJson).toHaveBeenCalledTimes(2)

    await service.scanCatalog(new AbortController().signal, { locale: 'ja' })
    expect(getJson).toHaveBeenCalledTimes(3)

    // 'zh-CN' was evicted; 'en' and 'ja' keep serving from the cache.
    const en = await service.scanCatalog(new AbortController().signal, { locale: 'en' })
    const ja = await service.scanCatalog(new AbortController().signal, { locale: 'ja' })
    expect(getJson).toHaveBeenCalledTimes(3)
    expect(en).toMatchObject({ cacheStatus: 'cached' })
    expect(ja).toMatchObject({ cacheStatus: 'cached' })

    // Reading the evicted locale must refetch instead of growing the cache.
    const zh = await service.scanCatalog(new AbortController().signal, { locale: 'zh-CN' })
    expect(getJson).toHaveBeenCalledTimes(4)
    expect(zh).toMatchObject({ cacheStatus: 'fresh' })
  })

  it('fails closed and revokes old cursors before rebuilding an expired complete index', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const secondItem = {
      ...rawPlugin,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const getJson = vi.fn()
      .mockResolvedValueOnce({
        value: catalogPage([rawPlugin, secondItem]),
        finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200',
      })
      .mockRejectedValueOnce(new Error('offline'))
    let now = 1_000
    const service = new DefaultCatalogService(store, { getJson }, {
      cacheTtlMs: 60_000,
      now: () => now,
    })

    const firstIndex = (await service.scanCatalog(new AbortController().signal))!
    const [page] = service.queryCatalog(
      firstIndex,
      { limit: 1 },
      { sourceRecordId: source().sourceRecordId },
    )
    const cursor = page?.snapshot?.page.nextCursor
    now += 60_001
    await expect(service.scanCatalog(new AbortController().signal)).rejects.toThrow('offline')
    expect(getJson).toHaveBeenCalledTimes(2)
    expect(() => service.queryCatalog(
      firstIndex,
      { limit: 1 },
      { sourceRecordId: source().sourceRecordId, cursor: cursor! },
    )).toThrow(/unknown or expired/u)
  })

  it('revokes paging cursors when eviction removes their scan index', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const secondItem = {
      ...rawPlugin,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const rebuiltItem = {
      ...rawPlugin,
      id: 'anywhere-labs/rebuilt-plugin',
      name: 'rebuilt-plugin',
      url: 'https://github.com/anywhere-labs/rebuilt-plugin',
    }
    const getJson = vi.fn()
      .mockResolvedValueOnce({
        value: catalogPage([rawPlugin, secondItem]),
        finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200',
      })
      .mockResolvedValueOnce({
        // The post-eviction rebuild returns different content; an old cursor
        // that still validates would page across the rebuild boundary.
        value: catalogPage([rawPlugin, secondItem, rebuiltItem]),
        finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200',
      })
    const service = new DefaultCatalogService(store, { getJson }, { maxCacheEntries: 1 })

    const firstIndex = (await service.scanCatalog(new AbortController().signal, { locale: 'en' }))!
    const [page] = service.queryCatalog(
      firstIndex,
      { limit: 1, locale: 'en' },
      { sourceRecordId: source().sourceRecordId },
    )
    const cursor = page?.snapshot?.page.nextCursor
    expect(cursor).toBeDefined()

    // A second locale evicts 'en' (limit 1); the eviction revokes the
    // source's cursors instead of leaving them valid across the rebuild.
    await service.scanCatalog(new AbortController().signal, { locale: 'zh-CN' })
    expect(getJson).toHaveBeenCalledTimes(2)
    expect(() => service.queryCatalog(
      firstIndex,
      { limit: 1, locale: 'en' },
      { sourceRecordId: source().sourceRecordId, cursor: cursor! },
    )).toThrow(/unknown or expired/u)
  })

  it('revokes media and the complete index when a source is invalidated', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200' })
      .mockRejectedValueOnce(new Error('offline'))
    const unregisterSource = vi.fn()
    const service = new DefaultCatalogService(store, { getJson }, {
      media: { register: () => publisherAssetRef, unregisterSource },
    })

    await expect(service.fetch({}, new AbortController().signal)).resolves.toHaveLength(1)
    service.invalidateSource(source().sourceRecordId)

    expect(unregisterSource).toHaveBeenCalledWith(source().sourceRecordId)
    await expect(service.fetch({}, new AbortController().signal)).rejects.toThrow('offline')
  })

  it('aborts an in-flight catalog request when its source is invalidated', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    let observedSignal: AbortSignal | undefined
    const getJson = vi.fn((_url: string, signal: AbortSignal) => {
      observedSignal = signal
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const service = new DefaultCatalogService(store, { getJson })

    const pending = service.fetch({}, new AbortController().signal)
    await vi.waitFor(() => { expect(getJson).toHaveBeenCalledOnce() })
    service.invalidateSource(source().sourceRecordId)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(observedSignal?.aborted).toBe(true)
  })

  it('does not accept a stale enabled record returned by a racing source load', async () => {
    let releaseLoad: ((records: readonly LocalSourceRecord[]) => void) | undefined
    const load = vi.fn(() => new Promise<readonly LocalSourceRecord[]>(resolve => { releaseLoad = resolve }))
    const getJson = vi.fn()
    const service = new DefaultCatalogService({ load }, { getJson })

    const pending = service.fetch({}, new AbortController().signal)
    await vi.waitFor(() => { expect(load).toHaveBeenCalledOnce() })
    service.invalidateSource(source().sourceRecordId)
    releaseLoad?.([source()])

    await expect(pending).rejects.toThrow(/changed during scan setup/u)
    expect(getJson).not.toHaveBeenCalled()
  })

  it('chooses the first source by order from legacy multi-enabled records', async () => {
    const first = source()
    const second = source({ sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003', order: 1 })
    const getJson = vi.fn(async () => ({
      value: rawCatalog,
      finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200',
    }))
    const service = new DefaultCatalogService({ load: async () => [second, first] }, { getJson })

    const results = await service.fetch({}, new AbortController().signal)

    expect(getJson).toHaveBeenCalledOnce()
    expect(results).toHaveLength(1)
    expect(results[0]?.source.sourceRecordId).toBe(first.sourceRecordId)
  })

  it('force reloads the complete index and revokes old local pagination cursors', async () => {
    const first = source()
    const store = new MemoryCatalogSourceStore()
    await store.save([first])
    const secondItem = {
      ...rawPlugin,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const completeCatalog = catalogPage([rawPlugin, secondItem])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: completeCatalog, finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200' })
      .mockResolvedValueOnce({ value: completeCatalog, finalUrl: 'https://deepseek1024.com/api/v2/plugins?page=1&limit=200' })
    const service = new DefaultCatalogService(store, { getJson })

    const firstIndex = (await service.scanCatalog(new AbortController().signal))!
    const [page] = service.queryCatalog(
      firstIndex,
      { limit: 1 },
      { sourceRecordId: first.sourceRecordId },
    )
    const cursor = page?.snapshot?.page.nextCursor
    const cached = await service.scanCatalog(new AbortController().signal)
    const refreshed = (await service.scanCatalog(new AbortController().signal, { force: true }))!

    expect(cached).toMatchObject({ cacheStatus: 'cached', scanKey: firstIndex.scanKey })
    expect(refreshed).toMatchObject({ cacheStatus: 'fresh' })
    expect(refreshed.scanKey).not.toBe(firstIndex.scanKey)
    expect(getJson).toHaveBeenCalledTimes(2)
    expect(getJson.mock.calls[1]?.[2]).toMatchObject({ cacheMode: 'reload' })
    expect(() => service.queryCatalog(
      refreshed,
      { limit: 1 },
      { sourceRecordId: first.sourceRecordId, cursor: cursor! },
    )).toThrow(/unknown or expired/u)
  })
})

describe('source mutation boundary', () => {
  it('normalizes a legacy multi-enabled registry to the first source by order', async () => {
    const first = source()
    const second = source({
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      order: 1,
    })
    const records = await new PersistentCatalogSourceStore(
      new MemoryMarketStateStore({ sources: [second, first] }),
    ).load()

    expect(records.map(record => [record.sourceRecordId, record.enabled])).toEqual([
      [first.sourceRecordId, true],
      [second.sourceRecordId, false],
    ])
  })

  it('preserves an explicit no-selection state in a legacy registry', async () => {
    const first = { ...source(), enabled: false }
    const second = source({
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      enabled: false,
      order: 1,
    })
    const records = await new PersistentCatalogSourceStore(
      new MemoryMarketStateStore({ sources: [second, first] }),
    ).load()

    expect(records.map(record => [record.sourceRecordId, record.enabled])).toEqual([
      [first.sourceRecordId, false],
      [second.sourceRecordId, false],
    ])
  })

  it('retains source disclosure without implicitly selecting the first configured source', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    const state = new MemoryMarketStateStore()
    const readManifest = vi.fn(async () => manifest)
    const mutate = createMarketSourceMutator(state, undefined, readManifest)

    await mutate(
      { action: 'add-standard', manifestUrl: 'https://plugins.example.org/catalog-source.json' },
      new AbortController().signal,
    )

    expect(state.getSources()[0]).toMatchObject({
      providerId: manifest.providerId,
      manifest,
      enabled: false,
    })
    const service = new DefaultCatalogService({ load: async () => state.getSources() }, restrictedHttpClient)
    await expect(service.listSources()).resolves.toEqual([
      expect.objectContaining({
        name: manifest.name,
        endpoint: manifest.transport.endpoint,
        attribution: manifest.attribution,
        partnership: false,
      }),
    ])
  })

  it('resolves each built-in mutation through the reviewed provider registry', async () => {
    const state = new MemoryMarketStateStore()
    const mutate = createMarketSourceMutator(state)

    await mutate({ action: 'add-builtin', key: DSH_1024STORE_KEY }, new AbortController().signal)
    await mutate({ action: 'add-builtin', key: DSHFIND_KEY }, new AbortController().signal)

    expect(state.getSources()).toEqual([
      expect.objectContaining({
        adapterId: DSH_1024STORE_ADAPTER_ID,
        providerId: DSH_1024STORE_PROVIDER_ID,
        builtInProviderKey: DSH_1024STORE_KEY,
        enabled: false,
        order: 0,
      }),
      expect.objectContaining({
        adapterId: DSHFIND_ADAPTER_ID,
        providerId: DSHFIND_PROVIDER_ID,
        builtInProviderKey: DSHFIND_KEY,
        enabled: false,
        order: 1,
      }),
    ])

    await expect(mutate(
      { action: 'add-builtin', key: 'unknown-provider' },
      new AbortController().signal,
    )).rejects.toThrow(/built-in source unavailable/u)
    expect(state.getSources()).toHaveLength(2)
  })

  it('serializes source writes so concurrent changes cannot overwrite each other', async () => {
    const first = { ...source(), enabled: false }
    const second: LocalSourceRecord = {
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      registrationKind: 'user-added',
      adapterId: 'market.standard-http-v1',
      providerId: 'fixture.second',
      manifestUrl: 'https://catalog.example/manifest.json',
      manifest: {
        ...(contractFixture('catalog-source.example') as CatalogSourceManifest),
        providerId: 'fixture.second',
        transport: { kind: 'https-json', endpoint: 'https://catalog.example/v1/plugins', method: 'GET' },
      },
      enabled: false,
      order: 1,
    }
    const backing = new MemoryMarketStateStore({ sources: [first, second] })
    let releaseFirst: (() => void) | undefined
    const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve })
    const setSources = vi.fn(async (records: readonly LocalSourceRecord[]) => {
      if (setSources.mock.calls.length === 1) await firstWrite
      await backing.setSources(records.map(record => ({ ...record })))
    })
    const mutate = createMarketSourceMutator(observedStateStore(backing, setSources))

    const one = mutate({ action: 'select', sourceRecordId: first.sourceRecordId }, new AbortController().signal)
    const two = mutate({ action: 'select', sourceRecordId: second.sourceRecordId }, new AbortController().signal)
    await vi.waitFor(() => { expect(setSources).toHaveBeenCalledTimes(1) })
    releaseFirst?.()
    await Promise.all([one, two])

    expect(setSources).toHaveBeenCalledTimes(2)
    expect(backing.getSources().map(record => record.enabled)).toEqual([false, true])
  })

  it('preserves a user-defined source order when another source is removed', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    const standardSource = (
      sourceRecordId: string,
      providerId: string,
      origin: string,
      order: number,
    ): LocalSourceRecord => ({
      sourceRecordId,
      registrationKind: 'user-added',
      adapterId: 'market.standard-http-v1',
      providerId,
      manifestUrl: `${origin}/catalog-source.json`,
      manifest: {
        ...manifest,
        providerId,
        name: providerId,
        attribution: { name: providerId, url: origin },
        transport: { kind: 'https-json', endpoint: `${origin}/v1/plugins`, method: 'GET' },
      },
      enabled: false,
      order,
    })
    const first = { ...source(), enabled: false }
    const second = standardSource(
      '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      'fixture.second',
      'https://second.example',
      1,
    )
    const third = standardSource(
      '038f1f77-a5c4-7b73-a9ae-0242ac120004',
      'fixture.third',
      'https://third.example',
      2,
    )
    const state = new MemoryMarketStateStore({ sources: [first, second, third] })
    const mutate = createMarketSourceMutator(state)

    await mutate(
      { action: 'move', sourceRecordId: third.sourceRecordId, direction: 'up' },
      new AbortController().signal,
    )
    await mutate(
      { action: 'remove', sourceRecordId: first.sourceRecordId },
      new AbortController().signal,
    )

    expect(state.getSources().map(record => [record.providerId, record.order, record.enabled])).toEqual([
      ['fixture.third', 0, false],
      ['fixture.second', 1, false],
    ])
  })

  it('rejects an aborted mutation before it reaches the serialized write', async () => {
    const record = { ...source(), enabled: false }
    const backing = new MemoryMarketStateStore({ sources: [record] })
    let releaseFirst: (() => void) | undefined
    const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve })
    const setSources = vi.fn(async (records: readonly LocalSourceRecord[]) => {
      await firstWrite
      await backing.setSources(records)
    })
    const mutate = createMarketSourceMutator(observedStateStore(backing, setSources))
    const first = mutate({ action: 'select', sourceRecordId: record.sourceRecordId }, new AbortController().signal)
    await vi.waitFor(() => { expect(setSources).toHaveBeenCalledOnce() })
    const queued = new AbortController()
    const second = mutate({ action: 'select', sourceRecordId: record.sourceRecordId }, queued.signal)
    queued.abort()
    releaseFirst?.()

    await first
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(setSources).toHaveBeenCalledOnce()
    expect(backing.getSources()[0]?.enabled).toBe(true)
  })

  it('selects one source atomically and revokes the previous active source after persistence', async () => {
    const current = source()
    const replacement = source({
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      enabled: false,
      order: 1,
    })
    const backing = new MemoryMarketStateStore({ sources: [current, replacement] })
    const events: string[] = []
    const state = observedStateStore(backing, async records => {
      await backing.setSources(records)
      events.push('saved')
    })
    const onUnavailable = vi.fn((sourceRecordId: string) => { events.push(`revoked:${sourceRecordId}`) })
    const mutate = createMarketSourceMutator(state, onUnavailable)

    await mutate({ action: 'select', sourceRecordId: replacement.sourceRecordId }, new AbortController().signal)

    expect(backing.getSources().map(record => record.enabled)).toEqual([false, true])
    expect(onUnavailable).toHaveBeenCalledWith(current.sourceRecordId)
    expect(events).toEqual(['saved', `revoked:${current.sourceRecordId}`])
  })

  it('keeps no selection when the active source is removed', async () => {
    const current = source()
    const replacement = source({
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      enabled: false,
      order: 1,
    })
    const state = new MemoryMarketStateStore({ sources: [current, replacement] })
    const onUnavailable = vi.fn()
    const mutate = createMarketSourceMutator(state, onUnavailable)

    await mutate({ action: 'remove', sourceRecordId: current.sourceRecordId }, new AbortController().signal)

    expect(state.getSources()).toEqual([{ ...replacement, enabled: false, order: 0 }])
    expect(onUnavailable).toHaveBeenCalledWith(current.sourceRecordId)
  })

  it('aborts an in-flight source mutation when the plugin generation is disposed', async () => {
    type RouteHandler = (req: EventEmitter & Record<string, any>, res: EventEmitter & Record<string, any>) => Promise<void>
    const handlers = new Map<string, RouteHandler>()
    const routeDisposers: ReturnType<typeof vi.fn>[] = []
    const ctx = {
      webServer: {
        port: 43_120,
        register: vi.fn((route: { path: string; handler: RouteHandler }) => {
          handlers.set(route.path, route.handler)
          const routeDispose = vi.fn()
          routeDisposers.push(routeDispose)
          return routeDispose
        }),
      },
    }
    const setSources = vi.fn(async () => {})
    const state: MarketStateStore = {
      getSources: () => [],
      setSources,
      getCatalogCache: () => undefined,
      setCatalogCache: vi.fn(async () => {}),
    }
    const dispose = registerMarketRoutes(ctx as never, state)
    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: marketRoutes.sources,
      headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
      end: vi.fn(),
    })
    const pending = handlers.get(marketRoutes.sources)!(request, response)

    dispose()
    dispose()
    await pending

    expect(setSources).not.toHaveBeenCalled()
    expect(response.end).not.toHaveBeenCalled()
    for (const event of ['data', 'end', 'error', 'aborted']) expect(request.listenerCount(event)).toBe(0)
    expect(routeDisposers).toHaveLength(4)
    for (const routeDispose of routeDisposers) expect(routeDispose).toHaveBeenCalledOnce()
  })

  it.each([
    ['127.0.0.1'],
    ['::ffff:7f00:1'],
  ])('allows loopback address %s only with the Desktop authority and a matching origin', (remoteAddress) => {
    const origin = 'http://127.0.0.1:43120'
    const host = '127.0.0.1:43120'
    expect(marketMutationAllowed({ remoteAddress, origin, host, expectedPort: 43_120 })).toBe(true)
  })

  it.each([
    [undefined, 'http://localhost:43120', 'localhost:43120'],
    ['127.0.0.1', undefined, 'localhost:43120'],
    ['127.0.0.1', 'http://attacker.example', 'localhost:43120'],
    ['104.21.87.154', 'http://localhost:43120', 'localhost:43120'],
    ['127.0.0.1', 'http://evil.example:43120', 'evil.example:43120'],
    ['127.0.0.1', 'http://localhost:43121', 'localhost:43121'],
  ])('rejects incomplete or non-local mutation context', (remoteAddress, origin, host) => {
    expect(marketMutationAllowed({ remoteAddress, origin, host, expectedPort: 43_120 })).toBe(false)
  })

  it('allows same-authority reads without Origin but rejects cross-site fetch metadata', () => {
    const base = {
      remoteAddress: '127.0.0.1',
      origin: undefined,
      host: '127.0.0.1:43120',
      expectedPort: 43_120,
    }
    expect(marketRequestAllowed(base)).toBe(true)
    expect(marketRequestAllowed({ ...base, secFetchSite: 'cross-site' })).toBe(false)
  })
})

describe('restricted HTTP boundary', () => {
  it('starts the first-byte deadline before response headers arrive', async () => {
    vi.useFakeTimers()
    const request = new EventEmitter()
    const destroy = vi.fn((cause?: Error) => { request.emit('error', cause) })
    Object.assign(request, { destroy, end: vi.fn() })
    const requestSpy = vi.spyOn(https, 'request').mockImplementation((() => request) as never)
    try {
      const client = createRestrictedHttpClient({
        resolveAddress: async () => ({ address: '93.184.216.34', family: 4 }),
        retryAttempts: 1,
      })
      const result = expect(client.getJson(
        'https://catalog.example/v1/plugins',
        new AbortController().signal,
      )).rejects.toMatchObject({ code: 'timeout' })

      await vi.advanceTimersByTimeAsync(0)
      expect(requestSpy).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(11_999)
      expect(destroy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await result
      expect(destroy).toHaveBeenCalledOnce()
    } finally {
      requestSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('allows proxy fake-IP DNS only for an exact reviewed hostname', async () => {
    const lookupAddresses = vi.fn(async () => [{ address: '198.18.0.38', family: 4 as const }])
    const request = vi.fn(async () => ({
      body: Buffer.from('{"plugins":[]}'),
      headers: { 'content-type': 'application/json' },
      statusCode: 200,
    }))
    const trusted = createRestrictedHttpClient({
      syntheticProxyHostnames: ['deepseek1024.com'],
      lookupAddresses,
      request,
    })

    await expect(trusted.getJson(
      'https://deepseek1024.com/api/v2/plugins',
      new AbortController().signal,
    )).resolves.toMatchObject({ value: { plugins: [] } })
    expect(request).toHaveBeenCalledOnce()

    const strict = createRestrictedHttpClient({ lookupAddresses, request })
    await expect(strict.getJson(
      'https://deepseek1024.com/api/v2/plugins',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
    await expect(trusted.getJson(
      'https://deepseek1024.com.attacker.example/api/v2/plugins',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
    await expect(trusted.getJson(
      'https://198.18.0.38/api/v2/plugins',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
  })

  it('rejects NAT64 and 6to4 addresses embedding private, loopback, or metadata IPv4', async () => {
    const request = vi.fn(async () => ({
      body: Buffer.from('{}'),
      headers: { 'content-type': 'application/json' },
      statusCode: 200,
    }))
    for (const address of [
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::7f00:1',
      '64:ff9b::c0a8:101',
      '64:ff9b:1::a9fe:a9fe',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '2002:c0a8:101::1',
      '::a9fe:a9fe',
      '::7f00:1',
    ]) {
      const client = createRestrictedHttpClient({
        lookupAddresses: vi.fn(async () => [{ address, family: 6 as const }]),
        request,
      })
      await expect(client.getJson(
        'https://catalog.example/manifest.json',
        new AbortController().signal,
      ), address).rejects.toMatchObject({ code: 'blocked-address' })
      const literal = createRestrictedHttpClient({ request })
      await expect(literal.getJson(
        `https://[${address}]/manifest.json`,
        new AbortController().signal,
      ), `literal ${address}`).rejects.toMatchObject({ code: 'blocked-address' })
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('still allows ordinary global IPv6 and blocks the whole NAT64 prefix', async () => {
    const request = vi.fn(async () => ({
      body: Buffer.from('{}'),
      headers: { 'content-type': 'application/json' },
      statusCode: 200,
    }))
    const allowed = createRestrictedHttpClient({
      lookupAddresses: vi.fn(async () => [{ address: '2606:4700:4700::1111', family: 6 as const }]),
      request,
    })
    await expect(allowed.getJson(
      'https://catalog.example/manifest.json',
      new AbortController().signal,
    )).resolves.toBeTruthy()

    // The well-known NAT64 prefix is blocked as a whole, including forms
    // embedding a public IPv4; the blocklist must not grow a per-target hole.
    const nat64Public = createRestrictedHttpClient({
      lookupAddresses: vi.fn(async () => [{ address: '64:ff9b::808:808', family: 6 as const }]),
      request,
    })
    await expect(nat64Public.getJson(
      'https://catalog.example/manifest.json',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
  })

  it('caches a completed fixed-catalog response and collapses concurrent reads', async () => {
    let now = 1_000
    let release: ((value: { value: object; finalUrl: string }) => void) | undefined
    const pending = new Promise<{ value: object; finalUrl: string }>(resolve => { release = resolve })
    const delegate: CatalogHttpClient = { getJson: vi.fn(async () => await pending) }
    const client = createCachedCatalogHttpClient(delegate, { ttlMs: 300_000, now: () => now })
    const first = client.getJson('https://deepseek1024.com/api/v2/plugins', new AbortController().signal)
    const second = client.getJson('https://deepseek1024.com/api/v2/plugins', new AbortController().signal)

    expect(delegate.getJson).toHaveBeenCalledOnce()
    release?.({ value: { plugins: [] }, finalUrl: 'https://deepseek1024.com/api/v2/plugins' })
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    await client.getJson('https://deepseek1024.com/api/v2/plugins', new AbortController().signal)
    expect(delegate.getJson).toHaveBeenCalledOnce()

    now += 300_001
    const refreshed = client.getJson('https://deepseek1024.com/api/v2/plugins', new AbortController().signal)
    expect(delegate.getJson).toHaveBeenCalledTimes(2)
    await expect(refreshed).resolves.toMatchObject({ value: { plugins: [] } })
  })

  it('bounds the cached-catalog entry count and evicts the least recently used entry', async () => {
    let now = 1_000
    const seen: string[] = []
    const delegate: CatalogHttpClient = {
      getJson: vi.fn(async (url: string) => {
        seen.push(url)
        return { value: { url }, finalUrl: url }
      }),
    }
    const client = createCachedCatalogHttpClient(delegate, { ttlMs: 300_000, now: () => now, maxEntries: 2 })
    await client.getJson('https://provider.example/a', new AbortController().signal)
    await client.getJson('https://provider.example/b', new AbortController().signal)
    // Touch "a" so "b" becomes the least recently used entry.
    await client.getJson('https://provider.example/a', new AbortController().signal)
    await client.getJson('https://provider.example/c', new AbortController().signal)
    expect(seen).toEqual(['https://provider.example/a', 'https://provider.example/b', 'https://provider.example/c'])

    // "b" was evicted; refetching it must hit the delegate again, while "a"
    // and "c" stay served from the cache without new requests.
    await client.getJson('https://provider.example/a', new AbortController().signal)
    await client.getJson('https://provider.example/c', new AbortController().signal)
    await client.getJson('https://provider.example/b', new AbortController().signal)
    expect(seen).toHaveLength(4)

    // Expired entries are swept even when the cache is below the entry cap:
    // inserting "d" sweeps the now-expired "c" and "b", so reading "b" again
    // must hit the delegate a third time.
    now += 300_001
    await client.getJson('https://provider.example/d', new AbortController().signal)
    await client.getJson('https://provider.example/b', new AbortController().signal)
    expect(seen.filter(url => url === 'https://provider.example/b')).toHaveLength(3)
  })

  it('re-imposes the entry limit after a burst of concurrent requests settles', async () => {
    let now = 1_000
    const seen: string[] = []
    const delegate: CatalogHttpClient = {
      getJson: vi.fn(async (url: string) => {
        seen.push(url)
        return { value: { url }, finalUrl: url }
      }),
    }
    const client = createCachedCatalogHttpClient(delegate, { ttlMs: 300_000, now: () => now, maxEntries: 2 })
    // Six distinct URLs resolve in submission order; request-start eviction
    // skips every in-flight entry, so only the post-completion sweep the fix
    // adds can bring the cache back under the limit.
    await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(suffix =>
      client.getJson(`https://provider.example/${suffix}`, new AbortController().signal)))
    expect(seen).toHaveLength(6)

    // The earliest URLs were evicted once everything settled, so reading them
    // again must hit the delegate; the two most recent stay cached.
    await client.getJson('https://provider.example/a', new AbortController().signal)
    expect(seen.filter(url => url === 'https://provider.example/a')).toHaveLength(2)
    await client.getJson('https://provider.example/f', new AbortController().signal)
    expect(seen.filter(url => url === 'https://provider.example/f')).toHaveLength(1)
  })

  it('refreshes the LRU order for an entry refetched after expiry', async () => {
    let now = 1_000
    const seen: string[] = []
    const delegate: CatalogHttpClient = {
      getJson: vi.fn(async (url: string) => {
        seen.push(url)
        return { value: { url }, finalUrl: url }
      }),
    }
    const client = createCachedCatalogHttpClient(delegate, { ttlMs: 300_000, now: () => now, maxEntries: 2 })
    await client.getJson('https://provider.example/a', new AbortController().signal)
    await client.getJson('https://provider.example/b', new AbortController().signal)

    // "a" expires and is refetched; the refetch must move it to the back of
    // the LRU order, so a later insertion evicts "b" instead of "a".
    now += 300_001
    await client.getJson('https://provider.example/a', new AbortController().signal)
    expect(seen).toHaveLength(3)
    await client.getJson('https://provider.example/c', new AbortController().signal)
    expect(seen).toHaveLength(4)

    await client.getJson('https://provider.example/a', new AbortController().signal)
    expect(seen).toHaveLength(4)
    await client.getJson('https://provider.example/b', new AbortController().signal)
    expect(seen).toHaveLength(5)
  })

  it('keeps an in-flight entry collapsing concurrent reads under eviction pressure', async () => {
    let now = 1_000
    const seen: string[] = []
    let releaseA!: (value: { value: object; finalUrl: string }) => void
    const delegate: CatalogHttpClient = {
      getJson: vi.fn((url: string, _signal: AbortSignal, _policy?: CatalogHttpRequestPolicy): Promise<CatalogHttpResponse> => {
        seen.push(url)
        if (url.endsWith('/a')) return new Promise<CatalogHttpResponse>(resolve => { releaseA = resolve })
        return Promise.resolve({ value: { url }, finalUrl: url })
      }),
    }
    const client = createCachedCatalogHttpClient(delegate, { ttlMs: 300_000, now: () => now, maxEntries: 1 })
    const first = client.getJson('https://provider.example/a', new AbortController().signal)
    const second = client.getJson('https://provider.example/a', new AbortController().signal)
    // Triggers eviction while "a" is still in flight; "a" must survive it.
    await client.getJson('https://provider.example/b', new AbortController().signal)
    releaseA({ value: { url: 'https://provider.example/a' }, finalUrl: 'https://provider.example/a' })
    await Promise.all([first, second])
    expect(seen.filter(url => url.endsWith('/a'))).toHaveLength(1)
    expect(seen.filter(url => url.endsWith('/b'))).toHaveLength(1)
  })

  it('aborts a shared fixed-catalog request after its last waiter leaves', async () => {
    let delegateSignal: AbortSignal | undefined
    const delegate: CatalogHttpClient = {
      getJson: vi.fn(async (_url, signal) => await new Promise<never>((_resolve, reject) => {
        delegateSignal = signal
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })),
    }
    const client = createCachedCatalogHttpClient(delegate)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = client.getJson('https://deepseek1024.com/api/v2/plugins', firstController.signal)
    const second = client.getJson('https://deepseek1024.com/api/v2/plugins', secondController.signal)
    const firstResult = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const secondResult = expect(second).rejects.toMatchObject({ name: 'AbortError' })

    firstController.abort()
    expect(delegateSignal?.aborted).toBe(false)
    secondController.abort()
    expect(delegateSignal?.aborted).toBe(true)
    await Promise.all([firstResult, secondResult])
    expect(delegate.getJson).toHaveBeenCalledOnce()
  })

  it('does not let an abandoned shared request overwrite its replacement', async () => {
    const releases: Array<(response: { value: object; finalUrl: string }) => void> = []
    const delegate: CatalogHttpClient = {
      getJson: vi.fn(async () => await new Promise<{ value: object; finalUrl: string }>(resolve => { releases.push(resolve) })),
    }
    const client = createCachedCatalogHttpClient(delegate)
    const abandonedController = new AbortController()
    const abandoned = client.getJson('https://deepseek1024.com/api/v2/plugins', abandonedController.signal)
    const abandonedResult = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    abandonedController.abort()
    await abandonedResult

    const replacement = client.getJson('https://deepseek1024.com/api/v2/plugins', new AbortController().signal)
    expect(delegate.getJson).toHaveBeenCalledTimes(2)
    releases[0]?.({ value: { revision: 'abandoned' }, finalUrl: 'https://deepseek1024.com/api/v2/plugins' })
    releases[1]?.({ value: { revision: 'replacement' }, finalUrl: 'https://deepseek1024.com/api/v2/plugins' })
    await expect(replacement).resolves.toMatchObject({ value: { revision: 'replacement' } })
    await expect(client.getJson(
      'https://deepseek1024.com/api/v2/plugins',
      new AbortController().signal,
    )).resolves.toMatchObject({ value: { revision: 'replacement' } })
    expect(delegate.getJson).toHaveBeenCalledTimes(2)
  })

  it('keeps one total deadline across redirects', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn((url: URL, signal: AbortSignal) => {
        if (url.hostname === 'catalog.example') {
          return new Promise<{ body: Buffer; headers: { location: string }; statusCode: number }>((resolve) => {
            setTimeout(() => resolve({
              body: Buffer.alloc(0),
              headers: { location: 'https://redirect.example/catalog.json' },
              statusCode: 302,
            }), 20)
          })
        }
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      })
      const client = createRestrictedHttpClient({
        request,
        resolveAddress: async () => ({ address: '104.21.87.154', family: 4 }),
        totalTimeoutMs: 30,
      })

      const result = expect(client.getJson(
        'https://catalog.example/catalog.json',
        new AbortController().signal,
      )).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(20)
      expect(request).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(10)
      await result
    } finally {
      vi.useRealTimers()
    }
  })

  it('enforces the total deadline while DNS resolution remains pending', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn()
      let releaseLookup: ((addresses: readonly [{ address: string; family: 4 }]) => void) | undefined
      const lookup = new Promise<readonly [{ address: string; family: 4 }]>(resolve => { releaseLookup = resolve })
      const client = createRestrictedHttpClient({
        lookupAddresses: vi.fn(async () => await lookup),
        request,
        totalTimeoutMs: 30,
      })
      const result = expect(client.getJson(
        'https://catalog.example/catalog.json',
        new AbortController().signal,
      )).rejects.toMatchObject({ code: 'timeout' })

      await vi.advanceTimersByTimeAsync(30)
      await result
      releaseLookup?.([{ address: '93.184.216.34', family: 4 }])
      await vi.advanceTimersByTimeAsync(0)
      expect(request).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('revalidates every redirect target before the next request', async () => {
    const resolveAddress = vi.fn(async (hostname: string) => {
      if (hostname === 'private.example') throw new CatalogNetworkError('blocked-address')
      return { address: '104.21.87.154', family: 4 as const }
    })
    const request = vi.fn(async () => ({
      body: Buffer.alloc(0),
      headers: { location: 'https://private.example/catalog.json' },
      statusCode: 302,
    }))
    const client = createRestrictedHttpClient({ request, resolveAddress })

    await expect(client.getJson(
      'https://catalog.example/catalog.json',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
    expect(resolveAddress).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects a standard-source cross-origin redirect before contacting it', async () => {
    const resolveAddress = vi.fn(async () => ({ address: '104.21.87.154', family: 4 as const }))
    const request = vi.fn(async () => ({
      body: Buffer.alloc(0),
      headers: { location: 'https://other.example/v1/plugins' },
      statusCode: 302,
    }))
    const client = createRestrictedHttpClient({ request, resolveAddress })

    await expect(client.getJson(
      'https://catalog.example/v1/plugins',
      new AbortController().signal,
      { allowedOrigin: 'https://catalog.example' },
    )).rejects.toMatchObject({ code: 'redirect' })
    expect(resolveAddress).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
  })

  it('returns an address list when Node requests an all-address lookup', () => {
    const pinned = { address: '104.21.87.154', family: 4 as const }
    expect(pinnedLookupResult({ all: true }, pinned)).toEqual([pinned])
    expect(pinnedLookupResult({ all: false }, pinned)).toEqual(pinned)
  })

  it.each(['http://example.com/catalog.json', 'https://127.0.0.1/catalog.json', 'https://169.254.169.254/latest'])('rejects unsafe URL %s before requesting it', async (url) => {
    await expect(restrictedHttpClient.getJson(url, new AbortController().signal)).rejects.toThrow(/catalog request failed/u)
  })

  it.each([
    'https://[::ffff:7f00:1]/catalog.json',
    'https://[::ffff:a9fe:a9fe]/latest',
  ])('rejects IPv4-mapped IPv6 URL %s before connecting', async (url) => {
    await expect(restrictedHttpClient.getJson(url, AbortSignal.timeout(250))).rejects.toMatchObject({
      code: 'blocked-address',
    })
  })
})
