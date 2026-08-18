import { describe, expect, it, vi } from 'vitest'
import { createMarketViewStore } from '../src/client/market-view-store.js'

describe('community market view store', () => {
  it('publishes only changed open snapshots to a selector subscriber', () => {
    const marketView = createMarketViewStore().create()
    const listener = vi.fn()
    let selectedOpen = marketView.getSnapshot().open
    const unsubscribe = marketView.subscribe(() => {
      const nextOpen = marketView.getSnapshot().open
      if (nextOpen === selectedOpen) return
      selectedOpen = nextOpen
      listener(nextOpen)
    })

    expect(marketView.getSnapshot().open).toBe(false)
    marketView.actions.open()
    marketView.actions.open()
    expect(marketView.getSnapshot().open).toBe(true)
    expect(listener).toHaveBeenLastCalledWith(true)
    expect(listener).toHaveBeenCalledOnce()

    marketView.actions.close()
    marketView.actions.close()
    expect(marketView.getSnapshot().open).toBe(false)
    expect(listener).toHaveBeenLastCalledWith(false)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    marketView.actions.open()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
