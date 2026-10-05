import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyScopedCatalogCursor,
  catalogIdentityChoices,
  CatalogContractError,
  normalizeCatalogQuery,
  normalizeGitHubInstallSource,
  normalizeRepositoryIdentity,
  parseCatalogProviderPage,
  parseCatalogQuery,
  parseCatalogSnapshot,
  parseCatalogSource,
  scopeCatalogCursor,
  serializeCatalogQuery,
  validateLocalSourceRecords,
  type CatalogProviderPage,
  type CatalogSourceManifest,
  type LocalSourceRecord,
} from '../src/contracts/index.js'

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as unknown
}

const sourceFixture = () => readJson('../docs/examples/catalog-source.example.json')
const queryFixture = () => readJson('../docs/examples/catalog-query.example.json')
const providerFixture = () => readJson('../docs/examples/catalog-provider-page.example.json')
const snapshotFixture = () => readJson('../docs/examples/catalog-snapshot.example.json')

describe('package integration contract', () => {
  it('loads the Client through the official settings, sidebar, and shell features', () => {
    const manifest = readJson('../package.json') as {
      dsh?: { client?: { inject?: string[] } }
      peerDependencies?: Record<string, string>
    }

    expect(manifest.dsh?.client?.inject).toEqual([
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-sidebar',
    ])
    expect(manifest.peerDependencies).toHaveProperty('@deepseek-ai/dsh-client-file-upload', '0.2.0-rc.2 || 0.2.1-alpha.1')
    expect(manifest.peerDependencies).toHaveProperty('@deepseek-ai/dsh-client-ui-layout', '0.2.0-rc.2 || 0.2.1-alpha.1')
    expect(manifest.peerDependencies).toHaveProperty('@deepseek-ai/dsh-client-ui-renderer', '0.2.0-rc.2 || 0.2.1-alpha.1')
    expect(manifest.peerDependencies).toHaveProperty('@deepseek-ai/dsh-client-ui-session', '0.2.0-rc.2 || 0.2.1-alpha.1')
    expect(manifest.peerDependencies).toHaveProperty('@deepseek-ai/dsh-client-ui-settings', '0.2.0-rc.2 || 0.2.1-alpha.1')
    expect(manifest.peerDependencies).toHaveProperty('@deepseek-ai/dsh-client-ui-sidebar', '0.2.0-rc.2 || 0.2.1-alpha.1')
    expect(manifest.peerDependencies).toHaveProperty('@deepseek-ai/dsh-client-ui-workspace', '0.2.0-rc.2 || 0.2.1-alpha.1')
  })

  it('keeps durable storage an optional peer so market still starts without it', () => {
    const manifest = readJson('../package.json') as {
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }

    expect(manifest.peerDependencies).toHaveProperty('@deepseek-ai/dsh-storage-domain', '0.2.0-rc.2 || 0.2.1-alpha.1')
    expect(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh-storage-domain']).toEqual({ optional: true })
    expect(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh-storage']).toEqual({ optional: true })
  })
})

describe('catalog schemas and semantics', () => {
  it('accepts all four reviewed positive fixtures', () => {
    for (const [fixture, parsed] of [
      [sourceFixture(), parseCatalogSource(sourceFixture())],
      [queryFixture(), parseCatalogQuery(queryFixture())],
      [providerFixture(), parseCatalogProviderPage(providerFixture())],
      [snapshotFixture(), parseCatalogSnapshot(snapshotFixture())],
    ]) {
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(fixture)
    }
  })

  it.each([
    ['source', '../tests/fixtures/catalog-source.invalid.json', parseCatalogSource],
    ['query', '../tests/fixtures/catalog-query.invalid.json', parseCatalogQuery],
    ['provider page', '../tests/fixtures/catalog-provider-page.invalid.json', parseCatalogProviderPage],
    ['snapshot', '../tests/fixtures/catalog-snapshot.invalid.json', parseCatalogSnapshot],
  ])('rejects the %s negative fixture', (_label, path, parse) => {
    expect(() => parse(readJson(path))).toThrow(CatalogContractError)
  })

  it('rejects unsupported contract versions and unknown fields', () => {
    expect(() => parseCatalogSource({ ...(sourceFixture() as object), manifestVersion: '2.0.0' }))
      .toThrow(CatalogContractError)
    expect(() => parseCatalogProviderPage({ ...(providerFixture() as object), schemaVersion: '2.0.0' }))
      .toThrow(CatalogContractError)
    expect(() => parseCatalogSnapshot({ ...(snapshotFixture() as object), schemaVersion: '2.0.0' }))
      .toThrow(CatalogContractError)
    expect(() => parseCatalogQuery({ ...(queryFixture() as object), command: 'pnpm add unsafe' }))
      .toThrow(CatalogContractError)
  })

  it('rejects provider pages that exceed the effective query limit', () => {
    expect(() => parseCatalogProviderPage(providerFixture(), 1)).not.toThrow()
    expect(() => parseCatalogProviderPage(providerFixture(), 0)).toThrow(/invalid effective query limit/u)
    expect(() => parseCatalogProviderPage({
      ...(providerFixture() as CatalogProviderPage),
      items: [
        ...(providerFixture() as CatalogProviderPage).items,
        { ...(providerFixture() as CatalogProviderPage).items[0]!, id: 'another-plugin' },
      ],
    }, 1)).toThrow(/effective query limit/u)
  })

  it('rejects provider and normalized pages above the 200-item safety cap', () => {
    const provider = providerFixture() as CatalogProviderPage
    const providerItems = Array.from({ length: 201 }, (_, index) => ({
      ...provider.items[0]!,
      id: `provider-plugin-${index}`,
    }))
    expect(() => parseCatalogProviderPage({ ...provider, items: providerItems }))
      .toThrow(CatalogContractError)

    const snapshot = snapshotFixture() as ReturnType<typeof parseCatalogSnapshot>
    const snapshotItems = Array.from({ length: 201 }, (_, index) => ({
      ...snapshot.items[0]!,
      id: `snapshot-plugin-${index}`,
      provenance: {
        ...snapshot.items[0]!.provenance,
        itemId: `snapshot-plugin-${index}`,
      },
    }))
    expect(() => parseCatalogSnapshot({ ...snapshot, items: snapshotItems }))
      .toThrow(CatalogContractError)
  })

  it('accepts a pinned GitHub install source in provider and normalized pages', () => {
    const installSource = {
      kind: 'github',
      commit: '0123456789abcdef0123456789abcdef01234567',
    } as const
    const provider = providerFixture() as CatalogProviderPage
    const providerWithSource = {
      ...provider,
      items: [{ ...provider.items[0]!, installSource }],
    }
    expect(parseCatalogProviderPage(providerWithSource).items[0]?.installSource).toEqual(installSource)

    const snapshot = snapshotFixture() as ReturnType<typeof parseCatalogSnapshot>
    const snapshotWithSource = {
      ...snapshot,
      items: [{ ...snapshot.items[0]!, installSource }],
    }
    expect(parseCatalogSnapshot(snapshotWithSource).items[0]?.installSource).toEqual(installSource)
  })

  it('enforces source limit and sort relationships beyond JSON Schema', () => {
    const source = sourceFixture() as CatalogSourceManifest
    expect(() => parseCatalogSource({
      ...source,
      query: { ...source.query, defaultLimit: 21, maxLimit: 20 },
    })).toThrow(/defaultLimit/u)
    expect(() => parseCatalogSource({
      ...source,
      query: { ...source.query, supported: ['q'], sorts: ['name'] },
    })).toThrow(/sorts/u)
  })
})

describe('catalog query boundary', () => {
  it('normalizes text and the Host default limit without mutating input', () => {
    const input = { q: '  sidebar  ', category: ['interface'] }
    const normalized = normalizeCatalogQuery(input)

    expect(normalized).toEqual({ q: 'sidebar', category: ['interface'], limit: 50 })
    expect(input.q).toBe('  sidebar  ')
  })

  it('serializes the minimal declared fields and omits undeclared extensions', () => {
    const source = parseCatalogSource(sourceFixture())
    const url = serializeCatalogQuery(source, normalizeCatalogQuery({
      q: 'side bar',
      category: ['interface', 'tools'],
      capability: ['ui.panel', 'storage.local'],
      limit: 100,
      sort: 'updated',
      locale: 'zh-CN',
    }))

    expect(url.origin + url.pathname).toBe('https://plugins.example.org/v1/plugins')
    expect(url.searchParams.get('q')).toBe('side bar')
    expect(url.searchParams.getAll('category')).toEqual(['interface', 'tools'])
    expect(url.searchParams.get('limit')).toBe('50')
    expect(url.searchParams.has('capability')).toBe(false)
    expect(url.searchParams.has('sort')).toBe(false)
    expect(url.searchParams.has('locale')).toBe(false)
  })

  it('omits unsupported fields and narrows a supported limit', () => {
    const source = parseCatalogSource(sourceFixture())
    const limited = parseCatalogSource({
      ...source,
      query: { ...source.query, defaultLimit: 5, maxLimit: 5 },
    })
    const url = serializeCatalogQuery(limited, normalizeCatalogQuery({ q: 'plugin', category: ['tools'], limit: 80 }))
    expect(url.searchParams.get('limit')).toBe('5')

    const qOnly = parseCatalogSource({
      ...source,
      query: { supported: ['q'], defaultLimit: 20, maxLimit: 20, sorts: [] },
    })
    const qOnlyUrl = serializeCatalogQuery(qOnly, normalizeCatalogQuery({ q: 'plugin', category: ['tools'] }))
    expect([...qOnlyUrl.searchParams.keys()]).toEqual(['q'])
  })

  it('binds cursors to one source and effective query', () => {
    const query = normalizeCatalogQuery({ q: 'plugin', category: ['tools'] })
    const cursor = scopeCatalogCursor('page_2', 'source-a', query)

    expect(applyScopedCatalogCursor(cursor, 'source-a', query).cursor).toBe('page_2')
    expect(() => applyScopedCatalogCursor(cursor, 'source-b', query)).toThrow(/does not belong/u)
    expect(() => applyScopedCatalogCursor(cursor, 'source-a', normalizeCatalogQuery({ q: 'other' })))
      .toThrow(/does not belong/u)
  })
})

describe('catalog identity and local source records', () => {
  it('canonicalizes repository identity and preserves explicit identity choices', () => {
    expect(normalizeRepositoryIdentity({
      url: 'https://github.com/Example/Plugin.git',
      subdirectory: 'packages/market',
    })).toEqual({
      url: 'https://github.com/example/plugin',
      subdirectory: 'packages/market',
    })

    const item = parseCatalogProviderPage(providerFixture()).items[0] as CatalogProviderPage['items'][number]
    expect(catalogIdentityChoices(item).map(choice => choice.kind)).toEqual(['package', 'repository'])
  })

  it('rejects ambiguous repository paths', () => {
    expect(() => normalizeRepositoryIdentity({
      url: 'https://github.com/example/plugin',
      subdirectory: 'packages//market',
    })).toThrow(CatalogContractError)
    expect(() => normalizeRepositoryIdentity({ url: 'https://github.com/example/plugin/issues' }))
      .toThrow(/exactly owner and repository/u)
  })

  it('accepts pinned GitHub sources only when they match a canonical repository', () => {
    expect(normalizeGitHubInstallSource({
      url: 'https://github.com/Example/Plugin.git',
      subdirectory: 'packages/market',
    }, {
      kind: 'github',
      commit: '0123456789abcdef0123456789abcdef01234567',
    })).toEqual({
      kind: 'github',
      owner: 'example',
      repo: 'plugin',
      commit: '0123456789abcdef0123456789abcdef01234567',
      subdirectory: 'packages/market',
    })

    expect(() => normalizeGitHubInstallSource(
      { url: 'https://github.com/example/plugin' },
      { kind: 'github', commit: 'not-a-commit' },
    )).toThrow(/40-character commit SHA/u)
    expect(() => normalizeGitHubInstallSource(
      { url: 'https://gitlab.example/example/plugin' },
      { kind: 'github', commit: '0123456789abcdef0123456789abcdef01234567' },
    )).toThrow(/GitHub repositories only/u)
    expect(() => normalizeGitHubInstallSource(
      undefined,
      { kind: 'github', commit: '0123456789abcdef0123456789abcdef01234567' },
    )).toThrow(/requires a repository identity/u)
  })

  it('requires one local source location and unique Host identities', () => {
    const record: LocalSourceRecord = {
      sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
      registrationKind: 'user-added',
      adapterId: 'market.standard-v1',
      providerId: 'org.example.catalog',
      manifestUrl: 'https://plugins.example.org/catalog-source.json',
      manifest: {
        ...(sourceFixture() as CatalogSourceManifest),
        providerId: 'org.example.catalog',
      },
      enabled: false,
      order: 0,
    }

    expect(() => validateLocalSourceRecords([record])).not.toThrow()
    const withoutManifest = { ...record }
    delete withoutManifest.manifest
    expect(() => validateLocalSourceRecords([withoutManifest])).toThrow(/manifest is required/u)
    expect(() => validateLocalSourceRecords([{
      ...record,
      manifest: {
        ...record.manifest!,
        transport: { kind: 'https-json', endpoint: 'https://other.example/v1/plugins', method: 'GET' },
      },
    }])).toThrow(/registered manifest origin/u)
    expect(() => validateLocalSourceRecords([record, { ...record }])).toThrow(/duplicates/u)
    expect(() => validateLocalSourceRecords([{
      ...record,
      builtInProviderKey: 'example',
    }])).toThrow(/exactly one/u)
    expect(() => validateLocalSourceRecords([{
      ...record,
      manifestUrl: 'http://127.0.0.1/catalog-source.json',
    }])).toThrow(/credential-free HTTPS/u)
  })
})
