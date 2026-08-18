export { CatalogContractError, type CatalogContractIssue, type CatalogContractName } from './errors.js'
export type { CatalogProviderPage } from './generated/catalog-provider-page.js'
export type { CatalogQuery } from './generated/catalog-query.js'
export type { CatalogSnapshot } from './generated/catalog-snapshot.js'
export type { CatalogSourceManifest } from './generated/catalog-source.js'
export {
  catalogIdentityChoices,
  normalizePackageIdentity,
  normalizeRepositoryIdentity,
} from './identity.js'
export {
  applyScopedCatalogCursor,
  normalizeCatalogQuery,
  scopeCatalogCursor,
  serializeCatalogQuery,
} from './query.js'
export type {
  CatalogAdapter,
  CatalogFetchContext,
  CatalogHttpClient,
  CatalogHttpResponse,
  CatalogIdentityChoice,
  CatalogMediaCandidate,
  CatalogMediaRegistrar,
  CatalogMediaRole,
  CatalogSourceStore,
  LocalSourceRecord,
  NormalizedPackageIdentity,
  NormalizedRepositoryIdentity,
  ScopedCatalogCursor,
  SourceRegistrationKind,
} from './types.js'
export {
  parseCatalogProviderPage,
  parseCatalogQuery,
  parseCatalogSnapshot,
  parseCatalogSource,
  validateLocalSourceRecords,
} from './validate.js'
