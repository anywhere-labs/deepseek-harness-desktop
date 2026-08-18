import dns from 'node:dns'
import { BlockList, isIP } from 'node:net'
import https from 'node:https'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { CatalogHttpClient, CatalogHttpRequestPolicy, CatalogHttpResponse } from '../contracts/types.js'

const MAX_REDIRECTS = 3
const MAX_BODY_BYTES = 2 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 8_000
const FIRST_BYTE_TIMEOUT_MS = 12_000
const TOTAL_TIMEOUT_MS = 30_000
const SYNTHETIC_PROXY_NETWORK = '198.18.0.0'
const SYNTHETIC_PROXY_PREFIX = 15

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

export interface PinnedAddress {
  readonly address: string
  readonly family: 4 | 6
}

interface RestrictedHttpResponse {
  readonly statusCode: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

export interface RestrictedHttpClientOptions {
  /**
   * Exact, reviewed hostnames that may resolve through a local proxy's
   * RFC 2544 fake-IP range. User-provided catalog hosts must never be added.
   */
  readonly syntheticProxyHostnames?: readonly string[]
  readonly lookupAddresses?: (hostname: string) => Promise<readonly PinnedAddress[]>
  readonly resolveAddress?: (hostname: string) => Promise<PinnedAddress>
  readonly request?: (
    url: URL,
    signal: AbortSignal,
    pinned: PinnedAddress,
  ) => Promise<RestrictedHttpResponse>
  readonly totalTimeoutMs?: number
  readonly maxBodyBytes?: number
}

const syntheticProxyAddresses = new BlockList()
syntheticProxyAddresses.addSubnet(SYNTHETIC_PROXY_NETWORK, SYNTHETIC_PROXY_PREFIX, 'ipv4')

function assertSafeAddress(address: string, allowSyntheticProxyAddress = false): 4 | 6 {
  const normalized = address.replace(/^\[|\]$/gu, '').split('%', 1)[0]!
  const family = isIP(normalized)
  const addressFamily = family === 4 ? 'ipv4' : 'ipv6'
  const allowedSyntheticAddress = allowSyntheticProxyAddress
    && family === 4
    && syntheticProxyAddresses.check(normalized, 'ipv4')
  if (family === 0 || blockedAddresses.check(normalized, addressFamily) && !allowedSyntheticAddress) {
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

function readBody(response: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    response.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > maxBodyBytes) {
        response.destroy(new CatalogNetworkError('response'))
        return
      }
      chunks.push(buffer)
    })
    response.once('end', () => resolve(Buffer.concat(chunks)))
    response.once('error', reject)
  })
}

async function defaultLookupAddresses(hostname: string): Promise<readonly PinnedAddress[]> {
  const entries = await dns.promises.lookup(hostname, { all: true, verbatim: true })
  return entries.map(entry => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }))
}

async function resolvePinnedAddress(
  hostname: string,
  lookupAddresses: (hostname: string) => Promise<readonly PinnedAddress[]>,
  syntheticProxyHostnames: ReadonlySet<string>,
): Promise<PinnedAddress> {
  const literal = hostname.replace(/^\[|\]$/gu, '')
  if (isIP(literal)) return { address: literal, family: assertSafeAddress(literal) }
  const addresses = await lookupAddresses(hostname)
  if (addresses.length === 0) throw new CatalogNetworkError('blocked-address')
  const allowSyntheticProxyAddress = syntheticProxyHostnames.has(hostname.toLowerCase())
  for (const entry of addresses) {
    if (entry.family !== assertSafeAddress(entry.address, allowSyntheticProxyAddress)) {
      throw new CatalogNetworkError('blocked-address')
    }
  }
  const first = addresses[0]!
  return { address: first.address, family: assertSafeAddress(first.address, allowSyntheticProxyAddress) }
}

