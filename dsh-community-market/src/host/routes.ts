import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BlockList, isIP } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import type { CatalogSourceManifest } from '../contracts/index.js'
import { parseCatalogSnapshot, parseCatalogSource, validateLocalSourceRecords } from '../contracts/validate.js'
import type { CatalogHttpClient } from '../contracts/types.js'
import type {
  MarketBuiltInProvider,
  MarketCatalogErrorCode,
  MarketCatalogMetadata,
  MarketCatalogResponse,
  MarketInstallationView,
  MarketInstallReceipt,
  MarketManualInstallHint,
  MarketSourceMutation,
  MarketStateResponse,
} from '../api-types.js'
import { CatalogContractError } from '../contracts/errors.js'
import {
  CatalogNetworkError,
  createCachedCatalogHttpClient,
  createRestrictedHttpClient,
  restrictedHttpClient,
} from '../network/restricted-http.js'
import {
  DSH_1024STORE_ADAPTER_ID,
  DSH_1024STORE_HOSTNAME,
} from '../adapters/dsh-1024store.js'
import { DSHFIND_ADAPTER_ID, DSHFIND_HOSTNAME } from '../adapters/dshfind.js'
import { assertStandardSourceTrustRoot } from '../adapters/standard-http.js'
import { BUILT_IN_PROVIDERS, DefaultCatalogService, type CatalogFetchScope, type CatalogFullIndex } from '../catalog/service.js'
import { SettingsCatalogSourceStore, type MarketCatalogCache, type MarketSettingsDocument } from '../catalog/source-store.js'
import { MARKET_MEDIA_ASSET_REF_PATTERN } from '../media/ref.js'
import { createRestrictedImageFetcher } from '../media/restricted-image.js'
import { createMarketMediaService } from '../media/service.js'
import { MarketInstallError, type MarketInstallService } from '../install/service.js'
import { manualInstallHints } from '../install/manual.js'

export const MARKET_SETTINGS_NAMESPACE = settingsNamespace('dsh-community-market')
const SOURCE_SCHEMA = z.object({
  sourceRecordId: z.string().required(),
  registrationKind: z.union(['user-added', 'built-in'] as const).required(),
  adapterId: z.string().required(),
  providerId: z.string().required(),
  manifestUrl: z.string(),
  manifest: z.any(),
  builtInProviderKey: z.string(),
  enabled: z.boolean().required(),
  order: z.number().required(),
})
const SETTINGS_SCHEMA = z.object({
  sources: z.array(SOURCE_SCHEMA).default([]),
  installReceipts: z.array(z.object({
    receiptId: z.string().required(),
    profileName: z.string().required(),
    packageName: z.string().required(),
    version: z.string().required(),
    integrity: z.string().required(),
    bundlePatch: z.string().required(),
    sourceRecordId: z.string().required(),
    providerId: z.string().required(),
    itemId: z.string().required(),
    displayName: z.string().required(),
    installedAt: z.string().required(),
  })).default([]),
  catalogCache: z.object({
    version: z.number().step(1),
    sourceRecordId: z.string(),
    locale: z.string(),
    savedAt: z.string(),
    snapshot: z.any(),
    categories: z.array(z.string()),
    scannedAt: z.string(),
    expiresAt: z.string(),
    providerRevision: z.string(),
  }).default(undefined as never),
}) as unknown as z<MarketSettingsDocument>

const ROUTE_STATE = '/api/community-market/state'
const ROUTE_SOURCES = '/api/community-market/sources'
const ROUTE_CATALOG = '/api/community-market/catalog'
const ROUTE_INSTALLABLE = '/api/community-market/installable'
const ROUTE_ASSETS = '/api/community-market/assets'
const ROUTE_INSTALLATIONS = '/api/community-market/installations'
const ROUTE_OPEN_TERMINAL = '/api/community-market/desktop/open-terminal'
const ROUTE_REQUEST_RESTART = '/api/community-market/desktop/request-restart'
const ROUTE_OPERATION_PREVIEW = '/api/community-market/operations/preview'
const ROUTE_OPERATION_EXECUTE = '/api/community-market/operations/execute'
const MAX_BODY_BYTES = 16 * 1024
// The full registry was already about 6.7 MiB in August 2026. Keep bounded
// headroom without relaxing the 2 MiB default used by user-added sources.
const MAX_DSH_1024STORE_BODY_BYTES = 16 * 1024 * 1024
const CATALOG_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

const dsh1024StoreHttpClient = createCachedCatalogHttpClient(
  createRestrictedHttpClient({
    syntheticProxyHostnames: [DSH_1024STORE_HOSTNAME],
    maxBodyBytes: MAX_DSH_1024STORE_BODY_BYTES,
  }),
)

const dshfindHttpClient = createCachedCatalogHttpClient(
  createRestrictedHttpClient({
    // This exact hostname is compiled into the reviewed adapter. User-added
    // source hostnames must never inherit this local-proxy exception.
    syntheticProxyHostnames: [DSHFIND_HOSTNAME],
  }),
)

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

function sendInstallError(res: ServerResponse, cause: unknown): void {
  if (!(cause instanceof MarketInstallError)) {
    sendJson(res, 500, { error: 'market package operation failed', code: 'operation-failed' })
    return
  }
  const status = cause.code === 'invalid-request' ? 400
    : cause.code === 'not-available' ? 404
      : cause.code === 'conflict' ? 409
        : cause.code === 'intent-expired' ? 410
          : cause.code === 'verification-failed' ? 422
            : cause.code === 'operation-failed' ? 502
              : 500
  sendJson(res, status, { error: cause.message, code: cause.code })
}

function sendCatalogFailure(res: ServerResponse, cause: unknown): void {
  let code: MarketCatalogErrorCode = 'catalog-unavailable'
  if (cause instanceof CatalogNetworkError && cause.code === 'timeout') code = 'catalog-timeout'
  else if (
    cause instanceof CatalogNetworkError && cause.code === 'response'
    || cause instanceof CatalogContractError
  ) code = 'catalog-invalid-response'
  const status = code === 'catalog-timeout' ? 504 : 502
  const error = code === 'catalog-timeout'
    ? 'catalog request timed out'
    : code === 'catalog-invalid-response'
      ? 'catalog response was invalid'
      : 'catalog source unavailable'
  sendJson(res, status, { error, code })
}

function catalogMetadata(index: CatalogFullIndex): MarketCatalogMetadata {
  return {
    scannedAt: index.scannedAt,
    expiresAt: index.expiresAt,
    ...(index.providerRevision === undefined ? {} : { providerRevision: index.providerRevision }),
    cacheStatus: index.cacheStatus,
  }
}

function catalogCategories(index: CatalogFullIndex): readonly string[] {
  return [...new Set(index.snapshots.flatMap(snapshot => snapshot.items.flatMap(item => item.categories ?? [])))]
    .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
}

