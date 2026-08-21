import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPANY_STORE_ADAPTER_ID,
  COMPANY_STORE_KEY,
  COMPANY_STORE_PROVIDER_ID,
} from '../src/adapters/company-store.js'
import { DSH_1024STORE_KEY } from '../src/adapters/dsh-1024store.js'
import { marketRoutes, registerMarketRoutes } from '../src/host/routes.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { MarketSettingsDocument } from '../src/catalog/source-store.js'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

async function startMarketServer() {
  const routes = new Map<string, RouteHandler>()
  const settings = { document: { sources: [] as MarketSettingsDocument['sources'] } }
  const scope = {
    get: () => settings.document,
    update: async (patch: object) => {
      settings.document = { ...settings.document, ...patch as Partial<MarketSettingsDocument> }
    },
  } as unknown as SettingsScope<MarketSettingsDocument>
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) { res.statusCode = 404; res.end(); return }
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
      await new Promise<void>((resolve, reject) => {
        server.close(error => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

describe('company-store host routes', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('lists company-store among built-in providers', async () => {
    const server = await startMarketServer()
    try {
      const response = await fetch(`${server.baseUrl}${marketRoutes.state}`, {
        headers: { host: new URL(server.baseUrl).host, origin: server.baseUrl },
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.builtIns).toEqual(expect.arrayContaining([
        {
          key: COMPANY_STORE_KEY,
          providerId: COMPANY_STORE_PROVIDER_ID,
          partnership: true,
        },
      ]))
    } finally {
      await server.close()
    }
  })

  it('adds company-store as a disabled built-in source', async () => {
    const server = await startMarketServer()
    try {
      const response = await fetch(`${server.baseUrl}${marketRoutes.sources}`, {
        method: 'POST',
        headers: {
          host: new URL(server.baseUrl).host,
          origin: server.baseUrl,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'add-builtin', key: COMPANY_STORE_KEY }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        sources: [{
          registrationKind: 'built-in',
          adapterId: COMPANY_STORE_ADAPTER_ID,
          providerId: COMPANY_STORE_PROVIDER_ID,
          builtInProviderKey: COMPANY_STORE_KEY,
          enabled: false,
          name: 'Company Store',
        }],
      })
    } finally {
      await server.close()
    }
  })
})
