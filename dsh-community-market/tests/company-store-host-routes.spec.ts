import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPANY_STORE_ADAPTER_ID,
  COMPANY_STORE_KEY,
  COMPANY_STORE_PROVIDER_ID,
} from '../src/adapters/company-store.js'
import {
  DSH_1024STORE_ADAPTER_ID,
  DSH_1024STORE_KEY,
  DSH_1024STORE_PROVIDER_ID,
} from '../src/adapters/dsh-1024store.js'
import { marketRoutes, registerMarketRoutes } from '../src/host/routes.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { MarketSettingsDocument } from '../src/catalog/source-store.js'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

async function startMarketServer(initialSources: MarketSettingsDocument['sources'] = []) {
  const routes = new Map<string, RouteHandler>()
  const settings = { document: { sources: [...initialSources] } }
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
    settings,
    close: async () => {
      disposeRoutes()
      await new Promise<void>((resolve, reject) => {
        server.close(error => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

async function mutate(server: Awaited<ReturnType<typeof startMarketServer>>, body: unknown) {
  return await fetch(`${server.baseUrl}${marketRoutes.sources}`, {
    method: 'POST',
    headers: {
      host: new URL(server.baseUrl).host,
      origin: server.baseUrl,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
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
        expect.objectContaining({
          key: COMPANY_STORE_KEY,
          providerId: COMPANY_STORE_PROVIDER_ID,
          partnership: true,
        }),
      ]))
      const company = body.builtIns.find((row: { key: string }) => row.key === COMPANY_STORE_KEY)
      expect(company).not.toMatchObject({ preferred: true })
      expect(company).not.toMatchObject({ default: true })
    } finally {
      await server.close()
    }
  })

  it('adds company-store as a disabled built-in source', async () => {
    const server = await startMarketServer()
    try {
      const response = await mutate(server, { action: 'add-builtin', key: COMPANY_STORE_KEY })
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

  it('coexists with dsh-1024store: both addable disabled; selecting one does not enable the other', async () => {
    const server = await startMarketServer()
    try {
      const addOfficial = await mutate(server, { action: 'add-builtin', key: DSH_1024STORE_KEY })
      expect(addOfficial.status).toBe(200)
      const addCompany = await mutate(server, { action: 'add-builtin', key: COMPANY_STORE_KEY })
      expect(addCompany.status).toBe(200)
      const afterAdd = await addCompany.json()
      expect(afterAdd.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ builtInProviderKey: DSH_1024STORE_KEY, enabled: false }),
        expect.objectContaining({ builtInProviderKey: COMPANY_STORE_KEY, enabled: false }),
      ]))

      const companyRecord = afterAdd.sources.find(
        (row: { builtInProviderKey?: string }) => row.builtInProviderKey === COMPANY_STORE_KEY,
      )
      const officialRecord = afterAdd.sources.find(
        (row: { builtInProviderKey?: string }) => row.builtInProviderKey === DSH_1024STORE_KEY,
      )
      expect(companyRecord?.sourceRecordId).toBeTruthy()
      expect(officialRecord?.sourceRecordId).toBeTruthy()

      const selectOfficial = await mutate(server, {
        action: 'select',
        sourceRecordId: officialRecord.sourceRecordId,
      })
      expect(selectOfficial.status).toBe(200)
      await expect(selectOfficial.json()).resolves.toMatchObject({
        sources: expect.arrayContaining([
          expect.objectContaining({ builtInProviderKey: DSH_1024STORE_KEY, enabled: true }),
          expect.objectContaining({ builtInProviderKey: COMPANY_STORE_KEY, enabled: false }),
        ]),
      })

      const selectCompany = await mutate(server, {
        action: 'select',
        sourceRecordId: companyRecord.sourceRecordId,
      })
      expect(selectCompany.status).toBe(200)
      await expect(selectCompany.json()).resolves.toMatchObject({
        sources: expect.arrayContaining([
          expect.objectContaining({ builtInProviderKey: DSH_1024STORE_KEY, enabled: false }),
          expect.objectContaining({ builtInProviderKey: COMPANY_STORE_KEY, enabled: true }),
        ]),
      })
    } finally {
      await server.close()
    }
  })

  it('never auto-enables company-store when only the official built-in is present', async () => {
    const official = {
      sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
      registrationKind: 'built-in' as const,
      adapterId: DSH_1024STORE_ADAPTER_ID,
      providerId: DSH_1024STORE_PROVIDER_ID,
      builtInProviderKey: DSH_1024STORE_KEY,
      enabled: true,
      order: 0,
    }
    const server = await startMarketServer([official])
    try {
      // Simulate a catalog refresh error surface: settings must not gain an enabled company-store.
      const state = await fetch(`${server.baseUrl}${marketRoutes.state}`, {
        headers: { host: new URL(server.baseUrl).host, origin: server.baseUrl },
      })
      expect(state.status).toBe(200)
      const body = await state.json()
      expect(body.sources).toHaveLength(1)
      expect(body.sources[0]).toMatchObject({
        builtInProviderKey: DSH_1024STORE_KEY,
        enabled: true,
      })
      expect(
        body.sources.some((row: { builtInProviderKey?: string }) => row.builtInProviderKey === COMPANY_STORE_KEY),
      ).toBe(false)
      expect(server.settings.document.sources).toHaveLength(1)
    } finally {
      await server.close()
    }
  })
})
