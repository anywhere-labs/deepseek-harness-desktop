import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {
  ConnectionRequestRejection,
  ConnectionTrustRequest,
} from '@deepseek-ai/dsh-client-connection'
import type { LocaleId } from '@deepseek-ai/dsh-client-locale'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ThemePreference } from '@deepseek-ai/dsh-client-ui-theme'
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
import {
  DESKTOP_DIRECTORY_PICKER_PATH,
  DESKTOP_DIRECTORY_VALIDATOR_PATH,
} from '../src/directory-picker-contract.ts'
import {
  DESKTOP_COPILOT_AUTHORIZATION_ANSWER_PATH,
  DESKTOP_COPILOT_AUTHORIZATION_BEGIN_PATH,
  DESKTOP_COPILOT_AUTHORIZATION_CANCEL_PATH,
  DESKTOP_COPILOT_AUTHORIZATION_MODELS_PATH,
  DESKTOP_COPILOT_AUTHORIZATION_PATH,
} from '../src/copilot-authorization-contract.ts'
import {
  DESKTOP_DEVELOPER_TOOLS_TOGGLE_PATH,
  DESKTOP_DIAGNOSTICS_EXPORT_PATH,
  DESKTOP_AA_SELECT_PATH,
  DESKTOP_MARKET_SELECT_PATH,
  DESKTOP_PROFILE_CREATE_PATH,
  DESKTOP_PROFILE_DELETE_PATH,
  DESKTOP_PROFILE_SELECT_PATH,
  DESKTOP_RECOVERY_RESTART_PATH,
  DESKTOP_RENDERER_RELOAD_PATH,
  DESKTOP_RESTART_PATH,
  DESKTOP_SETTINGS_PATH,
  DESKTOP_TERMINAL_OPEN_PATH,
} from '../src/desktop-settings-contract.ts'
import type { DesktopRuntime, DesktopShellSpec } from '../src/runtime.ts'
import type { DesktopPlatformLoginRequest, PlatformLoginAccount } from '../src/platform-login.ts'
import { createDesktopBrowserAccess } from '../src/desktop-browser-access.ts'
import { DESKTOP_LAN_HTTPS_CA_PATH, DesktopLanHttpsRuntime } from '../src/lan-https-runtime.ts'
import { RENDERER_BOOT_REPORT_PATH, type RendererBootReport } from '../src/renderer-boot-contract.ts'

/** Loader entry id dsh 0.1.7-alpha.1 keys the Desktop shell's settings by. */
const DESKTOP_SETTINGS_ENTRY_ID = 'desktop-shell'

/** Editable preference values every fixture configuration starts from. */
const DEFAULT_SETTINGS: DesktopSettings = {
  mode: 'compatibility',
  macosMaterial: 'transparent',
  windowsMaterial: 'off',
  linuxMaterial: 'off',
  port: 43_120,
  openBrowser: false,
  networkExposure: 'loopback',
  logLevel: 'info',
}

/** Geometry fields the shell adopts once at window construction. */
const GEOMETRY = { width: 1280, height: 840, minWidth: 900, minHeight: 640 } as const

/**
 * A live configuration fixture.
 *
 * dsh 0.1.7-alpha.1 hands a plugin its editable fields as `Volatile` references
 * rather than through a registered settings scope, so a "settings change" in
 * these tests is a write into this backing state followed by the
 * `loader/volatile-update` event the Loader raises on the owning fiber.
 */
interface ConfigFixture {
  readonly config: DesktopConfig
  /** Merge a partial preference edit into the live references. */
  write(next: Partial<DesktopSettings>): void
  /** @returns the preference values standing right now. */
  read(): DesktopSettings
}

function configFixture(overrides: Partial<DesktopSettings> = {}): ConfigFixture {
  let state: DesktopSettings = { ...DEFAULT_SETTINGS, ...overrides }
  const field = <K extends keyof DesktopSettings>(key: K): Volatile<DesktopSettings[K]> =>
    ({ get: () => state[key] }) as unknown as Volatile<DesktopSettings[K]>
  return {
    config: {
      mode: field('mode'),
      macosMaterial: field('macosMaterial'),
      windowsMaterial: field('windowsMaterial'),
      linuxMaterial: field('linuxMaterial'),
      port: field('port'),
      openBrowser: field('openBrowser'),
      networkExposure: field('networkExposure'),
      logLevel: field('logLevel'),
      ...GEOMETRY,
    },
    write(next) { state = { ...state, ...next } },
    read: () => state,
  }
}

