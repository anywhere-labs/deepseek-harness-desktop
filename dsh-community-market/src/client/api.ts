import type { MarketCatalogResponse, MarketSourceMutation, MarketStateResponse } from '../api-types.js'

async function readJson<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: unknown }
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `request failed: ${response.status}`)
  return value
}

export async function readMarketState(signal?: AbortSignal): Promise<MarketStateResponse> {
  return await readJson(await fetch('/api/community-market/state', {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

export async function readMarketCatalog(q: string, locale: string, signal?: AbortSignal): Promise<MarketCatalogResponse> {
  const url = new URL('/api/community-market/catalog', window.location.origin)
  if (q.trim()) url.searchParams.set('q', q.trim())
  url.searchParams.set('limit', '20')
  url.searchParams.set('locale', locale)
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
