/** Strict loopback HTTP handlers for the private Desktop settings API. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { assertDesktopProfileName } from './profile-manager.ts'
import type { DesktopMarketProvider } from './desktop-market.ts'
import { parseDesktopHostTargetSelection, type DesktopHostTargetSelection } from './host-target.ts'
import type DesktopSettingsController from './desktop-settings-controller.ts'
import type { DesktopSettingsPostResponse } from './desktop-settings-controller.ts'
import type {
  DesktopHostTargetRequest,
  DesktopMarketSelectRequest,
  DesktopProfileCreateRequest,
  DesktopProfileDeleteRequest,
  DesktopProfileSelectRequest,
  DesktopSettingsErrorResponse,
} from './desktop-settings-contract.ts'

const MAX_SETTINGS_BODY_BYTES = 16 * 1024

class BodyTooLargeError extends Error {}

function finishJson(
  res: ServerResponse,
  statusCode: number,
  value: object,
  allow?: 'GET' | 'POST',
): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  if (allow !== undefined) res.setHeader('allow', allow)
  res.end(JSON.stringify(value))
}

function error(message: string): DesktopSettingsErrorResponse {
  return { error: message }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]'
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1' || address === '127.0.0.1') return true
  if (address.startsWith('::ffff:')) {
    const mapped = address.slice('::ffff:'.length)
    return mapped.startsWith('127.')
  }
  return address.startsWith('127.')
}

function expectedLoopbackOrigin(expectedOrigin: string): URL | undefined {
  try {
    const url = new URL(expectedOrigin)
    if (url.origin !== expectedOrigin || url.protocol !== 'http:'
      || url.username !== '' || url.password !== ''
      || !isLoopbackHostname(url.hostname)) return undefined
    return url
  } catch {
    return undefined
  }
}

function exactHeaderOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.origin === value ? value : undefined
  } catch {
    return undefined
  }
}

function referrerOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

/**
 * Require the actual socket and Host to stay on the configured loopback origin.
 * A mutating request must carry the exact Origin. A read-only browser GET may
 * use the standard same-origin fetch metadata plus its same-origin referrer,
 * because browsers commonly omit Origin on same-origin GET requests.
 */
function isSameOriginLoopbackRequest(
  req: IncomingMessage,
  expectedOrigin: string,
  mutating: boolean,
): boolean {
  const expected = expectedLoopbackOrigin(expectedOrigin)
  if (expected === undefined || !isLoopbackAddress(req.socket.remoteAddress)) return false
  if (req.headers.host?.toLowerCase() !== expected.host.toLowerCase()) return false
  if (exactHeaderOrigin(req.headers.origin) === expected.origin) {
    return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin'
  }
  if (mutating) return false
  return req.headers['sec-fetch-site'] === 'same-origin'
    && referrerOrigin(req.headers.referer) === expected.origin
}

function isJsonRequest(req: IncomingMessage): boolean {
  return req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) throw new SyntaxError('invalid content length')
    if (Number(declaredLength) > MAX_SETTINGS_BODY_BYTES) throw new BodyTooLargeError()
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_SETTINGS_BODY_BYTES) throw new BodyTooLargeError()
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function isExactRecord(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1
    && Object.prototype.hasOwnProperty.call(value, key)
}

function parseProfileRequest(value: unknown): DesktopProfileCreateRequest | undefined {
  if (!isExactRecord(value, 'name') || typeof value.name !== 'string') return undefined
  try {
    assertDesktopProfileName(value.name)
    return { name: value.name }
  } catch {
    return undefined
  }
}

function isMarketProvider(value: unknown): value is DesktopMarketProvider {
  return value === 'disabled' || value === 'community-market' || value === 'dsh-market'
}

function parseMarketRequest(value: unknown): DesktopMarketSelectRequest | undefined {
  if (!isExactRecord(value, 'provider') || !isMarketProvider(value.provider)) return undefined
  return { provider: value.provider }
}

function parseHostTargetRequest(value: unknown): DesktopHostTargetRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (record.mode === 'local') {
    if (keys.length !== 1 || keys[0] !== 'mode') return undefined
  } else if (record.mode === 'wsl') {
    if (keys.length !== 2 || !keys.includes('mode') || !keys.includes('distribution')) return undefined
  } else {
    return undefined
  }
  try {
    return parseDesktopHostTargetSelection(record)
  } catch {
    return undefined
  }
}

function isEmptyRequest(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 0
}

async function parsePostBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown | typeof INVALID_BODY> {
  if (!isJsonRequest(req)) {
    finishJson(res, 415, error('content type must be application/json'))
    return INVALID_BODY
  }
  try {
    return await readJson(req)
  } catch (cause) {
    const tooLarge = cause instanceof BodyTooLargeError
    finishJson(res, tooLarge ? 413 : 400, error(tooLarge ? 'request body is too large' : 'invalid JSON request'))
    return INVALID_BODY
  }
}

const INVALID_BODY = Symbol('invalid body')

function finishPostResponse<T extends object>(
  res: ServerResponse,
  statusCode: number,
  operation: DesktopSettingsPostResponse<T>,
  operationName: string,
  reportError: (operation: string, cause: unknown) => void,
): void {
  finishJson(res, statusCode, operation.response)
  if (operation.afterResponse === undefined) return
  setImmediate(() => {
    try {
      operation.afterResponse?.()
    } catch (cause) {
      reportError(`${operationName} restart`, cause)
    }
  })
}