/** Read every volatile reference of a validated configuration. */
function readConfig(value: DesktopConfig): DesktopSettings {
  return {
    mode: value.mode.get(),
    macosMaterial: value.macosMaterial.get(),
    windowsMaterial: value.windowsMaterial.get(),
    linuxMaterial: value.linuxMaterial.get(),
    port: value.port.get(),
    openBrowser: value.openBrowser.get(),
    networkExposure: value.networkExposure.get(),
    logLevel: value.logLevel.get(),
  }
}

afterEach(() => { vi.useRealTimers() })

type AccountView = { attempt: { id: string; phase: string; authorizeUrl?: string } | null }

interface PluginHarness {
  ctx: Context
  platformLogin: ReturnType<typeof vi.fn<(request: DesktopPlatformLoginRequest) => void>>
  /** Publish one `deepseekAccount.watch` view to every open watcher. */
  emitAccount(view: AccountView): void
  config: DesktopConfig
  runtime: DesktopRuntime
  shell(): DesktopShellSpec | undefined
  update: ReturnType<typeof vi.fn<(namespace: unknown, patch: object) => Promise<void>>>
  restart: ReturnType<typeof vi.fn<() => Promise<void>>>
  setLocalePreference: ReturnType<typeof vi.fn<(locale: LocaleId | undefined) => void>>
  setThemeSource: ReturnType<typeof vi.fn<(source: ThemePreference) => void>>
  rendererBoot: ReturnType<typeof vi.fn<(report: RendererBootReport) => void>>
  pickDirectory: ReturnType<typeof vi.fn<() => Promise<string | null>>>
  validateDirectory: ReturnType<typeof vi.fn<(path: string) => Promise<boolean>>>
  browserAccess: ReturnType<typeof createDesktopBrowserAccess>
  lanHttps: DesktopLanHttpsRuntime
  setLanHttpsEnabled: ReturnType<typeof vi.fn<DesktopLanHttpsRuntime['setEnabled']>>
  requestRejection: ReturnType<typeof vi.fn<(request: ConnectionTrustRequest) => ConnectionRequestRejection>>
  route(path: string): WebRoute | undefined
  routes(): readonly WebRoute[]
  /** Write a live preference edit and raise the Loader's volatile update. */
  notify(next: Partial<DesktopSettings>): Promise<void>
  notifyLocale(preference: LocaleId | undefined): void
  notifyTheme(preference: ThemePreference): void
  /** Run a candidate configuration through the `internal/config` waterfall. */
  validate(candidate: DesktopSettings): void
}

