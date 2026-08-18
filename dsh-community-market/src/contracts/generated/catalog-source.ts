/* Generated from docs/schemas by scripts/generate-contract-types.mjs. Do not edit. */

/**
 * A provider-neutral declaration for a user-selectable HTTPS JSON catalog source. User-owned state such as enabled status and source ordering does not belong in this manifest.
 */
export interface CatalogSourceManifest {
  manifestVersion: '1.0.0'
  /**
   * Provider-claimed stable identifier, preferably in reverse-domain form. The Host generates a separate sourceRecordId for local identity.
   */
  providerId: string
  name: string
  description?: string
  homepage?: string
  attribution: {
    name: string
    url: string
    notice?: string
  }
  transport: {
    kind: 'https-json'
    /**
     * Absolute HTTPS endpoint with no query or fragment. The standard endpoint path ends in /v1/plugins.
     */
    endpoint: string
    method: 'GET'
  }
  query: {
    /**
     * @minItems 0
     * @maxItems 7
     */
    supported: ('q' | 'category' | 'capability' | 'cursor' | 'limit' | 'sort' | 'locale')[]
    defaultLimit: number
    maxLimit: number
    /**
     * @maxItems 4
     */
    sorts:
      | []
      | ['relevance' | 'updated' | 'name' | 'downloads']
      | ['relevance' | 'updated' | 'name' | 'downloads', 'relevance' | 'updated' | 'name' | 'downloads']
      | [
          'relevance' | 'updated' | 'name' | 'downloads',
          'relevance' | 'updated' | 'name' | 'downloads',
          'relevance' | 'updated' | 'name' | 'downloads',
        ]
      | [
          'relevance' | 'updated' | 'name' | 'downloads',
          'relevance' | 'updated' | 'name' | 'downloads',
          'relevance' | 'updated' | 'name' | 'downloads',
          'relevance' | 'updated' | 'name' | 'downloads',
        ]
  }
}
