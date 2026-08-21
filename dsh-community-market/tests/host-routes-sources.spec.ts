import { afterEach, describe, expect, it, vi } from 'vitest'
import { DSH_1024STORE_KEY } from '../src/adapters/dsh-1024store.js'
import { DSHFIND_KEY } from '../src/adapters/dshfind.js'
import { restrictedHttpClient } from '../src/network/restricted-http.js'
import {
  builtInSource,
  dshfindSource,
  fixture,
  marketRoutes,
  mutateSource,
  readRoute,
  standardSource,
  startMarketServer,
} from './host-routes.helpers.js'

describe('community market Host routes — sources', () => {
  afterEach(() => { vi.restoreAllMocks() })

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
