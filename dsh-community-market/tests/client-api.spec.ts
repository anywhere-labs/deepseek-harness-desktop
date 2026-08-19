// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketSourceMutation } from '../src/api-types.js'
import {
  executeMarketOperation,
  MarketApiError,
  mutateMarketSource,
  openMarketTerminal,
  previewMarketOperation,
  readMarketCatalog,
  readMarketInstallable,
  readMarketInstallations,
  readMarketState,
  readMoreMarketCatalog,
  requestMarketRestart,
} from '../src/client/api.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('community market client API', () => {
  it('binds the initial page to one source, requests 50 items, and repeats category parameters', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({ query: {}, results: [], fetchedAt: '2026-08-18T00:00:00Z' }),
    } as Response))
    vi.stubGlobal('fetch', fetch)

    await readMarketCatalog('source-record-1', '  terminal  ', 'zh-CN', ['tools', 'interface'])

    const url = fetch.mock.calls[0]?.[0] as URL
    expect(url.pathname).toBe('/api/community-market/catalog')
    expect(url.searchParams.get('sourceRecordId')).toBe('source-record-1')
    expect(url.searchParams.get('q')).toBe('terminal')
    expect(url.searchParams.get('limit')).toBe('50')
    expect(url.searchParams.get('locale')).toBe('zh-CN')
    expect(url.searchParams.getAll('category')).toEqual(['tools', 'interface'])
    expect(url.searchParams.has('cursor')).toBe(false)
    expect(url.searchParams.has('refresh')).toBe(false)
  })

  it('marks only an explicit catalog refresh as a forced index rescan', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({ query: {}, results: [], categories: [], fetchedAt: '2026-08-18T00:00:00Z' }),
    } as Response))
    vi.stubGlobal('fetch', fetch)

    await readMarketCatalog('source-record-1', '', 'en', [], undefined, true)

    const url = fetch.mock.calls[0]?.[0] as URL
    expect(url.pathname).toBe('/api/community-market/catalog')
    expect(url.searchParams.get('refresh')).toBe('1')
  })

  it('binds a later page to the same source and its opaque cursor', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({ query: {}, results: [], fetchedAt: '2026-08-18T00:00:00Z' }),
    } as Response))
    vi.stubGlobal('fetch', fetch)

    await readMoreMarketCatalog('source-record-2', 'opaque cursor/2', '', 'en', ['tools'])

    const url = fetch.mock.calls[0]?.[0] as URL
    expect(url.searchParams.get('sourceRecordId')).toBe('source-record-2')
    expect(url.searchParams.get('cursor')).toBe('opaque cursor/2')
    expect(url.searchParams.get('limit')).toBe('50')
    expect(url.searchParams.getAll('category')).toEqual(['tools'])
  })

  it('uses the exact installations, preview, and execute routes without forwarding package commands', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      json: async () => {
        const url = String(input)
        if (url.endsWith('/installations')) return { installations: [] }
        if (url.endsWith('/preview')) {
          return {
            action: 'install',
            profileName: 'web',
            packageName: 'dsh-plugin-safe',
            version: '1.2.3',
            displayName: 'Safe Plugin',
            expiresAt: '2026-08-18T00:05:00.000Z',
            previewId: 'preview-1',
          }
        }
        return {
          action: 'uninstall',
          receiptId: 'receipt-1',
          packageName: 'dsh-plugin-safe',
          restartToken: 'restart-token-1',
        }
      },
      status: 200,
      ...(init === undefined ? {} : { requestInit: init }),
    } as Response))
    vi.stubGlobal('fetch', fetch)

    await readMarketInstallations()
    await previewMarketOperation({ action: 'install', sourceRecordId: 'source-1', itemId: 'item-1' })
    await executeMarketOperation('preview-1')

    expect(fetch.mock.calls[0]?.[0]).toBe('/api/community-market/installations')
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/community-market/operations/preview')
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ action: 'install', sourceRecordId: 'source-1', itemId: 'item-1' }),
    })
    expect(fetch.mock.calls[2]?.[0]).toBe('/api/community-market/operations/execute')
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ previewId: 'preview-1' }),
    })
  })

  it('previews disable with only the Host-issued opaque bundle id', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        action: 'disable',
        profileName: 'web',
        packageName: 'dsh-plugin-external',
        displayName: 'dsh-plugin-external',
        expiresAt: '2099-08-18T00:05:00.000Z',
        previewId: 'disable-preview',
      }),
    } as Response))
    vi.stubGlobal('fetch', fetch)

    await previewMarketOperation({ action: 'disable', bundleId: 'opaque-bundle-id' })

    expect(fetch).toHaveBeenCalledWith('/api/community-market/operations/preview', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'disable', bundleId: 'opaque-bundle-id' }),
    }))
  })

  it('previews enable with only the Host-issued opaque bundle id', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        action: 'enable',
        profileName: 'web',
        packageName: 'dsh-plugin-external',
        displayName: 'dsh-plugin-external',
        expiresAt: '2099-08-18T00:05:00.000Z',
        previewId: 'enable-preview',
      }),
    } as Response))
    vi.stubGlobal('fetch', fetch)

    await previewMarketOperation({ action: 'enable', bundleId: 'opaque-disabled-bundle-id' })

    expect(fetch).toHaveBeenCalledWith('/api/community-market/operations/preview', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'enable', bundleId: 'opaque-disabled-bundle-id' }),
    }))
  })

  it('reads the independent verified index and sends refresh only for an explicit rescan', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({
        source: {},
        items: [],
        metadata: {
          scannedAt: '2026-08-18T00:00:00.000Z',
          expiresAt: '2026-08-18T00:05:00.000Z',
          cacheStatus: 'fresh',
        },
      }),
    } as Response))
    vi.stubGlobal('fetch', fetch)

    await readMarketInstallable('zh-CN')
    await readMarketInstallable('zh-CN', true)

    const cachedUrl = fetch.mock.calls[0]?.[0] as URL
    const refreshedUrl = fetch.mock.calls[1]?.[0] as URL
    expect(cachedUrl.pathname).toBe('/api/community-market/installable')
    expect(cachedUrl.searchParams.get('locale')).toBe('zh-CN')
    expect(cachedUrl.searchParams.has('refresh')).toBe(false)
    expect(refreshedUrl.searchParams.get('refresh')).toBe('1')
  })

  it('opens the terminal without a command and sends only the one-shot token when restarting', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      { ok: true, json: async () => ({ ok: true }) } as Response
    ))
    vi.stubGlobal('fetch', fetch)

    await openMarketTerminal()
    await requestMarketRestart('opaque-restart-token')

    expect(fetch.mock.calls[0]).toEqual([
      '/api/community-market/desktop/open-terminal',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    ])
    expect(fetch.mock.calls[1]).toEqual([
      '/api/community-market/desktop/request-restart',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ restartToken: 'opaque-restart-token' }) }),
    ])
  })

  it('preserves an unavailable status so the Client can explain the Desktop-only capability', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'private Host detail' }),
    } as Response)))

    await expect(readMarketInstallations()).rejects.toMatchObject({
      name: 'MarketApiError',
      status: 503,
    })
    await expect(readMarketInstallations()).rejects.toBeInstanceOf(MarketApiError)
  })

  it('reads state without caching and preserves the request cancellation signal', async () => {
    const body = {
      sources: [],
      builtIns: [],
      desktopActions: { openTerminal: false, requestRestart: false },
    }
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', request)
    const controller = new AbortController()

    await expect(readMarketState(controller.signal)).resolves.toEqual(body)
    expect(request).toHaveBeenCalledWith('/api/community-market/state', {
      cache: 'no-store',
      signal: controller.signal,
    })
  })

  it('surfaces the safe error returned by the Host route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'market state unavailable',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(readMarketState()).rejects.toThrow('market state unavailable')
  })

  it.each<MarketSourceMutation>([
    { action: 'add-builtin', key: 'dsh-1024store' },
    { action: 'add-standard', manifestUrl: 'https://plugins.example.org/catalog-source.json' },
    { action: 'select', sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002' },
    { action: 'move', sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002', direction: 'up' },
    { action: 'remove', sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002' },
  ])('posts the $action source mutation unchanged', async (mutation) => {
    const sources = [{ sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002' }]
    const request = vi.fn(async () => new Response(JSON.stringify({ sources }), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', request)
    const controller = new AbortController()

    await expect(mutateMarketSource(mutation, controller.signal)).resolves.toEqual(sources)
    expect(request).toHaveBeenCalledWith('/api/community-market/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mutation),
      signal: controller.signal,
    })
  })
})
