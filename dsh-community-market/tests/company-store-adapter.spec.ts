/**
 * Drop into dsh-community-market/tests/company-store-adapter.spec.ts
 *
 * Mirrors official dsh-1024store adapter coverage for the company built-in.
 * Uses fixtures/plugins-api.installable.json from this patch directory
 * (copy to tests/fixtures/ when applying).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  COMPANY_STORE_ADAPTER_ID,
  COMPANY_STORE_ENDPOINT,
  COMPANY_STORE_HOSTNAME,
  COMPANY_STORE_KEY,
  COMPANY_STORE_PROVIDER_ID,
  companyStoreAdapter,
} from '../src/adapters/company-store.js'
import { DSH_1024STORE_KEY } from '../src/adapters/dsh-1024store.js'
import type { CatalogHttpClient, LocalSourceRecord } from '../src/contracts/types.js'

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/plugins-api.installable.json', import.meta.url), 'utf8'),
) as {
  packages: unknown[]
  meta: Record<string, unknown>
  name: string
}

const source = (overrides: Partial<LocalSourceRecord> = {}): LocalSourceRecord => ({
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120099',
  registrationKind: 'built-in',
  adapterId: COMPANY_STORE_ADAPTER_ID,
  providerId: COMPANY_STORE_PROVIDER_ID,
  builtInProviderKey: COMPANY_STORE_KEY,
  enabled: true,
  order: 0,
  ...overrides,
})

function httpClient(value: unknown, finalUrl = COMPANY_STORE_ENDPOINT): CatalogHttpClient {
  return {
    async getJson(url, _signal, policy = {}) {
      const requested = new URL(url)
      const expected = new URL(COMPANY_STORE_ENDPOINT)
      expect(requested.origin).toBe(expected.origin)
      expect(requested.pathname).toBe(expected.pathname)
      if (policy.allowedOrigin !== undefined) {
        expect(policy.allowedOrigin).toBe(expected.origin)
      }
      return { value, finalUrl }
    },
  }
}

const media = {
  register: vi.fn(() => {
    throw new Error('media unavailable in unit fixture')
  }),
  unregisterSource() {},
}

describe('company-store adapter', () => {
  it('does not collide with the official built-in key', () => {
    expect(COMPANY_STORE_KEY).toBe('company-store')
    expect(COMPANY_STORE_KEY).not.toBe(DSH_1024STORE_KEY)
    expect(COMPANY_STORE_HOSTNAME).toBe('plugins.company.example')
    expect(COMPANY_STORE_ADAPTER_ID).toBe('market.company-store-v1')
  })

  it('pins origin and pages installable npm targets from the Store wire shape', async () => {
    const snapshot = await companyStoreAdapter.fetch({ limit: 50 }, {
      signal: new AbortController().signal,
      source: source(),
      http: httpClient({
        name: fixture.name,
        meta: { ...fixture.meta, total: fixture.packages.length },
        packages: fixture.packages,
      }),
      media,
    })

    expect(snapshot.source.providerId).toBe(COMPANY_STORE_PROVIDER_ID)
    expect(snapshot.source.adapterId).toBe(COMPANY_STORE_ADAPTER_ID)
    expect(snapshot.items.length).toBeGreaterThan(0)
    const installable = snapshot.items.find(item => item.package?.registry === 'npm')
    expect(installable?.package?.name).toMatch(/^[a-z0-9@]/)
    expect(installable?.latestVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(installable?.repository?.url).toMatch(/^https:\/\/github\.com\//)
  })

  it('filters by q and rejects origin changes', async () => {
    const needle = (fixture.packages[0] as { name: string }).name
    const hit = await companyStoreAdapter.fetch({ q: needle, limit: 10 }, {
      signal: new AbortController().signal,
      source: source(),
      http: httpClient({
        meta: { total: fixture.packages.length },
        packages: fixture.packages,
      }),
      media,
    })
    expect(hit.items.every(item =>
      [item.id, item.displayName, item.summary].join('\n').toLowerCase().includes(needle.toLowerCase()),
    )).toBe(true)

    await expect(companyStoreAdapter.fetch({}, {
      signal: new AbortController().signal,
      source: source(),
      http: httpClient({ packages: [], meta: { total: 0 } }, 'https://evil.example/api/v1/plugins'),
      media,
    })).rejects.toThrow(/origin/i)
  })

  it('keeps browse-only github packages without npm package identity', async () => {
    const browseOnly = {
      id: 'anweat/dsh-restart',
      name: 'dsh-restart',
      owner: 'anweat',
      url: 'https://github.com/anweat/dsh-restart',
      category: 'fun',
      description: { en: 'Restart DSH', zh: '重启' },
      added: '2026-08-14',
      installMethods: [{
        kind: 'github',
        spec: 'github:anweat/dsh-restart',
        command: 'dsh plugin --profile web add github:anweat/dsh-restart',
        verification: 'unverified',
        code: 'entry_missing_no_prepare',
        requiresBuildAllowance: false,
        revision: null,
      }],
    }
    const snapshot = await companyStoreAdapter.fetch({}, {
      signal: new AbortController().signal,
      source: source(),
      http: httpClient({ packages: [browseOnly], meta: { total: 1 } }),
      media,
    })
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]?.package).toBeUndefined()
    expect(snapshot.items[0]?.repository?.url).toBe('https://github.com/anweat/dsh-restart')
  })
})