function createHarness(
  platform: DesktopRuntime['platform'] = 'darwin',
  ordinaryBrowserEnabled = false,
  overrides: Partial<DesktopSettings> = {},
): PluginHarness {
  let shell: DesktopShellSpec | undefined
  const fixture = configFixture({ openBrowser: ordinaryBrowserEnabled, ...overrides })
  const volatileUpdated = new Set<() => void | Promise<void>>()
  const configWaterfall = new Set<(this: unknown, raw: unknown, next: () => unknown) => unknown>()
  const update = vi.fn(async (_namespace: unknown, _patch: object) => {})
  const restart = vi.fn(async () => {})
  const setLocalePreference = vi.fn<(locale: LocaleId | undefined) => void>()
  const setThemeSource = vi.fn<(source: ThemePreference) => void>()
  const rendererBoot = vi.fn<(report: RendererBootReport) => void>()
  const pickDirectory = vi.fn(async () => null)
  const validateDirectory = vi.fn(async () => true)
  const platformLogin = vi.fn<(request: DesktopPlatformLoginRequest) => void>()
  const accountWatchers = new Set<(view: AccountView) => void>()
  const account: PlatformLoginAccount = {
    async *watch(signal) {
      const queue: AccountView[] = []
      let wake: (() => void) | undefined
      const push = (view: AccountView) => { queue.push(view); wake?.() }
      accountWatchers.add(push)
      try {
        while (!signal.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve
              signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
          }
          wake = undefined
          while (queue.length > 0) yield queue.shift()!
        }
      } finally {
        accountWatchers.delete(push)
      }
    },
  }
  const requestRejection = vi.fn<(
    request: ConnectionTrustRequest,
  ) => ConnectionRequestRejection>(() => undefined)
  const routes = new Map<string, WebRoute>()
  const documentUpdated = new Set<(namespace: unknown, revision: number) => void>()
  let localePreference: LocaleId | undefined
  let themePreference: ThemePreference = 'system'
  const browserAccess = createDesktopBrowserAccess(
    ordinaryBrowserEnabled,
    Buffer.alloc(32, 6).toString('base64url'),
  )
  const lanHttps = new DesktopLanHttpsRuntime({ addresses: [] })
  const setLanHttpsEnabled = vi.spyOn(lanHttps, 'setEnabled')
  const authenticatedUrl = vi.fn((baseUrl: string) => {
    const url = new URL(baseUrl)
    url.pathname = '/'
    url.search = 'token=test-token'
    return url.href
  })
  const runtime: DesktopRuntime = {
    platform,
    locale: 'en',
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
    notifyAttention: () => {},
    registerTrayItem: () => ({ refresh: () => {}, dispose: () => {} }),
    openTerminal: () => {},
    reloadRenderer: () => {},
    toggleDeveloperTools: () => {},
    exportDiagnostics: async () => {},
    pickDirectory,
    validateDirectory,
    openProfileCreateWindow: () => {},
    reportRendererBoot: rendererBoot,
    setLocalePreference,
    setThemeSource,
    requestRestart: restart,
    requestRecoveryRestart: restart,
    prepareToQuit: () => {},
    platformLogin,
  }
  // 0.1.7's `SettingsForms` has no `register`: cross-plugin reads go through
  // `describe()`, which projects every Loader entry's live configuration, and a
  // write lands with `update(namespace, patch)`.
  const settings = {
    describe: vi.fn(() => [
      { ns: 'ui-theme', value: { preference: themePreference } },
      { ns: 'locale', value: { preference: localePreference } },
      { ns: DESKTOP_SETTINGS_ENTRY_ID, value: fixture.read() },
    ]),
    configure: vi.fn(),
    update,
  }
  const fiber = { id: DESKTOP_SETTINGS_ENTRY_ID }
  const ctx = {
    fiber,
    desktopRuntime: runtime,
    webServer: {
      host: '127.0.0.1',
      port: 43120,
      register: vi.fn((route: WebRoute) => {
        routes.set(route.path, route)
        return () => { if (routes.get(route.path) === route) routes.delete(route.path) }
      }),
    },
    settings,
    connection: { authenticatedUrl, requestRejection },
    logger: { warn: vi.fn(), error: vi.fn() },
    get: vi.fn((key: unknown) => {
      if (String(key) === 'desktopRuntime') return runtime
      if (String(key) === 'desktopBrowserAccess') return browserAccess
      if (String(key) === 'desktopLanHttps') return lanHttps
      if (String(key) === 'settings') return settings
      if (String(key) === 'deepseekAccount') return account
      return () => {}
    }),
    inject: vi.fn((_services: string[], callback: (child: Context) => void) => {
      callback(ctx as unknown as Context)
    }),
    effect: vi.fn((register: () => unknown) => register()),
    on: vi.fn((event: string, listener: (...args: never[]) => unknown) => {
      if (event === 'settings/document-updated') {
        documentUpdated.add(listener as (namespace: unknown, revision: number) => void)
        return () => { documentUpdated.delete(listener as (namespace: unknown, revision: number) => void) }
      }
      if (event === 'loader/volatile-update') {
        volatileUpdated.add(listener as () => void)
        return () => { volatileUpdated.delete(listener as () => void) }
      }
      if (event === 'internal/config') {
        const waterfall = listener as unknown as (this: unknown, raw: unknown, next: () => unknown) => unknown
        configWaterfall.add(waterfall)
        return () => { configWaterfall.delete(waterfall) }
      }
      return () => {}
    }),
  } as unknown as Context
  return {
    ctx,
    platformLogin,
    emitAccount: (view) => { for (const push of accountWatchers) push(view) },
    config: fixture.config,
    runtime,
    shell: () => shell,
    update,
    restart,
    setLocalePreference,
    setThemeSource,
    rendererBoot,
    pickDirectory,
    validateDirectory,
    browserAccess,
    lanHttps,
    setLanHttpsEnabled,
    requestRejection,
    route: path => routes.get(path),
    routes: () => [...routes.values()],
    notify: async (next) => {
      fixture.write(next)
      for (const listener of [...volatileUpdated]) await listener()
    },
    notifyLocale: (preference) => {
      localePreference = preference
      for (const listener of documentUpdated) listener('locale', 1)
    },
    notifyTheme: (preference) => {
      themePreference = preference
      for (const listener of documentUpdated) listener('ui-theme', 1)
    },
    validate: (candidate) => {
      for (const waterfall of configWaterfall) waterfall.call(fiber, candidate, () => candidate)
    },
  }
}

