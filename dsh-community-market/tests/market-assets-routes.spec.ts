import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const assetRef = 'mktimg_0123456789abcdefghijklmnopqrstuv'
const assetBody = Buffer.from('normalized-png-fixture')

const media = vi.hoisted(() => ({
  register: vi.fn(() => assetRef),
  resolve: vi.fn(),
  unregisterSource: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('../src/media/service.js', () => ({
  createMarketMediaService: () => media,
}))

const { marketRoutes, registerMarketRoutes } = await import('../src/host/routes.js')

interface TestServer {
  readonly baseUrl: string
  readonly disposeRoutes: () => void
  readonly close: () => Promise<void>
}

async function startServer(): Promise<TestServer> {
  const handlers = new Map<string, (req: any, res: any) => void | Promise<void>>()
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = handlers.get(path)
    if (handler === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.writableEnded) {
        res.statusCode = 500
        res.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  const scope = {
    get: () => ({ sources: [] }),
    update: async () => {},
  }
  const context = {
    webServer: {
      port,
      register: (route: { path: string; handler: (req: any, res: any) => void | Promise<void> }) => {
        handlers.set(route.path, route.handler)
        return () => { handlers.delete(route.path) }
      },
    },
    logger: { error: vi.fn() },
  }
  const disposeRoutes = registerMarketRoutes(context as never, scope as never)
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    disposeRoutes,
    close: async () => {
      disposeRoutes()
      await new Promise<void>((resolve, reject) => {
        server.close(error => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

function assetUrl(server: TestServer): string {
  return `${server.baseUrl}${marketRoutes.assets}?ref=${assetRef}`
}

describe('community market asset routes', () => {
  beforeEach(() => {
    media.resolve.mockReset()
    media.dispose.mockClear()
  })

  it('serves an asset with cache validators and browser isolation headers', async () => {
    media.resolve.mockResolvedValue({
      body: assetBody,
      contentType: 'image/png',
      etag: '"asset-etag"',
    })
    const server = await startServer()
    try {
      const response = await fetch(assetUrl(server))

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(response.headers.get('content-length')).toBe(String(assetBody.byteLength))
      expect(response.headers.get('content-disposition')).toBe('inline')
      expect(response.headers.get('etag')).toBe('"asset-etag"')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(assetBody))

      const cached = await fetch(assetUrl(server), { headers: { 'if-none-match': '"asset-etag"' } })
      expect(cached.status).toBe(304)
      expect(cached.headers.get('content-length')).toBeNull()
      expect((await cached.arrayBuffer()).byteLength).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('rejects malformed and unknown asset references without resolving media', async () => {
    media.resolve.mockResolvedValue(undefined)
    const server = await startServer()
    try {
      const malformed = await fetch(`${server.baseUrl}${marketRoutes.assets}?ref=javascript:alert(1)`)
      expect(malformed.status).toBe(404)
      expect(media.resolve).not.toHaveBeenCalled()

      const unknown = await fetch(`${server.baseUrl}${marketRoutes.assets}?ref=${assetRef}`)
      expect(unknown.status).toBe(404)
      expect(media.resolve).toHaveBeenCalledWith(assetRef, expect.any(AbortSignal))
    } finally {
      await server.close()
    }
  })

  it('aborts an in-flight asset resolution when the market generation is disposed', async () => {
    let observedSignal: AbortSignal | undefined
    media.resolve.mockImplementation(async (_ref: string, signal: AbortSignal) => {
      observedSignal = signal
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { resolve() }, { once: true }))
      throw signal.reason
    })
    const server = await startServer()
    const controller = new AbortController()
    const request = fetch(assetUrl(server), { signal: controller.signal }).catch(() => undefined)
    try {
      await vi.waitFor(() => { expect(observedSignal).toBeDefined() })
      server.disposeRoutes()
      await vi.waitFor(() => { expect(observedSignal?.aborted).toBe(true) })
    } finally {
      controller.abort()
      await request
      await server.close()
    }
  })
})
