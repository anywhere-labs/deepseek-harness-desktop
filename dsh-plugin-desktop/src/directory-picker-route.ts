import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  DesktopDirectoryPickerResponse,
  DesktopDirectoryValidationRequest,
  DesktopDirectoryValidationResponse,
} from './directory-picker-contract.ts'

const MAX_VALIDATION_BODY_BYTES = 16 * 1024

function finishJson(res: ServerResponse, statusCode: number, value: object): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_VALIDATION_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function isValidationRequest(value: unknown): value is DesktopDirectoryValidationRequest {
  if (typeof value !== 'object' || value === null || !('path' in value)) return false
  const path = (value as { path?: unknown }).path
  return typeof path === 'string' && path.trim().length > 0
}

/** Validate and serve one native directory-picker request from the desktop renderer. */
export async function handleDesktopDirectoryPickerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  pickDirectory: () => Promise<string | null>,
  reportError: (cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, { error: 'method not allowed' })
  if (req.headers.origin !== expectedOrigin) return finishJson(res, 403, { error: 'forbidden' })
  try {
    const response: DesktopDirectoryPickerResponse = { path: await pickDirectory() }
    finishJson(res, 200, response)
  } catch (cause: unknown) {
    reportError(cause)
    finishJson(res, 500, { error: 'native directory picker failed' })
  }
}

/** Validate one renderer-selected workspace before it can be persisted. */
export async function handleDesktopDirectoryValidationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  validateDirectory: (path: string) => Promise<boolean>,
  reportError: (cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, { error: 'method not allowed' })
  if (req.headers.origin !== expectedOrigin) return finishJson(res, 403, { error: 'forbidden' })
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return finishJson(res, 415, { error: 'content type must be application/json' })
  }
  let value: unknown
  try {
    value = await readJson(req)
  } catch (cause: unknown) {
    reportError(cause)
    return finishJson(res, 400, { error: 'invalid directory validation request' })
  }
  if (!isValidationRequest(value)) return finishJson(res, 400, { error: 'invalid directory validation request' })
  try {
    const response: DesktopDirectoryValidationResponse = {
      allowed: await validateDirectory(value.path),
    }
    finishJson(res, 200, response)
  } catch (cause: unknown) {
    reportError(cause)
    finishJson(res, 500, { error: 'directory validation failed' })
  }
}
