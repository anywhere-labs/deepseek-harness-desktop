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

const baseItem = {
  id: 'omdsh-dev/DSH-better-sidebar',
  name: 'DSH Better Sidebar',
  owner: 'omdsh-dev',
  url: 'https://github.com/omdsh-dev/DSH-better-sidebar',
  category: 'ui',
  description: { en: 'A better sidebar.' },
}

async function adapt(installMethods: readonly unknown[], itemOverrides: Record<string, unknown> = {}) {
  const http: CatalogHttpClient = {
    getJson: vi.fn(async () => ({
      value: {
        meta: { revision: 'sha256:fixture' },
        packages: [{ ...baseItem, ...itemOverrides, installMethods }],
      },
      finalUrl: 'https://deepseek1024.com/api/v1/plugins',
    })),
  }
  return await dsh1024StoreAdapter.fetch({}, {
    source,
    signal: new AbortController().signal,
    http,
    media: { register: () => 'mktimg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  })
}

describe('1024Store install target normalization', () => {
  it('projects one reviewed exact npm target without exposing the provider command', async () => {
    const snapshot = await adapt([{
      kind: 'npm',
      spec: 'dsh-better-sidebar',
      command: 'dsh plugin --profile web add attacker-controlled-text',
      verification: 'verified',
      code: 'repository_backlink',
      requiresBuildAllowance: false,
      revision: '0.12.3',
    }])

    expect(snapshot.items[0]).toMatchObject({
      latestVersion: '0.12.3',
      package: { registry: 'npm', name: 'dsh-better-sidebar' },
    })
    expect(JSON.stringify(snapshot)).not.toContain('attacker-controlled-text')
  })

  it.each([
    ['unverified', { verification: 'unverified' }],
    ['wrong verification code', { code: 'unlinked_package' }],
    ['build allowance required', { requiresBuildAllowance: true }],
    ['mutable GitHub target', { kind: 'github', spec: 'github:omdsh-dev/DSH-better-sidebar', revision: null }],
    ['prerelease version', { revision: '0.13.0-rc.1' }],
    ['tag instead of version', { revision: 'latest' }],
  ] as const)('does not expose an install identity for a %s method', async (_label, overrides) => {
    const snapshot = await adapt([{
      kind: 'npm',
      spec: 'dsh-better-sidebar',
      verification: 'verified',
      code: 'repository_backlink',
      requiresBuildAllowance: false,
      revision: '0.12.3',
      ...overrides,
    }])

    expect(snapshot.items[0]).not.toHaveProperty('package')
    expect(snapshot.items[0]).not.toHaveProperty('latestVersion')
  })

  it('rejects ambiguous reviewed npm targets instead of choosing one', async () => {
    const snapshot = await adapt([
      {
        kind: 'npm',
        spec: 'dsh-better-sidebar',
        verification: 'verified',
        code: 'repository_backlink',
        requiresBuildAllowance: false,
        revision: '0.12.3',
      },
      {
        kind: 'npm',
        spec: 'another-package',
        verification: 'verified',
        code: 'repository_backlink',
        requiresBuildAllowance: false,
        revision: '1.0.0',
      },
    ])

    expect(snapshot.items[0]).not.toHaveProperty('package')
    expect(snapshot.items[0]).not.toHaveProperty('latestVersion')
  })

  it('accepts duplicate evidence for the same reviewed npm target without treating it as ambiguity', async () => {
    const snapshot = await adapt([
      {
        kind: 'npm',
        spec: 'dsh-better-sidebar',
        verification: 'verified',
        code: 'repository_backlink',
        requiresBuildAllowance: false,
        revision: '0.12.3',
      },
      {
        kind: 'npm',
        spec: 'dsh-better-sidebar',
        command: 'still ignored',
        verification: 'verified',
        code: 'repository_backlink',
        requiresBuildAllowance: false,
        revision: '0.12.3',
      },
    ])

    expect(snapshot.items[0]).toMatchObject({
      latestVersion: '0.12.3',
      package: { registry: 'npm', name: 'dsh-better-sidebar' },
    })
    expect(JSON.stringify(snapshot)).not.toContain('still ignored')
  })

  it.each([
    ['non-GitHub repository', { url: 'https://gitlab.example/omdsh-dev/DSH-better-sidebar' }],
    ['repository with extra path segments', { url: 'https://github.com/omdsh-dev/DSH-better-sidebar/releases' }],
    ['repository with credentials', { url: 'https://user@github.com/omdsh-dev/DSH-better-sidebar' }],
    ['repository with query text', { url: 'https://github.com/omdsh-dev/DSH-better-sidebar?tab=readme' }],
    ['control character in item id', { id: 'omdsh-dev/DSH-better-sidebar\u0000hidden' }],
  ] as const)('drops a catalog item with %s', async (_label, itemOverrides) => {
    const snapshot = await adapt([{
      kind: 'npm',
      spec: 'dsh-better-sidebar',
      verification: 'verified',
      code: 'repository_backlink',
      requiresBuildAllowance: false,
      revision: '0.12.3',
    }], itemOverrides)

    expect(snapshot.items).toEqual([])
    expect(snapshot.page).toEqual({ total: 0 })
  })

  it('scans the full normalized catalog beyond discovery page one with one registry read', async () => {
    const packages = Array.from({ length: 205 }, (_, index) => {
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
        installMethods: index % 4 === 0
          ? []
          : [{
              kind: 'npm',
              spec: `dsh-plugin-${suffix}`,
              command: `ignored provider command ${suffix}`,
              verification: 'verified',
              code: 'repository_backlink',
              requiresBuildAllowance: false,
              revision: `1.0.${index}`,
            }],
      }
    })
    const response = {
      value: {
        meta: { generatedAt: '2026-08-18T00:00:00.000Z', revision: 'sha256:scan-fixture' },
        packages,
      },
      finalUrl: 'https://deepseek1024.com/api/v1/plugins',
    }
    const discoveryHttp: CatalogHttpClient = { getJson: vi.fn(async () => response) }
    const discovery = await dsh1024StoreAdapter.fetch({ limit: 100 }, {
      source,
      signal: new AbortController().signal,
      http: discoveryHttp,
      media: { register: () => 'mktimg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    })
    expect(discovery.items).toHaveLength(50)
    expect(discovery.items.map(item => item.id)).not.toContain('example/plugin-150')

    const getJson = vi.fn(async () => response)
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
      'https://deepseek1024.com/api/v1/plugins',
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
      latestVersion: '1.0.150',
      package: { registry: 'npm', name: 'dsh-plugin-150' },
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
    expect(items[152]).toMatchObject({
      id: 'example/plugin-152',
      summary: '插件 152 摘要。',
      categories: ['tools'],
      repository: { url: 'https://github.com/example/plugin-152' },
    })
    expect(items[152]).not.toHaveProperty('package')
    expect(items[152]).not.toHaveProperty('latestVersion')
    expect(items[152]).not.toHaveProperty('media')
    expect(JSON.stringify(items)).not.toContain('ignored provider command')
    expect(register).toHaveBeenCalledTimes(153)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      remoteUrl: 'https://github.com/example.png?size=96',
      role: 'publisher-avatar',
      sourceRecordId: source.sourceRecordId,
      allowedHostnames: ['github.com', 'avatars.githubusercontent.com'],
    }))
  })
})
