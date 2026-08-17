import type { CatalogQuery } from './generated/catalog-query.js'
import type { CatalogSnapshot } from './generated/catalog-snapshot.js'

export type SourceRegistrationKind = 'user-added' | 'built-in'

export interface LocalSourceRecord {
  readonly sourceRecordId: string
  readonly registrationKind: SourceRegistrationKind
  readonly adapterId: string
  readonly providerId: string
  readonly manifestUrl?: string
  readonly builtInProviderKey?: string
  readonly enabled: boolean
  readonly order: number
}

export interface CatalogSourceStore {
  load(): Promise<readonly LocalSourceRecord[]>
  save(records: readonly LocalSourceRecord[]): Promise<void>
}

export interface CatalogFetchContext {
  readonly signal: AbortSignal
  readonly source: LocalSourceRecord
  readonly http: CatalogHttpClient
}

export interface CatalogHttpClient {
  getJson(url: string, signal: AbortSignal): Promise<CatalogHttpResponse>
}

export interface CatalogHttpResponse {
  readonly value: unknown
  readonly finalUrl: string
}

export interface CatalogAdapter {
  readonly adapterId: string
  fetch(query: CatalogQuery, context: CatalogFetchContext): Promise<CatalogSnapshot>
}

export interface ScopedCatalogCursor {
  readonly value: string
  readonly sourceRecordId: string
  readonly queryKey: string
}

export interface NormalizedRepositoryIdentity {
  readonly url: string
  readonly subdirectory?: string
}

export interface NormalizedPackageIdentity {
  readonly registry: 'npm'
  readonly name: string
}

export type CatalogIdentityChoice =
  | { readonly kind: 'repository'; readonly repository: NormalizedRepositoryIdentity }
  | { readonly kind: 'package'; readonly package: NormalizedPackageIdentity }