/** Serve the renderer-safe Desktop settings snapshot. */
export async function handleDesktopSettingsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopSettingsController,
  reportError: (operation: string, cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'GET') return finishJson(res, 405, error('method not allowed'), 'GET')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) {
    return finishJson(res, 403, error('forbidden'))
  }
  try {
    finishJson(res, 200, controller.read())
  } catch (cause) {
    reportError('read settings', cause)
    finishJson(res, 500, error('desktop settings unavailable'))
  }
}

/** Create one safe Web profile without changing the active generation. */
export async function handleDesktopProfileCreateRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopSettingsController,
  reportError: (operation: string, cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  const request = parseProfileRequest(value)
  if (request === undefined) return finishJson(res, 400, error('invalid profile creation request'))
  try {
    finishJson(res, 201, controller.createProfile(request.name))
  } catch (cause) {
    reportError('create profile', cause)
    finishJson(res, 409, error('profile could not be created'))
  }
}

/** Select one compatible profile through the restart-safe launcher service. */
export async function handleDesktopProfileSelectRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopSettingsController,
  reportError: (operation: string, cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  const request = parseProfileRequest(value) as DesktopProfileSelectRequest | undefined
  if (request === undefined) return finishJson(res, 400, error('invalid profile selection request'))
  try {
    const operation = await controller.selectProfile(request.name)
    finishPostResponse(
      res,
      operation.response.restartRequired ? 202 : 200,
      operation,
      'select profile',
      reportError,
    )
  } catch (cause) {
    reportError('select profile', cause)
    finishJson(res, 409, error('profile could not be selected'))
  }
}

/** Delete one inactive user profile and return a fresh settings projection. */
export async function handleDesktopProfileDeleteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopSettingsController,
  reportError: (operation: string, cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  const request = parseProfileRequest(value) as DesktopProfileDeleteRequest | undefined
  if (request === undefined) return finishJson(res, 400, error('invalid profile deletion request'))
  try {
    finishJson(res, 200, await controller.deleteProfile(request.name))
  } catch (cause) {
    reportError('delete profile', cause)
    finishJson(res, 409, error('profile could not be deleted'))
  }
}

/** Persist one Market provider and queue restart only after persistence succeeds. */
export async function handleDesktopMarketSelectRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopSettingsController,
  reportError: (operation: string, cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  const request = parseMarketRequest(value)
  if (request === undefined) return finishJson(res, 400, error('invalid Market selection request'))
  try {
    const operation = await controller.selectMarket(request.provider)
    finishPostResponse(
      res,
      operation.response.restartRequired ? 202 : 200,
      operation,
      'select Market provider',
      reportError,
    )
  } catch (cause) {
    reportError('select Market provider', cause)
    finishJson(res, 500, error('Market selection could not be saved'))
  }
}

/** Persist a complete Host target and queue restart after the response is sent. */
export async function handleDesktopHostTargetSelectRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopSettingsController,
  reportError: (operation: string, cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  const request = parseHostTargetRequest(value)
  if (request === undefined) return finishJson(res, 400, error('invalid Host target selection request'))
  try {
    const operation = await controller.selectHostTarget(request as DesktopHostTargetSelection)
    finishPostResponse(
      res,
      operation.response.restartRequired ? 202 : 200,
      operation,
      'select Host target',
      reportError,
    )
  } catch (cause) {
    reportError('select Host target', cause)
    finishJson(res, 409, error('Host target could not be selected'))
  }
}

/** Open the launcher-owned DSH terminal from an exact empty request. */
export async function handleDesktopTerminalOpenRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopSettingsController,
  reportError: (operation: string, cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  if (!isEmptyRequest(value)) return finishJson(res, 400, error('invalid terminal request'))
  try {
    finishJson(res, 200, controller.openTerminal())
  } catch (cause) {
    reportError('open terminal', cause)
    finishJson(res, 500, error('terminal could not be opened'))
  }
}

/** Export diagnostics from an exact empty same-origin request. */
export async function handleDesktopDiagnosticsExportRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopSettingsController,
  reportError: (operation: string, cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  if (!isEmptyRequest(value)) return finishJson(res, 400, error('invalid diagnostic export request'))
  try {
    finishJson(res, 200, await controller.exportDiagnostics())
  } catch (cause) {
    reportError('export diagnostics', cause)
    finishJson(res, 500, error('diagnostics could not be exported'))
  }
}

/** Open the isolated native Profile creator from an exact empty request. */
export async function handleDesktopProfileCreateWindowRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopSettingsController,
  reportError: (operation: string, cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  if (!isEmptyRequest(value)) return finishJson(res, 400, error('invalid Profile creator request'))
  try {
    finishJson(res, 200, controller.openProfileCreator())
  } catch (cause) {
    reportError('open Profile creator', cause)
    finishJson(res, 500, error('Profile creator could not be opened'))
  }
}

/** Restore the last-known-good Profile from an exact empty request. */
export async function handleDesktopProfileRollbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopSettingsController,
  reportError: (operation: string, cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  if (!isEmptyRequest(value)) return finishJson(res, 400, error('invalid Profile rollback request'))
  try {
    finishPostResponse(
      res,
      202,
      controller.rollbackProfile(),
      'restore last-known-good Profile',
      reportError,
    )
  } catch (cause) {
    reportError('prepare last-known-good Profile restore', cause)
    finishJson(res, 409, error('last-known-good Profile could not be restored'))
  }
}

export const desktopSettingsRouteConstants = Object.freeze({
  maxBodyBytes: MAX_SETTINGS_BODY_BYTES,
})
