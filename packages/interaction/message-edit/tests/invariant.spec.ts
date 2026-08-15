import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as MessageEditInvariant from '../src/invariant.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { harness } from './helpers.ts'

describe('dsh-message-edit invariant companion', () => {
  it('removes its registry contribution when its fiber is disposed (HMR safety)', async () => {
    const ctx = await harness(new MockAdapter([]), { maxMessageChars: 20000 })
    try {
      await ctx.plugin(InvariantRegistry)
      const fiber = await ctx.plugin(MessageEditInvariant)

      expect(() => {
        ctx.invariants.register('@deepseek-ai/dsh-message-edit', () => {})
      }).toThrow(/already registered/u)

      await fiber.dispose()
      await expect(ctx.plugin(MessageEditInvariant).await()).resolves.toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
