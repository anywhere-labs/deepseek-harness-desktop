import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DSH_1024STORE_ADAPTER_ID,
  DSH_1024STORE_ENDPOINT,
  DSH_1024STORE_KEY,
  DSH_1024STORE_PROVIDER_ID,
} from '../src/adapters/dsh-1024store.js'
import {
  DSHFIND_ADAPTER_ID,
  DSHFIND_ENDPOINT,
  DSHFIND_KEY,
  DSHFIND_PROVIDER_ID,
} from '../src/adapters/dshfind.js'
import {
  COMPANY_STORE_ADAPTER_ID,
  COMPANY_STORE_KEY,
  COMPANY_STORE_PROVIDER_ID,
} from '../src/adapters/company-store.js'
import { restrictedHttpClient } from '../src/network/restricted-http.js'
import {
  builtInSource,
  dshfindSource,
  fixture,
  marketRoutes,
  mutateSource,
  readRoute,
  standardManifest,
  standardSource,
  startMarketServer,
  type SharedMarketSettings,
} from './host-routes.helpers.js'

describe('community market Host routes — catalog', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('returns settings-backed source state with built-in provider metadata', async () => {
    const server = await startMarketServer([builtInSource()])
    try {
      const response = await readRoute(server, marketRoutes.state)

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      await expect(response.json()).resolves.toMatchObject({
        sources: [{
          sourceRecordId: builtInSource().sourceRecordId,
          name: 'DSH 1024Store',
          endpoint: DSH_1024STORE_ENDPOINT,
          partnership: true,
          enabled: false,
        }],
        builtIns: [
          {
            key: DSH_1024STORE_KEY,
            providerId: DSH_1024STORE_PROVIDER_ID,
            partnership: true,
          },
          {
            key: DSHFIND_KEY,
            providerId: DSHFIND_PROVIDER_ID,
            endpoint: DSHFIND_ENDPOINT,
            partnership: true,
          },
          {
            key: COMPANY_STORE_KEY,
            providerId: COMPANY_STORE_PROVIDER_ID,
            partnership: true,
          },
        ],
      })
    } finally {
      await server.close()
    }
  })

  it('normalizes catalog query parameters and returns aggregated source results', async () => {
    const activeSource = standardSource({ enabled: true, order: 0 })
    const providerPage = fixture('../docs/examples/catalog-provider-page.example.json') as {
      readonly items: readonly unknown[]
      readonly [key: string]: unknown
    }
    const getJson = vi.spyOn(restrictedHttpClient, 'getJson')
      .mockResolvedValueOnce({
        value: standardManifest,
        finalUrl: activeSource.manifestUrl!,
      })
      .mockResolvedValueOnce({
        value: { ...providerPage, page: { total: 1 } },
        finalUrl: 'https://plugins.example.org/v1/plugins?limit=50',
      })
    const server = await startMarketServer([activeSource])
    try {
      const response = await readRoute(
        server,
        `${marketRoutes.catalog}?q=%20sidebar%20&category=interface&limit=15&sort=updated&locale=zh-CN`,
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({
        query: {
          q: 'sidebar',
          category: ['interface'],
          limit: 15,
          sort: 'updated',
          locale: 'zh-CN',
        },
        results: [{
          source: { sourceRecordId: activeSource.sourceRecordId },
          stale: false,
          snapshot: {
            items: [{
              id: 'better-sidebar',
              provenance: { sourceRecordId: activeSource.sourceRecordId },
            }],
          },
        }],
        categories: ['interface'],
        metadata: {
          scannedAt: expect.any(String),
          expiresAt: expect.any(String),
          providerRevision: '2026-08-17T08:00:00Z',
          cacheStatus: 'fresh',
        },
      })
      expect(body.fetchedAt).toEqual(expect.any(String))
      expect(getJson).toHaveBeenCalledTimes(2)
      expect(getJson).toHaveBeenNthCalledWith(
        1,
        activeSource.manifestUrl,
        expect.any(AbortSignal),
        { allowedOrigin: 'https://plugins.example.org' },
      )
      expect(getJson).toHaveBeenNthCalledWith(
        2,
        'https://plugins.example.org/v1/plugins?limit=50',
        expect.any(AbortSignal),
        { allowedOrigin: 'https://plugins.example.org' },
      )
    } finally {
      await server.close()
    }
  })

  it('serves the persisted first page before a restarted Host refresh completes', async () => {
    const activeSource = standardSource({ enabled: true, order: 0 })
    const providerPage = fixture('../docs/examples/catalog-provider-page.example.json') as {
      readonly items: readonly unknown[]
      readonly [key: string]: unknown
    }
    let requests = 0
    const getJson = vi.spyOn(restrictedHttpClient, 'getJson').mockImplementation(async (_url, signal) => {
      requests += 1
      if (requests === 1) return { value: standardManifest, finalUrl: activeSource.manifestUrl! }
      if (requests === 2) return {
        value: { ...providerPage, page: { total: 1 } },
        finalUrl: 'https://plugins.example.org/v1/plugins?limit=50',
      }
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const settings: SharedMarketSettings = { document: { sources: [activeSource] } }
    const first = await startMarketServer([], settings)
    try {
      const firstResponse = await readRoute(
        first,
        `${marketRoutes.catalog}?sourceRecordId=${activeSource.sourceRecordId}&limit=50&locale=en`,
      )
      expect(firstResponse.status).toBe(200)
      await vi.waitFor(() => expect(settings.document.catalogCache).toBeDefined())
    } finally {
      await first.close()
    }

    const second = await startMarketServer([], settings)
    try {
      const startedAt = Date.now()
      const secondResponse = await readRoute(
        second,
        `${marketRoutes.catalog}?sourceRecordId=${activeSource.sourceRecordId}&limit=50&locale=en`,
      )
      expect(Date.now() - startedAt).toBeLessThan(500)
      expect(secondResponse.status).toBe(200)
      await expect(secondResponse.json()).resolves.toMatchObject({
        results: [{ stale: true, snapshot: { items: [{ id: 'better-sidebar' }] } }],
        metadata: { cacheStatus: 'cached' },
      })
      expect(requests).toBe(2)

      const refreshController = new AbortController()
      const refresh = readRoute(
        second,
        `${marketRoutes.catalog}?sourceRecordId=${activeSource.sourceRecordId}&limit=50&locale=en&refresh=1`,
        refreshController.signal,
      )
      await vi.waitFor(() => expect(requests).toBe(3))
      refreshController.abort()
      await expect(refresh).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await second.close()
      getJson.mockRestore()
    }
  })

  it.each([
    [DSH_1024STORE_KEY, DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_PROVIDER_ID, 'DSH 1024Store'],
    [DSHFIND_KEY, DSHFIND_ADAPTER_ID, DSHFIND_PROVIDER_ID, 'dshfind'],
    [COMPANY_STORE_KEY, COMPANY_STORE_ADAPTER_ID, COMPANY_STORE_PROVIDER_ID, 'Company Store'],
  ] as const)('adds reviewed built-in provider %s as a disabled source', async (key, adapterId, providerId, name) => {
    const server = await startMarketServer([])
    try {
      const response = await mutateSource(server, {
        action: 'add-builtin',
        key,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        sources: [{
          registrationKind: 'built-in',
          adapterId,
          providerId,
          builtInProviderKey: key,
          enabled: false,
          order: 0,
          name,
        }],
      })
    } finally {
      await server.close()
    }
  })
})
