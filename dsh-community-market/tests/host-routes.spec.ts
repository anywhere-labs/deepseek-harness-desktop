import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DSH_1024STORE_ADAPTER_ID,
  DSH_1024STORE_ENDPOINT,
  DSH_1024STORE_KEY,
  DSH_1024STORE_PROVIDER_ID,
} from '../src/adapters/dsh-1024store.js'
import {
  DSHFIND_ADAPTER_ID,
  DSHFIND_ENDPOINT,
  DSHFIND_KEY,
  DSHFIND_PROVIDER_ID,
} from '../src/adapters/dshfind.js'
import type { MarketSettingsDocument } from '../src/catalog/source-store.js'
import type { CatalogSourceManifest, LocalSourceRecord } from '../src/contracts/index.js'
import { marketRoutes, registerMarketRoutes } from '../src/host/routes.js'
import { restrictedHttpClient } from '../src/network/restricted-http.js'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as unknown
}

interface MarketServer {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

interface SharedMarketSettings {
  document: MarketSettingsDocument
}

function localHeaders(server: MarketServer, origin = server.baseUrl): Record<string, string> {
  return {
    host: new URL(server.baseUrl).host,
    origin,
  }
}

async function readRoute(server: MarketServer, path: string, signal?: AbortSignal): Promise<Response> {
  return await fetch(`${server.baseUrl}${path}`, {
    headers: localHeaders(server),
    ...(signal === undefined ? {} : { signal }),
  })
}

async function mutateSource(server: MarketServer, mutation: unknown, origin = server.baseUrl): Promise<Response> {
  return await fetch(`${server.baseUrl}${marketRoutes.sources}`, {
    method: 'POST',
    headers: {
      ...localHeaders(server, origin),
      'content-type': 'application/json',
    },
    body: JSON.stringify(mutation),
  })
}

const standardManifest = fixture('../docs/examples/catalog-source.example.json') as CatalogSourceManifest

const builtInSource = (overrides: Partial<LocalSourceRecord> = {}): LocalSourceRecord => ({
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'built-in',
  adapterId: DSH_1024STORE_ADAPTER_ID,
  providerId: DSH_1024STORE_PROVIDER_ID,
  builtInProviderKey: DSH_1024STORE_KEY,
  enabled: false,
  order: 0,
  ...overrides,
})

const dshfindSource = (overrides: Partial<LocalSourceRecord> = {}): LocalSourceRecord => ({
  sourceRecordId: '038f1f77-a5c4-7b73-a9ae-0242ac120004',
  registrationKind: 'built-in',
  adapterId: DSHFIND_ADAPTER_ID,
  providerId: DSHFIND_PROVIDER_ID,
  builtInProviderKey: DSHFIND_KEY,
  enabled: false,
  order: 1,
  ...overrides,
})

const standardSource = (overrides: Partial<LocalSourceRecord> = {}): LocalSourceRecord => ({
  sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
  registrationKind: 'user-added',
  adapterId: 'market.standard-http-v1',
  providerId: 'org.example.community-catalog',
  manifestUrl: 'https://plugins.example.org/catalog-source.json',
  manifest: standardManifest,
  enabled: false,
  order: 1,
  ...overrides,
})

async function startMarketServer(
  initialSources: readonly LocalSourceRecord[],
  sharedSettings?: SharedMarketSettings,
): Promise<MarketServer> {
  const routes = new Map<string, RouteHandler>()
  const settings = sharedSettings ?? { document: { sources: initialSources } }
  const scope = {
    get: () => settings.document,
    update: async (patch: object) => {
      settings.document = { ...settings.document, ...patch as Partial<MarketSettingsDocument> }
    },
  } as unknown as SettingsScope<MarketSettingsDocument>
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    void Promise.resolve(handler(req, res)).catch((cause: unknown) => {
      res.statusCode = 500
      res.end(cause instanceof Error ? cause.message : String(cause))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  const ctx = {
    webServer: {
      port,
      register: (route: { readonly path: string; readonly handler: RouteHandler }) => {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
    logger: { error: vi.fn() },
  } as unknown as Context
  const disposeRoutes = registerMarketRoutes(ctx, scope)
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      disposeRoutes()
      await closeServer(server)
    },
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })
}

describe('community market Host routes', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('returns settings-backed source state with built-in provider metadata', async () => {
    const server = await startMarketServer([builtInSource()])
    try {
      const response = await readRoute(server, marketRoutes.state)

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      await expect(response.json()).resolves.toMatchObject({
        sources: [{
          sourceRecordId: builtInSource().sourceRecordId,
          name: 'DSH 1024Store',
          endpoint: DSH_1024STORE_ENDPOINT,
          partnership: true,
          enabled: false,
        }],
        builtIns: [
          {
            key: DSH_1024STORE_KEY,
            providerId: DSH_1024STORE_PROVIDER_ID,
            partnership: true,
          },
          {
            key: DSHFIND_KEY,
            providerId: DSHFIND_PROVIDER_ID,
            endpoint: DSHFIND_ENDPOINT,
            partnership: true,
          },
        ],
      })
    } finally {
      await server.close()
    }
  })

  it('normalizes catalog query parameters and returns aggregated source results', async () => {
    const activeSource = standardSource({ enabled: true, order: 0 })
    const providerPage = fixture('../docs/examples/catalog-provider-page.example.json') as {
      readonly items: readonly unknown[]
      readonly [key: string]: unknown
    }
    const getJson = vi.spyOn(restrictedHttpClient, 'getJson')
      .mockResolvedValueOnce({
        value: standardManifest,
        finalUrl: activeSource.manifestUrl!,
      })
      .mockResolvedValueOnce({
        value: { ...providerPage, page: { total: 1 } },
        finalUrl: 'https://plugins.example.org/v1/plugins?limit=50',
      })
    const server = await startMarketServer([activeSource])
    try {
      const response = await readRoute(
        server,
        `${marketRoutes.catalog}?q=%20sidebar%20&category=interface&limit=15&sort=updated&locale=zh-CN`,
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({
        query: {
          q: 'sidebar',
          category: ['interface'],
          limit: 15,
          sort: 'updated',
          locale: 'zh-CN',
        },
        results: [{
          source: { sourceRecordId: activeSource.sourceRecordId },
          stale: false,
          snapshot: {
            items: [{
              id: 'better-sidebar',
              provenance: { sourceRecordId: activeSource.sourceRecordId },
            }],
          },
        }],
        categories: ['interface'],
        metadata: {
          scannedAt: expect.any(String),
          expiresAt: expect.any(String),
          providerRevision: '2026-08-17T08:00:00Z',
          cacheStatus: 'fresh',
        },
      })
      expect(body.fetchedAt).toEqual(expect.any(String))
      expect(getJson).toHaveBeenCalledTimes(2)
      expect(getJson).toHaveBeenNthCalledWith(
        1,
        activeSource.manifestUrl,
        expect.any(AbortSignal),
        { allowedOrigin: 'https://plugins.example.org' },
      )
      expect(getJson).toHaveBeenNthCalledWith(
        2,
        'https://plugins.example.org/v1/plugins?limit=50',
        expect.any(AbortSignal),
        { allowedOrigin: 'https://plugins.example.org' },
      )
    } finally {
      await server.close()
    }
  })

  it('serves the persisted first page before a restarted Host refresh completes', async () => {
    const activeSource = standardSource({ enabled: true, order: 0 })
    const providerPage = fixture('../docs/examples/catalog-provider-page.example.json') as {
      readonly items: readonly unknown[]
      readonly [key: string]: unknown
    }
    let requests = 0
    const getJson = vi.spyOn(restrictedHttpClient, 'getJson').mockImplementation(async (_url, signal) => {
      requests += 1
      if (requests === 1) return { value: standardManifest, finalUrl: activeSource.manifestUrl! }
      if (requests === 2) return {
        value: { ...providerPage, page: { total: 1 } },
        finalUrl: 'https://plugins.example.org/v1/plugins?limit=50',
      }
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const settings: SharedMarketSettings = { document: { sources: [activeSource] } }
    const first = await startMarketServer([], settings)
    try {
      const firstResponse = await readRoute(
        first,
        `${marketRoutes.catalog}?sourceRecordId=${activeSource.sourceRecordId}&limit=50&locale=en`,
      )
      expect(firstResponse.status).toBe(200)
      await vi.waitFor(() => expect(settings.document.catalogCache).toBeDefined())
    } finally {
      await first.close()
    }

    const second = await startMarketServer([], settings)
    try {
      const startedAt = Date.now()
      const secondResponse = await readRoute(
        second,
        `${marketRoutes.catalog}?sourceRecordId=${activeSource.sourceRecordId}&limit=50&locale=en`,
      )
      expect(Date.now() - startedAt).toBeLessThan(500)
      expect(secondResponse.status).toBe(200)
      await expect(secondResponse.json()).resolves.toMatchObject({
        results: [{ stale: true, snapshot: { items: [{ id: 'better-sidebar' }] } }],
        metadata: { cacheStatus: 'cached' },
      })
      expect(requests).toBe(2)

      const refreshController = new AbortController()
      const refresh = readRoute(
        second,
        `${marketRoutes.catalog}?sourceRecordId=${activeSource.sourceRecordId}&limit=50&locale=en&refresh=1`,
        refreshController.signal,
      )
      await vi.waitFor(() => expect(requests).toBe(3))
      refreshController.abort()
      await expect(refresh).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await second.close()
      getJson.mockRestore()
    }
  })

  it.each([
    [DSH_1024STORE_KEY, DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_PROVIDER_ID, 'DSH 1024Store'],
    [DSHFIND_KEY, DSHFIND_ADAPTER_ID, DSHFIND_PROVIDER_ID, 'dshfind'],
  ] as const)('adds reviewed built-in provider %s as a disabled source', async (key, adapterId, providerId, name) => {
    const server = await startMarketServer([])
    try {
      const response = await mutateSource(server, {
        action: 'add-builtin',
        key,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        sources: [{
          registrationKind: 'built-in',
          adapterId,
          providerId,
          builtInProviderKey: key,
          enabled: false,
          order: 0,
          name,
        }],
      })
    } finally {
      await server.close()
    }
  })

  it('selects exactly one of two built-in sources', async () => {
    const current = builtInSource({ enabled: true })
    const replacement = dshfindSource()
    const server = await startMarketServer([current, replacement])
    try {
      const response = await mutateSource(server, {
        action: 'select',
        sourceRecordId: replacement.sourceRecordId,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        sources: [
          { builtInProviderKey: DSH_1024STORE_KEY, enabled: false },
          { builtInProviderKey: DSHFIND_KEY, enabled: true },
        ],
      })
    } finally {
      await server.close()
    }
  })

  it('rejects an unknown built-in provider key without changing settings', async () => {
    const server = await startMarketServer([])
    try {
      const response = await mutateSource(server, {
        action: 'add-builtin',
        key: 'attacker-controlled-provider',
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'built-in source unavailable' })
      const state = await readRoute(server, marketRoutes.state)
      await expect(state.json()).resolves.toMatchObject({ sources: [] })
    } finally {
      await server.close()
    }
  })

  it('selects one source and disables the previously active source', async () => {
    const existing = builtInSource()
    const previouslyActive = standardSource({ enabled: true })
    const server = await startMarketServer([existing, previouslyActive])
    try {
      const response = await mutateSource(server, {
        action: 'select',
        sourceRecordId: existing.sourceRecordId,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        sources: [
          { sourceRecordId: existing.sourceRecordId, enabled: true },
          { sourceRecordId: previouslyActive.sourceRecordId, enabled: false },
        ],
      })
      const state = await readRoute(server, marketRoutes.state)
      await expect(state.json()).resolves.toMatchObject({
        sources: [
          { sourceRecordId: existing.sourceRecordId, enabled: true },
          { sourceRecordId: previouslyActive.sourceRecordId, enabled: false },
        ],
      })
    } finally {
      await server.close()
    }
  })

  it('removes a source and compacts the remaining source order', async () => {
    const removed = builtInSource()
    const remaining = standardSource()
    const server = await startMarketServer([removed, remaining])
    try {
      const response = await mutateSource(server, {
        action: 'remove',
        sourceRecordId: removed.sourceRecordId,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        sources: [{ sourceRecordId: remaining.sourceRecordId, order: 0 }],
      })
      const state = await readRoute(server, marketRoutes.state)
      const body = await state.json()
      expect(body.sources).toHaveLength(1)
      expect(body.sources[0]).toMatchObject({
        sourceRecordId: remaining.sourceRecordId,
        order: 0,
      })
    } finally {
      await server.close()
    }
  })

  it('adds a disabled standard source after validating its HTTPS manifest', async () => {
    const manifestUrl = 'https://plugins.example.org/catalog-source.json'
    const getJson = vi.spyOn(restrictedHttpClient, 'getJson').mockResolvedValue({
      value: fixture('../docs/examples/catalog-source.example.json'),
      finalUrl: manifestUrl,
    })
    const server = await startMarketServer([])
    try {
      const response = await mutateSource(server, {
        action: 'add-standard',
        manifestUrl,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        sources: [{
          registrationKind: 'user-added',
          adapterId: 'market.standard-http-v1',
          providerId: 'org.example.community-catalog',
          manifestUrl,
          enabled: false,
          order: 0,
        }],
      })
      expect(getJson).toHaveBeenCalledWith(
        manifestUrl,
        expect.any(AbortSignal),
        { allowedOrigin: 'https://plugins.example.org' },
      )
    } finally {
      await server.close()
    }
  })

  it('rejects a cross-origin source mutation without changing settings', async () => {
    const server = await startMarketServer([])
    try {
      const response = await mutateSource(server, {
        action: 'add-builtin',
        key: DSH_1024STORE_KEY,
      }, 'http://attacker.example')

      expect(response.status).toBe(405)
      await expect(response.json()).resolves.toEqual({
        error: 'source changes require a local same-origin POST',
      })
      const state = await readRoute(server, marketRoutes.state)
      await expect(state.json()).resolves.toMatchObject({ sources: [] })
    } finally {
      await server.close()
    }
  })

  it('rejects an unsafe standard manifest URL before making a network request', async () => {
    const getJson = vi.spyOn(restrictedHttpClient, 'getJson')
    const server = await startMarketServer([])
    try {
      const response = await mutateSource(server, {
        action: 'add-standard',
        manifestUrl: 'https://plugins.example.org/catalog-source.json?token=secret',
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: 'manifest URL must use credential-free standard HTTPS port 443',
      })
      expect(getJson).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('aborts an active catalog request when its client disconnects', async () => {
    let releaseRequest!: () => void
    const requestStarted = new Promise<void>((resolve) => { releaseRequest = resolve })
    let externalSignal: AbortSignal | undefined
    vi.spyOn(restrictedHttpClient, 'getJson').mockImplementation(async (_url, signal) => {
      externalSignal = signal
      releaseRequest()
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      })
    })
    const server = await startMarketServer([standardSource({ enabled: true, order: 0 })])
    const controller = new AbortController()
    try {
      const request = readRoute(
        server,
        `${marketRoutes.catalog}?q=plugin&refresh=1`,
        controller.signal,
      ).catch((cause: unknown) => cause)
      await requestStarted

      controller.abort()
      await request

      await vi.waitFor(() => { expect(externalSignal?.aborted).toBe(true) })
    } finally {
      controller.abort()
      await server.close()
    }
  })
})
