import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { marketRoutes } from '../src/host/routes.js'

type Handler = (req: any, res: any) => void | Promise<void>

interface Injection {
  readonly names: readonly string[]
  readonly factory: (ctx: { get(name: string): unknown; effect(factory: () => void | (() => void)): void }) => void
  cleanups: (() => void)[]
  active: boolean
}

function createHarness() {
  const values = new Map<string, unknown>()
  const handlers = new Map<string, Handler>()
  const injections: Injection[] = []
  const globalCleanups: (() => void)[] = []
  let activeInjection: Injection | undefined
  let settings: Record<string, unknown> = { sources: [], installReceipts: [] }

  const registerEffect = (factory: () => void | (() => void), owner = activeInjection): void => {
    const cleanup = factory()
    if (typeof cleanup !== 'function') return
    if (owner === undefined) globalCleanups.push(cleanup)
    else owner.cleanups.push(cleanup)
  }

  const activate = (injection: Injection): void => {
    if (injection.active || !injection.names.every(name => values.has(name))) return
    injection.active = true
    activeInjection = injection
    injection.factory({
      get: name => values.get(name),
      effect: factory => { registerEffect(factory, injection) },
    })
    activeInjection = undefined
  }

  const context = {
    logger: { error: vi.fn() },
    settings: {
      register: vi.fn(() => ({
        get: () => settings,
        update: async (patch: Record<string, unknown>) => { settings = { ...settings, ...patch } },
      })),
    },
    webServer: {
      port: 43_120,
      register: vi.fn((route: { path: string; handler: Handler }) => {
        handlers.set(route.path, route.handler)
        return () => { handlers.delete(route.path) }
      }),
    },
    effect: (factory: () => void | (() => void)) => { registerEffect(factory) },
    inject: (
      names: readonly string[],
      factory: (ctx: { get(name: string): unknown; effect(factory: () => void | (() => void)): void }) => void,
    ) => {
      const injection: Injection = { names, factory, cleanups: [], active: false }
      injections.push(injection)
      activate(injection)
    },
  }

  const request = async (path: string) => {
    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: path,
      headers: {
        host: '127.0.0.1:43120',
        origin: 'http://127.0.0.1:43120',
        'sec-fetch-site': 'same-origin',
      },
      socket: { remoteAddress: '127.0.0.1' },
      destroy: vi.fn(),
    })
    let body: unknown
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      statusCode: 0,
      headers: new Map<string, string>(),
      setHeader(name: string, value: string) { response.headers.set(name.toLowerCase(), value) },
      removeHeader(name: string) { response.headers.delete(name.toLowerCase()) },
      end(value?: string) {
        response.writableEnded = true
        body = value === undefined || value === '' ? undefined : JSON.parse(value)
      },
    })
    const handler = handlers.get(path)
    if (handler === undefined) throw new Error(`missing route ${path}`)
    await handler(req, response)
    return { status: response.statusCode, body }
  }

  return {
    context,
    request,
    provide(name: string, value: unknown) {
      values.set(name, value)
      for (const injection of injections) activate(injection)
    },
    remove(name: string) {
      values.delete(name)
      for (const injection of injections) {
        if (!injection.active || !injection.names.includes(name)) continue
        for (const cleanup of injection.cleanups.splice(0).reverse()) cleanup()
        injection.active = false
      }
    },
    dispose() {
      for (const injection of injections.toReversed()) {
        for (const cleanup of injection.cleanups.splice(0).reverse()) cleanup()
        injection.active = false
      }
      for (const cleanup of globalCleanups.splice(0).reverse()) cleanup()
    },
  }
}

describe('community market Host capability lifecycle', () => {
  it('keeps desktop routes fail-closed until capabilities are live and after they are disposed', async () => {
    const harness = createHarness()
    apply(harness.context as never)

    await expect(harness.request(marketRoutes.installable)).resolves.toMatchObject({ status: 503 })
    await expect(harness.request(marketRoutes.state)).resolves.toMatchObject({
      status: 200,
      body: { desktopActions: { openTerminal: false, requestRestart: false } },
    })

    harness.provide('desktopActions', {
      openTerminal: vi.fn(),
      requestRestart: vi.fn(async () => {}),
    })
    await expect(harness.request(marketRoutes.state)).resolves.toMatchObject({
      body: { desktopActions: { openTerminal: true, requestRestart: false } },
    })

    harness.provide('desktopProfiles', { current: { name: 'web', dir: 'C:/fixture-profile' } })
    harness.provide('desktopPnpm', {})
    await expect(harness.request(marketRoutes.installable)).resolves.toMatchObject({ status: 404 })

    harness.remove('desktopPnpm')
    await expect(harness.request(marketRoutes.installable)).resolves.toMatchObject({ status: 503 })

    harness.dispose()
  })
})
