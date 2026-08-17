/* Generated from docs/schemas by scripts/generate-contract-types.mjs. Do not edit. */

export type Item = Item1 & {
  id: Identifier
  name: PlainText
  displayName: PlainText
  summary: PlainText
  description?: PlainText
  homepage?: HttpsUri
  latestVersion?: string
  license?: string
  /**
   * @maxItems 32
   */
  categories?: CategoryId[]
  /**
   * @maxItems 64
   */
  keywords?: string[]
  repository?: Repository
  package?: Package
  publisher?: Publisher
  capabilities?: Capabilities
  compatibility?: Compatibility
  updatedAt?: string
}
export type Item1 =
  | {
      repository: unknown
      [k: string]: unknown
    }
  | {
      package: unknown
      [k: string]: unknown
    }
export type Identifier = string
export type PlainText = string
export type HttpsUri = string
export type CategoryId = string
/**
 * @maxItems 64
 */
export type CapabilityList = string[]

/**
 * The untrusted wire response returned by a standard HTTPS catalog source. Host-observed provenance is intentionally absent and is injected only after validation.
 */
export interface CatalogProviderPage {
  schemaVersion: '1.0.0'
  generatedAt?: string
  revision?: string
  /**
   * @maxItems 100
   */
  items: Item[]
  page: Page
}
export interface Repository {
  url: HttpsUri
  subdirectory?: string
}
export interface Package {
  registry: 'npm'
  name: string
}
export interface Publisher {
  name: PlainText
  url?: HttpsUri
}
export interface Capabilities {
  required?: CapabilityList
  optional?: CapabilityList
}
export interface Compatibility {
  apiVersion?: string
  /**
   * @maxItems 32
   */
  hosts?: string[]
}
export interface Page {
  nextCursor?: string
  total?: number
}
