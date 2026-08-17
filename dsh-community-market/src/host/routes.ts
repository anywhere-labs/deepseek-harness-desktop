import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BlockList, isIP } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import type { CatalogSourceManifest } from '../contracts/index.js'
import { parseCatalogSource, validateLocalSourceRecords } from '../contracts/validate.js'
import type { MarketBuiltInProvider, MarketCatalogResponse, MarketSourceMutation, MarketStateResponse } from '../api-types.js'
import { restrictedHttpClient } from '../network/restricted-http.js'
import { DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_KEY, DSH_1024STORE_PROVIDER_ID } from '../adapters/dsh-1024store.js'
import { BUILT_IN_PROVIDERS, DefaultCatalogService } from '../catalog/service.js'
import { SettingsCatalogSourceStore, type MarketSettingsDocument } from '../catalog/source-store.js'

export const MARKET_SETTINGS_NAMESPACE = settingsNamespace('dsh-community-market')
const SOURCE_SCHEMA = z.object({
  sourceRecordId: z.string().required(),
  registrationKind: z.union(['user-added', 'built-in'] as const).required(),
  adapterId: z.string().required(),
  providerId: z.string().required(),
  manifestUrl: z.string(),
  builtInProviderKey: z.string(),
  enabled: z.boolean().required(),
  order: z.number().required(),
})
const SETTINGS_SCHEMA = z.object({
  sources: z.array(SOURCE_SCHEMA).default([]),
}) as unknown as z<MarketSettingsDocument>

const ROUTE_STATE = '/api/community-market/state'
const ROUTE_SOURCES = '/api/community-market/sources'
const ROUTE_CATALOG = '/api/community-market/catalog'
const MAX_BODY_BYTES = 16 * 1024

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
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

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(buffer)
    })
    req.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.once('error', reject)
  })
}

const loopbackAddresses = new BlockList()
loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
loopbackAddresses.addSubnet('::1', 128, 'ipv6')

export interface MarketMutationContext {
  readonly remoteAddress: string | undefined
  readonly origin: string | undefined
  readonly host: string | undefined
}

export function marketMutationAllowed(context: MarketMutationContext): boolean {
  if (context.remoteAddress === undefined || context.origin === undefined || context.host === undefined) return false
  const address = context.remoteAddress.replace(/^\[|\]$/gu, '').split('%', 1)[0]!
  const family = isIP(address)
  if (family === 0 || !loopbackAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6')) return false
  return context.origin === `http://${context.host}`
}

function mutationAllowed(req: IncomingMessage): boolean {
  return marketMutationAllowed({
    remoteAddress: req.socket.remoteAddress,
    origin: req.headers.origin,
    host: req.headers.host,
  })
}

function asMutation(value: unknown): MarketSourceMutation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid mutation')
  const mutation = value as Record<string, unknown>
  if (mutation.action === 'add-builtin' && mutation.key === DSH_1024STORE_KEY) return { action: 'add-builtin', key: DSH_1024STORE_KEY }
  if (mutation.action === 'add-standard' && typeof mutation.manifestUrl === 'string') return { action: 'add-standard', manifestUrl: mutation.manifestUrl }
  if (mutation.action === 'set-enabled' && typeof mutation.sourceRecordId === 'string' && typeof mutation.enabled === 'boolean') {
    return { action: 'set-enabled', sourceRecordId: mutation.sourceRecordId, enabled: mutation.enabled }
  }
  if (mutation.action === 'remove' && typeof mutation.sourceRecordId === 'string') return { action: 'remove', sourceRecordId: mutation.sourceRecordId }
  throw new Error('unsupported mutation')
}

function viewBuiltIns(): readonly MarketBuiltInProvider[] {
  return BUILT_IN_PROVIDERS.map(provider => ({ ...provider }))
}

