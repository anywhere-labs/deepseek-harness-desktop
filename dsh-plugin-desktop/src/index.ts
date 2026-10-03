/** DSH Desktop Host plugin: owns the selected native shell generation. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
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
  DESKTOP_DEVELOPER_TOOLS_TOGGLE_PATH,
  DESKTOP_AA_SELECT_PATH,
  DESKTOP_MARKET_SELECT_PATH,
  DESKTOP_PROFILE_CREATE_PATH,
  DESKTOP_PROFILE_DELETE_PATH,
  DESKTOP_PROFILE_SELECT_PATH,
  DESKTOP_RESTART_PATH,
  DESKTOP_RECOVERY_RESTART_PATH,
  DESKTOP_RENDERER_RELOAD_PATH,
  DESKTOP_SETTINGS_PATH,
  DESKTOP_TERMINAL_OPEN_PATH,
} from './desktop-settings-contract.ts'
import {
  handleDesktopDiagnosticsExportRequest,
  handleDesktopDeveloperToolsToggleRequest,
  handleDesktopAaSelectRequest,
  handleDesktopMarketSelectRequest,
  handleDesktopProfileCreateRequest,
  handleDesktopProfileDeleteRequest,
  handleDesktopProfileSelectRequest,
  handleDesktopRestartRequest,
  handleDesktopRecoveryRestartRequest,
  handleDesktopRendererReloadRequest,
  handleDesktopSettingsRequest,
  handleDesktopTerminalOpenRequest,
} from './desktop-settings-route.ts'
import type {} from './desktop-settings-controller.ts'
import { DESKTOP_LAN_HTTPS_CA_PATH } from './lan-https-runtime.ts'
import { desktopBootRecoveryInjections } from './desktop-boot-recovery.ts'
import type { DesktopLocale, DesktopShellMode } from './runtime.ts'
import type {} from './runtime.ts'
import {
  desktopBrowserAccessEnabled,
  desktopNetworkExposureForBrowserAccess,
  desktopWebServerHost,
  type DesktopNetworkExposure,
} from './desktop-network.ts'
import { DESKTOP_FRAME_HEIGHT } from './window-chrome.ts'
import {
  effectiveDesktopWindowMaterial,
  type DesktopWindowMaterial,
} from './window-material.ts'
import { DESKTOP_PRODUCT_NAME } from './product-identity.ts'
import { watchPlatformLogin, type PlatformLoginAccount } from './platform-login.ts'
import type { DesktopSetupWizardSettings } from './setup-wizard-settings.ts'
import {
  createDesktopSettingsPort,
  DESKTOP_NOTIFICATIONS_SETTINGS_ENTRY_ID,
  readUiLocalePreference,
  readUiThemeSource,
  resolveDesktopConfig,
  watchUiLocalePreference,
  watchUiThemeSource,
  type DesktopShellConfig,
} from './settings-bridge.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-shell'

/** Services required before the shell can register its renderer generation. */
/** Services required by the desktop shell; `desktopRuntime` is probed, not required. */
export const inject = ['webServer', 'webRuntime', 'appExit', 'settings', 'connection']

/**
 * Standard settings namespace shared by tray and configuration surfaces, the
 * editable preference subset, and the validated native window configuration.
 * All three are edition-local because the two channels' cores model plugin
 * configuration differently; see `src/settings-bridge.ts`.
 */
export {
  DESKTOP_SETTINGS_NAMESPACE,
  DesktopSettingsSchema,
  DesktopShellConfig as Config,
  type DesktopSettings,
} from './settings-bridge.ts'

/** Apply the official Connection trust and browser-auth fence before a private Desktop route. */
function rejectDesktopRequest(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection === undefined) return false
  res.writeHead(rejection)
  res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
  return true
}

