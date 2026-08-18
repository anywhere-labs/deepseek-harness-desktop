import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { standardHttpAdapter } from '../src/adapters/standard-http.js'
import type {
  CatalogHttpClient,
  CatalogSourceManifest,
  LocalSourceRecord,
} from '../src/contracts/index.js'

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as unknown
}

const manifest = fixture('../docs/examples/catalog-source.example.json') as CatalogSourceManifest
const assetRef = 'mktimg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const source: LocalSourceRecord = {
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'user-added',
  adapterId: standardHttpAdapter.adapterId,
  providerId: 'org.example.community-catalog',
  manifestUrl: 'https://plugins.example.org/catalog-source.json',
  manifest,
  enabled: true,
  order: 0,
}

describe('standard HTTP catalog adapter', () => {
  it('loads the source manifest before requesting its declared catalog query', async () => {
    const getJson = vi.fn<CatalogHttpClient['getJson']>()
      .mockResolvedValueOnce({
        value: fixture('../docs/examples/catalog-source.example.json'),
        finalUrl: source.manifestUrl!,
      })
      .mockResolvedValueOnce({
        value: fixture('../docs/examples/catalog-provider-page.example.json'),
        finalUrl: 'https://plugins.example.org/v1/plugins?q=sidebar&category=interface&limit=50',
      })

    await standardHttpAdapter.fetch({
      q: ' sidebar ',
      category: ['interface'],
      limit: 80,
      sort: 'updated',
      locale: 'zh-CN',
    }, {
      source,
      signal: new AbortController().signal,
      http: { getJson },
      media: { register: vi.fn(() => assetRef) },
    })

    expect(getJson).toHaveBeenCalledTimes(2)
    expect(getJson.mock.calls[0]).toEqual([
      source.manifestUrl,
      expect.any(AbortSignal),
      { allowedOrigin: 'https://plugins.example.org' },
    ])
    const catalogUrl = new URL(getJson.mock.calls[1]![0])
    expect(catalogUrl.origin + catalogUrl.pathname).toBe('https://plugins.example.org/v1/plugins')
    expect(Object.fromEntries(catalogUrl.searchParams)).toEqual({
      q: 'sidebar',
      category: 'interface',
      limit: '50',
    })
    expect(getJson.mock.calls[1]?.[2]).toEqual({ allowedOrigin: 'https://plugins.example.org' })
  })

  it('projects provider metadata and binds every item to its local source', async () => {
    const finalUrl = 'https://plugins.example.org/v1/plugins?cursor=page_1'
    const register = vi.fn(() => assetRef)
    const getJson = vi.fn<CatalogHttpClient['getJson']>()
      .mockResolvedValueOnce({
        value: fixture('../docs/examples/catalog-source.example.json'),
        finalUrl: source.manifestUrl!,
      })
      .mockResolvedValueOnce({
        value: fixture('../docs/examples/catalog-provider-page.example.json'),
        finalUrl,
      })

    const snapshot = await standardHttpAdapter.fetch({}, {
      source,
      signal: new AbortController().signal,
      http: { getJson },
      media: { register },
    })

    expect(snapshot.source).toMatchObject({
      sourceRecordId: source.sourceRecordId,
      providerId: source.providerId,
      adapterId: standardHttpAdapter.adapterId,
      registrationKind: 'user-added',
      finalUrl,
      providerGeneratedAt: '2026-08-17T08:00:00Z',
      providerRevision: '2026-08-17T08:00:00Z',
    })
    expect(snapshot.items[0]).toMatchObject({
      id: 'better-sidebar',
      provenance: {
        sourceRecordId: source.sourceRecordId,
        providerId: source.providerId,
        itemId: 'better-sidebar',
      },
      media: {
        icon: {
          assetRef,
          role: 'plugin-icon',
          alt: 'Better Sidebar plugin icon',
        },
      },
    })
    expect(snapshot.page).toEqual({ nextCursor: 'page_2', total: 42 })
    expect(register).toHaveBeenCalledWith({
      remoteUrl: 'https://plugins.example.org/assets/better-sidebar.png',
      role: 'plugin-icon',
      alt: 'Better Sidebar plugin icon',
      sourceRecordId: source.sourceRecordId,
      itemId: 'better-sidebar',
      allowedHostnames: ['plugins.example.org'],
    })
  })

  it('rejects a provider response that leaves the registered source origin', async () => {
    const getJson = vi.fn<CatalogHttpClient['getJson']>()
      .mockResolvedValueOnce({
        value: manifest,
        finalUrl: source.manifestUrl!,
      })
      .mockResolvedValueOnce({
        value: fixture('../docs/examples/catalog-provider-page.example.json'),
        finalUrl: 'https://cdn.plugins.example.org/catalog/page-1.json',
      })

    await expect(standardHttpAdapter.fetch({}, {
      source,
      signal: new AbortController().signal,
      http: { getJson },
      media: { register: vi.fn(() => assetRef) },
    })).rejects.toThrow(/changed the registered source origin/u)
  })
})
