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
}

function createHarness(platform: DesktopRuntime['platform'] = 'darwin'): PluginHarness {
  let shell: DesktopShellSpec | undefined
  let watcher: ((next: DesktopSettings, prev: DesktopSettings) => void | Promise<void>) | undefined
  const update = vi.fn(async (_patch: object) => {})
  const restart = vi.fn(async () => {})
  const setThemeSource = vi.fn<(source: ThemePreference) => void>()
  let settingsUpdated: ((namespace: unknown, next: unknown) => void) | undefined
  let themePreference: ThemePreference = 'system'
  const runtime: DesktopRuntime = {
    platform,
    updates: {
      isPackaged: false,
      currentVersion: '2.0.1',
      installMode: 'unsupported',
      createCancellation: () => ({ cancel: () => {} }),
      requestInstall: async () => {},
      openReleasePage: async () => {},
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
    },
    settings,
    logger: { warn: vi.fn(), error: vi.fn() },
    get: vi.fn(() => () => {}),
    effect: vi.fn((register: () => unknown) => register()),
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
  }
}

describe('desktop Host plugin', () => {
  it('defaults to compatibility mode and validates both schemas', () => {
    expect(Config({} as DesktopConfig)).toEqual(config)
    expect(Config({ mode: 'advanced' } as DesktopConfig)).toEqual({ ...config, mode: 'advanced' })
    expect(DesktopSettingsSchema({} as DesktopSettings)).toEqual({ mode: 'compatibility' })
    expect(() => Config({ mode: 'custom' } as never)).toThrow()
    expect(String(DESKTOP_SETTINGS_NAMESPACE)).toBe('dsh-desktop')
  })

  it('builds the loopback root with validated renderer mode and platform markers', () => {
    const url = new URL(desktopRendererUrl(43120, 'advanced', 'darwin', true))
    expect(url.origin).toBe('http://127.0.0.1:43120')
    expect(url.pathname).toBe('/')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'dsh-desktop-mode': 'advanced',
      'dsh-desktop-platform': 'darwin',
      'dsh-desktop-updates': 'enabled',
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
      url: 'http://127.0.0.1:43120/?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin&dsh-desktop-updates=disabled',
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
})
