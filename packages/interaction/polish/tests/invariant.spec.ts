import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as PolishInvariant from '../src/invariant.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { harness } from './helpers.ts'

describe('dsh-polish invariant companion', () => {
  it('removes its registry contribution when its fiber is disposed (HMR safety)', async () => {
    const ctx = await harness(new MockAdapter([]), { maxMessageChars: 20000 })
    try {
      await ctx.plugin(InvariantRegistry)
      const fiber = await ctx.plugin(PolishInvariant)

      expect(() => {
        ctx.invariants.register('@deepseek-ai/dsh-polish', () => {})
      }).toThrow(/already registered/u)

      await fiber.dispose()
      await expect(ctx.plugin(PolishInvariant).await()).resolves.toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
