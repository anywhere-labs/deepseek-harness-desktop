import type { Context } from '@deepseek-ai/cordis'
import type { ThemePreference } from '@deepseek-ai/dsh-client-ui-theme'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  Config,
  DESKTOP_SETTINGS_NAMESPACE,
  desktopRendererUrl,
  DesktopSettingsSchema,
  inject,
  type Config as DesktopConfig,
  type DesktopSettings,
} from '../src/index.ts'
import type { DesktopRuntime, DesktopShellSpec } from '../src/runtime.ts'

const config: DesktopConfig = {
  mode: 'compatibility',
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
  filePreview: {
    maxTextBytes: 2 * 1024 * 1024,
    maxImageBytes: 20 * 1024 * 1024,
    resourceTtlMs: 60_000,
    maxResources: 64,
  },
}

afterEach(() => { vi.useRealTimers() })

interface PluginHarness {
  ctx: Context
  runtime: DesktopRuntime
  shell(): DesktopShellSpec | undefined
  update: ReturnType<typeof vi.fn<(patch: object) => Promise<void>>>
  restart: ReturnType<typeof vi.fn<() => Promise<void>>>
  setThemeSource: ReturnType<typeof vi.fn<(source: ThemePreference) => void>>
  notify(next: DesktopSettings, prev: DesktopSettings): Promise<void>
  notifyTheme(preference: ThemePreference): void
  /** Routes registered through the fake webServer. */
  routes: Array<{ kind: 'exact' | 'prefix'; path: string }>
  /** RPC channels registered through the fake connection. */
  channels: string[]
  /** Disposers returned by every registered effect, in registration order. */
  disposers: Array<() => unknown>
  /** Live RPC handlers keyed by channel (undefined after the channel is disposed). */
  rpcHandlers: Map<string, ((...args: unknown[]) => unknown) | undefined>
}

function createHarness(platform: DesktopRuntime['platform'] = 'darwin'): PluginHarness {
  let shell: DesktopShellSpec | undefined
  let watcher: ((next: DesktopSettings, prev: DesktopSettings) => void | Promise<void>) | undefined
  const update = vi.fn(async (_patch: object) => {})
  const restart = vi.fn(async () => {})
  const setThemeSource = vi.fn<(source: ThemePreference) => void>()
  const routes: PluginHarness['routes'] = []
  const channels: string[] = []
  const disposers: Array<() => unknown> = []
  const rpcHandlers = new Map<string, ((...args: unknown[]) => unknown) | undefined>()
  let settingsUpdated: ((namespace: unknown, next: unknown) => void) | undefined
  let themePreference: ThemePreference = 'system'
  const runtime: DesktopRuntime = {
    platform,
    updates: {
      isPackaged: false,
      canDownload: platform === 'darwin' || platform === 'win32',
      currentVersion: '2.0.0',
      statePath: '/tmp/dsh-desktop-update-state.json',
      request: async () => new Response(null, { status: 304 }),
      confirmDownload: async () => false,
      showManualCheckResult: async () => {},
      downloadAndOpen: async () => {},
      notify: () => {},
    },
    schedule: (spec) => {
      shell = spec
      return async () => {}
    },
    mountScheduled: async () => {},
    show: () => {},
    registerTrayItem: () => ({ refresh: () => {}, dispose: () => {} }),
    openTerminal: () => {},
    setThemeSource,
    requestRestart: restart,
    prepareToQuit: () => {},
  }
  const settings = {
    get: vi.fn((namespace: unknown) => String(namespace) === 'ui-theme'
      ? { preference: themePreference }
      : undefined),
    register: vi.fn(() => ({
      get: () => ({ mode: config.mode }),
      watch: (callback: typeof watcher) => {
        watcher = callback
        return () => { watcher = undefined }
      },
      update,
      replace: vi.fn(async () => {}),
    })),
  }
  const ctx = {
    desktopRuntime: runtime,
    webServer: {
      host: '127.0.0.1',
      port: 43120,
      register: vi.fn((route: { kind: 'exact' | 'prefix'; path: string }) => {
        routes.push({ kind: route.kind, path: route.path })
        return () => {
          const at = routes.findIndex(r => r.kind === route.kind && r.path === route.path)
          if (at !== -1) routes.splice(at, 1)
        }
      }),
    },
    settings,
    connection: {
      rpc: {
        handle: vi.fn((channel: string, handler?: (...args: unknown[]) => unknown) => {
          channels.push(channel)
          let active = true
          rpcHandlers.set(channel, async (...args: unknown[]) => {
            if (!active) return { ok: false, error: { code: 'cancelled', message: 'channel removed', details: {} } }
            return handler?.(...args)
          })
          return async () => {
            active = false
            rpcHandlers.delete(channel)
            const at = channels.indexOf(channel)
            if (at !== -1) channels.splice(at, 1)
          }
        }),
      },
    },
    workspaceRegistry: { list: vi.fn(() => []) },
    sessionQuery: { traceSession: vi.fn(async () => ({ target: { header: {} }, ancestors: [] })) },
    fs: {},
    logger: { warn: vi.fn(), error: vi.fn() },
    get: vi.fn(() => () => {}),
    effect: vi.fn((register: () => unknown) => {
      const disposer = register()
      if (typeof disposer === 'function') disposers.push(disposer as () => unknown)
      return disposer
    }),
    on: vi.fn((event: string, listener: (namespace: unknown, next: unknown) => void) => {
      if (event === 'settings/updated') settingsUpdated = listener
      return () => { if (settingsUpdated === listener) settingsUpdated = undefined }
    }),
  } as unknown as Context
  return {
    ctx,
    runtime,
    shell: () => shell,
    update,
    restart,
    setThemeSource,
    notify: async (next, prev) => { await watcher?.(next, prev) },
    notifyTheme: (preference) => {
      themePreference = preference
      settingsUpdated?.(settingsNamespace('ui-theme'), { preference })
    },
    routes,
    channels,
    disposers,
    rpcHandlers,
  }
}

