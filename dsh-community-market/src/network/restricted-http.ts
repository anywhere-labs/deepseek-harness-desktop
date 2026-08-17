import dns from 'node:dns'
import { BlockList, isIP } from 'node:net'
import https from 'node:https'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { CatalogHttpClient, CatalogHttpResponse } from '../contracts/types.js'

const MAX_REDIRECTS = 3
const MAX_BODY_BYTES = 2 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 8_000
const FIRST_BYTE_TIMEOUT_MS = 12_000
const TOTAL_TIMEOUT_MS = 30_000

export class CatalogNetworkError extends Error {
  constructor(readonly code: 'invalid-url' | 'blocked-address' | 'redirect' | 'timeout' | 'http' | 'response') {
    super(`catalog request failed: ${code}`)
    this.name = 'CatalogNetworkError'
  }
}

const blockedAddresses = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6')
}

interface PinnedAddress {
  readonly address: string
  readonly family: 4 | 6
}

interface RestrictedHttpResponse {
  readonly statusCode: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

export interface RestrictedHttpClientOptions {
  readonly resolveAddress?: (hostname: string) => Promise<PinnedAddress>
  readonly request?: (
    url: URL,
    signal: AbortSignal,
    pinned: PinnedAddress,
  ) => Promise<RestrictedHttpResponse>
  readonly totalTimeoutMs?: number
}

function assertSafeAddress(address: string): 4 | 6 {
  const normalized = address.replace(/^\[|\]$/gu, '').split('%', 1)[0]!
  const family = isIP(normalized)
  if (family === 0 || blockedAddresses.check(normalized, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new CatalogNetworkError('blocked-address')
  }
  return family as 4 | 6
}

export function pinnedLookupResult(options: { readonly all?: boolean | undefined }, pinned: PinnedAddress): PinnedAddress | PinnedAddress[] {
  return options.all ? [pinned] : pinned
}

function validateUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CatalogNetworkError('invalid-url')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') {
    throw new CatalogNetworkError('invalid-url')
  }
  return url
}

function readBody(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    response.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        response.destroy(new CatalogNetworkError('response'))
        return
      }
      chunks.push(buffer)
    })
    response.once('end', () => resolve(Buffer.concat(chunks)))
    response.once('error', reject)
  })
}

async function resolvePinnedAddress(hostname: string): Promise<PinnedAddress> {
  const literal = hostname.replace(/^\[|\]$/gu, '')
  if (isIP(literal)) return { address: literal, family: assertSafeAddress(literal) }
  const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0) throw new CatalogNetworkError('blocked-address')
  for (const entry of addresses) assertSafeAddress(entry.address)
  const first = addresses[0]!
  return { address: first.address, family: assertSafeAddress(first.address) }
}

function requestOnce(url: URL, signal: AbortSignal, pinned: PinnedAddress): Promise<RestrictedHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false
    let firstByteTimer: NodeJS.Timeout | undefined
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (firstByteTimer !== undefined) clearTimeout(firstByteTimer)
      callback()
    }
    const request = https.request(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        'user-agent': 'dsh-community-market/0.1',
      },
      servername: url.hostname,
      lookup: (_hostname, options, callback) => {
        const result = pinnedLookupResult(options, pinned)
        if (Array.isArray(result)) callback(null, result)
        else callback(null, result.address, result.family)
      },
      signal,
      timeout: CONNECT_TIMEOUT_MS,
    }, response => {
      firstByteTimer = setTimeout(() => {
        request.destroy(new CatalogNetworkError('timeout'))
      }, FIRST_BYTE_TIMEOUT_MS)
      void readBody(response).then(
        body => finish(() => resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body,
        })),
        cause => finish(() => reject(cause)),
      )
    })
    request.once('error', cause => finish(() => reject(cause)))
    request.once('timeout', () => request.destroy(new CatalogNetworkError('timeout')))
    request.end()
  })
}

async function fetchJson(
  start: string,
  signal: AbortSignal,
  resolveAddress: (hostname: string) => Promise<PinnedAddress>,
  request: (url: URL, signal: AbortSignal, pinned: PinnedAddress) => Promise<RestrictedHttpResponse>,
  redirectCount = 0,
): Promise<CatalogHttpResponse> {
  if (signal.aborted) throw new CatalogNetworkError('timeout')
  const url = validateUrl(start)
  if (redirectCount > MAX_REDIRECTS) throw new CatalogNetworkError('redirect')
  const pinned = await resolveAddress(url.hostname)
  const response = await request(url, signal, pinned)
  const status = response.statusCode
  if (status >= 300 && status < 400) {
    const location = response.headers.location
    if (location === undefined) throw new CatalogNetworkError('redirect')
    return await fetchJson(
      new URL(location, url).href,
      signal,
      resolveAddress,
      request,
      redirectCount + 1,
    )
  }
  if (status < 200 || status >= 300) throw new CatalogNetworkError('http')
  const contentType = response.headers['content-type'] ?? ''
  const encoding = response.headers['content-encoding']
  if (!/^(?:application\/json|application\/[^;]+\+json)(?:;|$)/iu.test(contentType)
    || encoding !== undefined && encoding !== 'identity') {
    throw new CatalogNetworkError('response')
  }
  let value: unknown
  try {
    value = JSON.parse(response.body.toString('utf8')) as unknown
  } catch {
    throw new CatalogNetworkError('response')
  }
  return { value, finalUrl: url.href }
}

export function createRestrictedHttpClient(
  options: RestrictedHttpClientOptions = {},
): CatalogHttpClient {
  const resolveAddress = options.resolveAddress ?? resolvePinnedAddress
  const request = options.request ?? requestOnce
  const totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS

  return {
    async getJson(start, signal) {
      if (signal.aborted) throw new CatalogNetworkError('timeout')
      const totalController = new AbortController()
      let timedOut = false
      const onAbort = () => totalController.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      const totalTimer = setTimeout(() => {
        timedOut = true
        totalController.abort()
      }, totalTimeoutMs)
      try {
        return await fetchJson(start, totalController.signal, resolveAddress, request)
      } catch (cause) {
        if (timedOut) throw new CatalogNetworkError('timeout')
        throw cause
      } finally {
        clearTimeout(totalTimer)
        signal.removeEventListener('abort', onAbort)
      }
    },
  }
}

export const restrictedHttpClient: CatalogHttpClient = createRestrictedHttpClient()
