import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'
import {
  SettingsCatalogSourceStore,
  type MarketSettingsDocument,
} from '../src/catalog/source-store.js'
import type { LocalSourceRecord } from '../src/contracts/index.js'

const source: LocalSourceRecord = {
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'user-added',
  adapterId: 'market.standard-http-v1',
  providerId: 'org.example.community-catalog',
  manifestUrl: 'https://plugins.example.org/catalog-source.json',
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
})
