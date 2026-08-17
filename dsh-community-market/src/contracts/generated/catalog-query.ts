/* Generated from docs/schemas by scripts/generate-contract-types.mjs. Do not edit. */

export type CategoryId = string
export type CapabilityId = string

/**
 * The normalized query accepted by a catalog adapter. category and capability values are encoded as repeated query parameters for the standard HTTPS endpoint.
 */
export interface CatalogQuery {
  q?: string
  /**
   * @maxItems 20
   */
  category?: CategoryId[]
  /**
   * @maxItems 32
   */
  capability?: CapabilityId[]
  cursor?: string
  limit?: number
  sort?: 'relevance' | 'updated' | 'name' | 'downloads'
  /**
   * A BCP 47-like language tag.
   */
  locale?: string
}