/** Narrow the upstream locale preference to the translations bundled by Desktop chrome. */
function desktopLocalePreference(preference: string | undefined): DesktopLocale | undefined {
  return preference === 'zh' || preference === 'en' ? preference : undefined
}

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
  appVersion: string,
  material: DesktopWindowMaterial = 'off',
): string {
  const url = new URL(`http://127.0.0.1:${String(port)}/`)
  url.searchParams.set('dsh-desktop-mode', mode)
  url.searchParams.set('dsh-desktop-platform', platform)
  url.searchParams.set('dsh-desktop-version', appVersion)
  url.searchParams.set('dsh-desktop-material', material)
  if (mode === 'extended' || (mode === 'compatibility' && platform !== 'linux')) {
    // Body-level plugin portals do not inherit the framed root's geometry.
    // Publish the exact content boundary so they can yield Desktop chrome.
    url.searchParams.set('dsh-desktop-titlebar-inset', String(DESKTOP_FRAME_HEIGHT))
  }
  return url.href
}

/**
 * Register the Electron shell from active Web carrier values.
 * @param ctx - Host context carrying the Electron adapter and Web carrier.
 * @param config - validated native window values.
 */
export function apply(ctx: Context, config: DesktopShellConfig): void {
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
  const browserAccess = ctx.get('desktopBrowserAccess')
  if (browserAccess === undefined) {
    throw new Error('dsh-plugin-desktop: the launcher did not provide ctx.desktopBrowserAccess')
  }
  const lanHttps = ctx.get('desktopLanHttps')
  if (lanHttps === undefined) {
    throw new Error('dsh-plugin-desktop: the launcher did not provide ctx.desktopLanHttps')
  }
  const resolved = resolveDesktopConfig(config)
  if (ctx.webServer.host !== desktopWebServerHost(resolved.networkExposure)) {
    throw new Error('dsh-plugin-desktop: desktop shell WebServer host does not match networkExposure')
  }
  lanHttps.attach(ctx.webServer.port)
  const iconFilename = runtime.platform === 'darwin'
    ? 'app-icon-mac.png'
    : 'app-icon.png'
  const iconPath = fileURLToPath(new URL(`../build/${iconFilename}`, import.meta.url))
  const trayIcons = {
    templatePath: fileURLToPath(new URL('../build/tray-iconTemplate.png', import.meta.url)),
    bluePath: fileURLToPath(new URL('../build/tray-icon-blue.png', import.meta.url)),
  }
  const settings = createDesktopSettingsPort(ctx, config, runtime.platform)
  // Choices first-run Setup saved into this generation's settings. Setup's own
  // continuation offers the restart that applies them, after its account step.
  let setupSettings: DesktopSetupWizardSettings | undefined
  let setupSaved = false
  const rendererOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: DESKTOP_LAN_HTTPS_CA_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405
          res.setHeader('allow', 'GET, HEAD')
          res.setHeader('cache-control', 'no-store')
          res.end('method not allowed')
          return
        }
        const caCertificate = lanHttps.caCertificate
        if (caCertificate === null) {
          res.statusCode = 503
          res.setHeader('cache-control', 'no-store')
          res.end(req.method === 'HEAD' ? undefined : 'LAN HTTPS certificate unavailable')
          return
        }
        res.statusCode = 200
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-type', 'application/x-x509-ca-cert')
        res.setHeader('content-disposition', 'attachment; filename="dsh-desktop-local-ca.crt"')
        res.setHeader('content-length', String(Buffer.byteLength(caCertificate)))
        res.setHeader('x-content-type-options', 'nosniff')
        res.end(req.method === 'HEAD' ? undefined : caCertificate)
      },
    }),
    'dsh-plugin-desktop: public LAN HTTPS CA route',
  )
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
      [DESKTOP_PROFILE_DELETE_PATH, handleDesktopProfileDeleteRequest],
      [DESKTOP_PROFILE_SELECT_PATH, handleDesktopProfileSelectRequest],
      [DESKTOP_AA_SELECT_PATH, handleDesktopAaSelectRequest],
      [DESKTOP_MARKET_SELECT_PATH, handleDesktopMarketSelectRequest],
      [DESKTOP_TERMINAL_OPEN_PATH, handleDesktopTerminalOpenRequest],
      [DESKTOP_RESTART_PATH, handleDesktopRestartRequest],
      [DESKTOP_RECOVERY_RESTART_PATH, handleDesktopRecoveryRestartRequest],
      [DESKTOP_RENDERER_RELOAD_PATH, handleDesktopRendererReloadRequest],
      [DESKTOP_DEVELOPER_TOOLS_TOGGLE_PATH, handleDesktopDeveloperToolsToggleRequest],
      [DESKTOP_DIAGNOSTICS_EXPORT_PATH, handleDesktopDiagnosticsExportRequest],
    ] as const
    for (const [path, handler] of settingsRoutes) {
      ctx.effect(
        () => ctx.webServer.register({
          kind: 'exact',
          path,
          handler: (req, res) => {
            if (rejectDesktopRequest(ctx, req, res)) return
            return handler(
              req,
              res,
              rendererOrigin,
              desktopSettings,
              reportSettingsError,
            )
          },
        }),
        `dsh-plugin-desktop: private settings route ${path}`,
      )
    }
  }
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: RENDERER_BOOT_REPORT_PATH,
      handler: (req, res) => {
        if (rejectDesktopRequest(ctx, req, res)) return
        return handleRendererBootRequest(
          req,
          res,
          rendererOrigin,
          report => { runtime.reportRendererBoot(report) },
        )
      },
    }),
    'dsh-plugin-desktop: renderer boot report route',
  )
  if (runtime.platform === 'win32') {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: DESKTOP_DIRECTORY_PICKER_PATH,
        handler: (req, res) => {
          if (rejectDesktopRequest(ctx, req, res)) return
          return handleDesktopDirectoryPickerRequest(
            req,
            res,
            rendererOrigin,
            () => runtime.pickDirectory(),
            cause => {
              ctx.logger.error(`dsh-plugin-desktop: native directory picker failed: ${cause instanceof Error ? cause.message : String(cause)}`)
            },
          )
        },
      }),
      'dsh-plugin-desktop: native directory picker route',
    )
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: DESKTOP_DIRECTORY_VALIDATOR_PATH,
        handler: (req, res) => {
          if (rejectDesktopRequest(ctx, req, res)) return
          return handleDesktopDirectoryValidationRequest(
            req,
            res,
            rendererOrigin,
            path => runtime.validateDirectory(path),
            cause => {
              ctx.logger.error(`dsh-plugin-desktop: workspace directory validation failed: ${cause instanceof Error ? cause.message : String(cause)}`)
            },
          )
        },
      }),
      'dsh-plugin-desktop: workspace directory validation route',
    )
  }
  ctx.effect(() => {
    let pending: ReturnType<typeof setImmediate> | undefined
    const updateLiveWebAccess = (
      browserEnabled: boolean,
      exposure: DesktopNetworkExposure,
    ): void => {
      browserAccess.setOrdinaryBrowserEnabled(browserEnabled)
      void lanHttps.setEnabled(browserEnabled && exposure === 'lan').then((snapshot) => {
        if (snapshot.state === 'failed') {
          ctx.logger.error(
            `dsh-plugin-desktop: LAN HTTPS edge failed to start (${snapshot.errorCode ?? 'unknown'})`,
          )
        }
      }).catch((cause: unknown) => {
        ctx.logger.error(
          `dsh-plugin-desktop: LAN HTTPS edge transition failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      })
    }
    updateLiveWebAccess(browserAccess.ordinaryBrowserEnabled, resolved.networkExposure)
    const stopWatching = settings.watch((next) => {
      const nextBrowserAccess = desktopBrowserAccessEnabled(
        next.mode,
        next.openBrowser,
        next.networkExposure,
      )
      const nextNetworkExposure = desktopNetworkExposureForBrowserAccess(
        nextBrowserAccess,
        next.networkExposure,
      )
      updateLiveWebAccess(nextBrowserAccess, nextNetworkExposure)
      const matchesSetup = setupSettings !== undefined
        && next.mode === setupSettings.mode
        && next.port === resolved.port
        && next.macosMaterial === setupSettings.macosMaterial
        && next.linuxMaterial === resolved.linuxMaterial
      // Once saved, any other value supersedes Setup's choice for this generation;
      // a later return to it is a new change and asks for its restart.
      if (!matchesSetup && setupSaved) {
        setupSettings = undefined
        setupSaved = false
      }
      if (next.mode === resolved.mode
        && next.port === resolved.port
        && next.macosMaterial === resolved.macosMaterial
        && next.linuxMaterial === resolved.linuxMaterial) {
        if (pending !== undefined) clearImmediate(pending)
        pending = undefined
        return
      }
      // A native restart prompt here would interrupt the official login that
      // follows Setup; only a later, different choice asks for its own restart.
      if (matchesSetup) {
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
      void lanHttps.stop()
    }
  }, 'dsh-plugin-desktop: live browser access and restart-applied native settings')
  if (runtime.platform !== 'linux') {
    watchUiThemeSource(ctx, (preference) => { runtime.setThemeSource(preference) })
  }
  watchUiLocalePreference(ctx, (preference) => {
    runtime.setLocalePreference(desktopLocalePreference(preference))
  })
  // Cores with the DeepSeek account service (0.1.7+) leave opening the Platform
  // sign-in page to a native subscriber; older cores never activate this row.
  ctx.inject(['deepseekAccount'], (accountCtx) => {
    accountCtx.effect(() => {
      const account = accountCtx.get('deepseekAccount') as PlatformLoginAccount
      const lifetime = new AbortController()
      // A broken watcher only loses the automatic hand-off; the sign-in dialog still offers the link.
      void watchPlatformLogin(
        account,
        (request) => { runtime.platformLogin(request) },
        () => browserAccess.ordinaryBrowserEnabled,
        lifetime.signal,
      ).catch((cause: unknown) => {
        if (!lifetime.signal.aborted) {
          accountCtx.logger.error(`dsh-plugin-desktop: platform sign-in watcher stopped: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      })
      return () => { lifetime.abort() }
    }, 'dsh-plugin-desktop: platform sign-in hand-off')
  })
  ctx.effect(
    () => {
      const material = effectiveDesktopWindowMaterial(
        resolved.mode,
        runtime.platform,
        resolved.macosMaterial,
        resolved.linuxMaterial,
      )
      const url = desktopRendererUrl(
        ctx.webServer.port,
        resolved.mode,
        runtime.platform,
        runtime.updates.currentVersion,
        material,
      )
      return runtime.schedule({
        ...resolved,
        material,
        url,
        authenticationUrl: ctx.connection.authenticatedUrl(new URL(url).origin),
        rendererAccessHeader: browserAccess.rendererHeader,
        productName: DESKTOP_PRODUCT_NAME,
        windowTitle: 'DeepSeek Harness Desktop',
        iconPath,
        trayIcons,
        readLocalePreference: () => {
          return desktopLocalePreference(readUiLocalePreference(ctx))
        },
        readThemeSource: () => readUiThemeSource(ctx),
        ...(desktopSettings === undefined ? {} : {
          readRemoteControl: async () => {
            const aa = desktopSettings.read().aa
            return aa?.requested === true || aa?.effective === true
          },
          enableRemoteControl: async () => {
            const result = await desktopSettings.selectAa(true)
            result.afterResponse?.()
          },
        }),
        requestQuit: appExit,
        requestModeChange: async mode => {
          const current = settings.get()
          const storedBrowserCapability = current.openBrowser || current.networkExposure === 'lan'
          await settings.update(mode !== 'compatibility' && storedBrowserCapability
            ? { mode, openBrowser: false, networkExposure: 'loopback' }
            : { mode })
        },
        applySetupSettings: async next => {
          setupSettings = next
          setupSaved = false
          try {
            await settings.update({
              mode: next.mode,
              macosMaterial: next.macosMaterial,
              windowsMaterial: next.windowsMaterial,
              openBrowser: next.openBrowser,
              networkExposure: next.networkExposure,
            })
          } catch (cause) {
            setupSettings = undefined
            throw cause
          }
          // The mode is saved; a failed notifications write must not bring back
          // the native prompt for it.
          setupSaved = true
          await ctx.settings.update(DESKTOP_NOTIFICATIONS_SETTINGS_ENTRY_ID, { ...next.notifications })
        },
      })
    },
    'dsh-plugin-desktop: native shell generation',
  )
}
