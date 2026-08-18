import { createHash, randomBytes } from 'node:crypto'
import { MARKET_MEDIA_ASSET_REF_PATTERN } from './ref.js'
import {
  createRestrictedImageFetcher,
  normalizeAllowedHostnames,
  validateRemoteImageUrl,
  type RestrictedImageFetcher,
} from './restricted-image.js'
import { normalizeMarketImage } from './normalize-image.js'
import type {
  MarketMediaCandidate,
  MarketMediaService,
  ResolvedMarketMediaAsset,
} from './types.js'

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_CACHED_ASSETS = 256
const DEFAULT_MAX_REGISTERED_ASSETS = 4_096
const DEFAULT_MAX_CONCURRENT_RESOLUTIONS = 2

interface RegisteredAsset {
  readonly candidate: MarketMediaCandidate
  lastUsedAt: number
  cached?: ResolvedMarketMediaAsset
  cachedAt?: number
  inFlight?: Promise<ResolvedMarketMediaAsset>
  inFlightController?: AbortController
}

export interface MarketMediaServiceOptions {
  readonly fetchImage?: RestrictedImageFetcher
  readonly normalizeImage?: (image: Awaited<ReturnType<RestrictedImageFetcher>>) => Promise<Buffer>
  readonly now?: () => number
  readonly cacheTtlMs?: number
  readonly maxCachedAssets?: number
  readonly maxRegisteredAssets?: number
  readonly maxConcurrentResolutions?: number
  readonly createAssetRef?: () => string
}

function canonicalCandidate(candidate: MarketMediaCandidate): MarketMediaCandidate {
  if (
    (candidate.role !== 'plugin-icon' && candidate.role !== 'publisher-avatar')
    || candidate.sourceRecordId.length === 0
    || candidate.sourceRecordId.length > 256
    || candidate.itemId.length === 0
    || candidate.itemId.length > 512
    || candidate.alt !== undefined && candidate.alt.length > 1_024
  ) {
    throw new TypeError('invalid market media candidate')
  }
  const allowedHostnames = normalizeAllowedHostnames(candidate.allowedHostnames)
  const remoteUrl = validateRemoteImageUrl(candidate.remoteUrl, new Set(allowedHostnames)).href
  return {
    remoteUrl,
    role: candidate.role,
    ...(candidate.alt === undefined ? {} : { alt: candidate.alt }),
    sourceRecordId: candidate.sourceRecordId,
    itemId: candidate.itemId,
    allowedHostnames,
  }
}

function candidateKey(candidate: MarketMediaCandidate): string {
  return createHash('sha256').update(JSON.stringify(candidate)).digest('hex')
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortReason = () => signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  if (signal.aborted) return Promise.reject(abortReason())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason())
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      cause => {
        signal.removeEventListener('abort', onAbort)
        reject(cause)
      },
    )
  })
}

