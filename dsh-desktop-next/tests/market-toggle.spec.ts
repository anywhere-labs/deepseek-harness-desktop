import { expect, it } from 'vitest'
import type { BundleInfo } from '@deepseek-ai/dsh-api-remotes/client'
import { COMMUNITY_MARKET, DSH_MARKET, marketToggleTargets } from '../src/client/market-toggle.ts'

const row = (name: string, enabled: boolean, readOnlyReason?: string) =>
  ({ name, enabled, readOnlyReason }) as BundleInfo

it('enables the preferred market, falling back to the available provider', () => {
  const markets = [row(COMMUNITY_MARKET, false), row(DSH_MARKET, false)]
  expect(marketToggleTargets(markets, COMMUNITY_MARKET, true)).toEqual([COMMUNITY_MARKET])
  expect(marketToggleTargets(markets, DSH_MARKET, true)).toEqual([DSH_MARKET])
  expect(marketToggleTargets([row(COMMUNITY_MARKET, false, 'locked'), markets[1]!], COMMUNITY_MARKET, true)).toEqual([DSH_MARKET])
})

it('disables whichever market is active, including both in a legacy Profile', () => {
  const markets = [row(COMMUNITY_MARKET, true), row(DSH_MARKET, true)]
  expect(marketToggleTargets(markets, COMMUNITY_MARKET, false)).toEqual([COMMUNITY_MARKET, DSH_MARKET])
  expect(marketToggleTargets([markets[0]!, row(DSH_MARKET, false)], DSH_MARKET, false)).toEqual([COMMUNITY_MARKET])
  expect(marketToggleTargets([row(COMMUNITY_MARKET, false), row(DSH_MARKET, false)], COMMUNITY_MARKET, false)).toEqual([])
  expect(marketToggleTargets([row(COMMUNITY_MARKET, true, 'locked'), markets[1]!], DSH_MARKET, false)).toEqual([])
})
