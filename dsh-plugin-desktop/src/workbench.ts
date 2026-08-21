/** Desktop-owned workbench Host: local models, data-home merge, and a default-off control plane. */

import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { delimiter, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { applyHomeMigration, previewHomeMigration } from './home-migration.ts'
import {
  createLocalModelProviderConfig,
  LOCAL_MODEL_TARGETS,
  mergeLocalModelProvider,
  probeLocalModelRuntime,
  resolveLocalModelTarget,
  startLocalModelRuntime,
  type LocalModelProbeResult,
} from './local-models.ts'
import {
  confineRemotePath,
  createRemotePty,
  listRemoteFiles,
  listRemoteSessions,
  readRemoteFile,
  remoteControlPlaneStatus,
  writeRemoteFile,
  type RemotePtySession,
} from './remote-access.ts'
import {
  DESKTOP_WORKBENCH_SETTINGS_KEY,
  LOCAL_MODEL_LLM_SETTINGS_KEY,
  parseDesktopWorkbenchSettings,
  remoteEntranceEnabled,
  WORKBENCH_API_PREFIX,
  type DesktopWorkbenchSettings,
} from './workbench-settings.ts'

export { WORKBENCH_API_PREFIX } from './workbench-settings.ts'

const MAX_BODY_BYTES = 32 * 1024

/** Stable Cordis plugin name. */
export const name = 'desktop-workbench'

/** Settings and the loopback Web server required by workbench routes. */
export const inject = ['settings', 'webServer']

/** Settings namespace presented by the standard settings service. */
export const DESKTOP_WORKBENCH_SETTINGS_NAMESPACE = settingsNamespace(DESKTOP_WORKBENCH_SETTINGS_KEY)

const DesktopWorkbenchSettingsSchema: z<DesktopWorkbenchSettings> = z.object({
  localModels: z.object({
    autoStart: z.boolean().default(false),
  }).default({ autoStart: false }),
  home: z.object({
    lastSource: z.string().default(''),
  }).default({ lastSource: '' }),
  remote: z.object({
    enabled: z.boolean().default(false),
    trustedHost: z.string().default(''),
  }).default({ enabled: false, trustedHost: '' }),
})

function finishJson(res: ServerResponse, statusCode: number, value: object): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function commandExists(command: string): boolean {
  if (command.length === 0) return false
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const extension of extensions) {
      try {
        accessSync(join(dir, `${command}${extension}`), constants.X_OK)
        return true
      } catch {
        continue
      }
    }
  }
  return false
}

function spawnDetached(command: string, args: readonly string[]): void {
  const child = spawn(command, [...args], { detached: true, stdio: 'ignore' })
  child.unref()
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://127.0.0.1')
}

