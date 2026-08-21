import {
  WORKER_PACK_CATALOG_SOURCE_KEY,
  findCatalogItemForPackage,
  isWorkerPackRecommendedPackage,
  recommendedPackageInstalled,
  workerPackCatalogSelected,
  type WorkerPackInstallResult,
  type WorkerPackInstallationRef,
} from '../worker-pack.ts'

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

interface MarketInstallationsResponse {
  readonly installations: readonly WorkerPackInstallationRef[]
}

interface MarketCatalogResponse {
  readonly results: readonly {
    readonly snapshot?: { readonly items?: readonly { readonly id: string; readonly package?: { readonly name?: string } }[] }
  }[]
}

interface MarketPreviewResponse {
  readonly previewId: string
  readonly action: string
}

interface MarketExecuteResponse {
  readonly action: string
  readonly restartToken?: string
}

/** Read the active-profile plugin inventory used to mark recommendations installed. */
export async function readWorkerPackInstallations(
  signal?: AbortSignal,
): Promise<readonly WorkerPackInstallationRef[]> {
  const response = await readJson<MarketInstallationsResponse>(await fetch('/api/community-market/installations', {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
  return response.installations
}

async function searchCatalogItems(
  sourceRecordId: string,
  packageName: string,
  signal?: AbortSignal,
): Promise<readonly { readonly id: string; readonly package?: { readonly name?: string } }[]> {
  const url = new URL('/api/community-market/catalog', window.location.origin)
  url.searchParams.set('sourceRecordId', sourceRecordId)
  url.searchParams.set('q', packageName)
  url.searchParams.set('limit', '50')
  url.searchParams.set('locale', 'zh')
  const response = await readJson<MarketCatalogResponse>(await fetch(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
  return response.results.flatMap(result => result.snapshot?.items ?? [])
}

async function previewAndExecuteInstall(
  sourceRecordId: string,
  itemId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const preview = await readJson<MarketPreviewResponse>(await fetch('/api/community-market/operations/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'install', sourceRecordId, itemId }),
    ...(signal === undefined ? {} : { signal }),
  }))
  if (preview.action !== 'install') throw new Error('operation preview action mismatch')
  const executed = await readJson<MarketExecuteResponse>(await fetch('/api/community-market/operations/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId: preview.previewId }),
    ...(signal === undefined ? {} : { signal }),
  }))
  if (executed.action !== 'install') throw new Error('operation response action mismatch')
  return executed.restartToken
}

/**
 * Install curated recommendations through the plugin market.
 * This is user-initiated: unknown package names are rejected, and nothing runs at boot.
 */
export async function installRecommendedPlugins(
  packageNames: readonly string[],
  signal?: AbortSignal,
): Promise<{ readonly results: readonly WorkerPackInstallResult[]; readonly restartToken?: string }> {
  if (packageNames.length === 0) throw new Error('no recommended plugins requested')
  if (packageNames.some(packageName => !isWorkerPackRecommendedPackage(packageName))) {
    throw new Error('worker pack can only install its recommended plugins')
  }
  const sources = await selectWorkerPackCatalog(signal)
  const source = sources.find(item => item.builtInProviderKey === WORKER_PACK_CATALOG_SOURCE_KEY && item.enabled)
  if (source === undefined) throw new Error('built-in catalog source unavailable')
  const installations = [...await readWorkerPackInstallations(signal)]
  const results: WorkerPackInstallResult[] = []
  let restartToken: string | undefined
  for (const packageName of packageNames) {
    if (recommendedPackageInstalled(packageName, installations)) {
      results.push({ packageName, status: 'already' })
      continue
    }
    try {
      const item = findCatalogItemForPackage(
        await searchCatalogItems(source.sourceRecordId, packageName, signal),
        packageName,
      )
      if (item === undefined) {
        results.push({ packageName, status: 'missing' })
        continue
      }
      const nextToken = await previewAndExecuteInstall(source.sourceRecordId, item.id, signal)
      if (nextToken !== undefined) restartToken = nextToken
      installations.push({ packageName })
      results.push({ packageName, status: 'installed' })
    } catch (cause) {
      results.push({
        packageName,
        status: 'failed',
        error: cause instanceof Error ? cause.message : 'install failed',
      })
    }
  }
  return restartToken === undefined ? { results } : { results, restartToken }
}

/** Ask Desktop to restart after a completed market install. */
export async function requestWorkerPackRestart(
  restartToken: string,
  signal?: AbortSignal,
): Promise<void> {
  await readJson<{ ok: true }>(await fetch('/api/community-market/desktop/request-restart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ restartToken }),
    ...(signal === undefined ? {} : { signal }),
  }))
}
