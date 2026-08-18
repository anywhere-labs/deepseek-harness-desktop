export const MARKET_MEDIA_ASSET_REF_PATTERN = /^mktimg_[A-Za-z0-9_-]{32}$/u

/** Convert an opaque Host-issued reference into the only renderer-facing asset URL. */
export function marketMediaAssetUrl(assetRef: string): string {
  return `/api/community-market/assets?ref=${encodeURIComponent(assetRef)}`
}
