import type { CatalogQuery } from './generated/catalog-query.js'
import type { CatalogSnapshot } from './generated/catalog-snapshot.js'
import type { CatalogSourceManifest } from './generated/catalog-source.js'

export type SourceRegistrationKind = 'user-added' | 'built-in'

export interface LocalSourceRecord {
  readonly sourceRecordId: string
  readonly registrationKind: SourceRegistrationKind
  readonly adapterId: string
  readonly providerId: string
  readonly manifestUrl?: string
  /** Registration-time disclosure retained for user-added standard sources. */
  readonly manifest?: CatalogSourceManifest
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
  readonly media: CatalogMediaRegistrar
}

export type CatalogMediaRole = 'plugin-icon' | 'publisher-avatar'

export interface CatalogMediaCandidate {
  /** Credential-free HTTPS URL retained only by the Host. */
  readonly remoteUrl: string
  readonly role: CatalogMediaRole
  readonly alt?: string
  readonly sourceRecordId: string
  readonly itemId: string
  /** Exact reviewed hostnames allowed for the initial request and every redirect. */
  readonly allowedHostnames: readonly string[]
}

export interface CatalogMediaRegistrar {
  /** Register one candidate and return an opaque Host-managed reference. */
  register(candidate: CatalogMediaCandidate): string
}

export interface CatalogMediaRegistry extends CatalogMediaRegistrar {
  /** Revoke every reference and in-flight media read owned by one source. */
  unregisterSource(sourceRecordId: string): void
}

export interface CatalogHttpClient {
  getJson(url: string, signal: AbortSignal, policy?: CatalogHttpRequestPolicy): Promise<CatalogHttpResponse>
}

export interface CatalogHttpRequestPolicy {
  /** Reject a cross-origin redirect before the destination is contacted. */
  readonly allowedOrigin?: string
  /** Bypass and replace any completed or in-flight catalog response cache entry. */
  readonly cacheMode?: 'default' | 'reload'
}

export interface CatalogHttpResponse {
  readonly value: unknown
  readonly finalUrl: string
}

export interface CatalogAdapter {
  readonly adapterId: string
  fetch(query: CatalogQuery, context: CatalogFetchContext): Promise<CatalogSnapshot>
  /**
   * Optionally scan the adapter's complete normalized catalog independently
   * of the discovery query and page cursor.
   */
  scanCatalog?(query: CatalogQuery, context: CatalogFetchContext): Promise<readonly CatalogSnapshot[]>
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
