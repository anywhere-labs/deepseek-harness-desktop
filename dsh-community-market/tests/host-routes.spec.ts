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
import type { MarketSettingsDocument } from '../src/catalog/source-store.js'
import type { LocalSourceRecord } from '../src/contracts/index.js'
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

async function mutateSource(server: MarketServer, mutation: unknown, origin = server.baseUrl): Promise<Response> {
  return await fetch(`${server.baseUrl}${marketRoutes.sources}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
    },
    body: JSON.stringify(mutation),
  })
}

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

const standardSource = (overrides: Partial<LocalSourceRecord> = {}): LocalSourceRecord => ({
  sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
  registrationKind: 'user-added',
  adapterId: 'market.standard-http-v1',
  providerId: 'org.example.community-catalog',
  manifestUrl: 'https://plugins.example.org/catalog-source.json',
  enabled: false,
  order: 1,
  ...overrides,
})

async function startMarketServer(initialSources: readonly LocalSourceRecord[]): Promise<MarketServer> {
  const routes = new Map<string, RouteHandler>()
  let document: MarketSettingsDocument = { sources: initialSources }
  const scope = {
    get: () => document,
    update: async (patch: object) => {
      document = { ...document, ...patch as Partial<MarketSettingsDocument> }
    },
  } as unknown as SettingsScope<MarketSettingsDocument>
  const ctx = {
    webServer: {
      register: (route: { readonly path: string; readonly handler: RouteHandler }) => {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
  } as unknown as Context
  const disposeRoutes = registerMarketRoutes(ctx, scope)
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
      const response = await fetch(`${server.baseUrl}${marketRoutes.state}`)

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
        builtIns: [{
          key: DSH_1024STORE_KEY,
          providerId: DSH_1024STORE_PROVIDER_ID,
          partnership: true,
        }],
      })
    } finally {
      await server.close()
    }
  })

  it('normalizes catalog query parameters and returns aggregated source results', async () => {
    const getJson = vi.spyOn(restrictedHttpClient, 'getJson').mockResolvedValue({
      value: {
        page: 1,
        total: 1,
        totalPages: 1,
        results: [{
          id: 'example/dsh-plugin-sidebar',
          name: 'dsh-plugin-sidebar',
          owner: 'example',
          url: 'https://github.com/example/dsh-plugin-sidebar',
          category: 'interface',
          description: { zh: 'sidebar plugin' },
          pushedAt: '2026-08-17T05:45:19Z',
        }],
      },
      finalUrl: 'https://api.deepseek1024.com/v1/plugins/search?q=sidebar&limit=15&category=interface&sortBy=recent',
    })
    const server = await startMarketServer([builtInSource({ enabled: true })])
    try {
      const response = await fetch(
        `${server.baseUrl}${marketRoutes.catalog}?q=%20sidebar%20&category=interface&limit=15&sort=updated&locale=zh-CN`,
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
          source: { sourceRecordId: builtInSource().sourceRecordId },
          stale: false,
          snapshot: {
            items: [{
              id: 'example/dsh-plugin-sidebar',
              provenance: { sourceRecordId: builtInSource().sourceRecordId },
            }],
          },
        }],
      })
      expect(body.fetchedAt).toEqual(expect.any(String))
      const requestUrl = new URL(getJson.mock.calls[0]![0])
      expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
        q: 'sidebar',
        limit: '15',
        category: 'interface',
        sortBy: 'recent',
      })
    } finally {
      await server.close()
    }
  })

  it('adds the reviewed built-in provider as a disabled source', async () => {
    const server = await startMarketServer([])
    try {
      const response = await mutateSource(server, {
        action: 'add-builtin',
        key: DSH_1024STORE_KEY,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        sources: [{
          registrationKind: 'built-in',
          adapterId: DSH_1024STORE_ADAPTER_ID,
          providerId: DSH_1024STORE_PROVIDER_ID,
          builtInProviderKey: DSH_1024STORE_KEY,
          enabled: false,
          order: 0,
          name: 'DSH 1024Store',
        }],
      })
    } finally {
      await server.close()
    }
  })

  it('persists an enabled state change for an existing source', async () => {
    const existing = builtInSource()
    const server = await startMarketServer([existing])
    try {
      const response = await mutateSource(server, {
        action: 'set-enabled',
        sourceRecordId: existing.sourceRecordId,
        enabled: true,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        sources: [{ sourceRecordId: existing.sourceRecordId, enabled: true }],
      })
      const state = await fetch(`${server.baseUrl}${marketRoutes.state}`)
      await expect(state.json()).resolves.toMatchObject({
        sources: [{ sourceRecordId: existing.sourceRecordId, enabled: true }],
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
      const state = await fetch(`${server.baseUrl}${marketRoutes.state}`)
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
      expect(getJson).toHaveBeenCalledWith(manifestUrl, expect.any(AbortSignal))
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
      const state = await fetch(`${server.baseUrl}${marketRoutes.state}`)
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
        error: 'manifest URL must be credential-free HTTPS',
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
    const server = await startMarketServer([builtInSource({ enabled: true })])
    const controller = new AbortController()
    try {
      const request = fetch(`${server.baseUrl}${marketRoutes.catalog}?q=plugin`, {
        signal: controller.signal,
      }).catch((cause: unknown) => cause)
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