function catalogManualInstall(results: readonly { readonly snapshot?: { readonly items: CatalogFullIndex['snapshots'][number]['items'] } }[]): readonly MarketManualInstallHint[] {
  return manualInstallHints(results.flatMap(result => result.snapshot?.items ?? []))
}

function cachedCatalogResponse(
  cache: MarketCatalogCache | undefined,
  source: MarketCatalogResponse['results'][number]['source'],
  locale: string,
  now = Date.now(),
): MarketCatalogResponse | undefined {
  if (cache === undefined
    || cache.version !== 1
    || cache.sourceRecordId !== source.sourceRecordId
    || cache.locale !== locale
    || !Number.isFinite(Date.parse(cache.savedAt))
    || now - Date.parse(cache.savedAt) < 0
    || now - Date.parse(cache.savedAt) > CATALOG_CACHE_MAX_AGE_MS
    || !Array.isArray(cache.categories)
    || cache.categories.length > 4_096
    || !cache.categories.every(value => typeof value === 'string')
    || !Number.isFinite(Date.parse(cache.scannedAt))
    || !Number.isFinite(Date.parse(cache.expiresAt))) return undefined
  let snapshot: CatalogFullIndex['snapshots'][number]
  try {
    snapshot = parseCatalogSnapshot(cache.snapshot)
  } catch {
    return undefined
  }
  if (
    snapshot.source.sourceRecordId !== source.sourceRecordId
    || snapshot.source.providerId !== source.providerId
    || snapshot.source.adapterId !== source.adapterId
    || snapshot.source.registrationKind !== source.registrationKind
  ) return undefined
  return {
    query: { limit: 50, locale },
    results: [{ source, stale: true, snapshot }],
    categories: [...cache.categories],
    manualInstall: catalogManualInstall([{ snapshot }]),
    metadata: {
      scannedAt: cache.scannedAt,
      expiresAt: cache.expiresAt,
      ...(cache.providerRevision === undefined ? {} : { providerRevision: cache.providerRevision }),
      cacheStatus: 'cached',
    },
    fetchedAt: new Date(now).toISOString(),
  }
}

function catalogCacheFromResponse(
  response: MarketCatalogResponse,
  sourceRecordId: string,
  locale: string,
  now = Date.now(),
): MarketCatalogCache | undefined {
  const result = response.results.find(value => value.source.sourceRecordId === sourceRecordId)
  const snapshot = result?.snapshot
  const metadata = response.metadata
  if (snapshot === undefined || metadata === undefined
    || !Number.isFinite(Date.parse(metadata.scannedAt))
    || !Number.isFinite(Date.parse(metadata.expiresAt))
    || !Array.isArray(response.categories)
    || response.categories.length > 4_096
    || !response.categories.every(value => typeof value === 'string')) return undefined
  const { nextCursor: _nextCursor, ...page } = snapshot.page
  let normalizedSnapshot: CatalogFullIndex['snapshots'][number]
  try {
    normalizedSnapshot = parseCatalogSnapshot({ ...snapshot, page })
  } catch {
    return undefined
  }
  return {
    version: 1,
    sourceRecordId,
    locale,
    savedAt: new Date(now).toISOString(),
    snapshot: normalizedSnapshot,
    categories: [...response.categories],
    scannedAt: metadata.scannedAt,
    expiresAt: metadata.expiresAt,
    ...(metadata.providerRevision === undefined ? {} : { providerRevision: metadata.providerRevision }),
  }
}

function abortOnDisconnect(req: IncomingMessage, res: ServerResponse, controller: AbortController): () => void {
  const abort = () => controller.abort()
  const abortIfUnfinished = () => {
    if (!res.writableEnded) controller.abort()
  }
  req.once('aborted', abort)
  res.once('close', abortIfUnfinished)
  return () => {
    req.off('aborted', abort)
    res.off('close', abortIfUnfinished)
  }
}

function readJson(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const abortReason = () => signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  if (signal.aborted) return Promise.reject(abortReason())
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onRequestAbort)
      signal.removeEventListener('abort', onSignalAbort)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        const cause = new Error('body too large')
        finish(() => {
          req.destroy(cause)
          reject(cause)
        })
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        finish(() => resolve(value))
      } catch {
        finish(() => reject(new Error('invalid json')))
      }
    }
    const onError = (cause: Error) => finish(() => reject(cause))
    const onRequestAbort = () => finish(() => reject(new DOMException('The request was aborted', 'AbortError')))
    const onSignalAbort = () => finish(() => reject(abortReason()))
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onRequestAbort)
    signal.addEventListener('abort', onSignalAbort, { once: true })
  })
}

const loopbackAddresses = new BlockList()
loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
loopbackAddresses.addSubnet('::1', 128, 'ipv6')

export interface MarketRequestContext {
  readonly remoteAddress: string | undefined
  readonly origin: string | undefined
  readonly host: string | undefined
  readonly secFetchSite?: string | undefined
  readonly expectedPort: number
}

function marketAuthority(context: MarketRequestContext): URL | undefined {
  if (context.remoteAddress === undefined || context.host === undefined) return undefined
  const address = context.remoteAddress.replace(/^\[|\]$/gu, '').split('%', 1)[0]!
  const family = isIP(address)
  if (family === 0 || !loopbackAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6')) return undefined
  let authority: URL
  try {
    authority = new URL(`http://${context.host}`)
  } catch {
    return undefined
  }
  if (
    authority.protocol !== 'http:'
    || Number(authority.port || '80') !== context.expectedPort
    || authority.hostname !== '127.0.0.1'
    || context.secFetchSite === 'cross-site'
  ) return undefined
  return authority
}

export function marketRequestAllowed(context: MarketRequestContext): boolean {
  return marketAuthority(context) !== undefined
}

export function marketMutationAllowed(context: MarketRequestContext): boolean {
  const authority = marketAuthority(context)
  if (authority === undefined || context.origin === undefined) return false
  try {
    const origin = new URL(context.origin)
    return origin.protocol === 'http:' && origin.host === authority.host && origin.pathname === '/'
  } catch {
    return false
  }
}

function requestContext(req: IncomingMessage, expectedPort: number): MarketRequestContext {
  const secFetchSite = req.headers['sec-fetch-site']
  return {
    remoteAddress: req.socket.remoteAddress,
    origin: req.headers.origin,
    host: req.headers.host,
    ...(typeof secFetchSite === 'string' ? { secFetchSite } : {}),
    expectedPort,
  }
}

function requestAllowed(req: IncomingMessage, expectedPort: number): boolean {
  return marketRequestAllowed(requestContext(req, expectedPort))
}

function mutationAllowed(req: IncomingMessage, expectedPort: number): boolean {
  return marketMutationAllowed({
    ...requestContext(req, expectedPort),
  })
}

function asMutation(value: unknown): MarketSourceMutation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid mutation')
  const mutation = value as Record<string, unknown>
  if (
    mutation.action === 'add-builtin'
    && typeof mutation.key === 'string'
    && mutation.key.length > 0
    && mutation.key.length <= 64
  ) return { action: 'add-builtin', key: mutation.key }
  if (mutation.action === 'add-standard' && typeof mutation.manifestUrl === 'string') return { action: 'add-standard', manifestUrl: mutation.manifestUrl }
  if (mutation.action === 'select' && typeof mutation.sourceRecordId === 'string') {
    return { action: 'select', sourceRecordId: mutation.sourceRecordId }
  }
  if (
    mutation.action === 'move'
    && typeof mutation.sourceRecordId === 'string'
    && (mutation.direction === 'up' || mutation.direction === 'down')
  ) {
    return { action: 'move', sourceRecordId: mutation.sourceRecordId, direction: mutation.direction }
  }
  if (mutation.action === 'remove' && typeof mutation.sourceRecordId === 'string') return { action: 'remove', sourceRecordId: mutation.sourceRecordId }
  throw new Error('unsupported mutation')
}

