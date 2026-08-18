/* Generated from docs/schemas by scripts/generate-contract-types.mjs. Do not edit. */

export type CategoryId = string
export type CapabilityId = string

/**
 * The normalized query accepted by the currently selected catalog adapter. The standard HTTPS endpoint encodes category and capability values as repeated parameters; repeated category values use OR semantics. The current UI defaults limit to 50, while the contract permits values through 100.
 */
export interface CatalogQuery {
  q?: string
  /**
   * A multi-select OR filter: an item matches when it belongs to any requested category.
   *
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