describe('desktop Host plugin', () => {
  it('defaults to compatibility mode and validates both schemas', () => {
    // 0.1.7 boxes every editable field in a volatile reference, so the
    // validated configuration is compared through its reads rather than by
    // structural equality against a plain fixture.
    expect(readConfig(Config({} as never))).toEqual(DEFAULT_SETTINGS)
    expect(Config({} as never)).toMatchObject(GEOMETRY)
    expect(readConfig(Config({ mode: 'advanced' } as never))).toEqual({ ...DEFAULT_SETTINGS, mode: 'advanced' })
    expect(DesktopSettingsSchema({} as DesktopSettings)).toEqual({
      mode: 'compatibility',
      macosMaterial: 'transparent',
      windowsMaterial: 'off',
      linuxMaterial: 'off',
      port: 43_120,
      openBrowser: false,
      networkExposure: 'loopback',
      logLevel: 'info',
    })
    expect(() => DesktopSettingsSchema({ port: -1 } as DesktopSettings)).toThrow()
    expect(() => DesktopSettingsSchema({ port: 1.5 } as DesktopSettings)).toThrow()
    expect(() => DesktopSettingsSchema({ port: 65_536 } as DesktopSettings)).toThrow()
    expect(() => Config({ mode: 'custom' } as never)).toThrow()
    expect(String(DESKTOP_SETTINGS_NAMESPACE)).toBe('dsh-desktop')
  })

  it('serves the CA created after startup without restarting the Host or exposing a missing certificate', async () => {
    const harness = createHarness('win32')
    const certificate = vi.spyOn(harness.lanHttps, 'caCertificate', 'get').mockReturnValue(null)
    apply(harness.ctx, harness.config)
    const route = harness.route(DESKTOP_LAN_HTTPS_CA_PATH)!
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() }
    const request = async (method: string) => {
      res.end.mockClear()
      await route.handler({ method } as IncomingMessage, res as unknown as ServerResponse)
    }
    await request('GET')
    expect(res.statusCode).toBe(503)
    expect(res.setHeader).toHaveBeenCalledWith('cache-control', 'no-store')
    certificate.mockReturnValue('test CA certificate')
    await request('GET')
    expect(res.statusCode).toBe(200)
    expect(res.end).toHaveBeenCalledWith('test CA certificate')
    await request('HEAD')
    expect(res.statusCode).toBe(200)
    expect(res.end).toHaveBeenCalledWith(undefined)
    await request('POST')
    expect(res.statusCode).toBe(405)
    certificate.mockRestore()
  })

  it('prints a launcher reminder and registers nothing without desktopRuntime', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const registerRoute = vi.fn()
    const ctx = {
      webServer: { host: '127.0.0.1', port: 43120, register: registerRoute },
      settings: {
        describe: vi.fn(() => []),
        configure: vi.fn(),
        update: vi.fn(async () => {}),
      },
      logger: { warn: vi.fn(), error: vi.fn() },
      get: vi.fn(() => undefined),
      inject: vi.fn(),
      effect: vi.fn((register: () => unknown) => register()),
      on: vi.fn(() => () => {}),
    } as unknown as Context

    apply(ctx, configFixture().config)

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('desktop launcher'))
    expect(registerRoute).not.toHaveBeenCalled()
    expect(vi.mocked(ctx.settings.configure)).not.toHaveBeenCalled()
    stderr.mockRestore()
  })

  it('builds the loopback root with validated renderer mode and platform markers', () => {
    const url = new URL(desktopRendererUrl(43120, 'advanced', 'darwin', '2.0.3'))
    expect(url.origin).toBe('http://127.0.0.1:43120')
    expect(url.pathname).toBe('/')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'dsh-desktop-mode': 'advanced',
      'dsh-desktop-platform': 'darwin',
      'dsh-desktop-version': '2.0.3',
      'dsh-desktop-material': 'off',
    })
    expect(Object.fromEntries(new URL(desktopRendererUrl(
      43120,
      'extended',
      'win32',
      '2.0.3',
      'off',
    )).searchParams)).toEqual({
      'dsh-desktop-mode': 'extended',
      'dsh-desktop-platform': 'win32',
      'dsh-desktop-version': '2.0.3',
      'dsh-desktop-material': 'off',
      'dsh-desktop-titlebar-inset': '36',
    })
    expect(Object.fromEntries(new URL(desktopRendererUrl(
      43120,
      'compatibility',
      'linux',
      '2.0.3',
    )).searchParams)).not.toHaveProperty('dsh-desktop-titlebar-inset')
  })

  it('publishes settings and the active Web port without re-entering Loader settlement', async () => {
    const harness = createHarness()
    const loaderAwait = vi.fn(() => new Promise<void>(() => {}))
    Object.assign(harness.ctx, { loader: { await: loaderAwait } })

    apply(harness.ctx, harness.config)

    expect(inject).toContain('settings')
    expect(inject).toContain('connection')
    expect(inject).not.toContain('loader')
    // 0.1.7 publishes the editable fields from the plugin's own volatile Config
    // and has no `applies: 'restart'`: Desktop withdraws the automatic form and
    // owns both the settings page and the restart decision itself.
    expect(vi.mocked(harness.ctx.settings.configure))
      .toHaveBeenCalledWith({ auto: false }, expect.anything())
    expect(loaderAwait).not.toHaveBeenCalled()
    expect(harness.shell()).toEqual(expect.objectContaining({
      mode: 'compatibility',
      url: 'http://127.0.0.1:43120/?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin&dsh-desktop-version=2.0.0&dsh-desktop-material=transparent&dsh-desktop-titlebar-inset=36',
      authenticationUrl: 'http://127.0.0.1:43120/?token=test-token',
      productName: 'DSH Desktop Beta',
      windowTitle: 'DeepSeek Harness Desktop',
      rendererAccessHeader: {
        name: 'x-dsh-desktop-renderer',
        value: Buffer.alloc(32, 6).toString('base64url'),
      },
      readThemeSource: expect.any(Function),
    }))
    expect(harness.shell()?.iconPath.endsWith(join('build', 'app-icon-mac.png'))).toBe(true)
    expect(harness.shell()?.trayIcons.templatePath.endsWith(join('build', 'tray-iconTemplate.png'))).toBe(true)
    expect(harness.shell()?.trayIcons.bluePath.endsWith(join('build', 'tray-icon-blue.png'))).toBe(true)
    expect(harness.shell()?.readThemeSource()).toBe('system')
    harness.notifyTheme('dark')
    expect(harness.setThemeSource).toHaveBeenCalledWith('dark')

    await harness.shell()?.requestModeChange('advanced')
    expect(harness.update).toHaveBeenCalledWith(DESKTOP_SETTINGS_ENTRY_ID, { mode: 'advanced' })
  })

  it('atomically withdraws browser access when the native tray selects a custom mode', async () => {
    const harness = createHarness('darwin', true)
    apply(harness.ctx, harness.config)

    await harness.shell()?.requestModeChange('advanced')

    expect(harness.update).toHaveBeenCalledWith(DESKTOP_SETTINGS_ENTRY_ID, {
      mode: 'advanced',
      openBrowser: false,
      networkExposure: 'loopback',
    })
  })

  it('forwards same-origin renderer boot reports through the Host route', async () => {
    const harness = createHarness()
    apply(harness.ctx, harness.config)
    const route = harness.route(RENDERER_BOOT_REPORT_PATH)
    expect(route).toEqual(expect.objectContaining({
      kind: 'exact',
      path: RENDERER_BOOT_REPORT_PATH,
    }))
    const report = { status: 'failed', plugins: ['dsh-vision-router'], error: 'slot conflict' } as const
    const req = {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:43120',
        'content-type': 'application/json',
      },
      async * [Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(report)) },
    } as unknown as IncomingMessage
    const res = { statusCode: 200, end: vi.fn() } as unknown as ServerResponse

    await route?.handler(req, res)

    expect(harness.requestRejection).toHaveBeenCalledWith(req)
    expect(harness.rendererBoot).toHaveBeenCalledWith(report)
    expect(res.statusCode).toBe(204)
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
  ] as const)('applies the Connection %i rejection before every private exact route', async (
    status,
    body,
  ) => {
    const harness = createHarness('win32')
    harness.requestRejection.mockReturnValue(status)
    apply(harness.ctx, harness.config)
    const expectedPaths = [
      DESKTOP_SETTINGS_PATH,
      DESKTOP_PROFILE_CREATE_PATH,
      DESKTOP_PROFILE_DELETE_PATH,
      DESKTOP_PROFILE_SELECT_PATH,
      DESKTOP_AA_SELECT_PATH,
      DESKTOP_MARKET_SELECT_PATH,
      DESKTOP_COPILOT_AUTHORIZATION_PATH,
      DESKTOP_COPILOT_AUTHORIZATION_BEGIN_PATH,
      DESKTOP_COPILOT_AUTHORIZATION_ANSWER_PATH,
      DESKTOP_COPILOT_AUTHORIZATION_CANCEL_PATH,
      DESKTOP_COPILOT_AUTHORIZATION_MODELS_PATH,
      DESKTOP_TERMINAL_OPEN_PATH,
      DESKTOP_RESTART_PATH,
      DESKTOP_RECOVERY_RESTART_PATH,
      DESKTOP_RENDERER_RELOAD_PATH,
      DESKTOP_DEVELOPER_TOOLS_TOGGLE_PATH,
      DESKTOP_DIAGNOSTICS_EXPORT_PATH,
      RENDERER_BOOT_REPORT_PATH,
      DESKTOP_DIRECTORY_PICKER_PATH,
      DESKTOP_DIRECTORY_VALIDATOR_PATH,
    ].sort()
    const routes = harness.routes().filter(route => route.path !== DESKTOP_LAN_HTTPS_CA_PATH)
    expect(routes.map(route => route.path).sort()).toEqual(expectedPaths)

    for (const route of routes) {
      const req = { headers: {} } as IncomingMessage
      const writeHead = vi.fn()
      const end = vi.fn()
      const res = { writeHead, end } as unknown as ServerResponse

      await route.handler(req, res)

      expect(writeHead).toHaveBeenCalledWith(status)
      expect(end).toHaveBeenCalledWith(body)
    }
    expect(harness.requestRejection).toHaveBeenCalledTimes(routes.length)
    expect(harness.rendererBoot).not.toHaveBeenCalled()
    expect(harness.pickDirectory).not.toHaveBeenCalled()
    expect(harness.validateDirectory).not.toHaveBeenCalled()
  })

  it('serves the Windows native picker through a same-origin desktop route', async () => {
    const harness = createHarness('win32')
    harness.pickDirectory.mockResolvedValue('C:\\Work')
    apply(harness.ctx, harness.config)
    const route = harness.route(DESKTOP_DIRECTORY_PICKER_PATH)
    expect(route).toEqual(expect.objectContaining({
      kind: 'exact',
      path: DESKTOP_DIRECTORY_PICKER_PATH,
    }))
    const req = {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:43120' },
    } as unknown as IncomingMessage
    let body = ''
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((value?: string) => { body = value ?? '' }),
    } as unknown as ServerResponse

    await route?.handler(req, res)

    expect(harness.pickDirectory).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(body)).toEqual({ path: 'C:\\Work' })
  })

  it('validates a Windows workspace through a same-origin desktop route', async () => {
    const harness = createHarness('win32')
    harness.validateDirectory.mockResolvedValue(false)
    apply(harness.ctx, harness.config)
    const route = harness.route(DESKTOP_DIRECTORY_VALIDATOR_PATH)
    const req = {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:43120',
        'content-type': 'application/json',
      },
      async * [Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ path: 'E:\\repo' })) },
    } as unknown as IncomingMessage
    let body = ''
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((value?: string) => { body = value ?? '' }),
    } as unknown as ServerResponse

    await route?.handler(req, res)

    expect(harness.validateDirectory).toHaveBeenCalledWith('E:\\repo')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(body)).toEqual({ allowed: false })
  })

  it.each(['win32', 'linux'] as const)(
    'keeps the full-size application icon on %s',
    (platform) => {
      const harness = createHarness(platform)

      apply(harness.ctx, harness.config)

      expect(harness.shell()?.iconPath.endsWith(join('build', 'app-icon.png'))).toBe(true)
    },
  )

  it('requests one orderly restart after the settings form commits another mode', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    apply(harness.ctx, harness.config)

    await harness.notify({})
    expect(harness.restart).not.toHaveBeenCalled()

    harness.restart.mockImplementation(() => new Promise<void>(() => {}))
    await harness.notify({ mode: 'advanced' })
    await vi.runAllTimersAsync()
    expect(harness.restart).toHaveBeenCalledOnce()
  })

  it('saves first-run Setup through the settings scopes without its own native restart prompt', async () => {
    vi.useFakeTimers()
    const harness = createHarness('darwin')
    apply(harness.ctx, harness.config)
    harness.restart.mockImplementation(() => new Promise<void>(() => {}))
    const notifications = {
      enabled: true,
      notifyOnTurnCompletion: false,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: false,
      notifyOnJobFailure: true,
      notifyOnScheduleCompletion: true,
      notifyOnScheduleFailure: true,
    }

    await harness.shell()?.applySetupSettings?.({
      mode: 'extended',
      macosMaterial: 'off',
      windowsMaterial: 'off',
      openBrowser: false,
      networkExposure: 'loopback',
      notifications,
    })

    expect(harness.update).toHaveBeenCalledWith(DESKTOP_SETTINGS_ENTRY_ID, {
      mode: 'extended',
      macosMaterial: 'off',
      windowsMaterial: 'off',
      openBrowser: false,
      networkExposure: 'loopback',
    })
    expect(harness.update).toHaveBeenCalledWith('desktop-notifications', notifications)

    // Setup's continuation owns the restart that applies its own choice.
    await harness.notify({ mode: 'extended', macosMaterial: 'off' })
    await vi.runAllTimersAsync()
    expect(harness.restart).not.toHaveBeenCalled()

    // A later, different choice still asks for its own restart.
    await harness.notify({ mode: 'advanced' })
    await vi.runAllTimersAsync()
    expect(harness.restart).toHaveBeenCalledOnce()
  })

  it('asks again when the user returns to the Setup mode after leaving it', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    apply(harness.ctx, harness.config)
    harness.restart.mockImplementation(() => new Promise<void>(() => {}))
    // Only the notifications half fails; the saved mode keeps its own quiet restart.
    harness.update.mockImplementation(async (id: unknown) => {
      if (id === 'desktop-notifications') throw new Error('refused')
    })

    await expect(harness.shell()?.applySetupSettings?.({
      mode: 'extended',
      macosMaterial: 'transparent',
      windowsMaterial: 'off',
      openBrowser: false,
      networkExposure: 'loopback',
      notifications: {
        enabled: false,
        notifyOnTurnCompletion: false,
        notifyOnTurnFailure: false,
        notifyOnJobCompletion: false,
        notifyOnJobFailure: false,
        notifyOnScheduleCompletion: false,
        notifyOnScheduleFailure: false,
      },
    })).rejects.toThrow('refused')
    await harness.notify({ mode: 'extended' })
    await vi.runAllTimersAsync()
    expect(harness.restart).not.toHaveBeenCalled()

    // Back to the running mode, then Setup's mode again from the mode picker.
    await harness.notify({ mode: 'compatibility' })
    await harness.notify({ mode: 'extended' })
    await vi.runAllTimersAsync()
    expect(harness.restart).toHaveBeenCalledOnce()
  })

  it('keeps the restart prompt when first-run Setup could not save its choice', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    apply(harness.ctx, harness.config)
    harness.restart.mockImplementation(() => new Promise<void>(() => {}))
    harness.update.mockRejectedValueOnce(new Error('refused'))

    await expect(harness.shell()?.applySetupSettings?.({
      mode: 'extended',
      macosMaterial: 'transparent',
      windowsMaterial: 'off',
      openBrowser: false,
      networkExposure: 'loopback',
      notifications: {
        enabled: false,
        notifyOnTurnCompletion: false,
        notifyOnTurnFailure: false,
        notifyOnJobCompletion: false,
        notifyOnJobFailure: false,
        notifyOnScheduleCompletion: false,
        notifyOnScheduleFailure: false,
      },
    })).rejects.toThrow('refused')

    await harness.notify({ mode: 'extended' })
    await vi.runAllTimersAsync()
    expect(harness.restart).toHaveBeenCalledOnce()
  })

  it('hot-applies browser and LAN access but restarts when a custom mode withdraws them', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    apply(harness.ctx, harness.config)
    harness.restart.mockImplementation(() => new Promise<void>(() => {}))

    await harness.notify({ openBrowser: true, networkExposure: 'lan' })
    await vi.runAllTimersAsync()
    expect(harness.restart).not.toHaveBeenCalled()
    expect(harness.browserAccess.ordinaryBrowserEnabled).toBe(true)
    expect(harness.setLanHttpsEnabled).toHaveBeenLastCalledWith(true)

    const enabledHarness = createHarness('darwin', true)
    apply(enabledHarness.ctx, enabledHarness.config)
    await enabledHarness.notify({ mode: 'advanced' })
    await vi.runAllTimersAsync()
    expect(enabledHarness.restart).toHaveBeenCalledOnce()
    expect(enabledHarness.browserAccess.ordinaryBrowserEnabled).toBe(false)
    expect(enabledHarness.setLanHttpsEnabled).toHaveBeenLastCalledWith(false)
  })

  it('requests one orderly restart after the configured Web port changes', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    apply(harness.ctx, harness.config)

    await harness.notify({ logLevel: 'debug' })
    expect(harness.restart).not.toHaveBeenCalled()

    harness.restart.mockImplementation(() => new Promise<void>(() => {}))
    await harness.notify({ port: 43_189 })
    await vi.runAllTimersAsync()
    expect(harness.restart).toHaveBeenCalledOnce()
  })

  it('requests one orderly restart after the native material changes', async () => {
    vi.useFakeTimers()
    const harness = createHarness('darwin')
    apply(harness.ctx, harness.config)

    harness.restart.mockImplementation(() => new Promise<void>(() => {}))
    await harness.notify({ macosMaterial: 'off' })
    await vi.runAllTimersAsync()

    expect(harness.restart).toHaveBeenCalledOnce()
  })

  it('does not restart for a legacy Windows Mica value that still renders opaque', async () => {
    vi.useFakeTimers()
    const harness = createHarness('win32')
    apply(harness.ctx, harness.config)

    await harness.notify({ windowsMaterial: 'mica' })
    await vi.runAllTimersAsync()

    expect(harness.restart).not.toHaveBeenCalled()
  })

  it('projects live built-in theme changes into an advanced native material', () => {
    const harness = createHarness('darwin', false, { mode: 'advanced' })
    apply(harness.ctx, harness.config)

    expect(harness.shell()?.readThemeSource()).toBe('system')
    harness.notifyTheme('dark')
    expect(harness.setThemeSource).toHaveBeenCalledWith('dark')
  })

  it('projects the Host-backed locale preference into the native tray', () => {
    const harness = createHarness('win32')
    apply(harness.ctx, harness.config)

    expect(harness.shell()?.readLocalePreference()).toBeUndefined()
    expect(harness.setLocalePreference).not.toHaveBeenCalled()

    harness.notifyLocale('zh')
    expect(harness.shell()?.readLocalePreference()).toBe('zh')
    expect(harness.setLocalePreference).toHaveBeenCalledWith('zh')

    harness.notifyLocale(undefined)
    expect(harness.setLocalePreference).toHaveBeenLastCalledWith(undefined)
  })

  it('hands Platform sign-in attempts to the native shell with the live browser-access route', async () => {
    const harness = createHarness('win32')
    apply(harness.ctx, harness.config)
    const first = 'https://platform.deepseek.com/dsh/authorize?state=a'
    const second = 'https://platform.deepseek.com/dsh/authorize?state=b'

    harness.emitAccount({ attempt: { id: 'a', phase: 'waiting-browser', authorizeUrl: first } })
    await vi.waitFor(() => { expect(harness.platformLogin).toHaveBeenCalledWith({ action: 'open', url: first, external: false }) })
    harness.emitAccount({ attempt: { id: 'a', phase: 'expired' } })
    await vi.waitFor(() => { expect(harness.platformLogin).toHaveBeenLastCalledWith({ action: 'close', focus: true }) })

    harness.browserAccess.setOrdinaryBrowserEnabled(true)
    harness.emitAccount({ attempt: { id: 'b', phase: 'waiting-browser', authorizeUrl: second } })
    await vi.waitFor(() => { expect(harness.platformLogin).toHaveBeenLastCalledWith({ action: 'open', url: second, external: true }) })
    expect(harness.platformLogin).toHaveBeenCalledTimes(3)
  })

  it('requires the Web carrier host to match the configured exposure', () => {
    const harness = createHarness()
    Object.assign(harness.ctx.webServer, { host: '0.0.0.0' })

    expect(() => apply(harness.ctx, harness.config)).toThrow('does not match networkExposure')
    expect(() => apply(harness.ctx, configFixture({ networkExposure: 'lan' }).config))
      .toThrow('does not match networkExposure')

    Object.assign(harness.ctx.webServer, { host: '127.0.0.1' })
    expect(() => apply(harness.ctx, configFixture({ networkExposure: 'lan' }).config)).not.toThrow()
  })

  it('validates the effective Linux mode while a browser migration is deferred', () => {
    const harness = createHarness('linux')
    apply(harness.ctx, harness.config)

    // 0.1.7 dropped the registration-time `validate` hook, so the two
    // combination rules now refuse a candidate configuration inside the
    // Loader's `internal/config` waterfall, before the update commits.
    const settings: DesktopSettings = {
      mode: 'compatibility',
      macosMaterial: 'transparent',
      windowsMaterial: 'acrylic',
      linuxMaterial: 'off',
      port: 43_120,
      openBrowser: false,
      networkExposure: 'loopback',
      logLevel: 'info',
    }
    expect(() => harness.validate({ ...settings, mode: 'advanced' })).toThrow(
      'supported on macOS and Windows',
    )
    expect(() => harness.validate({ ...settings, mode: 'extended' })).toThrow(
      'supported on macOS and Windows',
    )
    expect(() => harness.validate({ ...settings, mode: 'compatibility' })).not.toThrow()
    expect(() => harness.validate({
      ...settings,
      mode: 'advanced',
      openBrowser: true,
    })).toThrow('browser access requires compatibility mode')
    expect(() => harness.validate({
      ...settings,
      mode: 'advanced',
      networkExposure: 'lan',
    })).toThrow('supported on macOS and Windows')
  })

  it('accepts a deferred LAN preference independently of browser mode on supported platforms', () => {
    const harness = createHarness('darwin')
    apply(harness.ctx, harness.config)

    expect(() => harness.validate({
      mode: 'advanced',
      macosMaterial: 'transparent',
      windowsMaterial: 'off',
      linuxMaterial: 'off',
      port: 43_120,
      openBrowser: false,
      networkExposure: 'lan',
      logLevel: 'info',
    })).not.toThrow()
  })
})
