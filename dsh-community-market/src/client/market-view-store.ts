import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

export interface MarketViewState {
  open: boolean
}

type MarketViewActions = {
  open: (draft: MarketViewState) => void
  close: (draft: MarketViewState) => void
}

export function createMarketViewStore(): EngineStoreHandle<MarketViewState, MarketViewActions> {
  return defineStore({
    init: (): MarketViewState => ({ open: false }),
    actions: {
      open: draft => { draft.open = true },
      close: draft => { draft.open = false },
    },
  })
}
