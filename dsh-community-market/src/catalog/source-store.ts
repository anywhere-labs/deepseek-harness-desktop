import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { validateLocalSourceRecords } from '../contracts/validate.js'
import type { CatalogSourceStore, LocalSourceRecord } from '../contracts/types.js'

export interface MarketSettingsDocument {
  readonly sources: readonly LocalSourceRecord[]
}

export class SettingsCatalogSourceStore implements CatalogSourceStore {
  constructor(private readonly scope: SettingsScope<MarketSettingsDocument>) {}

  async load(): Promise<readonly LocalSourceRecord[]> {
    const records = [...this.scope.get().sources]
    validateLocalSourceRecords(records)
    return records
  }

  async save(records: readonly LocalSourceRecord[]): Promise<void> {
    validateLocalSourceRecords(records)
    await this.scope.update({ sources: records })
  }
}

export class MemoryCatalogSourceStore implements CatalogSourceStore {
  private records: readonly LocalSourceRecord[] = []

  async load(): Promise<readonly LocalSourceRecord[]> {
    return this.records
  }

  async save(records: readonly LocalSourceRecord[]): Promise<void> {
    validateLocalSourceRecords(records)
    this.records = records.map(record => ({ ...record }))
  }
}
