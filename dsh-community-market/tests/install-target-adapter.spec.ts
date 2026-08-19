import { describe, expect, it, vi } from 'vitest'
import {
  DSH_1024STORE_ADAPTER_ID,
  DSH_1024STORE_KEY,
  DSH_1024STORE_PROVIDER_ID,
  dsh1024StoreAdapter,
} from '../src/adapters/dsh-1024store.js'
import type { CatalogHttpClient, LocalSourceRecord } from '../src/contracts/index.js'

const source: LocalSourceRecord = {
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'built-in',
  adapterId: DSH_1024STORE_ADAPTER_ID,
  providerId: DSH_1024STORE_PROVIDER_ID,
  builtInProviderKey: DSH_1024STORE_KEY,
  enabled: true,
  order: 0,
}

const REQUEST_URL = 'https://deepseek1024.com/api/v2/plugins?limit=100&source=dsh-desktop'

const baseItem = {
  id: 'omdsh-dev/DSH-better-sidebar',
  name: 'DSH Better Sidebar',
  owner: 'omdsh-dev',
  url: 'https://github.com/omdsh-dev/DSH-better-sidebar',
  category: 'ui',
  description: { en: 'A better sidebar.' },
  install: 'dsh plugin --profile web add github:omdsh-dev/DSH-better-sidebar',
}

function registry(plugins: readonly unknown[]): unknown {
  return {
    plugins,
    generatedAt: '2026-08-19T10:42:00.000Z',
  }
}

async function adapt(itemOverrides: Record<string, unknown> = {}) {
  const http: CatalogHttpClient = {
    getJson: vi.fn(async () => ({
      value: registry([{ ...baseItem, ...itemOverrides }]),
      finalUrl: REQUEST_URL,
    })),
  }
  return await dsh1024StoreAdapter.fetch({}, {
    source,
    signal: new AbortController().signal,
    http,
    media: { register: () => 'mktimg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  })
}

describe('1024Store v2 catalog normalization', () => {
  it('projects a browse-only repository item and never exposes the provider install command', async () => {
    const snapshot = await adapt()

    expect(snapshot.items[0]).toMatchObject({
      id: 'omdsh-dev/DSH-better-sidebar',
      repository: { url: 'https://github.com/omdsh-dev/dsh-better-sidebar' },
      publisher: { name: 'omdsh-dev', url: 'https://github.com/omdsh-dev' },
      categories: ['ui'],
      summary: 'A better sidebar.',
    })
    expect(snapshot.items[0]).not.toHaveProperty('package')
    expect(snapshot.items[0]).not.toHaveProperty('latestVersion')
    expect(JSON.stringify(snapshot)).not.toContain('dsh plugin --profile web add')
  })

  it('derives a monorepo subdirectory from the provider item id', async () => {
    const snapshot = await adapt({ id: 'omdsh-dev/DSH-better-sidebar/packages/foo', name: 'foo' })

    expect(snapshot.items[0]).toMatchObject({
      id: 'omdsh-dev/DSH-better-sidebar/packages/foo',
      repository: {
        url: 'https://github.com/omdsh-dev/dsh-better-sidebar',
        subdirectory: 'packages/foo',
      },
    })
  })

  it.each([
    ['non-GitHub repository', { url: 'https://gitlab.example/omdsh-dev/DSH-better-sidebar' }],
    ['repository with extra path segments', { url: 'https://github.com/omdsh-dev/DSH-better-sidebar/releases' }],
    ['repository with credentials', { url: 'https://user@github.com/omdsh-dev/DSH-better-sidebar' }],
    ['repository with query text', { url: 'https://github.com/omdsh-dev/DSH-better-sidebar?tab=readme' }],
    ['control character in item id', { id: 'omdsh-dev/DSH-better-sidebar\u0000hidden' }],
  ] as const)('drops a catalog item with %s', async (_label, itemOverrides) => {
    const snapshot = await adapt(itemOverrides)

    expect(snapshot.items).toEqual([])
    expect(snapshot.page).toEqual({ total: 0 })
  })

  it('rejects a 1024Store response that leaves the reviewed provider origin', async () => {
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: registry([]),
        finalUrl: 'https://deepseek1024.com.evil.example/api/v2/plugins',
      })),
    }
    await expect(dsh1024StoreAdapter.fetch({}, {
      source,
      signal: new AbortController().signal,
      http,
      media: { register: () => 'mktimg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    })).rejects.toThrow(/changed the reviewed provider origin/)
  })

  it('requests the paged v2 endpoint with the desktop source marker and scans chunks of 100', async () => {
    const plugins = Array.from({ length: 205 }, (_, index) => {
      const suffix = String(index).padStart(3, '0')
      return {
        ...baseItem,
        id: `example/plugin-${suffix}`,
        name: `Plugin ${suffix}`,
        owner: 'example',
        url: `https://github.com/example/plugin-${suffix}`,
        category: index % 2 === 0 ? 'tools' : 'ui',
        description: { en: `Plugin ${suffix} summary.`, zh: `插件 ${suffix} 摘要。` },
        stars: 205 - index,
      }
    })
    const getJson = vi.fn(async () => ({
      value: registry(plugins),
      finalUrl: REQUEST_URL,
    }))
    const register = vi.fn(() => 'mktimg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    const snapshots = await dsh1024StoreAdapter.scanCatalog!({ limit: 100, locale: 'zh-CN' }, {
      source,
      signal: new AbortController().signal,
      http: { getJson },
      media: { register },
    })
    const items = snapshots.flatMap(snapshot => snapshot.items)

    expect(getJson).toHaveBeenCalledOnce()
    expect(getJson).toHaveBeenCalledWith(
      REQUEST_URL,
      expect.any(AbortSignal),
      { allowedOrigin: 'https://deepseek1024.com' },
    )
    expect(snapshots.map(snapshot => snapshot.items.length)).toEqual([100, 100, 5])
    expect(snapshots.every(snapshot => snapshot.page.total === 205)).toBe(true)
    expect(items).toHaveLength(205)
    expect([...new Set(items.flatMap(item => item.categories ?? []))].sort()).toEqual(['tools', 'ui'])
    expect(items[150]).toMatchObject({
      id: 'example/plugin-150',
      summary: '插件 150 摘要。',
      categories: ['tools'],
      repository: { url: 'https://github.com/example/plugin-150' },
      media: {
        icon: {
          assetRef: 'mktimg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          role: 'publisher-avatar',
          alt: 'example',
        },
      },
      provenance: {
        sourceRecordId: source.sourceRecordId,
        providerId: source.providerId,
        itemId: 'example/plugin-150',
      },
    })
    expect(items[150]).not.toHaveProperty('package')
    expect(items[150]).not.toHaveProperty('latestVersion')
    expect(JSON.stringify(items)).not.toContain('dsh plugin --profile web add')
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      remoteUrl: 'https://github.com/example.png?size=96',
      role: 'publisher-avatar',
      sourceRecordId: source.sourceRecordId,
      allowedHostnames: ['github.com', 'avatars.githubusercontent.com'],
    }))
  })
})
