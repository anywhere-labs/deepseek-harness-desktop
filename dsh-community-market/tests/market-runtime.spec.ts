import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { describe, expect, it, vi } from 'vitest'
import { dsh1024StoreAdapter, DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_KEY, DSH_1024STORE_PROVIDER_ID } from '../src/adapters/dsh-1024store.js'
import { DSHFIND_ADAPTER_ID, DSHFIND_KEY, DSHFIND_PROVIDER_ID } from '../src/adapters/dshfind.js'
import { standardHttpAdapter } from '../src/adapters/standard-http.js'
import { DefaultCatalogService, type CatalogFullIndex } from '../src/catalog/service.js'
import { MemoryCatalogSourceStore, SettingsCatalogSourceStore } from '../src/catalog/source-store.js'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {
  CatalogHttpClient,
  CatalogProviderPage,
  CatalogSourceManifest,
  LocalSourceRecord,
} from '../src/contracts/index.js'
import type { MarketSettingsDocument } from '../src/catalog/source-store.js'
import {
  createMarketSourceMutator,
  marketMutationAllowed,
  marketRequestAllowed,
  marketRoutes,
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

const rawCatalog = {
  name: 'dsh-1024store-catalog',
  meta: {
    total: 1,
    generatedAt: '2026-08-17T15:49:53.062Z',
    revision: 'sha256:fixture',
  },
  packages: [{
    id: 'anywhere-labs/deepseek-harness-desktop/dsh-plugin-desktop',
    name: 'deepseek-harness-desktop',
    owner: 'anywhere-labs',
    url: 'https://github.com/anywhere-labs/deepseek-harness-desktop',
    category: 'dev',
    description: { en: 'Desktop shell', zh: '桌面外壳' },
    pushedAt: '2026-08-17T05:45:19Z',
    stars: 11_402,
    installCount: 7,
    install: 'dsh plugin --profile web add unsafe-value-that-must-be-ignored',
  }],
}

function catalogIndex(record: LocalSourceRecord = source()): CatalogFullIndex {
  return {
    source: {
      ...record,
      name: 'DSH 1024Store',
      endpoint: 'https://deepseek1024.com/api/v1/plugins',
      partnership: true,
    },
    snapshots: [],
    scannedAt: '2026-08-18T00:00:00.000Z',
    expiresAt: '2026-08-18T00:05:00.000Z',
    providerRevision: 'sha256:fixture',
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
  const scope = {
    get: () => ({ sources: records }),
    update: vi.fn(),
  } as unknown as SettingsScope<MarketSettingsDocument>
  const dispose = registerMarketRoutes(ctx as never, scope)
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
    await handlers.get(marketRoutes.catalog)!(request, response)
  } finally {
    dispose()
  }
  if (bodyText === undefined) throw new Error('catalog route did not return a JSON body')
  return {
    statusCode: response.statusCode,
    body: JSON.parse(bodyText) as Record<string, any>,
  }
}

describe('1024Store adapter', () => {
  it('represents a valid empty catalog with one explicit empty snapshot', async () => {
    const snapshots = await dsh1024StoreAdapter.scanCatalog!({}, {
      source: source(),
      signal: new AbortController().signal,
      http: {
        getJson: vi.fn(async () => ({
          value: { ...rawCatalog, meta: { ...rawCatalog.meta, total: 0 }, packages: [] },
          finalUrl: 'https://deepseek1024.com/api/v1/plugins',
        })),
      },
      media: { register: vi.fn() },
    })

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ items: [], page: { total: 0 } })
  })

  it('projects reviewed fields and never forwards remote install strings', async () => {
    const http: CatalogHttpClient = { getJson: vi.fn(async () => ({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })) }
    const register = vi.fn(() => publisherAssetRef)
    const snapshot = await dsh1024StoreAdapter.fetch(
      { locale: 'en-US' },
      { source: source(), signal: new AbortController().signal, http, media: { register } },
    )

    expect(snapshot.items[0]).toMatchObject({
      id: rawCatalog.packages[0]!.id,
      summary: 'Desktop shell',
      repository: {
        url: 'https://github.com/anywhere-labs/deepseek-harness-desktop',
        subdirectory: 'dsh-plugin-desktop',
      },
      media: { icon: { assetRef: publisherAssetRef, role: 'publisher-avatar', alt: 'anywhere-labs' } },
      provenance: { sourceRecordId: source().sourceRecordId },
    })
    expect(JSON.stringify(snapshot)).not.toContain('unsafe-value')
    expect(snapshot.source).toMatchObject({
      providerGeneratedAt: '2026-08-17T15:49:53.062Z',
      providerRevision: 'sha256:fixture',
    })
    expect(register).toHaveBeenCalledWith({
      remoteUrl: 'https://github.com/anywhere-labs.png?size=96',
      role: 'publisher-avatar',
      alt: 'anywhere-labs',
      sourceRecordId: source().sourceRecordId,
      itemId: rawCatalog.packages[0]!.id,
      allowedHostnames: ['github.com', 'avatars.githubusercontent.com'],
    })
    expect(http.getJson).toHaveBeenCalledWith(
      'https://deepseek1024.com/api/v1/plugins',
      expect.any(AbortSignal),
      { allowedOrigin: 'https://deepseek1024.com' },
    )
  })

  it('prefers an explicit provider icon over the GitHub publisher avatar fallback', async () => {
    const item = {
      ...rawCatalog.packages[0]!,
      media: { icon: { url: 'https://avatars.githubusercontent.com/u/1?v=4', alt: 'Plugin logo' } },
    }
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: { ...rawCatalog, packages: [item] },
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
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
      getJson: vi.fn(async () => ({ value: rawCatalog, finalUrl: 'https://attacker.example/api/v1/plugins' })),
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
      ...rawCatalog.packages[0]!,
      id: 'former-owner/former-repository',
      owner: 'current-owner',
      url: 'https://github.com/current-owner/current-repository',
    }
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: { ...rawCatalog, packages: [item] },
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
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
      ...rawCatalog.packages[0]!,
      id: 'tianxia--/fixture',
      owner: 'tianxia--',
      url: 'https://github.com/tianxia--/fixture',
    }
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: { ...rawCatalog, packages: [item] },
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
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

  it('browses the complete registry locally with filtering, sorting, and cursor paging', async () => {
    const low = {
      ...rawCatalog.packages[0]!,
      id: 'example/low-plugin',
      name: 'Low Plugin',
      owner: 'example',
      url: 'https://github.com/example/low-plugin',
      category: 'tools',
      stars: 1,
    }
    const high = {
      ...rawCatalog.packages[0]!,
      id: 'example/high-plugin',
      name: 'High Plugin',
      owner: 'example',
      url: 'https://github.com/example/high-plugin',
      category: 'tools',
      stars: 100,
    }
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: { ...rawCatalog, meta: { ...rawCatalog.meta, total: 3 }, packages: [{ invalid: true }, low, high] },
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
      })),
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
    expect(first.page).toEqual({ nextCursor: '1', total: 2 })
    expect(second.items.map(item => item.id)).toEqual(['example/low-plugin'])
    expect(second.page).toEqual({ total: 2 })
  })

  it('does not silently treat a truncated 1024Store response as the complete catalog', async () => {
    const packages = Array.from({ length: 51 }, (_, index) => ({
      ...rawCatalog.packages[0]!,
      id: `anywhere-labs/plugin-${index}`,
      name: `plugin-${index}`,
      url: `https://github.com/anywhere-labs/plugin-${index}`,
    }))
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: { ...rawCatalog, meta: { ...rawCatalog.meta, total: 7635 }, packages },
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
      })),
    }

    const snapshot = await dsh1024StoreAdapter.fetch(
      { limit: 100 },
      { source: source(), signal: new AbortController().signal, http, media: { register: () => fixtureAssetRef } },
    )

    expect(snapshot.items).toHaveLength(50)
    expect(snapshot.page).toEqual({ nextCursor: '50', total: 7635 })
  })

  it('fails a complete 1024Store scan when provider metadata says more items exist', async () => {
    const packages = Array.from({ length: 51 }, (_, index) => ({
      ...rawCatalog.packages[0]!,
      id: `anywhere-labs/plugin-${index}`,
      name: `plugin-${index}`,
      url: `https://github.com/anywhere-labs/plugin-${index}`,
    }))
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: { ...rawCatalog, meta: { ...rawCatalog.meta, total: 7635 }, packages },
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
      })),
    }

    await expect(dsh1024StoreAdapter.scanCatalog!(
      { limit: 100 },
      { source: source(), signal: new AbortController().signal, http, media: { register: () => fixtureAssetRef } },
    )).rejects.toThrow(/provider total/u)
  })

  it('keeps the reviewed 1024Store adapter page size fixed at 50', async () => {
    const packages = Array.from({ length: 51 }, (_, index) => ({
      ...rawCatalog.packages[0]!,
      id: `anywhere-labs/plugin-${index}`,
      name: `plugin-${index}`,
      url: `https://github.com/anywhere-labs/plugin-${index}`,
    }))
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: { ...rawCatalog, packages },
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
      })),
    }

    const snapshot = await dsh1024StoreAdapter.fetch(
      { limit: 100 },
      { source: source(), signal: new AbortController().signal, http, media: { register: () => fixtureAssetRef } },
    )

    expect(snapshot.items).toHaveLength(50)
    expect(snapshot.page).toEqual({ nextCursor: '50', total: 51 })
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
    const scanCatalog = vi.spyOn(DefaultCatalogService.prototype, 'scanCatalog')
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
      scanCatalog.mockRestore()
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
        metadata: { cacheStatus: 'fresh', providerRevision: 'sha256:fixture' },
      })
    } finally {
      scanCatalog.mockRestore()
      queryCatalog.mockRestore()
    }
  })

  it('allows an initial request to bind itself to the current active source', async () => {
    const active = source()
    const index = catalogIndex(active)
    const scanCatalog = vi.spyOn(DefaultCatalogService.prototype, 'scanCatalog').mockResolvedValue(index)
    const queryCatalog = vi.spyOn(DefaultCatalogService.prototype, 'queryCatalog').mockReturnValue([])
    try {
      const response = await requestMarketCatalog(
        [active],
        `${marketRoutes.catalog}?sourceRecordId=${active.sourceRecordId}`,
      )

      expect(response.statusCode).toBe(200)
      expect(queryCatalog).toHaveBeenCalledWith(
        index,
        { limit: 50 },
        { sourceRecordId: active.sourceRecordId },
      )
    } finally {
      scanCatalog.mockRestore()
      queryCatalog.mockRestore()
    }
  })

  it('accepts an explicit page size up to the shared 100-item safety cap', async () => {
    const response = await requestMarketCatalog([], `${marketRoutes.catalog}?limit=100`)

    expect(response.statusCode).toBe(200)
    expect(response.body.query).toEqual({ limit: 100 })
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
    const scanCatalog = vi.spyOn(dsh1024StoreAdapter, 'scanCatalog')
      .mockRejectedValue(new Error('invalid cursor scope reached the catalog adapter'))
    try {
      const response = await requestMarketCatalog(
        records,
        `${marketRoutes.catalog}?sourceRecordId=${sourceRecordId}&cursor=page-2`,
      )

      expect(response.statusCode).toBe(400)
      expect(response.body).toEqual({ error: 'invalid catalog query' })
      expect(scanCatalog).not.toHaveBeenCalled()
    } finally {
      scanCatalog.mockRestore()
    }
  })
})