describe('desktop Host plugin', () => {
  it('defaults to the platform shell mode and validates both schemas', () => {
    const expectedMode = process.platform === 'linux' ? 'compatibility' : 'advanced'
    expect(Config({} as DesktopConfig)).toEqual({ ...config, mode: expectedMode })
    expect(Config({ mode: 'advanced' } as DesktopConfig)).toEqual({ ...config, mode: 'advanced' })
    expect(DesktopSettingsSchema({} as DesktopSettings)).toEqual({ mode: expectedMode })
    expect(() => Config({ mode: 'custom' } as never)).toThrow()
    expect(String(DESKTOP_SETTINGS_NAMESPACE)).toBe('dsh-desktop')
  })

  it('builds the loopback root with validated renderer mode and platform markers', () => {
    const url = new URL(desktopRendererUrl(43120, 'advanced', 'darwin'))
    expect(url.origin).toBe('http://127.0.0.1:43120')
    expect(url.pathname).toBe('/')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'dsh-desktop-mode': 'advanced',
      'dsh-desktop-platform': 'darwin',
    })
  })

  it('registers settings and the active Web port without re-entering Loader settlement', async () => {
    const harness = createHarness()
    const loaderAwait = vi.fn(() => new Promise<void>(() => {}))
    Object.assign(harness.ctx, { loader: { await: loaderAwait } })

    apply(harness.ctx, config)

    expect(inject).toContain('settings')
    expect(inject).not.toContain('loader')
    const register = vi.mocked(harness.ctx.settings.register)
    expect(register.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ applies: 'restart' }))
    expect(register.mock.calls[0]?.[2]).not.toHaveProperty('base')
    expect(loaderAwait).not.toHaveBeenCalled()
    expect(harness.shell()).toEqual(expect.objectContaining({
      mode: 'compatibility',
      url: 'http://127.0.0.1:43120/?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin',
      productName: 'DSH Desktop',
      windowTitle: 'DeepSeek Harness Desktop',
      iconPath: expect.stringMatching(/\/build\/app-icon-mac\.png$/u),
      trayIcons: {
        templatePath: expect.stringMatching(/\/build\/tray-iconTemplate\.png$/u),
        bluePath: expect.stringMatching(/\/build\/tray-icon-blue\.png$/u),
      },
      readThemeSource: expect.any(Function),
    }))
    expect(harness.shell()?.readThemeSource()).toBe('system')
    harness.notifyTheme('dark')
    expect(harness.setThemeSource).not.toHaveBeenCalled()

    await harness.shell()?.requestModeChange('advanced')
    expect(harness.update).toHaveBeenCalledWith({ mode: 'advanced' })
  })

  it.each(['win32', 'linux'] as const)(
    'keeps the full-size application icon on %s',
    (platform) => {
      const harness = createHarness(platform)

      apply(harness.ctx, config)

      expect(harness.shell()?.iconPath).toMatch(/\/build\/app-icon\.png$/u)
    },
  )

  it('requests one orderly restart after the settings scope commits another mode', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    apply(harness.ctx, config)

    await harness.notify({ mode: 'compatibility' }, { mode: 'compatibility' })
    expect(harness.restart).not.toHaveBeenCalled()

    harness.restart.mockImplementation(() => new Promise<void>(() => {}))
    await harness.notify({ mode: 'advanced' }, { mode: 'compatibility' })
    await vi.runAllTimersAsync()
    expect(harness.restart).toHaveBeenCalledOnce()
  })

  it('projects live built-in theme changes into an advanced native material', () => {
    const harness = createHarness()
    apply(harness.ctx, { ...config, mode: 'advanced' })

    expect(harness.shell()?.readThemeSource()).toBe('system')
    harness.notifyTheme('dark')
    expect(harness.setThemeSource).toHaveBeenCalledWith('dark')
  })

  it('requires the desktop Web carrier to remain loopback-only', () => {
    const harness = createHarness()
    Object.assign(harness.ctx.webServer, { host: '0.0.0.0' })

    expect(() => apply(harness.ctx, config)).toThrow('requires a loopback Web server')
  })

  it('refuses advanced settings on Linux before persistence', () => {
    const harness = createHarness('linux')
    apply(harness.ctx, config)
    const register = vi.mocked(harness.ctx.settings.register)
    const options = register.mock.calls[0]?.[2]

    expect(() => options?.validate?.({ mode: 'advanced' })).toThrow(
      'supported on macOS and Windows',
    )
    expect(() => options?.validate?.({ mode: 'compatibility' })).not.toThrow()
  })

  it('registers exactly one file-preview RPC channel and one binary route in advanced mode', () => {
    const harness = createHarness()
    apply(harness.ctx, { ...config, mode: 'advanced' })

    expect(harness.channels).toEqual(['/desktop-file-preview'])
    expect(harness.routes).toEqual([{ kind: 'prefix', path: '/desktop-file-preview-content' }])
  })

  it('does not register any file-preview RPC channel or binary route in compatibility mode', () => {
    const harness = createHarness()
    apply(harness.ctx, config)

    expect(harness.channels).toEqual([])
    expect(harness.routes).toEqual([])
  })

  it('invalidates the RPC handler and removes the route when the fiber disposers run', async () => {
    const harness = createHarness()
    apply(harness.ctx, { ...config, mode: 'advanced' })

    const handler = harness.rpcHandlers.get('/desktop-file-preview')
    expect(handler).toBeDefined()
    expect(harness.routes).toHaveLength(1)
    expect(harness.channels).toHaveLength(1)

    // Fiber teardown runs disposers in reverse registration order.
    for (const disposer of [...harness.disposers].reverse()) await disposer()

    // The route and channel registrations are removed.
    expect(harness.routes).toEqual([])
    expect(harness.channels).toEqual([])
    expect(harness.rpcHandlers.has('/desktop-file-preview')).toBe(false)
  })

  it('does not leak filePreview config into the native shell spec', () => {
    const harness = createHarness()
    apply(harness.ctx, { ...config, mode: 'advanced' })

    const spec = harness.shell()
    expect(spec).toBeDefined()
    expect(spec).not.toHaveProperty('filePreview')
    expect(spec).toMatchObject({
      mode: 'advanced',
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 640,
    })
  })
})
