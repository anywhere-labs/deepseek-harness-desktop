import type { CatalogAdapter, CatalogFetchContext } from '../contracts/types.js'
import type { CatalogProviderPage } from '../contracts/generated/catalog-provider-page.js'
import type { CatalogSnapshot } from '../contracts/generated/catalog-snapshot.js'
import { normalizeRepositoryIdentity } from '../contracts/identity.js'
import { normalizeCatalogQuery, serializeCatalogQuery } from '../contracts/query.js'
import { parseCatalogProviderPage, parseCatalogSnapshot, parseCatalogSource } from '../contracts/validate.js'

function safeHttpsUrl(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new Error(`${label} must use credential-free standard HTTPS port 443 without a fragment`)
  }
  return url
}

function requireOrigin(value: string, expectedOrigin: string, label: string): URL {
  const url = safeHttpsUrl(value, label)
  if (url.origin !== expectedOrigin) throw new Error(`${label} changed the registered source origin`)
  return url
}

export function assertStandardSourceTrustRoot(
  manifestUrlValue: string,
  manifestFinalUrl: string,
  endpointValue: string,
): string {
  const manifestUrl = safeHttpsUrl(manifestUrlValue, 'standard source manifest URL')
  requireOrigin(manifestFinalUrl, manifestUrl.origin, 'standard source manifest final URL')
  requireOrigin(endpointValue, manifestUrl.origin, 'standard source endpoint')
  return manifestUrl.origin
}

function snapshotFromPage(
  page: CatalogProviderPage,
  context: Pick<CatalogFetchContext, 'source' | 'media'>,
  finalUrl: string,
): CatalogSnapshot {
  const fetchedAt = new Date().toISOString()
  const providerOrigin = new URL(finalUrl).origin
  return parseCatalogSnapshot({
    schemaVersion: '1.0.0',
    source: {
      sourceRecordId: context.source.sourceRecordId,
      providerId: context.source.providerId,
      adapterId: context.source.adapterId,
      registrationKind: context.source.registrationKind,
      fetchedAt,
      finalUrl,
      ...(page.generatedAt === undefined ? {} : { providerGeneratedAt: page.generatedAt }),
      ...(page.revision === undefined ? {} : { providerRevision: page.revision }),
    },
    items: page.items.map(item => {
      const { media, repository, ...plainItem } = item
      const normalizedRepository = repository === undefined
        ? undefined
        : normalizeRepositoryIdentity(repository)
      let resolvedMedia: CatalogSnapshot['items'][number]['media']
      if (media !== undefined) {
        try {
          const remoteUrl = new URL(media.icon.url)
          if (remoteUrl.origin !== providerOrigin) {
            throw new Error('standard catalog icons must use the provider response origin')
          }
          const assetRef = context.media.register({
            remoteUrl: remoteUrl.href,
            role: 'plugin-icon',
            ...(media.icon.alt === undefined ? {} : { alt: media.icon.alt }),
            sourceRecordId: context.source.sourceRecordId,
            itemId: item.id,
            allowedHostnames: [remoteUrl.hostname],
          })
          resolvedMedia = {
            icon: {
              assetRef,
              role: 'plugin-icon',
              ...(media.icon.alt === undefined ? {} : { alt: media.icon.alt }),
            },
          }
        } catch {
          // Optional media is isolated from the otherwise valid catalog item.
        }
      }
      return {
        ...plainItem,
        ...(normalizedRepository === undefined ? {} : { repository: normalizedRepository }),
        ...(resolvedMedia === undefined ? {} : { media: resolvedMedia }),
        provenance: {
          sourceRecordId: context.source.sourceRecordId,
          providerId: context.source.providerId,
          itemId: item.id,
        },
      }
    }),
    page: page.page,
  })
}

export const standardHttpAdapter: CatalogAdapter = {
  adapterId: 'market.standard-http-v1',
  async fetch(queryValue, context) {
    if (context.source.manifestUrl === undefined) throw new Error('standard source has no manifest URL')
    const registeredOrigin = safeHttpsUrl(context.source.manifestUrl, 'standard source manifest URL').origin
    const manifestResponse = await context.http.getJson(
      context.source.manifestUrl,
      context.signal,
      { allowedOrigin: registeredOrigin },
    )
    const manifest = parseCatalogSource(manifestResponse.value)
    if (manifest.providerId !== context.source.providerId) {
      throw new Error('standard source provider identity changed after registration')
    }
    const sourceOrigin = assertStandardSourceTrustRoot(
      context.source.manifestUrl,
      manifestResponse.finalUrl,
      manifest.transport.endpoint,
    )
    const query = normalizeCatalogQuery(queryValue)
    const url = serializeCatalogQuery(manifest, query)
    const response = await context.http.getJson(url.href, context.signal, { allowedOrigin: sourceOrigin })
    requireOrigin(response.finalUrl, sourceOrigin, 'standard source provider page final URL')
    const effectiveLimit = manifest.query.supported.includes('limit')
      ? Math.min(query.limit ?? 50, manifest.query.maxLimit)
      : manifest.query.defaultLimit
    const page = parseCatalogProviderPage(response.value, effectiveLimit)
    return snapshotFromPage(page, context, response.finalUrl)
  },
}
