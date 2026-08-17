import { describe, expect, it, vi } from 'vitest'
import { dsh1024StoreAdapter, DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_KEY, DSH_1024STORE_PROVIDER_ID } from '../src/adapters/dsh-1024store.js'
import { DefaultCatalogService } from '../src/catalog/service.js'
import { MemoryCatalogSourceStore } from '../src/catalog/source-store.js'
import type { CatalogHttpClient, LocalSourceRecord } from '../src/contracts/index.js'
import { marketMutationAllowed } from '../src/host/routes.js'
import {
  CatalogNetworkError,
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

const rawPage = {
  query: 'plugin',
  page: 1,
  limit: 20,
  sortBy: 'stars',
  total: 1,
  totalPages: 1,
  results: [{
    id: 'anywhere-labs/deepseek-harness-desktop/dsh-plugin-desktop',
    name: 'deepseek-harness-desktop',
    owner: 'anywhere-labs',
    url: 'https://github.com/anywhere-labs/deepseek-harness-desktop',
    category: 'dev',
    description: { en: 'Desktop shell', zh: '桌面外壳' },
    pushedAt: '2026-08-17T05:45:19Z',
    install: 'dsh plugin --profile web add unsafe-value-that-must-be-ignored',
  }],
}

describe('1024Store adapter', () => {
  it('projects reviewed fields and never forwards remote install strings', async () => {
    const http: CatalogHttpClient = { getJson: vi.fn(async () => ({ value: rawPage, finalUrl: 'https://api.deepseek1024.com/v1/plugins/search?q=plugin' })) }
    const snapshot = await dsh1024StoreAdapter.fetch({}, { source: source(), signal: new AbortController().signal, http })

    expect(snapshot.items[0]).toMatchObject({
      id: rawPage.results[0]!.id,
      repository: {
        url: 'https://github.com/anywhere-labs/deepseek-harness-desktop',
        subdirectory: 'dsh-plugin-desktop',
      },
      provenance: { sourceRecordId: source().sourceRecordId },
    })
    expect(JSON.stringify(snapshot)).not.toContain('unsafe-value')
  })
})

describe('catalog aggregation', () => {
  it('performs zero network requests with no enabled sources', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([{ ...source(), enabled: false }])
    const http: CatalogHttpClient = { getJson: vi.fn() }
    const service = new DefaultCatalogService(store, http)

    await expect(service.fetch({}, new AbortController().signal)).resolves.toEqual([])
    expect(http.getJson).not.toHaveBeenCalled()
  })

  it('keeps successful source results when another source fails', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([
      source(),
      source({ sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003', order: 1 }),
    ])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawPage, finalUrl: 'https://api.deepseek1024.com/v1/plugins/search?q=plugin' })
      .mockRejectedValueOnce(new Error('offline'))
    const service = new DefaultCatalogService(store, { getJson })
    const results = await service.fetch({}, new AbortController().signal)

    expect(results).toHaveLength(2)
    expect(results[0]?.snapshot?.items).toHaveLength(1)
    expect(results[1]?.error).toBe('source unavailable')
  })

  it('marks a last-good cache as stale after a later failure', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawPage, finalUrl: 'https://api.deepseek1024.com/v1/plugins/search?q=plugin' })
      .mockRejectedValueOnce(new Error('offline'))
    const service = new DefaultCatalogService(store, { getJson })

    await service.fetch({}, new AbortController().signal)
    const [result] = await service.fetch({}, new AbortController().signal)
    expect(result).toMatchObject({ stale: true, error: 'source unavailable' })
    expect(result?.snapshot?.items).toHaveLength(1)
  })

  it('does not serve a last-good snapshot after its cache TTL expires', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawPage, finalUrl: 'https://api.deepseek1024.com/v1/plugins/search?q=plugin' })
      .mockRejectedValueOnce(new Error('offline'))
    let now = 1_000
    const service = new DefaultCatalogService(store, { getJson }, {
      cacheTtlMs: 60_000,
      now: () => now,
    })

    await service.fetch({}, new AbortController().signal)
    now += 60_001
    const [result] = await service.fetch({}, new AbortController().signal)
    expect(result).toMatchObject({ stale: false, error: 'source unavailable' })
    expect(result?.snapshot).toBeUndefined()
  })
})

describe('source mutation boundary', () => {
  it.each([
    ['127.0.0.1', 'http://127.0.0.1:43120', '127.0.0.1:43120'],
    ['::1', 'http://localhost:43120', 'localhost:43120'],
    ['::ffff:7f00:1', 'http://localhost:43120', 'localhost:43120'],
  ])('allows loopback address %s only with a matching origin', (remoteAddress, origin, host) => {
    expect(marketMutationAllowed({ remoteAddress, origin, host })).toBe(true)
  })

  it.each([
    [undefined, 'http://localhost:43120', 'localhost:43120'],
    ['127.0.0.1', undefined, 'localhost:43120'],
    ['127.0.0.1', 'http://attacker.example', 'localhost:43120'],
    ['104.21.87.154', 'http://localhost:43120', 'localhost:43120'],
  ])('rejects incomplete or non-local mutation context', (remoteAddress, origin, host) => {
    expect(marketMutationAllowed({ remoteAddress, origin, host })).toBe(false)
  })
})

describe('restricted HTTP boundary', () => {
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
