import { describe, expect, it } from 'vitest'
import {
  adoptCloseBehaviorRowState,
  CLOSE_BEHAVIOR_ROW_INITIAL_STATE,
} from '../src/client/close-behavior-settings-state.ts'

describe('desktop close-behavior row state', () => {
  it('starts on the tray default with an unsynced revision', () => {
    expect(CLOSE_BEHAVIOR_ROW_INITIAL_STATE).toEqual({ value: 'tray', revision: -1 })
  })

  it('adopts newer revisions and ignores stale ones', () => {
    const initial = { ...CLOSE_BEHAVIOR_ROW_INITIAL_STATE }
    const quit = adoptCloseBehaviorRowState(initial, 'quit', 1)
    expect(quit).toEqual({ value: 'quit', revision: 1 })
    expect(adoptCloseBehaviorRowState(quit, 'tray', 1)).toBe(quit)
    expect(adoptCloseBehaviorRowState(quit, 'tray', 2)).toEqual({ value: 'tray', revision: 2 })
  })
})
