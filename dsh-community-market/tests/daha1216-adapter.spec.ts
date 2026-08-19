import { describe, expect, it, vi } from 'vitest'
import {
  createDaha1216Adapter,
  DAHA1216_ADAPTER_ID,
  DAHA1216_ENDPOINT,
  DAHA1216_KEY,
  DAHA1216_PROVIDER_ID,
} from '../src/adapters/daha1216.js'
import type { CatalogHttpClient, LocalSourceRecord } from '../src/contracts/index.js'

const UPDATED_AT = '2026-08-19'
const FETCHED_AT = new Date('2026-08-19T09:30:00Z')

const source = (): LocalSourceRecord => ({
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120010',
  registrationKind: 'built-in',
  adapterId: DAHA1216_ADAPTER_ID,
  providerId: DAHA1216_PROVIDER_ID,
  builtInProviderKey: DAHA1216_KEY,
  enabled: true,
  order: 0,
})

function rawItem(index: number): Record<string, unknown> {
  return {
    id: `dsh-plugin-${index}`,
    name: `dsh-plugin-${index}`,
    version: '1.2.3',
    description: `Plugin ${index} summary`,
    source: `https://github.com/example/plugin-${index}`,
    // This field is intentionally untrusted and must never reach the snapshot.
    install: `unsafe-command-${index}`,
  }
}

function rawCatalog(items: readonly unknown[] = [rawItem(0), rawItem(1)]): Record<string, unknown> {
  return {
    catalogVersion: '1.0.0',
    updatedAt: UPDATED_AT,
    plugins: items,
  }
}

describe('daha1216 plugin collection adapter', () => {
  it('normalizes the public catalog and keeps GitHub-only entries browse-only', async () => {
    const getJson = vi.fn(async () => ({
      value: rawCatalog(),
      finalUrl: DAHA1216_ENDPOINT,
    }))
    const adapter = createDaha1216Adapter({ now: () => FETCHED_AT })

    const snapshots = await adapter.scanCatalog!({}, {
      source: source(),
      signal: new AbortController().signal,
      http: { getJson },
      media: { register: vi.fn() },
    })

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.source).toMatchObject({
      sourceRecordId: source().sourceRecordId,
      providerId: DAHA1216_PROVIDER_ID,
      adapterId: DAHA1216_ADAPTER_ID,
      registrationKind: 'built-in',
      fetchedAt: FETCHED_AT.toISOString(),
      providerGeneratedAt: '2026-08-19T00:00:00.000Z',
      providerRevision: UPDATED_AT,
    })
    expect(snapshots[0]?.items[0]).toEqual({
      id: 'dsh-plugin-0',
      name: 'dsh-plugin-0',
      displayName: 'dsh-plugin-0',
      summary: 'Plugin 0 summary',
      description: 'Plugin 0 summary | 目录版本：1.2.3',
      homepage: 'https://github.com/example/plugin-0',
      repository: { url: 'https://github.com/example/plugin-0' },
      publisher: { name: 'example', url: 'https://github.com/example' },
      provenance: {
        sourceRecordId: source().sourceRecordId,
        providerId: DAHA1216_PROVIDER_ID,
        itemId: 'dsh-plugin-0',
      },
    })
    expect(JSON.stringify(snapshots)).not.toContain('unsafe-command')
    expect(JSON.stringify(snapshots)).not.toContain('package')
    expect(getJson).toHaveBeenCalledWith(
      DAHA1216_ENDPOINT,
      expect.any(AbortSignal),
      { allowedOrigin: 'https://raw.githubusercontent.com' },
    )
  })

  it('rejects a response that changes the reviewed origin', async () => {
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: rawCatalog(),
        finalUrl: 'https://attacker.example/plugins.json',
      })),
    }
    const adapter = createDaha1216Adapter()

    await expect(adapter.scanCatalog!({}, {
      source: source(),
      signal: new AbortController().signal,
      http,
      media: { register: vi.fn() },
    })).rejects.toThrow(/reviewed provider origin/u)
  })

  it('rejects malformed items and duplicate IDs', async () => {
    const adapter = createDaha1216Adapter()
    const context = {
      source: source(),
      signal: new AbortController().signal,
      media: { register: vi.fn() },
    }
    const malformed: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: rawCatalog([{ ...rawItem(0), source: 'https://example.com/plugin' }]),
        finalUrl: DAHA1216_ENDPOINT,
      })),
    }
    await expect(adapter.scanCatalog!({}, { ...context, http: malformed })).rejects.toThrow(/repository is invalid/u)

    const duplicate: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: rawCatalog([rawItem(0), rawItem(0)]),
        finalUrl: DAHA1216_ENDPOINT,
      })),
    }
    await expect(adapter.scanCatalog!({}, { ...context, http: duplicate })).rejects.toThrow(/duplicate item IDs/u)
  })

  it('rejects an invalid catalog root and supports cancellation', async () => {
    const adapter = createDaha1216Adapter()
    const invalid: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: { catalogVersion: '2.0.0', plugins: [] },
        finalUrl: DAHA1216_ENDPOINT,
      })),
    }
    await expect(adapter.scanCatalog!({}, {
      source: source(),
      signal: new AbortController().signal,
      http: invalid,
      media: { register: vi.fn() },
    })).rejects.toThrow(/catalog is invalid/u)

    const controller = new AbortController()
    controller.abort()
    const cancelled: CatalogHttpClient = {
      getJson: vi.fn(async () => {
        throw new Error('request should not run')
      }),
    }
    await expect(adapter.scanCatalog!({}, {
      source: source(),
      signal: controller.signal,
      http: cancelled,
      media: { register: vi.fn() },
    })).rejects.toBeDefined()
    expect(cancelled.getJson).not.toHaveBeenCalled()
  })
})
