import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRuntime, DesktopTrayItem } from '../src/runtime.ts'
import type { DesktopUpdaterAdapter } from '../src/update-controller.ts'
import {
  apply,
  Config,
  inject,
  type Config as UpdateConfig,
} from '../src/updates.ts'

const testConfig: UpdateConfig = {
  enabled: true,
  initialDelayMs: 10,
  intervalMs: 1_000,
}

function updaterFor(version: string): DesktopUpdaterAdapter {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  return {
    on: (event, listener) => { listeners.set(event, listener) },
    off: (event) => { listeners.delete(event) },
    checkForUpdates: vi.fn(async () => ({
      updateInfo: {
        version,
        desktopUpdateMode: 'automatic',
        files: [{ size: 1024 }],
      },
    })),
    downloadUpdate: vi.fn(async () => {
      listeners.get('update-downloaded')?.({ version })
    }),
  }
}

interface Harness {
  readonly tray: DesktopTrayItem
  readonly rpc: (endpoint: string, payload: unknown) => Promise<unknown>
  readonly updater: DesktopUpdaterAdapter
  readonly notify: ReturnType<typeof vi.fn>
  readonly openReleasePage: ReturnType<typeof vi.fn>
  readonly refresh: ReturnType<typeof vi.fn>
  readonly rpcDispose: ReturnType<typeof vi.fn>
  dispose(): Promise<void>
}

function createHarness(options: {
  readonly packaged?: boolean
  readonly installMode?: 'automatic' | 'manual' | 'unsupported'
  readonly version?: string
  readonly config?: UpdateConfig
} = {}): Harness {
  const updater = updaterFor(options.version ?? '2.0.2')
  const notify = vi.fn()
  const openReleasePage = vi.fn(async () => {})
  const refresh = vi.fn()
  const rpcDispose = vi.fn(async () => {})
  let tray: DesktopTrayItem | undefined
  let rpc: ((endpoint: string, payload: unknown) => Promise<unknown>) | undefined
  let disposer: (() => void | Promise<void>) | undefined
  const runtime = {
    updates: {
      isPackaged: options.packaged ?? true,
      currentVersion: '2.0.1',
      installMode: options.installMode ?? 'automatic',
      updater,
      createCancellation: () => ({ cancel: vi.fn() }),
      requestInstall: vi.fn(async () => {}),
      openReleasePage,
      notify,
    },
    registerTrayItem: (item: DesktopTrayItem) => {
      tray = item
      return { refresh, dispose: vi.fn() }
    },
  } as unknown as DesktopRuntime
  const ctx = {
    desktopRuntime: runtime,
    connection: {
      rpc: {
        handle: vi.fn((_channel, handler, policy) => {
          expect(policy).toEqual({ authority: 'loopback' })
          rpc = async (endpoint, payload) => await handler(endpoint, payload, new AbortController().signal)
          return rpcDispose
        }),
      },
    },
    effect: (register: () => (() => void | Promise<void>)) => {
      disposer = register()
      return disposer
    },
  } as unknown as Context

  apply(ctx, options.config ?? testConfig)
  if (tray === undefined || rpc === undefined) throw new Error('update coordinator did not register its surfaces')
  return {
    tray,
    rpc,
    updater,
    notify,
    openReleasePage,
    refresh,
    rpcDispose,
    dispose: async () => { await disposer?.() },
  }
}

afterEach(() => { vi.useRealTimers() })

describe('desktop update Host plugin', () => {
  it('publishes the packaged startup and six-hour schedule', () => {
    expect(inject).toEqual(['desktopRuntime', 'connection'])
    expect(Config({} as UpdateConfig)).toEqual({
      enabled: true,
      initialDelayMs: 60_000,
      intervalMs: 21_600_000,
    })
    expect(() => Config({ intervalMs: 0 } as UpdateConfig)).toThrow()
  })

  it('serves state and actions only through the fixed empty-payload RPC', async () => {
    const harness = createHarness({ packaged: false })

    await expect(harness.rpc('state', {})).resolves.toMatchObject({
      ok: true,
      value: { phase: 'idle', currentVersion: '2.0.1' },
    })
    await expect(harness.rpc('check', {})).resolves.toMatchObject({
      ok: true,
      value: { phase: 'available', availableVersion: '2.0.2' },
    })
    await expect(harness.rpc('state', { url: 'https://example.test' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
    await expect(harness.rpc('unknown', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })

    await harness.dispose()
    expect(harness.rpcDispose).toHaveBeenCalledOnce()
  })

  it('checks after startup, updates the tray, and notifies once per version', async () => {
    vi.useFakeTimers()
    const harness = createHarness()

    expect(harness.tray.label()).toBe('Check for Updates…')
    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => {
      expect(harness.tray.label()).toBe('DSH Desktop 2.0.2 Available')
    })
    expect(harness.notify).toHaveBeenCalledWith({
      title: 'DSH Desktop Update Available',
      body: 'Version 2.0.2 is ready to download.',
    })

    await vi.advanceTimersByTimeAsync(testConfig.intervalMs)
    expect(harness.notify).toHaveBeenCalledOnce()
    await harness.dispose()
  })

  it('uses the tray action for automatic download and manual release fallback', async () => {
    const automatic = createHarness({ packaged: false })
    await automatic.tray.invoke()
    await automatic.tray.invoke()
    expect(automatic.updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(automatic.tray.label()).toBe('Restart to Install 2.0.2')
    await automatic.dispose()

    const manual = createHarness({ packaged: false, installMode: 'manual' })
    await manual.tray.invoke()
    await manual.tray.invoke()
    expect(manual.openReleasePage).toHaveBeenCalledOnce()
    expect(manual.updater.downloadUpdate).not.toHaveBeenCalled()
    await manual.dispose()
  })
})
