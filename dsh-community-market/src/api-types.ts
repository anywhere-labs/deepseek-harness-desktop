import type { CatalogSnapshot } from './contracts/generated/catalog-snapshot.js'
import type { CatalogSourceManifest } from './contracts/generated/catalog-source.js'
import type { LocalSourceRecord } from './contracts/types.js'

export interface MarketBuiltInProvider {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly providerId: string
  readonly adapterId: string
  readonly endpoint: string
  readonly partnership: boolean
}

export interface MarketSourceView extends LocalSourceRecord {
  readonly name: string
  readonly description?: string
  readonly endpoint: string
  readonly partnership: boolean
}

export interface MarketStateResponse {
  readonly sources: readonly MarketSourceView[]
  readonly builtIns: readonly MarketBuiltInProvider[]
}

export interface MarketCatalogSourceResult {
  readonly source: MarketSourceView
  readonly snapshot?: CatalogSnapshot
  readonly error?: string
  readonly stale: boolean
}

export interface MarketCatalogResponse {
  readonly query: Record<string, unknown>
  readonly results: readonly MarketCatalogSourceResult[]
  readonly fetchedAt: string
}

export interface MarketSourceManifestResponse {
  readonly source: CatalogSourceManifest
}

export type MarketSourceMutation =
  | { readonly action: 'add-builtin'; readonly key: string }
  | { readonly action: 'add-standard'; readonly manifestUrl: string }
  | { readonly action: 'set-enabled'; readonly sourceRecordId: string; readonly enabled: boolean }
  | { readonly action: 'remove'; readonly sourceRecordId: string }
