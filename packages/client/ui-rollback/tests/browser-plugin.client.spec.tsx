// @vitest-environment jsdom
/**
 * ui-rollback browser half on a real cordis Context with fake slots/remote
 * faces: the plugin registers the rollback entry at
 * conversation.chat.assistant-leading-actions, the injected verb routes to the
 * generated rollback Remote and normalizes both envelopes, and registration
 * rides the plugin fiber (HMR safety). The node half and the invariant
 * companion are exercised over the same Context.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { RollbackResult } from '@deepseek-ai/dsh-rollback/types'
import type { RollbackActions } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

const sid = (k: string): SessionId => k as SessionId

/** Boot the plugin over fake faces; the Remote namespace records every call. */
async function bench(remoteRollback?: (request: unknown) => Promise<unknown>) {
  const ctx = new Context()
  const calls: { request: unknown }[] = []
  // The generated face wraps every business result in the carrier envelope.
  const carried = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
  const rollback = remoteRollback ?? ((request: unknown) => {
    calls.push({ request })
    return carried({ ok: true as const, value: { cutSeq: 12, codeReverted: 0, codeFailures: [] } })
  })
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  ctx.provide('remote.rollback', { rollback })
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.chat.assistant-leading-actions': { kind: 'list', scope: 'session' } },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    calls,
    entry: () => {
      const entry = ctx.slots.entries('conversation.chat.assistant-leading-actions')[0]
      if (entry === undefined) return undefined
      return {
        ...entry.options,
        locale: entry.locale,
        inject: entry.inject as unknown as ((sessionId: SessionId) => RollbackActions) | undefined,
      }
    },
  }
}

describe('ui-rollback browser plugin', () => {
  it('registers the rollback entry with the documented id, order, and locale', async () => {
    const b = await bench()
    await b.fiber.await()

    expect(b.entry()).toMatchObject({ id: 'rollback', order: 10, locale: 'rollback' })
    expect(b.entry()?.inject).toBeTypeOf('function')
  })

  it('routes rollback to the Remote and normalizes the success envelope', async () => {
    const b = await bench()
    await b.fiber.await()

    const outcome = await b.entry()!.inject!(sid('s1')).rollback(40, true)
    expect(outcome).toEqual({ ok: true, cutSeq: 12, codeReverted: 0, codeFailures: [] })
    expect(b.calls[0]?.request).toEqual({ sessionId: 's1', messageSeq: 40, code: true })
  })

  it('normalizes a business failure without a message to its code', async () => {
    const businessFailure: RollbackResult = {
      ok: false,
      error: { code: 'session-not-found', sessionId: sid('s1') },
    }
    const b = await bench(() => Promise.resolve({ ok: true as const, value: businessFailure }))
    await b.fiber.await()

    const outcome = await b.entry()!.inject!(sid('s1')).rollback(40, false)
    expect(outcome).toEqual({ ok: false, code: 'session-not-found', message: 'session-not-found' })
  })

  it('normalizes a carrier failure to its raw code and message', async () => {
    const b = await bench(() => Promise.resolve({ ok: false as const, error: { code: 'transport-down', message: 'wire lost' } }))
    await b.fiber.await()

    const outcome = await b.entry()!.inject!(sid('s1')).rollback(40, false)
    expect(outcome).toEqual({ ok: false, code: 'transport-down', message: 'wire lost' })
  })

  it('withdraws the registration with the plugin fiber and re-registers on reload', async () => {
    const b = await bench()
    await b.fiber.await()
    await b.fiber.dispose()
    expect(b.ctx.slots.entries('conversation.chat.assistant-leading-actions')).toHaveLength(0)

    const reloaded = b.ctx.plugin({ inject: [...inject], apply })
    await reloaded.await()
    expect(b.ctx.slots.entries('conversation.chat.assistant-leading-actions')).toHaveLength(1)
    expect(b.entry()).toMatchObject({ id: 'rollback' })
  })

  it('the node half applies without host-side behavior', () => {
    // The invariant companion is mounted by the vitest-wide invariant host on
    // every Context this suite creates; its registration is covered there.
    expect(() => { nodeApply() }).not.toThrow()
  })
})
