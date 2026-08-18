import { describe, expect, it, vi } from 'vitest'
import { MarketController } from '../src/client/controller.js'

describe('community market client controller', () => {
  it('notifies subscribers only when the open state changes', () => {
    const controller = new MarketController()
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)

    expect(controller.getSnapshot()).toBe(false)
    controller.open()
    controller.open()
    expect(controller.getSnapshot()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    controller.close()
    controller.close()
    expect(controller.getSnapshot()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    controller.open()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