async function readManifest(manifestUrl: string, signal: AbortSignal): Promise<CatalogSourceManifest> {
  const url = new URL(manifestUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('manifest URL must be credential-free HTTPS')
  const response = await restrictedHttpClient.getJson(url.href, signal)
  return parseCatalogSource(response.value)
}

async function mutateSources(scope: SettingsScope<MarketSettingsDocument>, mutation: MarketSourceMutation, signal: AbortSignal): Promise<void> {
  const store = new SettingsCatalogSourceStore(scope)
  const records = [...await store.load()]
  if (mutation.action === 'add-builtin') {
    if (records.some(record => record.builtInProviderKey === mutation.key)) throw new Error('source already added')
    records.push({
      sourceRecordId: randomUUID(),
      registrationKind: 'built-in',
      adapterId: DSH_1024STORE_ADAPTER_ID,
      providerId: DSH_1024STORE_PROVIDER_ID,
      builtInProviderKey: mutation.key,
      enabled: false,
      order: records.length,
    })
  } else if (mutation.action === 'add-standard') {
    const manifest = await readManifest(mutation.manifestUrl, signal)
    if (records.some(record => record.manifestUrl === mutation.manifestUrl)) throw new Error('source already added')
    records.push({
      sourceRecordId: randomUUID(),
      registrationKind: 'user-added',
      adapterId: 'market.standard-http-v1',
      providerId: manifest.providerId,
      manifestUrl: mutation.manifestUrl,
      enabled: false,
      order: records.length,
    })
  } else {
    const index = records.findIndex(record => record.sourceRecordId === mutation.sourceRecordId)
    if (index < 0) throw new Error('source not found')
    if (mutation.action === 'remove') {
      records.splice(index, 1)
      records.forEach((record, order) => { records[order] = { ...record, order } })
    } else records[index] = { ...records[index]!, enabled: mutation.enabled }
  }
  validateLocalSourceRecords(records)
  await store.save(records)
}

export function registerMarketRoutes(ctx: Context, scope: SettingsScope<MarketSettingsDocument>): () => void {
  const store = new SettingsCatalogSourceStore(scope)
  const service = new DefaultCatalogService(store, restrictedHttpClient)
  const routes = [
    ctx.webServer.register({ kind: 'exact', path: ROUTE_STATE, handler: async (_req, res) => {
      try {
        const response: MarketStateResponse = { sources: await service.listSources(), builtIns: viewBuiltIns() }
        sendJson(res, 200, response)
      } catch {
        sendJson(res, 500, { error: 'market state unavailable' })
      }
    }}),
    ctx.webServer.register({ kind: 'exact', path: ROUTE_CATALOG, handler: async (req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost')
      const query: Record<string, unknown> = {}
      const q = requestUrl.searchParams.get('q')?.trim()
      if (q) query.q = q
      const categories = requestUrl.searchParams.getAll('category')
      if (categories.length) query.category = categories
      const limit = Number(requestUrl.searchParams.get('limit') ?? 20)
      if (Number.isInteger(limit)) query.limit = limit
      const sort = requestUrl.searchParams.get('sort')
      if (sort) query.sort = sort
      const locale = requestUrl.searchParams.get('locale')
      if (locale) query.locale = locale
      const controller = new AbortController()
      const stopWatching = abortOnDisconnect(req, res, controller)
      try {
        const results = await service.fetch(query, controller.signal)
        const response: MarketCatalogResponse = { query, results, fetchedAt: new Date().toISOString() }
        if (!controller.signal.aborted && !res.destroyed) sendJson(res, 200, response)
      } catch {
        if (!controller.signal.aborted && !res.destroyed) sendJson(res, 400, { error: 'invalid catalog query' })
      } finally {
        stopWatching()
      }
    }}),
    ctx.webServer.register({ kind: 'exact', path: ROUTE_SOURCES, handler: async (req, res) => {
      if (req.method !== 'POST' || !mutationAllowed(req)) {
        sendJson(res, 405, { error: 'source changes require a local same-origin POST' })
        return
      }
      const controller = new AbortController()
      const stopWatching = abortOnDisconnect(req, res, controller)
      try {
        const mutation = asMutation(await readJson(req))
        await mutateSources(scope, mutation, controller.signal)
        if (!controller.signal.aborted && !res.destroyed) sendJson(res, 200, { sources: await service.listSources() })
      } catch (cause) {
        if (!controller.signal.aborted && !res.destroyed) {
          sendJson(res, 400, { error: cause instanceof Error ? cause.message : 'source change failed' })
        }
      } finally {
        stopWatching()
      }
    }}),
  ]
  return () => { routes.forEach(dispose => dispose()) }
}

export function registerMarketSettings(ctx: Context): SettingsScope<MarketSettingsDocument> {
  return ctx.settings.register(MARKET_SETTINGS_NAMESPACE, SETTINGS_SCHEMA, { applies: 'live' })
}

export const marketRoutes = { state: ROUTE_STATE, sources: ROUTE_SOURCES, catalog: ROUTE_CATALOG }
