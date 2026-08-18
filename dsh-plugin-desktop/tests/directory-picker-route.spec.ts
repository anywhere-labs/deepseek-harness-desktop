import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleDesktopDirectoryPickerRequest } from '../src/directory-picker-route.ts'

function request(origin = 'http://127.0.0.1:43120', method = 'POST'): IncomingMessage {
  return { method, headers: { origin } } as IncomingMessage
}

function response(): ServerResponse & {
  body: string
  end: ReturnType<typeof vi.fn>
  setHeader: ReturnType<typeof vi.fn>
} {
  const res = {
    body: '',
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => { res.body = body ?? '' }),
  }
  return res as unknown as ServerResponse & typeof res
}

describe('desktop directory picker route', () => {
  it('returns the path selected by the native desktop adapter', async () => {
    const pick = vi.fn(async () => 'C:\\Work')
    const res = response()

    await handleDesktopDirectoryPickerRequest(
      request(),
      res,
      'http://127.0.0.1:43120',
      pick,
    )

    expect(pick).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(200)
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/json; charset=utf-8')
    expect(JSON.parse(res.body)).toEqual({ path: 'C:\\Work' })
  })

  it('keeps cancellation distinct from route failure', async () => {
    const res = response()

    await handleDesktopDirectoryPickerRequest(
      request(),
      res,
      'http://127.0.0.1:43120',
      async () => null,
    )

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ path: null })
  })

  it('rejects cross-origin and non-POST requests without opening a dialog', async () => {
    const pick = vi.fn(async () => null)

    for (const req of [request('https://example.com'), request(undefined, 'GET')]) {
      const res = response()
      await handleDesktopDirectoryPickerRequest(req, res, 'http://127.0.0.1:43120', pick)
      expect(res.statusCode).toBe(req.method === 'GET' ? 405 : 403)
    }
    expect(pick).not.toHaveBeenCalled()
  })

  it('returns a stable error without exposing Electron details', async () => {
    const res = response()

    await handleDesktopDirectoryPickerRequest(
      request(),
      res,
      'http://127.0.0.1:43120',
      async () => { throw new Error('private native failure') },
    )

    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'native directory picker failed' })
  })
})
