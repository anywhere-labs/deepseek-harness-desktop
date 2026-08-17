import type { CatalogAdapter, CatalogFetchContext } from '../contracts/types.js'
import type { CatalogProviderPage } from '../contracts/generated/catalog-provider-page.js'
import type { CatalogSnapshot } from '../contracts/generated/catalog-snapshot.js'
import { normalizeCatalogQuery, serializeCatalogQuery } from '../contracts/query.js'
import { parseCatalogProviderPage, parseCatalogSnapshot, parseCatalogSource } from '../contracts/validate.js'

function snapshotFromPage(
  page: CatalogProviderPage,
  source: CatalogFetchContext['source'],
  finalUrl: string,
): CatalogSnapshot {
  const fetchedAt = new Date().toISOString()
  return parseCatalogSnapshot({
    schemaVersion: '1.0.0',
    source: {
      sourceRecordId: source.sourceRecordId,
      providerId: source.providerId,
      adapterId: source.adapterId,
      registrationKind: source.registrationKind,
      fetchedAt,
      finalUrl,
      ...(page.generatedAt === undefined ? {} : { providerGeneratedAt: page.generatedAt }),
      ...(page.revision === undefined ? {} : { providerRevision: page.revision }),
    },
    items: page.items.map(item => ({
      ...item,
      provenance: {
        sourceRecordId: source.sourceRecordId,
        providerId: source.providerId,
        itemId: item.id,
      },
    })),
    page: page.page,
  })
}

export const standardHttpAdapter: CatalogAdapter = {
  adapterId: 'market.standard-http-v1',
  async fetch(queryValue, context) {
    if (context.source.manifestUrl === undefined) throw new Error('standard source has no manifest URL')
    const manifestResponse = await context.http.getJson(context.source.manifestUrl, context.signal)
    const manifest = parseCatalogSource(manifestResponse.value)
    const query = normalizeCatalogQuery(queryValue)
    const url = serializeCatalogQuery(manifest, query)
    const response = await context.http.getJson(url.href, context.signal)
    const page = parseCatalogProviderPage(response.value, Math.min(query.limit ?? manifest.query.defaultLimit, manifest.query.maxLimit))
    return snapshotFromPage(page, context.source, response.finalUrl)
  },
}
