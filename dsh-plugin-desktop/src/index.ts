/** DSH Desktop Host plugin: owns the selected native shell generation. */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cmdline'
import {
  LOCALE_SETTINGS_NAMESPACE,
  type LocaleSettings,
} from '@deepseek-ai/dsh-client-locale'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  THEME_SETTINGS_NAMESPACE,
  type ThemeSettings,
} from '@deepseek-ai/dsh-client-ui-theme'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  handleRendererBootRequest,
  RENDERER_BOOT_REPORT_PATH,
} from './renderer-boot.ts'
import {
  DESKTOP_DIRECTORY_PICKER_PATH,
  DESKTOP_DIRECTORY_VALIDATOR_PATH,
} from './directory-picker-contract.ts'
import {
  handleDesktopDirectoryPickerRequest,
  handleDesktopDirectoryValidationRequest,
} from './directory-picker-route.ts'
import {
  DESKTOP_DIAGNOSTICS_EXPORT_PATH,
  DESKTOP_HOST_TARGET_SELECT_PATH,
  DESKTOP_MARKET_SELECT_PATH,
  DESKTOP_PROFILE_CREATE_PATH,
  DESKTOP_PROFILE_CREATE_WINDOW_PATH,
  DESKTOP_PROFILE_DELETE_PATH,
  DESKTOP_PROFILE_ROLLBACK_PATH,
  DESKTOP_PROFILE_SELECT_PATH,
  DESKTOP_SETTINGS_PATH,
  DESKTOP_TERMINAL_OPEN_PATH,
} from './desktop-settings-contract.ts'
import {
  handleDesktopDiagnosticsExportRequest,
  handleDesktopHostTargetSelectRequest,
  handleDesktopMarketSelectRequest,
  handleDesktopProfileCreateRequest,
  handleDesktopProfileCreateWindowRequest,
  handleDesktopProfileDeleteRequest,
  handleDesktopProfileRollbackRequest,
  handleDesktopProfileSelectRequest,
  handleDesktopSettingsRequest,
  handleDesktopTerminalOpenRequest,
} from './desktop-settings-route.ts'
import type {} from './desktop-settings-controller.ts'
import { desktopBootRecoveryInjections } from './desktop-boot-recovery.ts'
import type { DesktopShellMode } from './runtime.ts'
import type {} from './runtime.ts'
import { DESKTOP_DEFAULT_WEB_PORT } from './desktop-port.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-shell'

/** Services required before the shell can register its renderer generation. */
/** Services required by the desktop shell; `desktopRuntime` is probed, not required. */
export const inject = ['webServer', 'webRuntime', 'appExit', 'settings']

/** Standard settings namespace shared by tray and configuration surfaces. */
export const DESKTOP_SETTINGS_NAMESPACE = settingsNamespace('dsh-desktop')

const UI_THEME_SETTINGS_NAMESPACE = settingsNamespace(THEME_SETTINGS_NAMESPACE)
const UI_LOCALE_SETTINGS_NAMESPACE = settingsNamespace(LOCALE_SETTINGS_NAMESPACE)