type MarketOperationPreviewRequest =
  | { readonly action: 'install'; readonly sourceRecordId: string; readonly itemId: string }
  | { readonly action: 'uninstall'; readonly receiptId: string }
  | { readonly action: 'disable'; readonly bundleId: string }
  | { readonly action: 'enable'; readonly bundleId: string }

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 240 && !value.includes('\0')
}

function asOperationPreview(value: unknown): MarketOperationPreviewRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MarketInstallError('invalid-request', 'Invalid package operation preview request.')
  }
  const request = value as Record<string, unknown>
  if (
    request.action === 'install'
    && exactKeys(request, ['action', 'sourceRecordId', 'itemId'])
    && boundedIdentifier(request.sourceRecordId)
    && boundedIdentifier(request.itemId)
  ) return { action: 'install', sourceRecordId: request.sourceRecordId, itemId: request.itemId }
  if (
    request.action === 'uninstall'
    && exactKeys(request, ['action', 'receiptId'])
    && boundedIdentifier(request.receiptId)
  ) return { action: 'uninstall', receiptId: request.receiptId }
  if (
    (request.action === 'disable' || request.action === 'enable')
    && exactKeys(request, ['action', 'bundleId'])
    && boundedIdentifier(request.bundleId)
  ) return { action: request.action, bundleId: request.bundleId }
  throw new MarketInstallError('invalid-request', 'Invalid package operation preview request.')
}

function asOperationExecute(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MarketInstallError('invalid-request', 'Invalid package operation execution request.')
  }
  const request = value as Record<string, unknown>
  if (!exactKeys(request, ['previewId']) || !boundedIdentifier(request.previewId)) {
    throw new MarketInstallError('invalid-request', 'Invalid package operation execution request.')
  }
  return request.previewId
}

function asEmptyDesktopAction(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new MarketInstallError('invalid-request', 'The desktop action request must not contain parameters.')
  }
}

function asRestartToken(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MarketInstallError('invalid-request', 'The restart request was invalid.')
  }
  const request = value as Record<string, unknown>
  if (!exactKeys(request, ['restartToken']) || !boundedIdentifier(request.restartToken)) {
    throw new MarketInstallError('invalid-request', 'The restart request was invalid.')
  }
  return request.restartToken
}

async function readOperationJson(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  try {
    return await readJson(req, signal)
  } catch (cause) {
    if (signal.aborted) throw cause
    throw new MarketInstallError('invalid-request', 'The package operation request body was invalid.')
  }
}

export interface MarketInstallServiceProvider {
  get(): MarketInstallService | undefined
}

export interface MarketDesktopActions {
  openTerminal(): void
  requestRestart(): Promise<void>
}

export interface MarketDesktopActionsProvider {
  get(): MarketDesktopActions | undefined
}

export interface MarketDesktopPluginBundle {
  readonly bundleId: string
  readonly packageName: string
  readonly status: 'active' | 'disabled'
  readonly mutable: boolean
}

export interface MarketDesktopPluginDisablePreview {
  readonly previewId: string
  readonly profileName: string
  readonly packageName: string
  readonly expiresAt: string
}

export interface MarketDesktopPluginEnablePreview {
  readonly previewId: string
  readonly profileName: string
  readonly packageName: string
  readonly expiresAt: string
}

export interface MarketDesktopPlugins {
  list(): readonly MarketDesktopPluginBundle[]
  previewDisable(bundleId: string): MarketDesktopPluginDisablePreview
  executeDisable(previewId: string): Promise<{ readonly packageName: string }>
  previewEnable(bundleId: string): MarketDesktopPluginEnablePreview
  executeEnable(previewId: string): Promise<{ readonly packageName: string }>
  isDisabled(packageName: string): boolean
  disabledPackageNames(): readonly string[]
}

export interface MarketDesktopPluginsProvider {
  get(): MarketDesktopPlugins | undefined
}

function validDesktopBundle(value: unknown): value is MarketDesktopPluginBundle {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const bundle = value as Record<string, unknown>
  return exactKeys(bundle, ['bundleId', 'packageName', 'status', 'mutable'])
    && boundedIdentifier(bundle.bundleId)
    && boundedIdentifier(bundle.packageName)
    && (bundle.status === 'active' || bundle.status === 'disabled')
    && typeof bundle.mutable === 'boolean'
}

function reconcileInstallations(
  receipts: readonly MarketInstallReceipt[],
  value: readonly MarketDesktopPluginBundle[],
): readonly MarketInstallationView[] {
  if (!Array.isArray(value) || value.length > 4_096 || !value.every(validDesktopBundle)) {
    throw new MarketInstallError('operation-failed', 'The desktop plugin inventory was invalid.')
  }
  const ids = new Set(value.map(bundle => bundle.bundleId))
  if (ids.size !== value.length) {
    throw new MarketInstallError('operation-failed', 'The desktop plugin inventory was invalid.')
  }
  const packageCounts = new Map<string, number>()
  for (const bundle of value) packageCounts.set(bundle.packageName, (packageCounts.get(bundle.packageName) ?? 0) + 1)
  const receiptsByPackage = new Map(receipts.map(receipt => [receipt.packageName, receipt]))
  return value.flatMap((bundle): readonly MarketInstallationView[] => {
    const receipt = packageCounts.get(bundle.packageName) === 1
      ? receiptsByPackage.get(bundle.packageName)
      : undefined
    if (receipt !== undefined) {
      return bundle.mutable && bundle.status === 'active'
        ? [{
            kind: 'managed',
            status: 'active',
            action: 'uninstall',
            disableBundleId: bundle.bundleId,
            receipt,
          }]
        : bundle.mutable && bundle.status === 'disabled'
        ? [{
            kind: 'managed',
            status: 'disabled',
            action: 'uninstall',
            enableBundleId: bundle.bundleId,
            receipt,
          }]
        : [{ kind: 'managed', status: bundle.status, action: 'uninstall', receipt }]
    }
    if (!bundle.mutable) return []
    return bundle.status === 'active'
      ? [{
          kind: 'external',
          status: 'active',
          action: 'disable',
          bundleId: bundle.bundleId,
          packageName: bundle.packageName,
        }]
      : [{
          kind: 'external',
          status: 'disabled',
          action: 'enable',
          bundleId: bundle.bundleId,
          packageName: bundle.packageName,
        }]
  })
}

