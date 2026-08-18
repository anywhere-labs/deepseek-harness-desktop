/* Generated from docs/schemas by scripts/generate-contract-types.mjs. Do not edit. */

/**
 * A provider-neutral declaration for one user-selectable HTTPS JSON catalog endpoint. A user registers its manifest URL; selection and all other user-owned state stay local. The smallest recommended profile supports q, category, cursor, and limit and uses 50 as an example page size, not a global cap.
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
     * Absolute HTTPS endpoint on standard port 443 with no query or fragment. It must share the user-approved manifest origin, and the standard endpoint path ends in /v1/plugins.
     */
    endpoint: string
    method: 'GET'
  }
  /**
   * The endpoint query features advertised by this source. The minimal fixture uses supported=[q, category, cursor, limit], defaultLimit=50, maxLimit=50, and sorts=[]. Standard sources may declare limits through the Schema maximum of 100.
   */
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
