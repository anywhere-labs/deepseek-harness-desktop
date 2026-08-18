import { readFileSync } from 'node:fs'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'
import {
  SettingsCatalogSourceStore,
  type MarketSettingsDocument,
} from '../src/catalog/source-store.js'
import type { CatalogSourceManifest, LocalSourceRecord } from '../src/contracts/index.js'

const manifest = JSON.parse(
  readFileSync(new URL('../docs/examples/catalog-source.example.json', import.meta.url), 'utf8'),
) as CatalogSourceManifest

const source: LocalSourceRecord = {
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'user-added',
  adapterId: 'market.standard-http-v1',
  providerId: 'org.example.community-catalog',
  manifestUrl: 'https://plugins.example.org/catalog-source.json',
  manifest,
  enabled: true,
  order: 0,
}

describe('settings-backed catalog source store', () => {
  it('persists validated source records through the settings scope', async () => {
    let document: MarketSettingsDocument = { sources: [] }
    const update = vi.fn(async (next: MarketSettingsDocument) => { document = next })
    const scope = {
      get: () => document,
      update,
    } as unknown as SettingsScope<MarketSettingsDocument>
    const store = new SettingsCatalogSourceStore(scope)

    await store.save([source])

    expect(update).toHaveBeenCalledWith({ sources: [source] })
    await expect(store.load()).resolves.toEqual([source])
  })

  it('normalizes legacy multi-enabled settings to one selected source', async () => {
    const secondSource: LocalSourceRecord = {
      ...source,
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      order: 1,
    }
    let document: MarketSettingsDocument = { sources: [] }
    const update = vi.fn(async (next: MarketSettingsDocument) => { document = next })
    const scope = {
      get: () => document,
      update,
    } as unknown as SettingsScope<MarketSettingsDocument>
    const store = new SettingsCatalogSourceStore(scope)

    await store.save([source, secondSource])

    expect(update).toHaveBeenCalledWith({
      sources: [source, { ...secondSource, enabled: false }],
    })
    await expect(store.load()).resolves.toEqual([
      source,
      { ...secondSource, enabled: false },
    ])
  })
})