function requestOnce(
  url: URL,
  signal: AbortSignal,
  pinned: PinnedAddress,
  maxBodyBytes: number,
): Promise<RestrictedHttpResponse> {
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
      if (firstByteTimer !== undefined) {
        clearTimeout(firstByteTimer)
        firstByteTimer = undefined
      }
      void readBody(response, maxBodyBytes).then(
        body => finish(() => resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body,
        })),
        cause => finish(() => reject(cause)),
      )
    })
    firstByteTimer = setTimeout(() => {
      request.destroy(new CatalogNetworkError('timeout'))
    }, FIRST_BYTE_TIMEOUT_MS)
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
  allowedOrigin: string | undefined,
  redirectCount = 0,
): Promise<CatalogHttpResponse> {
  if (signal.aborted) throw new CatalogNetworkError('timeout')
  const url = validateUrl(start)
  if (allowedOrigin !== undefined && url.origin !== allowedOrigin) throw new CatalogNetworkError('redirect')
  if (redirectCount > MAX_REDIRECTS) throw new CatalogNetworkError('redirect')
  const pinned = await resolveAddress(url.hostname)
  if (signal.aborted) throw new CatalogNetworkError('timeout')
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
      allowedOrigin,
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
  const syntheticProxyHostnames = new Set(
    (options.syntheticProxyHostnames ?? []).map(hostname => hostname.toLowerCase()),
  )
  const lookupAddresses = options.lookupAddresses ?? defaultLookupAddresses
  const resolveAddress = options.resolveAddress
    ?? (async hostname => await resolvePinnedAddress(hostname, lookupAddresses, syntheticProxyHostnames))
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
  const request = options.request
    ?? (async (url, signal, pinned) => await requestOnce(url, signal, pinned, maxBodyBytes))
  const totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS

  return {
    async getJson(start, signal, policy: CatalogHttpRequestPolicy = {}) {
      if (signal.aborted) throw new CatalogNetworkError('timeout')
      const totalController = new AbortController()
      let rejectAbort!: (cause: unknown) => void
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
      const onAbort = () => {
        const cause = signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
        totalController.abort(cause)
        rejectAbort(cause)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      let totalTimer!: NodeJS.Timeout
      const timedOut = new Promise<never>((_resolve, reject) => {
        totalTimer = setTimeout(() => {
          const cause = new CatalogNetworkError('timeout')
          totalController.abort(cause)
          reject(cause)
        }, totalTimeoutMs)
      })
      const operation = fetchJson(start, totalController.signal, resolveAddress, request, policy.allowedOrigin)
      try {
        return await Promise.race([operation, aborted, timedOut])
      } finally {
        clearTimeout(totalTimer)
        signal.removeEventListener('abort', onAbort)
      }
    },
  }
}

export interface CachedCatalogHttpClientOptions {
  readonly ttlMs?: number
  readonly now?: () => number
}

interface CachedCatalogResponse {
  response?: CatalogHttpResponse
  savedAt?: number
  inFlight?: Promise<CatalogHttpResponse>
  inFlightController?: AbortController
  waiters: number
}

function awaitCachedResponse(
  promise: Promise<CatalogHttpResponse>,
  signal: AbortSignal,
  release: () => void,
): Promise<CatalogHttpResponse> {
  const abortReason = () => signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  if (signal.aborted) {
    release()
    return Promise.reject(abortReason())
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      release()
      callback()
    }
    const onAbort = () => finish(() => reject(abortReason()))
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      response => finish(() => resolve(response)),
      cause => finish(() => reject(cause)),
    )
  })
}

/** Cache completed catalog responses and collapse concurrent reads by URL. */
export function createCachedCatalogHttpClient(
  delegate: CatalogHttpClient,
  options: CachedCatalogHttpClientOptions = {},
): CatalogHttpClient {
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000
  const now = options.now ?? Date.now
  const cache = new Map<string, CachedCatalogResponse>()
  return {
    async getJson(url, signal, policy: CatalogHttpRequestPolicy = {}) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      }
      const key = `${policy.allowedOrigin ?? ''}\0${url}`
      let entry = cache.get(key)
      if (entry === undefined || policy.cacheMode === 'reload') {
        entry = { waiters: 0 }
        cache.set(key, entry)
      }
      if (entry.response !== undefined && entry.savedAt !== undefined && now() - entry.savedAt < ttlMs) {
        return entry.response
      }
      if (entry.inFlight === undefined) {
        const inFlightController = new AbortController()
        entry.inFlightController = inFlightController
        const request = delegate.getJson(url, inFlightController.signal, policy)
        entry.inFlight = request
        void request.then(
          response => {
            if (entry.inFlight !== request || inFlightController.signal.aborted) return
            entry.response = response
            entry.savedAt = now()
          },
          () => {},
        ).finally(() => {
          if (entry.inFlight === request) {
            delete entry.inFlight
            delete entry.inFlightController
          }
        })
      }
      entry.waiters += 1
      let released = false
      return await awaitCachedResponse(entry.inFlight, signal, () => {
        if (released) return
        released = true
        entry.waiters -= 1
        if (entry.waiters === 0 && entry.inFlightController !== undefined) {
          const abandoned = entry.inFlight
          entry.inFlightController.abort()
          if (entry.inFlight === abandoned) {
            delete entry.inFlight
            delete entry.inFlightController
          }
        }
      })
    },
  }
}

export const restrictedHttpClient: CatalogHttpClient = createRestrictedHttpClient()
