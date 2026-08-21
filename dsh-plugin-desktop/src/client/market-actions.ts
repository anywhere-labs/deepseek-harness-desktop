import { WORKER_PACK_CATALOG_SOURCE_KEY, workerPackCatalogSelected } from '../worker-pack.ts'

export { workerPackCatalogSelected }

interface MarketSourceView {
  readonly sourceRecordId: string
  readonly enabled: boolean
  readonly builtInProviderKey?: string
}

interface MarketStateResponse {
  readonly sources: readonly MarketSourceView[]
}

async function readJson<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: unknown }
  if (!response.ok) {
    throw new Error(typeof value.error === 'string' ? value.error : `request failed: ${response.status}`)
  }
  return value
}

/** Read the current market source registry. */
export async function readMarketSources(signal?: AbortSignal): Promise<readonly MarketSourceView[]> {
  const state = await readJson<MarketStateResponse>(await fetch('/api/community-market/state', {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
  return state.sources
}

async function mutateMarketSource(
  mutation: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<readonly MarketSourceView[]> {
  const response = await readJson<{ sources: readonly MarketSourceView[] }>(await fetch('/api/community-market/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mutation),
    ...(signal === undefined ? {} : { signal }),
  }))
  return response.sources
}

function findCatalogSource(sources: readonly MarketSourceView[]): MarketSourceView | undefined {
  return sources.find(source => source.builtInProviderKey === WORKER_PACK_CATALOG_SOURCE_KEY)
}

/**
 * Add the recommended built-in catalog if missing, then select it.
 * This is a user-initiated write — the market still starts with no selected source.
 */
export async function selectWorkerPackCatalog(signal?: AbortSignal): Promise<readonly MarketSourceView[]> {
  let sources = [...await readMarketSources(signal)]
  let source = findCatalogSource(sources)
  if (source === undefined) {
    sources = [...await mutateMarketSource({ action: 'add-builtin', key: WORKER_PACK_CATALOG_SOURCE_KEY }, signal)]
    source = findCatalogSource(sources)
  }
  if (source === undefined) throw new Error('built-in catalog source unavailable')
  if (source.enabled) return sources
  return await mutateMarketSource({ action: 'select', sourceRecordId: source.sourceRecordId }, signal)
}
