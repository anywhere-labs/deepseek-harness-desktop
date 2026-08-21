import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { vi } from 'vitest'
import {
  DSH_1024STORE_ADAPTER_ID,
  DSH_1024STORE_KEY,
  DSH_1024STORE_PROVIDER_ID,
} from '../src/adapters/dsh-1024store.js'
import {
  DSHFIND_ADAPTER_ID,
  DSHFIND_KEY,
  DSHFIND_PROVIDER_ID,
} from '../src/adapters/dshfind.js'
import type { MarketSettingsDocument } from '../src/catalog/source-store.js'
import type { CatalogSourceManifest, LocalSourceRecord } from '../src/contracts/index.js'
import { marketRoutes, registerMarketRoutes } from '../src/host/routes.js'

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export function fixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as unknown
}

export interface MarketServer {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

export interface SharedMarketSettings {
  document: MarketSettingsDocument
}

export function localHeaders(server: MarketServer, origin = server.baseUrl): Record<string, string> {
  return {
    host: new URL(server.baseUrl).host,
    origin,
  }
}

export async function readRoute(server: MarketServer, path: string, signal?: AbortSignal): Promise<Response> {
  return await fetch(`${server.baseUrl}${path}`, {
    headers: localHeaders(server),
    ...(signal === undefined ? {} : { signal }),
  })
}

export async function mutateSource(server: MarketServer, mutation: unknown, origin = server.baseUrl): Promise<Response> {
  return await fetch(`${server.baseUrl}${marketRoutes.sources}`, {
    method: 'POST',
    headers: {
      ...localHeaders(server, origin),
      'content-type': 'application/json',
    },
    body: JSON.stringify(mutation),
  })
}

export const standardManifest = fixture('../docs/examples/catalog-source.example.json') as CatalogSourceManifest

export const builtInSource = (overrides: Partial<LocalSourceRecord> = {}): LocalSourceRecord => ({
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'built-in',
  adapterId: DSH_1024STORE_ADAPTER_ID,
  providerId: DSH_1024STORE_PROVIDER_ID,
  builtInProviderKey: DSH_1024STORE_KEY,
  enabled: false,
  order: 0,
  ...overrides,
})

export const dshfindSource = (overrides: Partial<LocalSourceRecord> = {}): LocalSourceRecord => ({
  sourceRecordId: '038f1f77-a5c4-7b73-a9ae-0242ac120004',
  registrationKind: 'built-in',
  adapterId: DSHFIND_ADAPTER_ID,
  providerId: DSHFIND_PROVIDER_ID,
  builtInProviderKey: DSHFIND_KEY,
  enabled: false,
  order: 1,
  ...overrides,
})

export const standardSource = (overrides: Partial<LocalSourceRecord> = {}): LocalSourceRecord => ({
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

export async function startMarketServer(
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

export { marketRoutes }
