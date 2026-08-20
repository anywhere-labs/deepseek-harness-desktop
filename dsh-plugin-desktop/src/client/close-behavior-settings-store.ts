/** Close-behavior row slot store: thin defineStore wrapper over the pure state. */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import {
  adoptCloseBehaviorRowState,
  CLOSE_BEHAVIOR_ROW_INITIAL_STATE,
  type CloseBehaviorRowState,
} from './close-behavior-settings-state.ts'

/** Declared action shape giving the exported factory a stable return type. */
type CloseBehaviorRowActions = {
  sync: (draft: CloseBehaviorRowState, value: CloseBehaviorRowState['value'], revision: number) => void
}

/**
 * Declares the close-behavior row state and write surface.
 * @returns the store handle.
 */
export function createCloseBehaviorRowStore(): EngineStoreHandle<CloseBehaviorRowState, CloseBehaviorRowActions> {
  return defineStore({
    init: (): CloseBehaviorRowState => ({ ...CLOSE_BEHAVIOR_ROW_INITIAL_STATE }),
    actions: {
      sync: (d, value, revision) => {
        const next = adoptCloseBehaviorRowState(d, value, revision)
        if (next !== d) {
          d.value = next.value
          d.revision = next.revision
        }
      },
    },
  })
}