function originAllowed(
  req: IncomingMessage,
  rendererOrigin: string,
  settings: DesktopWorkbenchSettings,
  remoteRoute: boolean,
): boolean {
  const origin = req.headers.origin
  if (origin === rendererOrigin) return !remoteRoute || remoteEntranceEnabled(settings.remote)
  if (!remoteRoute || !remoteEntranceEnabled(settings.remote) || typeof origin !== 'string') return false
  try {
    const url = new URL(origin)
    const trusted = settings.remote.trustedHost
    const host = trusted.includes(':') ? trusted.slice(0, trusted.lastIndexOf(':')) : trusted
    const port = trusted.includes(':') ? trusted.slice(trusted.lastIndexOf(':') + 1) : ''
    if (url.hostname.toLowerCase() !== host.toLowerCase()) return false
    if (port.length > 0) {
      const implied = url.protocol === 'https:' ? '443' : '80'
      if (url.port !== port && !(url.port === '' && port === implied)) return false
    }
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function localOrigin(req: IncomingMessage, rendererOrigin: string): boolean {
  return req.headers.origin === rendererOrigin
}

async function applyLocalModel(
  ctx: Context,
  probe: LocalModelProbeResult,
): Promise<Record<string, unknown>> {
  const config = createLocalModelProviderConfig(probe)
  const llm = settingsNamespace(LOCAL_MODEL_LLM_SETTINGS_KEY)
  const current = ctx.settings.get(llm) as { providers?: Record<string, unknown> } | undefined
  const providers = mergeLocalModelProvider(current?.providers ?? {}, probe.id, config)
  await ctx.settings.update(llm, { providers })
  return providers
}

/**
 * Register settings and same-origin workbench routes.
 * Local-model auto-start and the remote control plane stay off until settings say otherwise.
 */
export function apply(ctx: Context): void {
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('dsh-plugin-desktop/workbench: workbench routes require a loopback Web server')
  }
  const scope = ctx.settings.register(
    DESKTOP_WORKBENCH_SETTINGS_NAMESPACE,
    DesktopWorkbenchSettingsSchema,
    {
      applies: 'restart',
      validate: (value) => {
        parseDesktopWorkbenchSettings(value)
      },
    },
  )
  const rendererOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const ptySessions = new Map<string, RemotePtySession>()
  const readSettings = (): DesktopWorkbenchSettings => parseDesktopWorkbenchSettings(scope.get())

  if (readSettings().localModels.autoStart) {
    for (const target of LOCAL_MODEL_TARGETS) {
      void startLocalModelRuntime(target, {
        commandExists,
        spawn: spawnDetached,
        waitMs: 0,
      }).catch((cause: unknown) => {
        ctx.logger.warn(
          `dsh-plugin-desktop/workbench: auto-start skipped for ${target.id}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        )
      })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: WORKBENCH_API_PREFIX,
      handler: (req, res) => handleWorkbenchRequest(req, res, {
        ctx,
        rendererOrigin,
        readSettings,
        ptySessions,
        home: resolveDshHome(),
      }),
    }),
    'dsh-plugin-desktop: workbench routes',
  )
  ctx.effect(() => () => {
    for (const session of ptySessions.values()) session.close()
    ptySessions.clear()
  }, 'dsh-plugin-desktop: dispose remote PTY sessions')
}

interface WorkbenchRouteContext {
  readonly ctx: Context
  readonly rendererOrigin: string
  readonly readSettings: () => DesktopWorkbenchSettings
  readonly ptySessions: Map<string, RemotePtySession>
  readonly home: string
}

async function handleWorkbenchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  route: WorkbenchRouteContext,
): Promise<void> {
  const url = requestUrl(req)
  const path = url.pathname
  const settings = route.readSettings()
  const remotePath = path.startsWith(`${WORKBENCH_API_PREFIX}/sessions`)
    || path.startsWith(`${WORKBENCH_API_PREFIX}/files`)
    || path.startsWith(`${WORKBENCH_API_PREFIX}/file`)
    || path.startsWith(`${WORKBENCH_API_PREFIX}/pty`)
  if (remotePath) {
    if (!originAllowed(req, route.rendererOrigin, settings, true)) {
      return finishJson(res, 403, { error: 'forbidden' })
    }
  } else if (!localOrigin(req, route.rendererOrigin)) {
    return finishJson(res, 403, { error: 'forbidden' })
  }
  try {
    if (path === `${WORKBENCH_API_PREFIX}/status` && req.method === 'GET') {
      return finishJson(res, 200, remoteControlPlaneStatus(settings.remote, {
        loopbackOrigin: route.rendererOrigin,
        home: route.home,
      }))
    }
    if (path === `${WORKBENCH_API_PREFIX}/models/scan` && req.method === 'POST') {
      const body = await readJson(req) as { id?: string; origin?: string }
      const targets = body.id !== undefined || body.origin !== undefined
        ? [resolveLocalModelTarget(body)]
        : [...LOCAL_MODEL_TARGETS]
      const results = await Promise.all(targets.map(target => probeLocalModelRuntime(target)))
      return finishJson(res, 200, { results })
    }
    if (path === `${WORKBENCH_API_PREFIX}/models/start` && req.method === 'POST') {
      const body = await readJson(req) as { id?: string; origin?: string }
      const target = resolveLocalModelTarget(body)
      const result = await startLocalModelRuntime(target, {
        commandExists,
        spawn: spawnDetached,
        waitMs: 800,
      })
      return finishJson(res, 200, { result })
    }
    if (path === `${WORKBENCH_API_PREFIX}/models/apply` && req.method === 'POST') {
      const body = await readJson(req) as { id?: string; origin?: string }
      const target = resolveLocalModelTarget(body)
      const probe = await probeLocalModelRuntime(target)
      const providers = await applyLocalModel(route.ctx, probe)
      return finishJson(res, 200, { providers, result: probe })
    }
    if (path === `${WORKBENCH_API_PREFIX}/home/preview` && req.method === 'POST') {
      const body = await readJson(req) as { source?: string }
      if (typeof body.source !== 'string') throw new Error('source home is required')
      return finishJson(res, 200, previewHomeMigration(body.source, route.home))
    }
    if (path === `${WORKBENCH_API_PREFIX}/home/apply` && req.method === 'POST') {
      const body = await readJson(req) as { source?: string; token?: string }
      if (typeof body.source !== 'string' || typeof body.token !== 'string') {
        throw new Error('source home and preview token are required')
      }
      return finishJson(res, 200, applyHomeMigration(body.source, route.home, body.token))
    }
    if (path === `${WORKBENCH_API_PREFIX}/sessions` && req.method === 'GET') {
      return finishJson(res, 200, { sessions: listRemoteSessions(route.home) })
    }
    if (path === `${WORKBENCH_API_PREFIX}/files` && req.method === 'GET') {
      const root = url.searchParams.get('root') ?? route.home
      const rel = url.searchParams.get('path') ?? '.'
      return finishJson(res, 200, { root: confineRemotePath(root, '.'), entries: listRemoteFiles(root, rel) })
    }
    if (path === `${WORKBENCH_API_PREFIX}/file` && req.method === 'GET') {
      const root = url.searchParams.get('root') ?? route.home
      const rel = url.searchParams.get('path')
      if (rel === null) throw new Error('path is required')
      return finishJson(res, 200, { path: rel, content: readRemoteFile(root, rel) })
    }
    if (path === `${WORKBENCH_API_PREFIX}/file` && req.method === 'PUT') {
      const body = await readJson(req) as { root?: string; path?: string; content?: string }
      if (typeof body.path !== 'string' || typeof body.content !== 'string') {
        throw new Error('path and content are required')
      }
      writeRemoteFile(typeof body.root === 'string' ? body.root : route.home, body.path, body.content)
      return finishJson(res, 200, { ok: true })
    }
    if (path === `${WORKBENCH_API_PREFIX}/pty` && req.method === 'POST') {
      const body = await readJson(req) as { cwd?: string }
      const cwd = typeof body.cwd === 'string' ? confineRemotePath(body.cwd, '.') : route.home
      const session = createRemotePty(cwd)
      route.ptySessions.set(session.id, session)
      return finishJson(res, 200, { id: session.id, cwd: session.cwd })
    }
    const ptyMatch = /^\/api\/desktop\/workbench\/pty\/([^/]+)$/u.exec(path)
    if (ptyMatch !== null) {
      const session = route.ptySessions.get(ptyMatch[1] ?? '')
      if (session === undefined) return finishJson(res, 404, { error: 'pty session not found' })
      if (req.method === 'GET') return finishJson(res, 200, { id: session.id, data: session.read() })
      if (req.method === 'POST') {
        const body = await readJson(req) as { data?: string }
        if (typeof body.data !== 'string') throw new Error('data is required')
        session.write(body.data)
        return finishJson(res, 200, { ok: true })
      }
      if (req.method === 'DELETE') {
        session.close()
        route.ptySessions.delete(session.id)
        return finishJson(res, 200, { ok: true })
      }
    }
    return finishJson(res, 404, { error: 'not found' })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return finishJson(res, 400, { error: detail })
  }
}