describe('catalog active-source reads', () => {
  it('exchanges a Host cursor token only for its original active source and query', async () => {
    const first = source()
    const second = source({
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      order: 1,
    })
    const store = new MemoryCatalogSourceStore()
    await store.save([first, second])
    const secondItem = {
      ...rawCatalog.packages[0]!,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const getJson = vi.fn(async () => ({
      value: { ...rawCatalog, packages: [...rawCatalog.packages, secondItem] },
      finalUrl: 'https://deepseek1024.com/api/v1/plugins',
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
      ...rawCatalog.packages[0]!,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const getJson = vi.fn(async () => ({
      value: { ...rawCatalog, packages: [...rawCatalog.packages, secondItem] },
      finalUrl: 'https://deepseek1024.com/api/v1/plugins',
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
      ...rawCatalog.packages[0]!,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const getJson = vi.fn(async () => ({
      value: { ...rawCatalog, packages: [...rawCatalog.packages, secondItem] },
      finalUrl: 'https://deepseek1024.com/api/v1/plugins',
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
      ...rawCatalog.packages[0]!,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const getJson = vi.fn(async () => ({
      value: { ...rawCatalog, packages: [...rawCatalog.packages, secondItem] },
      finalUrl: 'https://deepseek1024.com/api/v1/plugins',
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
      return { value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' }
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
      .mockResolvedValueOnce({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
    const service = new DefaultCatalogService(store, { getJson })
    const results = await service.fetch({}, new AbortController().signal)

    expect(getJson).toHaveBeenCalledOnce()
    expect(results).toHaveLength(1)
    expect(results[0]?.snapshot?.items).toHaveLength(1)
  })

  it('reuses only an unexpired complete index and reports explicit cache status', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
    const service = new DefaultCatalogService(store, { getJson })

    const first = await service.scanCatalog(new AbortController().signal)
    const second = await service.scanCatalog(new AbortController().signal)

    expect(first).toMatchObject({ cacheStatus: 'fresh', providerRevision: 'sha256:fixture' })
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
    release?.({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
    const [first, second] = await Promise.all([firstPending, secondPending])

    expect(getJson).toHaveBeenCalledOnce()
    expect(first).toMatchObject({ cacheStatus: 'fresh', locale: 'zh-CN' })
    expect(second).toMatchObject({ cacheStatus: 'cached', locale: 'zh-CN', scanKey: first?.scanKey })
  })

  it('fails closed and revokes old cursors before rebuilding an expired complete index', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const secondItem = {
      ...rawCatalog.packages[0]!,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const getJson = vi.fn()
      .mockResolvedValueOnce({
        value: { ...rawCatalog, packages: [...rawCatalog.packages, secondItem] },
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
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

  it('revokes media and the complete index when a source is invalidated', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
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
      finalUrl: 'https://deepseek1024.com/api/v1/plugins',
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
      ...rawCatalog.packages[0]!,
      id: 'anywhere-labs/second-plugin',
      name: 'second-plugin',
      url: 'https://github.com/anywhere-labs/second-plugin',
    }
    const completeCatalog = { ...rawCatalog, packages: [...rawCatalog.packages, secondItem] }
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: completeCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
      .mockResolvedValueOnce({ value: completeCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
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
  it('normalizes legacy multi-enabled settings to the first source by order', async () => {
    const first = source()
    const second = source({
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      order: 1,
    })
    const scope = {
      get: () => ({ sources: [second, first] }),
      update: vi.fn(),
    } as unknown as SettingsScope<MarketSettingsDocument>

    const records = await new SettingsCatalogSourceStore(scope).load()

    expect(records.map(record => [record.sourceRecordId, record.enabled])).toEqual([
      [first.sourceRecordId, true],
      [second.sourceRecordId, false],
    ])
  })

  it('preserves an explicit no-selection state in legacy settings', async () => {
    const first = { ...source(), enabled: false }
    const second = source({
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      enabled: false,
      order: 1,
    })
    const scope = {
      get: () => ({ sources: [second, first] }),
      update: vi.fn(),
    } as unknown as SettingsScope<MarketSettingsDocument>

    const records = await new SettingsCatalogSourceStore(scope).load()

    expect(records.map(record => [record.sourceRecordId, record.enabled])).toEqual([
      [first.sourceRecordId, false],
      [second.sourceRecordId, false],
    ])
  })

  it('retains source disclosure without implicitly selecting the first configured source', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    let document: MarketSettingsDocument = { sources: [] }
    const scope = {
      get: () => document,
      update: async (patch: { sources: readonly LocalSourceRecord[] }) => { document = { sources: patch.sources } },
    } as unknown as SettingsScope<MarketSettingsDocument>
    const readManifest = vi.fn(async () => manifest)
    const mutate = createMarketSourceMutator(scope, undefined, readManifest)

    await mutate(
      { action: 'add-standard', manifestUrl: 'https://plugins.example.org/catalog-source.json' },
      new AbortController().signal,
    )

    expect(document.sources[0]).toMatchObject({
      providerId: manifest.providerId,
      manifest,
      enabled: false,
    })
    const service = new DefaultCatalogService({ load: async () => document.sources }, restrictedHttpClient)
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
    let document: MarketSettingsDocument = { sources: [] }
    const scope = {
      get: () => document,
      update: async (patch: { sources: readonly LocalSourceRecord[] }) => { document = { sources: patch.sources } },
    } as unknown as SettingsScope<MarketSettingsDocument>
    const mutate = createMarketSourceMutator(scope)

    await mutate({ action: 'add-builtin', key: DSH_1024STORE_KEY }, new AbortController().signal)
    await mutate({ action: 'add-builtin', key: DSHFIND_KEY }, new AbortController().signal)

    expect(document.sources).toEqual([
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
    expect(document.sources).toHaveLength(2)
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
    let document: MarketSettingsDocument = { sources: [first, second] }
    let releaseFirst: (() => void) | undefined
    const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve })
    const update = vi.fn(async (patch: { sources: readonly LocalSourceRecord[] }) => {
      if (update.mock.calls.length === 1) await firstWrite
      document = { sources: patch.sources.map(record => ({ ...record })) }
    })
    const scope = {
      get: () => document,
      update,
    } as unknown as SettingsScope<MarketSettingsDocument>
    const mutate = createMarketSourceMutator(scope)

    const one = mutate({ action: 'select', sourceRecordId: first.sourceRecordId }, new AbortController().signal)
    const two = mutate({ action: 'select', sourceRecordId: second.sourceRecordId }, new AbortController().signal)
    await vi.waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
    releaseFirst?.()
    await Promise.all([one, two])

    expect(update).toHaveBeenCalledTimes(2)
    expect(document.sources.map(record => record.enabled)).toEqual([false, true])
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
    let document: MarketSettingsDocument = { sources: [first, second, third] }
    const scope = {
      get: () => document,
      update: async (patch: { sources: readonly LocalSourceRecord[] }) => {
        document = { sources: patch.sources }
      },
    } as unknown as SettingsScope<MarketSettingsDocument>
    const mutate = createMarketSourceMutator(scope)

    await mutate(
      { action: 'move', sourceRecordId: third.sourceRecordId, direction: 'up' },
      new AbortController().signal,
    )
    await mutate(
      { action: 'remove', sourceRecordId: first.sourceRecordId },
      new AbortController().signal,
    )

    expect(document.sources.map(record => [record.providerId, record.order, record.enabled])).toEqual([
      ['fixture.third', 0, false],
      ['fixture.second', 1, false],
    ])
  })

  it('rejects an aborted mutation before it reaches the serialized write', async () => {
    const record = { ...source(), enabled: false }
    let document: MarketSettingsDocument = { sources: [record] }
    let releaseFirst: (() => void) | undefined
    const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve })
    const update = vi.fn(async (patch: { sources: readonly LocalSourceRecord[] }) => {
      await firstWrite
      document = { sources: patch.sources }
    })
    const scope = { get: () => document, update } as unknown as SettingsScope<MarketSettingsDocument>
    const mutate = createMarketSourceMutator(scope)
    const first = mutate({ action: 'select', sourceRecordId: record.sourceRecordId }, new AbortController().signal)
    await vi.waitFor(() => { expect(update).toHaveBeenCalledOnce() })
    const queued = new AbortController()
    const second = mutate({ action: 'select', sourceRecordId: record.sourceRecordId }, queued.signal)
    queued.abort()
    releaseFirst?.()

    await first
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(update).toHaveBeenCalledOnce()
    expect(document.sources[0]?.enabled).toBe(true)
  })

  it('selects one source atomically and revokes the previous active source after persistence', async () => {
    const current = source()
    const replacement = source({
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      enabled: false,
      order: 1,
    })
    let document: MarketSettingsDocument = { sources: [current, replacement] }
    const events: string[] = []
    const scope = {
      get: () => document,
      update: async (patch: { sources: readonly LocalSourceRecord[] }) => {
        document = { sources: patch.sources }
        events.push('saved')
      },
    } as unknown as SettingsScope<MarketSettingsDocument>
    const onUnavailable = vi.fn((sourceRecordId: string) => { events.push(`revoked:${sourceRecordId}`) })
    const mutate = createMarketSourceMutator(scope, onUnavailable)

    await mutate({ action: 'select', sourceRecordId: replacement.sourceRecordId }, new AbortController().signal)

    expect(document.sources.map(record => record.enabled)).toEqual([false, true])
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
    let document: MarketSettingsDocument = { sources: [current, replacement] }
    const onUnavailable = vi.fn()
    const scope = {
      get: () => document,
      update: async (patch: { sources: readonly LocalSourceRecord[] }) => { document = { sources: patch.sources } },
    } as unknown as SettingsScope<MarketSettingsDocument>
    const mutate = createMarketSourceMutator(scope, onUnavailable)

    await mutate({ action: 'remove', sourceRecordId: current.sourceRecordId }, new AbortController().signal)

    expect(document.sources).toEqual([{ ...replacement, enabled: false, order: 0 }])
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
    const update = vi.fn()
    const scope = {
      get: () => ({ sources: [] }),
      update,
    } as unknown as SettingsScope<MarketSettingsDocument>
    const dispose = registerMarketRoutes(ctx as never, scope)
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

    expect(update).not.toHaveBeenCalled()
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
      body: Buffer.from('{"packages":[]}'),
      headers: { 'content-type': 'application/json' },
      statusCode: 200,
    }))
    const trusted = createRestrictedHttpClient({
      syntheticProxyHostnames: ['deepseek1024.com'],
      lookupAddresses,
      request,
    })

    await expect(trusted.getJson(
      'https://deepseek1024.com/api/v1/plugins',
      new AbortController().signal,
    )).resolves.toMatchObject({ value: { packages: [] } })
    expect(request).toHaveBeenCalledOnce()

    const strict = createRestrictedHttpClient({ lookupAddresses, request })
    await expect(strict.getJson(
      'https://deepseek1024.com/api/v1/plugins',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
    await expect(trusted.getJson(
      'https://deepseek1024.com.attacker.example/api/v1/plugins',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
    await expect(trusted.getJson(
      'https://198.18.0.38/api/v1/plugins',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
  })

  it('caches a completed fixed-catalog response and collapses concurrent reads', async () => {
    let now = 1_000
    let release: ((value: { value: object; finalUrl: string }) => void) | undefined
    const pending = new Promise<{ value: object; finalUrl: string }>(resolve => { release = resolve })
    const delegate: CatalogHttpClient = { getJson: vi.fn(async () => await pending) }
    const client = createCachedCatalogHttpClient(delegate, { ttlMs: 300_000, now: () => now })
    const first = client.getJson('https://deepseek1024.com/api/v1/plugins', new AbortController().signal)
    const second = client.getJson('https://deepseek1024.com/api/v1/plugins', new AbortController().signal)

    expect(delegate.getJson).toHaveBeenCalledOnce()
    release?.({ value: { packages: [] }, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    await client.getJson('https://deepseek1024.com/api/v1/plugins', new AbortController().signal)
    expect(delegate.getJson).toHaveBeenCalledOnce()

    now += 300_001
    const refreshed = client.getJson('https://deepseek1024.com/api/v1/plugins', new AbortController().signal)
    expect(delegate.getJson).toHaveBeenCalledTimes(2)
    await expect(refreshed).resolves.toMatchObject({ value: { packages: [] } })
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
    const first = client.getJson('https://deepseek1024.com/api/v1/plugins', firstController.signal)
    const second = client.getJson('https://deepseek1024.com/api/v1/plugins', secondController.signal)
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
    const abandoned = client.getJson('https://deepseek1024.com/api/v1/plugins', abandonedController.signal)
    const abandonedResult = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    abandonedController.abort()
    await abandonedResult

    const replacement = client.getJson('https://deepseek1024.com/api/v1/plugins', new AbortController().signal)
    expect(delegate.getJson).toHaveBeenCalledTimes(2)
    releases[0]?.({ value: { revision: 'abandoned' }, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
    releases[1]?.({ value: { revision: 'replacement' }, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
    await expect(replacement).resolves.toMatchObject({ value: { revision: 'replacement' } })
    await expect(client.getJson(
      'https://deepseek1024.com/api/v1/plugins',
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