/** Desktop settings presented by the standard settings service. */
export interface DesktopSettings {
  /** Native presentation selected for the next application generation. */
  mode: DesktopShellMode
  /** Loopback Web port selected for the next application generation; zero requests a random port. */
  port: number
  /** Log verbosity threshold applied to the file logger. */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/** Schema registered with the standard settings service. */
export const DesktopSettingsSchema: z<DesktopSettings> = z.object({
  mode: z.union(['compatibility', 'advanced'] as const).default('compatibility'),
  port: z.number().step(1).min(0).max(65_535).default(DESKTOP_DEFAULT_WEB_PORT),
  logLevel: z.union(['debug', 'info', 'warn', 'error'] as const).default('info'),
})

/** Native window configuration. */
export interface Config {
  /** Native presentation mode selected before BrowserWindow construction. */
  mode: DesktopShellMode
  /** Configured loopback Web port used to detect restart-applied settings changes. */
  port: number
  /** Initial window width in CSS pixels. */
  width: number
  /** Initial window height in CSS pixels. */
  height: number
  /** Minimum window width in CSS pixels. */
  minWidth: number
  /** Minimum window height in CSS pixels. */
  minHeight: number
}

/** Validated native window configuration. */
export const Config: z<Config> = z.object({
  mode: z.union(['compatibility', 'advanced'] as const).default('compatibility'),
  port: z.number().step(1).min(0).max(65_535).default(DESKTOP_DEFAULT_WEB_PORT),
  width: z.number().step(1).min(800).default(1280),
  height: z.number().step(1).min(600).default(840),
  minWidth: z.number().step(1).min(640).default(900),
  minHeight: z.number().step(1).min(480).default(640),
})

/**
 * Construct the unmodified upstream Web root URL.
 * @param port - active loopback Web server port.
 * @param mode - active native presentation mode.
 * @param platform - active Electron platform.
 * @returns the URL loaded by the BrowserWindow.
 */
export function desktopRendererUrl(
  port: number,
  mode: DesktopShellMode,
  platform: Context['desktopRuntime']['platform'],
): string {
  const url = new URL(`http://127.0.0.1:${String(port)}/`)
  url.searchParams.set('dsh-desktop-mode', mode)
  url.searchParams.set('dsh-desktop-platform', platform)
  return url.href
}

/**
 * Register the Electron shell from active Web carrier values.
 * @param ctx - Host context carrying the Electron adapter and Web carrier.
 * @param config - validated native window values.
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = ctx.get('desktopRuntime')
  if (runtime === undefined) {
    process.stderr.write(
      'dsh-plugin-desktop: this profile is composed with the DSH Desktop shell, which requires the desktop launcher (desktopRuntime).\n'
      + 'Start it with `dsh-desktop`, or select this profile inside the packaged DSH Desktop application.\n'
      + 'The desktop terminal, profile, and update rows stay inactive in an ordinary DSH boot.\n',
    )
    return
  }
  const appExit = ctx.get('appExit')
  if (appExit === undefined) {
    throw new Error('dsh-plugin-desktop: the launcher did not provide ctx.appExit')
  }
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('dsh-plugin-desktop: desktop shell requires a loopback Web server')
  }
  const iconFilename = runtime.platform === 'darwin'
    ? 'app-icon-mac.png'
    : 'app-icon.png'
  const iconPath = fileURLToPath(new URL(`../build/${iconFilename}`, import.meta.url))
  const trayIcons = {
    templatePath: fileURLToPath(new URL('../build/tray-iconTemplate.png', import.meta.url)),
    bluePath: fileURLToPath(new URL('../build/tray-icon-blue.png', import.meta.url)),
  }
  const settings = ctx.settings.register(
    DESKTOP_SETTINGS_NAMESPACE,
    DesktopSettingsSchema,
    {
      applies: 'restart',
      validate: (value) => {
        if (value.mode === 'advanced' && runtime.platform === 'linux') {
          throw new Error('dsh-plugin-desktop: advanced shell mode is supported on macOS and Windows')
        }
      },
    },
  )
  const rendererOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  ctx.on('webserver/index-inject', table => {
    table.push(...desktopBootRecoveryInjections())
  })
  const desktopSettings = ctx.get('desktopSettingsController')
  if (desktopSettings !== undefined) {
    const reportSettingsError = (operation: string, cause: unknown): void => {
      ctx.logger.error(
        `dsh-plugin-desktop: failed to ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    const settingsRoutes = [
      [DESKTOP_SETTINGS_PATH, handleDesktopSettingsRequest],
      [DESKTOP_PROFILE_CREATE_PATH, handleDesktopProfileCreateRequest],
      [DESKTOP_PROFILE_CREATE_WINDOW_PATH, handleDesktopProfileCreateWindowRequest],
      [DESKTOP_PROFILE_DELETE_PATH, handleDesktopProfileDeleteRequest],
      [DESKTOP_PROFILE_ROLLBACK_PATH, handleDesktopProfileRollbackRequest],
      [DESKTOP_PROFILE_SELECT_PATH, handleDesktopProfileSelectRequest],
      [DESKTOP_MARKET_SELECT_PATH, handleDesktopMarketSelectRequest],
      [DESKTOP_HOST_TARGET_SELECT_PATH, handleDesktopHostTargetSelectRequest],
      [DESKTOP_TERMINAL_OPEN_PATH, handleDesktopTerminalOpenRequest],
      [DESKTOP_DIAGNOSTICS_EXPORT_PATH, handleDesktopDiagnosticsExportRequest],
    ] as const
    for (const [path, handler] of settingsRoutes) {
      ctx.effect(
        () => ctx.webServer.register({
          kind: 'exact',
          path,
          handler: (req, res) => handler(
            req,
            res,
            rendererOrigin,
            desktopSettings,
            reportSettingsError,
          ),
        }),
        `dsh-plugin-desktop: private settings route ${path}`,
      )
    }
  }
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: RENDERER_BOOT_REPORT_PATH,
      handler: (req, res) => handleRendererBootRequest(
        req,
        res,
        rendererOrigin,
        report => { runtime.reportRendererBoot(report) },
      ),
    }),
    'dsh-plugin-desktop: renderer boot report route',
  )
  if (runtime.platform === 'win32') {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: DESKTOP_DIRECTORY_PICKER_PATH,
        handler: (req, res) => handleDesktopDirectoryPickerRequest(
          req,
          res,
          rendererOrigin,
          () => runtime.pickDirectory(),
          cause => {
            ctx.logger.error(`dsh-plugin-desktop: native directory picker failed: ${cause instanceof Error ? cause.message : String(cause)}`)
          },
        ),
      }),
      'dsh-plugin-desktop: native directory picker route',
    )
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: DESKTOP_DIRECTORY_VALIDATOR_PATH,
        handler: (req, res) => handleDesktopDirectoryValidationRequest(
          req,
          res,
          rendererOrigin,
          path => runtime.validateDirectory(path),
          cause => {
            ctx.logger.error(`dsh-plugin-desktop: workspace directory validation failed: ${cause instanceof Error ? cause.message : String(cause)}`)
          },
        ),
      }),
      'dsh-plugin-desktop: workspace directory validation route',
    )
  }
  ctx.effect(() => {
    let pending: ReturnType<typeof setImmediate> | undefined
    const stopWatching = settings.watch((next) => {
      if (next.mode === config.mode && next.port === config.port) {
        if (pending !== undefined) clearImmediate(pending)
        pending = undefined
        return
      }
      pending ??= setImmediate(() => {
        pending = undefined
        void runtime.requestRestart().catch((cause: unknown) => {
          ctx.logger.error('dsh-plugin-desktop: failed to restart after startup setting change')
          ctx.logger.error(cause)
        })
      })
    })
    return () => {
      stopWatching()
      if (pending !== undefined) clearImmediate(pending)
    }
  }, 'dsh-plugin-desktop: restart after startup setting change')
  if (config.mode === 'advanced') {
    ctx.on('settings/updated', (namespace, next) => {
      if (namespace !== UI_THEME_SETTINGS_NAMESPACE) return
      runtime.setThemeSource((next as ThemeSettings).preference)
    })
  }
  ctx.on('settings/updated', (namespace, next) => {
    if (namespace !== UI_LOCALE_SETTINGS_NAMESPACE) return
    runtime.setLocalePreference((next as LocaleSettings).preference)
  })
  ctx.effect(
    () => runtime.schedule({
      ...config,
      url: desktopRendererUrl(ctx.webServer.port, config.mode, runtime.platform),
      productName: 'DSH Desktop',
      windowTitle: 'DeepSeek Harness Desktop',
      iconPath,
      trayIcons,
      readLocalePreference: () => {
        return (ctx.settings.get(UI_LOCALE_SETTINGS_NAMESPACE) as LocaleSettings | undefined)?.preference
      },
      readThemeSource: () => {
        const theme = ctx.settings.get(UI_THEME_SETTINGS_NAMESPACE) as ThemeSettings | undefined
        if (theme === undefined) {
          throw new Error('dsh-plugin-desktop: advanced shell requires the ui-theme settings namespace')
        }
        return theme.preference
      },
      requestQuit: appExit,
      requestModeChange: async mode => settings.update({ mode }),
    }),
    'dsh-plugin-desktop: native shell generation',
  )
}
