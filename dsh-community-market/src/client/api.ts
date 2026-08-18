import type {
  MarketCatalogResponse,
  MarketDesktopActionResponse,
  MarketInstallableResponse,
  MarketInstallationsResponse,
  MarketOperationExecuteResponse,
  MarketOperationPreviewRequest,
  MarketOperationPreviewResponse,
  MarketSourceMutation,
  MarketStateResponse,
} from '../api-types.js'

const CATALOG_PAGE_LIMIT = 50

async function readJson<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: unknown; code?: unknown }
  if (!response.ok) {
    throw new MarketApiError(
      typeof value.error === 'string' ? value.error : `request failed: ${response.status}`,
      response.status,
      typeof value.code === 'string' ? value.code : undefined,
    )
  }
  return value
}

/** HTTP facts used to localize safe Client-facing Market failures. */
export class MarketApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'MarketApiError'
  }
}

export async function readMarketState(signal?: AbortSignal): Promise<MarketStateResponse> {
  return await readJson(await fetch('/api/community-market/state', {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

function marketCatalogUrl(sourceRecordId: string, q: string, locale: string, categories: readonly string[]): URL {
  const url = new URL('/api/community-market/catalog', window.location.origin)
  url.searchParams.set('sourceRecordId', sourceRecordId)
  if (q.trim()) url.searchParams.set('q', q.trim())
  for (const category of categories) url.searchParams.append('category', category)
  url.searchParams.set('limit', String(CATALOG_PAGE_LIMIT))
  url.searchParams.set('locale', locale)
  return url
}

export async function readMarketCatalog(
  sourceRecordId: string,
  q: string,
  locale: string,
  categories: readonly string[],
  signal?: AbortSignal,
  refresh = false,
): Promise<MarketCatalogResponse> {
  const url = marketCatalogUrl(sourceRecordId, q, locale, categories)
  if (refresh) url.searchParams.set('refresh', '1')
  return await readJson(await fetch(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

export async function readMoreMarketCatalog(
  sourceRecordId: string,
  cursor: string,
  q: string,
  locale: string,
  categories: readonly string[],
  signal?: AbortSignal,
): Promise<MarketCatalogResponse> {
  const url = marketCatalogUrl(sourceRecordId, q, locale, categories)
  url.searchParams.set('cursor', cursor)
  return await readJson(await fetch(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

export async function mutateMarketSource(mutation: MarketSourceMutation, signal?: AbortSignal): Promise<MarketStateResponse['sources']> {
  const response = await readJson<{ sources: MarketStateResponse['sources'] }>(await fetch('/api/community-market/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mutation),
    ...(signal === undefined ? {} : { signal }),
  }))
  return response.sources
}

export async function readMarketInstallations(signal?: AbortSignal): Promise<MarketInstallationsResponse> {
  return await readJson(await fetch('/api/community-market/installations', {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

export async function readMarketInstallable(
  locale: string,
  refresh = false,
  signal?: AbortSignal,
): Promise<MarketInstallableResponse> {
  const url = new URL('/api/community-market/installable', window.location.origin)
  url.searchParams.set('locale', locale)
  if (refresh) url.searchParams.set('refresh', '1')
  return await readJson(await fetch(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

export async function previewMarketOperation(
  request: MarketOperationPreviewRequest,
  signal?: AbortSignal,
): Promise<MarketOperationPreviewResponse> {
  return await readJson(await fetch('/api/community-market/operations/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal }),
  }))
}

export async function executeMarketOperation(
  previewId: string,
  signal?: AbortSignal,
): Promise<MarketOperationExecuteResponse> {
  return await readJson(await fetch('/api/community-market/operations/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId }),
    ...(signal === undefined ? {} : { signal }),
  }))
}

export async function openMarketTerminal(signal?: AbortSignal): Promise<MarketDesktopActionResponse> {
  return await readJson(await fetch('/api/community-market/desktop/open-terminal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    ...(signal === undefined ? {} : { signal }),
  }))
}

export async function requestMarketRestart(
  restartToken: string,
  signal?: AbortSignal,
): Promise<MarketDesktopActionResponse> {
  return await readJson(await fetch('/api/community-market/desktop/request-restart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ restartToken }),
    ...(signal === undefined ? {} : { signal }),
  }))
}
