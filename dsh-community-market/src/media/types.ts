export type MarketMediaRole = 'plugin-icon' | 'publisher-avatar'

/**
 * A reviewed image candidate produced inside a catalog adapter.
 *
 * This type must never be accepted directly from a renderer request. The Host
 * registers it and exposes only the returned opaque asset reference.
 */
export interface MarketMediaCandidate {
  readonly remoteUrl: string
  readonly role: MarketMediaRole
  readonly alt?: string
  readonly sourceRecordId: string
  readonly itemId: string
  /** Exact redirect hostnames reviewed by the adapter; wildcards are forbidden. */
  readonly allowedHostnames: readonly string[]
}

export interface ResolvedMarketMediaAsset {
  readonly body: Buffer
  readonly contentType: 'image/png'
  readonly etag: string
}

export interface MarketMediaRegistrar {
  register(candidate: MarketMediaCandidate): string
}

export interface MarketMediaService extends MarketMediaRegistrar {
  resolve(assetRef: string, signal: AbortSignal): Promise<ResolvedMarketMediaAsset | undefined>
  unregisterSource(sourceRecordId: string): void
  dispose(): void
}