function viewBuiltIns(): readonly MarketBuiltInProvider[] {
  return BUILT_IN_PROVIDERS.map(provider => ({ ...provider }))
}

export async function readStandardSourceManifest(
  manifestUrl: string,
  signal: AbortSignal,
  http: CatalogHttpClient = restrictedHttpClient,
): Promise<CatalogSourceManifest> {
  const url = new URL(manifestUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('manifest URL must use credential-free standard HTTPS port 443')
  }
  const response = await http.getJson(url.href, signal, { allowedOrigin: url.origin })
  const manifest = parseCatalogSource(response.value)
  assertStandardSourceTrustRoot(url.href, response.finalUrl, manifest.transport.endpoint)
  return manifest
}

async function mutateSources(
  scope: SettingsScope<MarketSettingsDocument>,
  mutation: MarketSourceMutation,
  signal: AbortSignal,
  onUnavailable?: (sourceRecordId: string) => void,
  readManifest: (
    manifestUrl: string,
    signal: AbortSignal,
  ) => Promise<CatalogSourceManifest> = readStandardSourceManifest,
): Promise<void> {
  signal.throwIfAborted()
  const store = new SettingsCatalogSourceStore(scope)
  const records = [...await store.load()]
  const unavailableSourceRecordIds = new Set<string>()
  const nextOrder = records.reduce((maximum, record) => Math.max(maximum, record.order), -1) + 1
  if (mutation.action === 'add-builtin') {
    const provider = BUILT_IN_PROVIDERS.find(candidate => candidate.key === mutation.key)
    if (provider === undefined) throw new Error('built-in source unavailable')
    if (records.some(record => record.builtInProviderKey === mutation.key)) throw new Error('source already added')
    records.push({
      sourceRecordId: randomUUID(),
      registrationKind: 'built-in',
      adapterId: provider.adapterId,
      providerId: provider.providerId,
      builtInProviderKey: provider.key,
      enabled: false,
      order: nextOrder,
    })
  } else if (mutation.action === 'add-standard') {
    const manifest = await readManifest(mutation.manifestUrl, signal)
    signal.throwIfAborted()
    if (records.some(record => record.manifestUrl === mutation.manifestUrl)) throw new Error('source already added')
    records.push({
      sourceRecordId: randomUUID(),
      registrationKind: 'user-added',
      adapterId: 'market.standard-http-v1',
      providerId: manifest.providerId,
      manifestUrl: mutation.manifestUrl,
      manifest,
      enabled: false,
      order: nextOrder,
    })
  } else if (mutation.action === 'select' || mutation.action === 'remove') {
    const index = records.findIndex(record => record.sourceRecordId === mutation.sourceRecordId)
    if (index < 0) throw new Error('source not found')
    if (mutation.action === 'remove') {
      unavailableSourceRecordIds.add(records[index]!.sourceRecordId)
      records.splice(index, 1)
      records.sort((left, right) => left.order - right.order)
      records.forEach((record, order) => { records[order] = { ...record, order } })
    } else {
      for (const [recordIndex, record] of records.entries()) {
        const enabled = record.sourceRecordId === mutation.sourceRecordId
        if (record.enabled && !enabled) unavailableSourceRecordIds.add(record.sourceRecordId)
        records[recordIndex] = { ...record, enabled }
      }
    }
  } else {
    const ordered = [...records].sort((left, right) => left.order - right.order)
    const index = ordered.findIndex(record => record.sourceRecordId === mutation.sourceRecordId)
    if (index < 0) throw new Error('source not found')
    const targetIndex = mutation.direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= ordered.length) throw new Error('source cannot move further')
    const current = ordered[index]!
    const target = ordered[targetIndex]!
    const currentRecordIndex = records.findIndex(record => record.sourceRecordId === current.sourceRecordId)
    const targetRecordIndex = records.findIndex(record => record.sourceRecordId === target.sourceRecordId)
    records[currentRecordIndex] = { ...current, order: target.order }
    records[targetRecordIndex] = { ...target, order: current.order }
  }
  validateLocalSourceRecords(records)
  signal.throwIfAborted()
  await store.save(records)
  for (const sourceRecordId of unavailableSourceRecordIds) onUnavailable?.(sourceRecordId)
}

export function createMarketSourceMutator(
  scope: SettingsScope<MarketSettingsDocument>,
  onUnavailable?: (sourceRecordId: string) => void,
  readManifest?: (manifestUrl: string, signal: AbortSignal) => Promise<CatalogSourceManifest>,
): (
  mutation: MarketSourceMutation,
  signal: AbortSignal,
) => Promise<void> {
  let tail = Promise.resolve()
  return (mutation, signal) => {
    const pending = tail.then(async () => {
      signal.throwIfAborted()
      await mutateSources(scope, mutation, signal, onUnavailable, readManifest)
    })
    tail = pending.catch(() => {})
    return pending
  }
}

