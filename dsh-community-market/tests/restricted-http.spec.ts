import { describe, expect, it, vi } from 'vitest'
import {
  CatalogNetworkError,
  createRestrictedHttpClient,
  type RestrictedHttpClientOptions,
} from '../src/network/restricted-http.js'
import type { PinnedAddress } from '../src/network/restricted-http.js'

const pinned: PinnedAddress = { address: '93.184.216.34', family: 4 }

const jsonResponse = (body: string) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(body),
})

const statusResponse = (statusCode: number) => ({
  statusCode,
  headers: {},
  body: Buffer.alloc(0),
})

function buildClient(options: RestrictedHttpClientOptions) {
  return createRestrictedHttpClient({
    resolveAddress: async () => pinned,
    sleep: async () => {},
    random: () => 0.5,
    ...options,
  })
}

const controller = () => new AbortController()

describe('restricted HTTP client retry policy', () => {
  it('retries a per-attempt timeout and succeeds on the next attempt', async () => {
    const request = vi.fn(async () => {
      if (request.mock.calls.length === 1) throw new CatalogNetworkError('timeout')
      return jsonResponse('{"ok":true}')
    })
    const sleep = vi.fn(async () => {})
    const client = buildClient({ request, sleep })

    const response = await client.getJson('https://market.example.org/catalog.json', controller().signal)

    expect(response.value).toEqual({ ok: true })
    expect(request).toHaveBeenCalledTimes(2)
    // full jitter at random 0.5 over the first backoff cap (250 ms): 125 ms
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(125)
  })

  it('retries a 5xx status and succeeds once the provider recovers', async () => {
    const request = vi.fn(async () => {
      if (request.mock.calls.length === 1) return statusResponse(502)
      return jsonResponse('{"ok":true}')
    })
    const client = buildClient({ request })

    const response = await client.getJson('https://market.example.org/catalog.json', controller().signal)

    expect(response.value).toEqual({ ok: true })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('fails a 4xx immediately without retrying', async () => {
    const request = vi.fn(async () => statusResponse(404))
    const sleep = vi.fn(async () => {})
    const client = buildClient({ request, sleep })

    await expect(
      client.getJson('https://market.example.org/catalog.json', controller().signal),
    ).rejects.toMatchObject({ code: 'http', statusCode: 404 })
    expect(request).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('fails blocked addresses immediately without retrying', async () => {
    const request = vi.fn()
    const sleep = vi.fn(async () => {})
    const client = buildClient({
      request,
      sleep,
      resolveAddress: async () => {
        throw new CatalogNetworkError('blocked-address')
      },
    })

    await expect(
      client.getJson('https://market.example.org/catalog.json', controller().signal),
    ).rejects.toMatchObject({ code: 'blocked-address' })
    expect(request).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('fails cross-origin redirects immediately without retrying', async () => {
    const request = vi.fn()
    const sleep = vi.fn(async () => {})
    const client = buildClient({ request, sleep })

    await expect(
      client.getJson('https://market.example.org/catalog.json', controller().signal, {
        allowedOrigin: 'https://elsewhere.example.org',
      }),
    ).rejects.toMatchObject({ code: 'redirect' })
    expect(request).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('gives up after the configured attempt count with growing backoff caps', async () => {
    const request = vi.fn(async () => {
      throw new CatalogNetworkError('timeout')
    })
    const sleep = vi.fn(async () => {})
    const client = buildClient({ request, sleep, retryAttempts: 3 })

    await expect(
      client.getJson('https://market.example.org/catalog.json', controller().signal),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(request).toHaveBeenCalledTimes(3)
    // caps double per retry: 250 then 500, each drawn at random 0.5
    expect(sleep.mock.calls.map(call => call.at(0))).toEqual([125, 250])
  })

  it('honours retryAttempts: 1 by making exactly one attempt', async () => {
    const request = vi.fn(async () => {
      throw new CatalogNetworkError('timeout')
    })
    const sleep = vi.fn(async () => {})
    const client = buildClient({ request, sleep, retryAttempts: 1 })

    await expect(
      client.getJson('https://market.example.org/catalog.json', controller().signal),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('stops retrying once the caller aborts during backoff', async () => {
    const abortController = controller()
    const request = vi.fn(async () => {
      throw new CatalogNetworkError('timeout')
    })
    const client = buildClient({
      request,
      sleep: async () => {
        abortController.abort()
        await new Promise<never>(() => {})
      },
    })

    await expect(
      client.getJson('https://market.example.org/catalog.json', abortController.signal),
    ).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
