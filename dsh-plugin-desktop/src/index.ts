/** DSH Desktop Host plugin: owns the selected native shell generation. */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  THEME_SETTINGS_NAMESPACE,
  type ThemeSettings,
} from '@deepseek-ai/dsh-client-ui-theme'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { DesktopShellMode } from './runtime.ts'
import type {} from './runtime.ts'
import { DesktopFilePreviewGateway } from './file-preview-gateway.ts'
import type { WorkspaceMembership } from './file-preview-gateway.ts'
import {
  FILE_PREVIEW_BINARY_PREFIX,
  FILE_PREVIEW_RPC_CHANNEL,
} from './file-preview-contract.ts'
import type { FilePreviewGatewayConfig } from './file-preview-gateway.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Workspace membership registry read fresh by the file-preview gateway. */
    workspaceRegistry: { list(): readonly WorkspaceMembership[] }
  }
}

/** Stable Cordis plugin name. */
export const name = 'desktop-shell'

/** Services required before the shell can register its renderer generation. */
export const inject = [
  'desktopRuntime',
  'webServer',
  'webRuntime',
  'appExit',
  'settings',
  // Advanced-mode hard dependencies for the file-preview gateway.
  'connection',
  'workspaceRegistry',
  'sessionQuery',
  'fs',
]

/** Standard settings namespace shared by tray and configuration surfaces. */
export const DESKTOP_SETTINGS_NAMESPACE = settingsNamespace('dsh-desktop')

const UI_THEME_SETTINGS_NAMESPACE = settingsNamespace(THEME_SETTINGS_NAMESPACE)

/**
 * Native presentation default for hosts that never persisted a mode, mirroring
 * `defaultDesktopShellMode` in `profile.ts` so the Host schema and the
 * launcher projection cannot diverge. macOS and Windows support the
 * desktop-owned advanced presentation; Linux stays on compatibility.
 */
const DEFAULT_SHELL_MODE: DesktopShellMode = process.platform === 'linux' ? 'compatibility' : 'advanced'

/** Desktop settings presented by the standard settings service. */
export interface DesktopSettings {
  /** Native presentation selected for the next application generation. */
  mode: DesktopShellMode
}

/** Schema registered with the standard settings service. */
export const DesktopSettingsSchema: z<DesktopSettings> = z.object({
  mode: z.union(['compatibility', 'advanced'] as const).default(DEFAULT_SHELL_MODE),
})

/** Native window configuration. */
export interface Config {
  /** Native presentation mode selected before BrowserWindow construction. */
  mode: DesktopShellMode
  /** Initial window width in CSS pixels. */
  width: number
  /** Initial window height in CSS pixels. */
  height: number
  /** Minimum window width in CSS pixels. */
  minWidth: number
  /** Minimum window height in CSS pixels. */
  minHeight: number
  /** Advanced-mode file-preview gateway limits. */
  filePreview: FilePreviewGatewayConfig
}

/** Upper bounds the schemastery schema enforces on file-preview limits. */
const FILE_PREVIEW_MAX_TEXT_BYTES = 1024 * 1024 * 1024
const FILE_PREVIEW_MAX_IMAGE_BYTES = 1024 * 1024 * 1024
const FILE_PREVIEW_MAX_TTL_MS = 60 * 60 * 1000
const FILE_PREVIEW_MAX_RESOURCES = 10_000

/** Schemastery schema for the advanced file-preview gateway limits. */
const FilePreviewConfig: z<FilePreviewGatewayConfig> = z.object({
  maxTextBytes: z.natural().min(1).max(FILE_PREVIEW_MAX_TEXT_BYTES).default(1024 * 1024 * 2),
  maxImageBytes: z.natural().min(1).max(FILE_PREVIEW_MAX_IMAGE_BYTES).default(1024 * 1024 * 20),
  resourceTtlMs: z.natural().min(1).max(FILE_PREVIEW_MAX_TTL_MS).default(60_000),
  maxResources: z.natural().min(1).max(FILE_PREVIEW_MAX_RESOURCES).default(64),
})

