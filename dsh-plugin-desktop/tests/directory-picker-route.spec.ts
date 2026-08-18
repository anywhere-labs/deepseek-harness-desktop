import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  handleDesktopDirectoryPickerRequest,
  handleDesktopDirectoryValidationRequest,
} from '../src/directory-picker-route.ts'

function request(origin = 'http://127.0.0.1:43120', method = 'POST'): IncomingMessage {
  return { method, headers: { origin } } as IncomingMessage
}

function jsonRequest(value: unknown, origin = 'http://127.0.0.1:43120'): IncomingMessage {
  const req = Readable.from([JSON.stringify(value)]) as IncomingMessage
  req.method = 'POST'
  req.headers = { origin, 'content-type': 'application/json' }
  return req
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

describe('desktop directory validation route', () => {
  it('returns the runtime decision for a selected path', async () => {
    const validate = vi.fn(async () => false)
    const res = response()

    await handleDesktopDirectoryValidationRequest(
      jsonRequest({ path: 'E:\\repo' }),
      res,
      'http://127.0.0.1:43120',
      validate,
    )

    expect(validate).toHaveBeenCalledWith('E:\\repo')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ allowed: false })
  })

  it.each([
    [{}, 400],
    [{ path: '' }, 400],
    [{ path: 42 }, 400],
  ])('rejects an invalid validation body', async (body, statusCode) => {
    const validate = vi.fn(async () => true)
    const res = response()

    await handleDesktopDirectoryValidationRequest(
      jsonRequest(body),
      res,
      'http://127.0.0.1:43120',
      validate,
    )

    expect(validate).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(statusCode)
  })

  it('rejects cross-origin validation before reading the path', async () => {
    const validate = vi.fn(async () => true)
    const res = response()

    await handleDesktopDirectoryValidationRequest(
      jsonRequest({ path: 'C:\\Work' }, 'https://example.com'),
      res,
      'http://127.0.0.1:43120',
      validate,
    )

    expect(validate).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
  })

  it('reports a runtime validation failure as a stable server error', async () => {
    const res = response()

    await handleDesktopDirectoryValidationRequest(
      jsonRequest({ path: 'E:\\repo' }),
      res,
      'http://127.0.0.1:43120',
      async () => { throw new Error('private volume query failure') },
    )

    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'directory validation failed' })
  })
})
