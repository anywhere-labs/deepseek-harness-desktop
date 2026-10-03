/** Map the Plugins-page switch to official bundle-manager operations. */
import type { BundleInfo } from '@deepseek-ai/dsh-api-remotes/client'

export const COMMUNITY_MARKET = 'dsh-community-market'
export const DSH_MARKET = 'dshmarket'
export type MarketName = typeof COMMUNITY_MARKET | typeof DSH_MARKET

type MarketState = Pick<BundleInfo, 'name' | 'enabled' | 'readOnlyReason' | 'error'>

function editable(row: MarketState): boolean {
  return row.readOnlyReason === undefined && row.error === undefined
}

/** Disabling both handles older Profiles with two selected markets; enabling prefers the last choice. */
export function marketToggleTargets(rows: readonly MarketState[], preferred: MarketName, enable: boolean): MarketName[] {
  const markets = rows.filter((row): row is MarketState & { name: MarketName } =>
    row.name === COMMUNITY_MARKET || row.name === DSH_MARKET)
  if (!enable) {
    const active = markets.filter(row => row.enabled)
    return active.every(editable) ? active.map(row => row.name) : []
  }
  const preferredRow = markets.find(row => row.name === preferred && editable(row))
  const fallback = markets.find(row => editable(row))
  return preferredRow ? [preferredRow.name] : fallback ? [fallback.name] : []
}