/** Validated native window configuration. */
export const Config: z<Config> = z.object({
  mode: z.union(['compatibility', 'advanced'] as const).default(DEFAULT_SHELL_MODE),
  width: z.number().step(1).min(800).default(1280),
  height: z.number().step(1).min(600).default(840),
  minWidth: z.number().step(1).min(640).default(900),
  minHeight: z.number().step(1).min(480).default(640),
  filePreview: FilePreviewConfig.default({
    maxTextBytes: 1024 * 1024 * 2,
    maxImageBytes: 1024 * 1024 * 20,
    resourceTtlMs: 60_000,
    maxResources: 64,
  }),
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
  const appExit = ctx.get('appExit')
  if (appExit === undefined) {
    throw new Error('dsh-plugin-desktop: the launcher did not provide ctx.appExit')
  }
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('dsh-plugin-desktop: desktop shell requires a loopback Web server')
  }
  const iconFilename = ctx.desktopRuntime.platform === 'darwin'
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
        if (value.mode === 'advanced' && ctx.desktopRuntime.platform === 'linux') {
          throw new Error('dsh-plugin-desktop: advanced shell mode is supported on macOS and Windows')
        }
      },
    },
  )
  ctx.effect(() => {
    let pending: ReturnType<typeof setImmediate> | undefined
    const stopWatching = settings.watch((next) => {
      if (next.mode === config.mode) {
        if (pending !== undefined) clearImmediate(pending)
        pending = undefined
        return
      }
      pending ??= setImmediate(() => {
        pending = undefined
        void ctx.desktopRuntime.requestRestart().catch((cause: unknown) => {
          ctx.logger.error('dsh-plugin-desktop: failed to restart after mode change')
          ctx.logger.error(cause)
        })
      })
    })
    return () => {
      stopWatching()
      if (pending !== undefined) clearImmediate(pending)
    }
  }, 'dsh-plugin-desktop: restart after mode change')
  if (config.mode === 'advanced') {
    ctx.on('settings/updated', (namespace, next) => {
      if (namespace !== UI_THEME_SETTINGS_NAMESPACE) return
      ctx.desktopRuntime.setThemeSource((next as ThemeSettings).preference)
    })
    installFilePreviewGateway(ctx, config.filePreview)
  }
  ctx.effect(
    () => ctx.desktopRuntime.schedule({
      mode: config.mode,
      width: config.width,
      height: config.height,
      minWidth: config.minWidth,
      minHeight: config.minHeight,
      url: desktopRendererUrl(ctx.webServer.port, config.mode, ctx.desktopRuntime.platform),
      productName: 'DSH Desktop',
      windowTitle: 'DeepSeek Harness Desktop',
      iconPath,
      trayIcons,
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

/**
 * Install the advanced-mode file-preview gateway: create the instance from the
 * injected services, then register, in order, the resource cleanup effect, the
 * binary data-plane route, and the loopback RPC handler. None of these run in
 * compatibility mode.
 * @param ctx - Host context injecting the connection/workspace/query/fs services.
 * @param filePreview - validated file-preview gateway limits.
 */
function installFilePreviewGateway(ctx: Context, filePreview: FilePreviewGatewayConfig): void {
  const traceSession = ctx.sessionQuery === undefined
    ? undefined
    : (sessionId: string, signal: AbortSignal) => ctx.sessionQuery.traceSession(SessionId(sessionId), signal)
  const gateway = new DesktopFilePreviewGateway(
    ctx.fs,
    () => ctx.workspaceRegistry.list(),
    traceSession,
    ctx.logger,
    `http://127.0.0.1:${String(ctx.webServer.port)}`,
    filePreview,
  )

  ctx.effect(
    () => () => gateway.dispose(),
    'dsh-plugin-desktop: file-preview resource cleanup',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: FILE_PREVIEW_BINARY_PREFIX,
      handler: (req, res) => void gateway.handleImageRequest(req, res),
    }),
    'dsh-plugin-desktop: file-preview binary route',
  )

  const handler: ConnectionRpcHandler = (endpoint, payload, signal) => gateway.dispatch(endpoint, payload, signal)
  ctx.effect(
    () => ctx.connection.rpc.handle(FILE_PREVIEW_RPC_CHANNEL, handler, { authority: 'loopback' }),
    'dsh-plugin-desktop: file-preview RPC',
  )
}