export function createMarketMediaService(
  options: MarketMediaServiceOptions = {},
): MarketMediaService {
  const fetchImage = options.fetchImage ?? createRestrictedImageFetcher()
  const normalizeImage = options.normalizeImage ?? normalizeMarketImage
  const now = options.now ?? Date.now
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const maxCachedAssets = options.maxCachedAssets ?? DEFAULT_MAX_CACHED_ASSETS
  const maxRegisteredAssets = options.maxRegisteredAssets ?? DEFAULT_MAX_REGISTERED_ASSETS
  const maxConcurrentResolutions = options.maxConcurrentResolutions ?? DEFAULT_MAX_CONCURRENT_RESOLUTIONS
  if (
    !Number.isSafeInteger(maxCachedAssets)
    || maxCachedAssets < 0
    || !Number.isSafeInteger(maxRegisteredAssets)
    || maxRegisteredAssets < 1
    || !Number.isSafeInteger(maxConcurrentResolutions)
    || maxConcurrentResolutions < 1
    || cacheTtlMs < 0
  ) {
    throw new TypeError('invalid market media cache options')
  }
  const createAssetRef = options.createAssetRef
    ?? (() => `mktimg_${randomBytes(24).toString('base64url')}`)
  const assets = new Map<string, RegisteredAsset>()
  const candidateRefs = new Map<string, string>()
  let disposed = false
  let activeResolutions = 0
  const resolutionWaiters: Array<{
    readonly signal: AbortSignal
    readonly grant: () => void
    readonly reject: (cause: unknown) => void
    readonly onAbort: () => void
  }> = []

  const grantResolutionSlots = () => {
    while (activeResolutions < maxConcurrentResolutions && resolutionWaiters.length > 0) {
      const waiter = resolutionWaiters.shift()!
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) continue
      activeResolutions += 1
      waiter.grant()
    }
  }

  const acquireResolutionSlot = async (signal: AbortSignal): Promise<() => void> => {
    signal.throwIfAborted()
    if (activeResolutions < maxConcurrentResolutions) {
      activeResolutions += 1
    } else {
      await new Promise<void>((grant, reject) => {
        const waiter = {
          signal,
          grant,
          reject,
          onAbort: () => {
            const index = resolutionWaiters.indexOf(waiter)
            if (index >= 0) resolutionWaiters.splice(index, 1)
            reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
          },
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
        resolutionWaiters.push(waiter)
      })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      activeResolutions -= 1
      grantResolutionSlots()
    }
  }

  const resolveBounded = async <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
    const release = await acquireResolutionSlot(signal)
    try {
      signal.throwIfAborted()
      return await operation()
    } finally {
      release()
    }
  }

  const deleteAsset = (assetRef: string, entry: RegisteredAsset) => {
    entry.inFlightController?.abort(new DOMException('Market media registration was revoked', 'AbortError'))
    assets.delete(assetRef)
    candidateRefs.delete(candidateKey(entry.candidate))
  }

  const makeRegistrationRoom = () => {
    if (assets.size < maxRegisteredAssets) return
    const oldest = [...assets.entries()]
      .filter(([, entry]) => entry.inFlight === undefined)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0]
    if (oldest === undefined) throw new Error('market media registration limit reached')
    deleteAsset(oldest[0], oldest[1])
  }

  const evictExcessCache = () => {
    const cached = [...assets.values()]
      .filter(entry => entry.cachedAt !== undefined)
      .sort((left, right) => left.cachedAt! - right.cachedAt!)
    while (cached.length > maxCachedAssets) {
      const entry = cached.shift()!
      delete entry.cached
      delete entry.cachedAt
    }
  }

  return {
    register(rawCandidate) {
      if (disposed) throw new Error('market media service is disposed')
      const candidate = canonicalCandidate(rawCandidate)
      const key = candidateKey(candidate)
      const existingRef = candidateRefs.get(key)
      if (existingRef !== undefined) {
        const existing = assets.get(existingRef)
        if (existing !== undefined) existing.lastUsedAt = now()
        return existingRef
      }
      makeRegistrationRoom()
      let assetRef = createAssetRef()
      if (!MARKET_MEDIA_ASSET_REF_PATTERN.test(assetRef)) {
        throw new TypeError('invalid generated market media asset reference')
      }
      while (assets.has(assetRef)) assetRef = `mktimg_${randomBytes(24).toString('base64url')}`
      assets.set(assetRef, { candidate, lastUsedAt: now() })
      candidateRefs.set(key, assetRef)
      return assetRef
    },

    async resolve(assetRef, signal) {
      if (disposed) return undefined
      if (!MARKET_MEDIA_ASSET_REF_PATTERN.test(assetRef)) return undefined
      const entry = assets.get(assetRef)
      if (entry === undefined) return undefined
      entry.lastUsedAt = now()
      if (
        entry.cached !== undefined
        && entry.cachedAt !== undefined
        && now() - entry.cachedAt < cacheTtlMs
      ) {
        return entry.cached
      }
      if (entry.inFlight === undefined) {
        const inFlightController = new AbortController()
        entry.inFlightController = inFlightController
        entry.inFlight = resolveBounded(inFlightController.signal, async () => {
          const rawImage = await fetchImage(entry.candidate, inFlightController.signal)
          const body = await normalizeImage(rawImage)
          const digest = createHash('sha256').update(body).digest('base64url')
          return {
            body,
            contentType: 'image/png',
            etag: `\"sha256-${digest}\"`,
          }
        })
        const inFlight = entry.inFlight
        void inFlight.then(
          asset => {
            if (disposed || assets.get(assetRef) !== entry) return
            entry.cached = asset
            entry.cachedAt = now()
            evictExcessCache()
          },
          () => {},
        ).then(() => {
          if (entry.inFlight === inFlight) {
            delete entry.inFlight
            delete entry.inFlightController
          }
        })
      }
      return await awaitWithSignal(entry.inFlight, signal)
    },

    unregisterSource(sourceRecordId) {
      for (const [assetRef, entry] of assets) {
        if (entry.candidate.sourceRecordId !== sourceRecordId) continue
        deleteAsset(assetRef, entry)
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const [assetRef, entry] of assets) deleteAsset(assetRef, entry)
      for (const waiter of resolutionWaiters.splice(0)) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiter.reject(new DOMException('Market media service was disposed', 'AbortError'))
      }
      candidateRefs.clear()
    },
  }
}