export function registerMarketRoutes(
  ctx: Context,
  scope: SettingsScope<MarketSettingsDocument>,
  installProvider?: MarketInstallServiceProvider,
  desktopActionsProvider?: MarketDesktopActionsProvider,
  desktopPluginsProvider?: MarketDesktopPluginsProvider,
): () => void {
  const expectedPort = ctx.webServer.port
  const generationController = new AbortController()
  type DesktopPluginPreviewBinding = {
    readonly expiresAt: number
    readonly bundleId: string
    readonly packageName: string
    readonly receiptId?: string
  }
  const disablePreviews = new Map<string, DesktopPluginPreviewBinding>()
  const enablePreviews = new Map<string, DesktopPluginPreviewBinding>()
  const desktopPluginRestartTokens = new Map<string, number>()
  const purgeDesktopTokens = () => {
    const now = Date.now()
    for (const [token, preview] of disablePreviews) {
      if (now >= preview.expiresAt) disablePreviews.delete(token)
    }
    for (const [token, preview] of enablePreviews) {
      if (now >= preview.expiresAt) enablePreviews.delete(token)
    }
    for (const [token, expiresAt] of desktopPluginRestartTokens) {
      if (now >= expiresAt) desktopPluginRestartTokens.delete(token)
    }
  }
  const rememberDesktopToken = (tokens: Map<string, number>, token: string, expiresAt: number) => {
    purgeDesktopTokens()
    tokens.set(token, expiresAt)
    while (tokens.size > 256) {
      const oldest = tokens.keys().next().value as string | undefined
      if (oldest === undefined) break
      tokens.delete(oldest)
    }
  }
  const rememberDisablePreview = (
    previewId: string,
    expiresAt: number,
    bundleId: string,
    packageName: string,
    receiptId?: string,
  ) => {
    purgeDesktopTokens()
    disablePreviews.set(previewId, {
      expiresAt,
      bundleId,
      packageName,
      ...(receiptId === undefined ? {} : { receiptId }),
    })
    while (disablePreviews.size > 256) {
      const oldest = disablePreviews.keys().next().value as string | undefined
      if (oldest === undefined) break
      disablePreviews.delete(oldest)
    }
  }
  const rememberEnablePreview = (
    previewId: string,
    expiresAt: number,
    bundleId: string,
    packageName: string,
    receiptId?: string,
  ) => {
    purgeDesktopTokens()
    enablePreviews.set(previewId, {
      expiresAt,
      bundleId,
      packageName,
      ...(receiptId === undefined ? {} : { receiptId }),
    })
    while (enablePreviews.size > 256) {
      const oldest = enablePreviews.keys().next().value as string | undefined
      if (oldest === undefined) break
      enablePreviews.delete(oldest)
    }
  }
  const store = new SettingsCatalogSourceStore(scope)
  const media = createMarketMediaService({
    fetchImage: createRestrictedImageFetcher({
      // These are compiled-in adapter hosts, not names supplied by a remote source.
      syntheticProxyHostnames: [DSH_1024STORE_HOSTNAME, 'github.com', 'avatars.githubusercontent.com'],
    }),
  })
  const service = new DefaultCatalogService(store, restrictedHttpClient, {
    adapterHttpClients: new Map([
      [DSH_1024STORE_ADAPTER_ID, dsh1024StoreHttpClient],
      [DSHFIND_ADAPTER_ID, dshfindHttpClient],
    ]),
    media,
    observeSnapshot: snapshot => installProvider?.get()?.observeCatalog(snapshot),
  })
  const servedCatalogPreviews = new Set<string>()
  const catalogPreviewKey = (sourceRecordId: string, locale: string) => `${sourceRecordId}\0${locale}`
  const mutateSource = createMarketSourceMutator(scope, sourceRecordId => {
    service.invalidateSource(sourceRecordId)
    for (const key of servedCatalogPreviews) {
      if (key.startsWith(`${sourceRecordId}\0`)) servedCatalogPreviews.delete(key)
    }
    installProvider?.get()?.invalidateSource(sourceRecordId)
  })
  const buildCatalogResponse = (
    index: CatalogFullIndex | undefined,
    query: Record<string, unknown>,
    fetchScope: CatalogFetchScope | undefined,
  ): MarketCatalogResponse => {
    const results = index === undefined ? [] : service.queryCatalog(index, query, fetchScope)
    const responseQuery = fetchScope === undefined
      ? query
      : {
          ...query,
          sourceRecordId: fetchScope.sourceRecordId,
          ...(fetchScope.cursor === undefined ? {} : { cursor: fetchScope.cursor }),
        }
    return {
      query: responseQuery,
      results,
      categories: index === undefined ? [] : catalogCategories(index),
      manualInstall: catalogManualInstall(results),
      ...(index === undefined ? {} : { metadata: catalogMetadata(index) }),
      fetchedAt: new Date().toISOString(),
    }
  }
  const persistCatalogResponse = async (
    response: MarketCatalogResponse,
    sourceRecordId: string,
    locale: string,
  ): Promise<void> => {
    const cache = catalogCacheFromResponse(response, sourceRecordId, locale)
    if (cache !== undefined) await scope.update({ catalogCache: cache })
  }
  const settingsScope = scope
  const routes = [
    ctx.webServer.register({ kind: 'exact', path: ROUTE_STATE, handler: async (_req, res) => {
      if (generationController.signal.aborted) return
      if (!requestAllowed(_req, expectedPort)) {
        sendJson(res, 403, { error: 'market request authority rejected' })
        return
      }
      try {
        const desktopActions = desktopActionsProvider?.get()
        const response: MarketStateResponse = {
          sources: await service.listSources(),
          builtIns: viewBuiltIns(),
          desktopActions: {
            openTerminal: desktopActions !== undefined,
            requestRestart: desktopActions !== undefined
              && (installProvider?.get() !== undefined || desktopPluginsProvider?.get() !== undefined),
          },
        }
        if (!generationController.signal.aborted && !res.destroyed) sendJson(res, 200, response)
      } catch {
        if (!generationController.signal.aborted && !res.destroyed) sendJson(res, 500, { error: 'market state unavailable' })
      }
    }}),
    ctx.webServer.register({ kind: 'exact', path: ROUTE_CATALOG, handler: async (req, res) => {
      if (!requestAllowed(req, expectedPort)) {
        sendJson(res, 403, { error: 'market request authority rejected' })
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'market catalog requires GET' })
        return
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, generationController.signal])
      const stopWatching = abortOnDisconnect(req, res, controller)
      let refreshPreviewKey: string | undefined
      try {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost')
        const query: Record<string, unknown> = {}
        const q = requestUrl.searchParams.get('q')?.trim()
        if (q) query.q = q
        const categories = requestUrl.searchParams.getAll('category')
        if (categories.length) query.category = categories
        const limit = Number(requestUrl.searchParams.get('limit') ?? 50)
        if (Number.isInteger(limit)) query.limit = limit
        const sort = requestUrl.searchParams.get('sort')
        if (sort) query.sort = sort
        const locale = requestUrl.searchParams.get('locale')
        if (locale) query.locale = locale
        const refreshValues = requestUrl.searchParams.getAll('refresh')
        if (refreshValues.length > 1 || refreshValues.length === 1 && refreshValues[0] !== '1') {
          throw new Error('invalid catalog refresh flag')
        }
        const force = refreshValues.length === 1

        const sourceRecordIds = requestUrl.searchParams.getAll('sourceRecordId')
        const cursors = requestUrl.searchParams.getAll('cursor')
        if (sourceRecordIds.length > 1 || cursors.length > 1 || cursors.length > sourceRecordIds.length) {
          throw new Error('catalog cursor requires exactly one source record')
        }
        const scope: CatalogFetchScope | undefined = sourceRecordIds.length === 0
          ? undefined
          : {
              sourceRecordId: sourceRecordIds[0]!,
              ...(cursors.length === 0 ? {} : { cursor: cursors[0]! }),
            }
        const activeSource = scope === undefined
          ? undefined
          : (await service.listSources()).find(source => (
              source.enabled && source.sourceRecordId === scope.sourceRecordId
            ))
        if (scope !== undefined && activeSource === undefined) throw new Error('catalog source is not active')
        const localeKey = locale ?? ''
        const previewSourceRecordId = q === undefined
          && categories.length === 0
          && sort === null
          && limit === 50
          && scope !== undefined
          && scope.cursor === undefined
          ? scope.sourceRecordId
          : undefined
        const previewKey = previewSourceRecordId === undefined
          ? undefined
          : catalogPreviewKey(previewSourceRecordId, localeKey)
        if (force) refreshPreviewKey = previewKey
        if (!force && previewKey !== undefined && !servedCatalogPreviews.has(previewKey)) {
          const cached = activeSource === undefined
            ? undefined
            : cachedCatalogResponse(settingsScope.get().catalogCache, activeSource, localeKey)
          if (cached !== undefined) {
            servedCatalogPreviews.add(previewKey)
            if (!signal.aborted && !res.destroyed) sendJson(res, 200, cached)
            return
          }
        }
        let index: CatalogFullIndex | undefined
        try {
          index = await service.scanCatalog(signal, {
            force,
            ...(locale === null || locale === '' ? {} : { locale }),
            ...(scope === undefined ? {} : { expectedSourceRecordId: scope.sourceRecordId }),
          })
        } catch (cause) {
          if (!signal.aborted && !res.destroyed) sendCatalogFailure(res, cause)
          return
        }
        signal.throwIfAborted()
        const response = buildCatalogResponse(index, query, scope)
        if (!signal.aborted && !res.destroyed) sendJson(res, 200, response)
        if (previewKey !== undefined && previewSourceRecordId !== undefined
          && index !== undefined && !generationController.signal.aborted) {
          servedCatalogPreviews.add(previewKey)
          void persistCatalogResponse(response, previewSourceRecordId, localeKey)
        }
      } catch {
        if (refreshPreviewKey !== undefined) servedCatalogPreviews.delete(refreshPreviewKey)
        if (!signal.aborted && !res.destroyed) sendJson(res, 400, { error: 'invalid catalog query' })
      } finally {
        stopWatching()
      }
    }}),
    ctx.webServer.register({ kind: 'exact', path: ROUTE_ASSETS, handler: async (req, res) => {
      if (!requestAllowed(req, expectedPort)) {
        sendJson(res, 403, { error: 'market request authority rejected' })
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'market media requires GET' })
        return
      }
      const requestUrl = new URL(req.url ?? '/', 'http://localhost')
      const refs = requestUrl.searchParams.getAll('ref')
      const assetRef = refs.length === 1 ? refs[0] : undefined
      if (assetRef === undefined || !MARKET_MEDIA_ASSET_REF_PATTERN.test(assetRef)) {
        sendJson(res, 404, { error: 'market media unavailable' })
        return
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, generationController.signal])
      const stopWatching = abortOnDisconnect(req, res, controller)
      try {
        const asset = await media.resolve(assetRef, signal)
        if (signal.aborted || res.destroyed) return
        if (asset === undefined) {
          sendJson(res, 404, { error: 'market media unavailable' })
          return
        }
        res.setHeader('cache-control', 'private, max-age=3600')
        res.setHeader('content-type', asset.contentType)
        res.setHeader('content-length', String(asset.body.byteLength))
        res.setHeader('content-disposition', 'inline')
        res.setHeader('etag', asset.etag)
        res.setHeader('x-content-type-options', 'nosniff')
        res.setHeader('cross-origin-resource-policy', 'same-origin')
        res.setHeader('content-security-policy', "default-src 'none'; sandbox")
        res.setHeader('referrer-policy', 'no-referrer')
        if (req.headers['if-none-match'] === asset.etag) {
          res.statusCode = 304
          res.removeHeader('content-length')
          res.end()
          return
        }
        res.statusCode = 200
        res.end(asset.body)
      } catch {
        if (!signal.aborted && !res.destroyed) sendJson(res, 404, { error: 'market media unavailable' })
      } finally {
        stopWatching()
      }
    }}),
    ctx.webServer.register({ kind: 'exact', path: ROUTE_SOURCES, handler: async (req, res) => {
      if (req.method !== 'POST' || !mutationAllowed(req, expectedPort)) {
        sendJson(res, 405, { error: 'source changes require a local same-origin POST' })
        return
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, generationController.signal])
      const stopWatching = abortOnDisconnect(req, res, controller)
      try {
        const mutation = asMutation(await readJson(req, signal))
        await mutateSource(mutation, signal)
        if (!signal.aborted && !res.destroyed) sendJson(res, 200, { sources: await service.listSources() })
      } catch (cause) {
        if (!signal.aborted && !res.destroyed) {
          sendJson(res, 400, { error: cause instanceof Error ? cause.message : 'source change failed' })
        }
      } finally {
        stopWatching()
      }
    }}),
  ]
  if (desktopActionsProvider !== undefined) {
    routes.push(
      ctx.webServer.register({ kind: 'exact', path: ROUTE_OPEN_TERMINAL, handler: async (req, res) => {
        if (req.method !== 'POST' || !mutationAllowed(req, expectedPort)) {
          sendJson(res, 405, { error: 'opening DSH Terminal requires a local same-origin POST' })
          return
        }
        const actions = desktopActionsProvider.get()
        if (actions === undefined) {
          sendJson(res, 503, { error: 'desktop actions are unavailable' })
          return
        }
        const controller = new AbortController()
        const signal = AbortSignal.any([controller.signal, generationController.signal])
        const stopWatching = abortOnDisconnect(req, res, controller)
        try {
          asEmptyDesktopAction(await readOperationJson(req, signal))
          signal.throwIfAborted()
          actions.openTerminal()
          if (!signal.aborted && !res.destroyed) sendJson(res, 200, { ok: true })
        } catch (cause) {
          if (!signal.aborted && !res.destroyed) sendInstallError(res, cause)
        } finally {
          stopWatching()
        }
      }}),
    )
  }
  if (installProvider !== undefined) {
    routes.push(
      ctx.webServer.register({ kind: 'exact', path: ROUTE_INSTALLABLE, handler: async (req, res) => {
        if (req.method !== 'GET' || !requestAllowed(req, expectedPort)) {
          sendJson(res, 405, { error: 'market installable catalog requires a local GET' })
          return
        }
        const install = installProvider.get()
        if (install === undefined) {
          sendJson(res, 503, { error: 'market package operations are unavailable' })
          return
        }
        const controller = new AbortController()
        const signal = AbortSignal.any([controller.signal, generationController.signal])
        const stopWatching = abortOnDisconnect(req, res, controller)
        try {
          const requestUrl = new URL(req.url ?? '/', 'http://localhost')
          const localeValues = requestUrl.searchParams.getAll('locale')
          const refreshValues = requestUrl.searchParams.getAll('refresh')
          if (
            localeValues.length > 1
            || refreshValues.length > 1
            || refreshValues.length === 1 && refreshValues[0] !== '1'
          ) throw new MarketInstallError('invalid-request', 'The installable catalog query was invalid.')
          const force = refreshValues.length === 1
          const localeKey = localeValues[0] ?? ''
          const index = await service.scanCatalog(signal, {
            force,
            ...(localeKey === '' ? {} : { locale: localeKey }),
          })
          if (index === undefined) {
            throw new MarketInstallError('not-available', 'No catalog source is active.')
          }
          const response = await install.listInstallable(index, signal)
          if (!signal.aborted && !res.destroyed) sendJson(res, 200, response)
          if (!generationController.signal.aborted) {
            servedCatalogPreviews.add(catalogPreviewKey(index.source.sourceRecordId, localeKey))
            const preview = buildCatalogResponse(
              index,
              { limit: 50, ...(localeKey === '' ? {} : { locale: localeKey }) },
              { sourceRecordId: index.source.sourceRecordId },
            )
            void persistCatalogResponse(preview, index.source.sourceRecordId, localeKey)
          }
        } catch (cause) {
          if (!signal.aborted && !res.destroyed) sendInstallError(res, cause)
        } finally {
          stopWatching()
        }
      }}),
      ctx.webServer.register({ kind: 'exact', path: ROUTE_INSTALLATIONS, handler: async (req, res) => {
        if (req.method !== 'GET' || !requestAllowed(req, expectedPort)) {
          sendJson(res, 405, { error: 'market installations require a local GET' })
          return
        }
        const install = installProvider.get()
        const desktopPlugins = desktopPluginsProvider?.get()
        if (install === undefined || desktopPlugins === undefined) {
          sendJson(res, 503, { error: 'market package operations are unavailable' })
          return
        }
        try {
          const installations = reconcileInstallations(await install.listVerifiedReceipts(), desktopPlugins.list())
          if (!generationController.signal.aborted && !res.destroyed) sendJson(res, 200, { installations })
        } catch (cause) {
          if (!generationController.signal.aborted && !res.destroyed) sendInstallError(res, cause)
        }
      }}),
      ctx.webServer.register({ kind: 'exact', path: ROUTE_OPERATION_PREVIEW, handler: async (req, res) => {
        if (req.method !== 'POST' || !mutationAllowed(req, expectedPort)) {
          sendJson(res, 405, { error: 'market package previews require a local same-origin POST' })
          return
        }
        const controller = new AbortController()
        const signal = AbortSignal.any([controller.signal, generationController.signal])
        const stopWatching = abortOnDisconnect(req, res, controller)
        try {
          const request = asOperationPreview(await readOperationJson(req, signal))
          if (request.action === 'disable' || request.action === 'enable') {
            const desktopPlugins = desktopPluginsProvider?.get()
            const install = installProvider.get()
            if (desktopPlugins === undefined || install === undefined) {
              throw new MarketInstallError('not-available', 'Desktop plugin management is unavailable.')
            }
            const inventory = desktopPlugins.list()
            const target = inventory.find(bundle => bundle.bundleId === request.bundleId)
            if (target === undefined) {
              throw new MarketInstallError('not-available', 'The selected plugin bundle is no longer available.')
            }
            const expectedStatus = request.action === 'disable' ? 'active' : 'disabled'
            if (!target.mutable || target.status !== expectedStatus) {
              throw new MarketInstallError(
                'conflict',
                request.action === 'disable'
                  ? 'The selected plugin bundle can no longer be disabled.'
                  : 'The selected plugin bundle can no longer be enabled.',
              )
            }
            const matchingReceipts = (await install.listVerifiedReceipts(signal))
              .filter(receipt => receipt.packageName === target.packageName)
            const packageBundleCount = inventory.filter(bundle => bundle.packageName === target.packageName).length
            const managedReceipt = matchingReceipts.length === 1 && packageBundleCount === 1
              ? matchingReceipts[0]
              : undefined
            if (matchingReceipts.length > 0 && managedReceipt === undefined) {
              throw new MarketInstallError('conflict', 'The selected plugin bundle ownership is ambiguous.')
            }
            let preview: MarketDesktopPluginDisablePreview | MarketDesktopPluginEnablePreview
            try {
              preview = request.action === 'disable'
                ? desktopPlugins.previewDisable(request.bundleId)
                : desktopPlugins.previewEnable(request.bundleId)
            } catch {
              throw new MarketInstallError(
                'conflict',
                request.action === 'disable'
                  ? 'The selected plugin bundle can no longer be disabled.'
                  : 'The selected plugin bundle can no longer be enabled.',
              )
            }
            const expiresAt = Date.parse(preview.expiresAt)
            if (
              !boundedIdentifier(preview.previewId)
              || !boundedIdentifier(preview.profileName)
              || !boundedIdentifier(preview.packageName)
              || !Number.isFinite(expiresAt)
              || expiresAt <= Date.now()
            ) throw new MarketInstallError(
              'operation-failed',
              request.action === 'disable'
                ? 'The desktop plugin disable preview was invalid.'
                : 'The desktop plugin enable preview was invalid.',
            )
            if (preview.packageName !== target.packageName) {
              throw new MarketInstallError('conflict', 'The selected plugin bundle changed during preview.')
            }
            if (request.action === 'disable') {
              rememberDisablePreview(
                preview.previewId,
                expiresAt,
                request.bundleId,
                preview.packageName,
                managedReceipt?.receiptId,
              )
            } else {
              rememberEnablePreview(
                preview.previewId,
                expiresAt,
                request.bundleId,
                preview.packageName,
                managedReceipt?.receiptId,
              )
            }
            if (!signal.aborted && !res.destroyed) {
              sendJson(res, 200, {
                action: request.action,
                profileName: preview.profileName,
                packageName: preview.packageName,
                displayName: preview.packageName,
                expiresAt: preview.expiresAt,
                previewId: preview.previewId,
              })
            }
          } else {
            const install = installProvider.get()
            if (install === undefined) {
              throw new MarketInstallError('not-available', 'Market package operations are unavailable.')
            }
            const preview = request.action === 'install'
              ? await install.previewInstall(request.sourceRecordId, request.itemId, signal)
              : await install.previewUninstall(request.receiptId, signal)
            const { intent, ...summary } = preview
            if (!signal.aborted && !res.destroyed) sendJson(res, 200, { ...summary, previewId: intent })
          }
        } catch (cause) {
          if (!signal.aborted && !res.destroyed) sendInstallError(res, cause)
        } finally {
          stopWatching()
        }
      }}),
      ctx.webServer.register({ kind: 'exact', path: ROUTE_OPERATION_EXECUTE, handler: async (req, res) => {
        if (req.method !== 'POST' || !mutationAllowed(req, expectedPort)) {
          sendJson(res, 405, { error: 'market package execution requires a local same-origin POST' })
          return
        }
        const controller = new AbortController()
        const signal = AbortSignal.any([controller.signal, generationController.signal])
        const stopWatching = abortOnDisconnect(req, res, controller)
        try {
          const previewId = asOperationExecute(await readOperationJson(req, signal))
          // Once the Host accepts a confirmed mutation it owns the transaction.
          // Closing the Market surface may stop the HTTP response, but must not
          // interrupt profile writes between pnpm, post-checks, and the receipt.
          purgeDesktopTokens()
          let result: unknown
          const disablePreview = disablePreviews.get(previewId)
          const enablePreview = enablePreviews.get(previewId)
          if (disablePreview !== undefined || enablePreview !== undefined) {
            disablePreviews.delete(previewId)
            enablePreviews.delete(previewId)
            const desktopPreview = disablePreview ?? enablePreview!
            const action = disablePreview === undefined ? 'enable' : 'disable'
            const desktopPlugins = desktopPluginsProvider?.get()
            const install = installProvider.get()
            if (desktopPlugins === undefined || install === undefined) {
              throw new MarketInstallError('not-available', 'Desktop plugin management is unavailable.')
            }
            const currentInventory = desktopPlugins.list()
            const currentTarget = currentInventory
              .find(bundle => bundle.bundleId === desktopPreview.bundleId)
            const expectedStatus = action === 'disable' ? 'active' : 'disabled'
            if (
              currentTarget === undefined
              || currentTarget.packageName !== desktopPreview.packageName
              || !currentTarget.mutable
              || currentTarget.status !== expectedStatus
            ) {
              throw new MarketInstallError(
                'conflict',
                action === 'disable'
                  ? 'The selected plugin bundle changed before it could be disabled.'
                  : 'The selected plugin bundle changed before it could be enabled.',
              )
            }
            const matchingReceipts = (await install.listVerifiedReceipts(generationController.signal))
              .filter(receipt => receipt.packageName === desktopPreview.packageName)
            if (action === 'disable') {
              const packageBundleCount = currentInventory
                .filter(bundle => bundle.packageName === desktopPreview.packageName).length
              const ownershipUnchanged = desktopPreview.receiptId === undefined
                ? matchingReceipts.length === 0
                : packageBundleCount === 1
                  && matchingReceipts.length === 1
                  && matchingReceipts[0]?.receiptId === desktopPreview.receiptId
              if (!ownershipUnchanged) {
                throw new MarketInstallError('conflict', 'The selected plugin ownership changed before it could be disabled.')
              }
            }
            if (action === 'enable') {
              const receiptUnchanged = desktopPreview.receiptId === undefined
                ? matchingReceipts.length === 0
                : matchingReceipts.length === 1 && matchingReceipts[0]?.receiptId === desktopPreview.receiptId
              if (!receiptUnchanged) {
                throw new MarketInstallError('conflict', 'The selected plugin ownership changed before it could be enabled.')
              }
            }
            let changed: { readonly packageName: string }
            try {
              changed = action === 'disable'
                ? await desktopPlugins.executeDisable(previewId)
                : await desktopPlugins.executeEnable(previewId)
            } catch {
              throw new MarketInstallError(
                'conflict',
                action === 'disable'
                  ? 'The selected plugin bundle changed before it could be disabled.'
                  : 'The selected plugin bundle changed before it could be enabled.',
              )
            }
            if (!boundedIdentifier(changed.packageName) || changed.packageName !== desktopPreview.packageName) {
              throw new MarketInstallError(
                'operation-failed',
                action === 'disable'
                  ? 'The desktop plugin disable result was invalid.'
                  : 'The desktop plugin enable result was invalid.',
              )
            }
            const restartToken = randomUUID()
            rememberDesktopToken(desktopPluginRestartTokens, restartToken, Date.now() + 5 * 60 * 1000)
            result = { action, packageName: changed.packageName, restartToken }
          } else {
            const install = installProvider.get()
            if (install === undefined) {
              throw new MarketInstallError('not-available', 'Market package operations are unavailable.')
            }
            result = await install.executePreview(previewId, generationController.signal)
          }
          if (!signal.aborted && !res.destroyed) sendJson(res, 200, result)
        } catch (cause) {
          if (!signal.aborted && !res.destroyed) sendInstallError(res, cause)
        } finally {
          stopWatching()
        }
      }}),
    )
  }
  if (desktopActionsProvider !== undefined) {
    routes.push(ctx.webServer.register({ kind: 'exact', path: ROUTE_REQUEST_RESTART, handler: async (req, res) => {
      if (req.method !== 'POST' || !mutationAllowed(req, expectedPort)) {
        sendJson(res, 405, { error: 'requesting a restart requires a local same-origin POST' })
        return
      }
      const actions = desktopActionsProvider.get()
      if (actions === undefined) {
        sendJson(res, 503, { error: 'desktop restart is unavailable' })
        return
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, generationController.signal])
      const stopWatching = abortOnDisconnect(req, res, controller)
      try {
        const restartToken = asRestartToken(await readOperationJson(req, signal))
        signal.throwIfAborted()
        purgeDesktopTokens()
        if (!desktopPluginRestartTokens.delete(restartToken)) {
          const install = installProvider?.get()
          if (install === undefined) {
            throw new MarketInstallError('intent-expired', 'The restart confirmation expired or was already used.')
          }
          install.consumeRestartToken(restartToken)
        }
        // Once the Host consumes the one-shot grant it owns the restart. A
        // renderer disconnect may drop the acknowledgement, but must not burn
        // the token without performing the accepted action.
        if (!res.destroyed) sendJson(res, 200, { ok: true })
        try {
          void actions.requestRestart().catch(() => {
            ctx.logger.error('dsh-community-market: desktop restart request failed')
          })
        } catch {
          ctx.logger.error('dsh-community-market: desktop restart request failed')
        }
      } catch (cause) {
        if (!signal.aborted && !res.destroyed) sendInstallError(res, cause)
      } finally {
        stopWatching()
      }
    }}))
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    generationController.abort(new DOMException('Market plugin generation was disposed', 'AbortError'))
    disablePreviews.clear()
    enablePreviews.clear()
    desktopPluginRestartTokens.clear()
    media.dispose()
    routes.forEach(dispose => dispose())
  }
}

export function registerMarketSettings(ctx: Context): SettingsScope<MarketSettingsDocument> {
  return ctx.settings.register(MARKET_SETTINGS_NAMESPACE, SETTINGS_SCHEMA, { applies: 'live' })
}

export const marketRoutes = {
  state: ROUTE_STATE,
  sources: ROUTE_SOURCES,
  catalog: ROUTE_CATALOG,
  installable: ROUTE_INSTALLABLE,
  assets: ROUTE_ASSETS,
  installations: ROUTE_INSTALLATIONS,
  openTerminal: ROUTE_OPEN_TERMINAL,
  requestRestart: ROUTE_REQUEST_RESTART,
  operationPreview: ROUTE_OPERATION_PREVIEW,
  operationExecute: ROUTE_OPERATION_EXECUTE,
}
