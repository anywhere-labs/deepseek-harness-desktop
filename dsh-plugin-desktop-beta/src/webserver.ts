/** Desktop-owned WebServer wrapper with bounded bind-conflict retry. */

import { diagnosticOperation } from './developer-logging.ts'
import type { ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Service } from '@deepseek-ai/cordis'
import WebServer, {
  type Config,
  type WebRoute,
  type WebUpgradeRoute,
} from '@deepseek-ai/dsh-host-webserver'
import { decideDesktopBrowserAccess } from './desktop-browser-access.ts'
import { DESKTOP_WEB_PORT_RETRY_LIMIT } from './desktop-port.ts'

function isAddressInUse(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE'
}

/** Close an unbound server left behind by a failed listen attempt. */
function closeFailedServer(instance: unknown): void {
  const server = (instance as { server?: { close?: (callback?: (error?: Error) => void) => void } } | null)?.server
  if (typeof server?.close !== 'function') return
  try {
    server.close(() => {})
  } catch {
    // The failed server is already unbound; preserve the original bind error.
  }
}

function rejectBrowserRequest(res: ServerResponse): void {
  res.statusCode = 403
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end('forbidden')
}

function rejectBrowserUpgrade(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 403 Forbidden',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 9',
    '',
    'forbidden',
  ].join('\r\n'))
}

/** Reuse the upstream WebServer while retrying only real bind collisions. */
export class DesktopWebServer extends WebServer {
  static override Config = WebServer.Config

  private readonly desktopConfig: Config

  constructor(ctx: ConstructorParameters<typeof WebServer>[0], config: Config) {
    if (config.host !== '127.0.0.1') {
      throw new Error('dsh-plugin-desktop: Desktop WebServer requires loopback until LAN HTTPS is available')
    }
    super(ctx, config)
    this.desktopConfig = config
  }

  private permits(request: Parameters<WebRoute['handler']>[0]): boolean {
    const access = this.ctx.get('desktopBrowserAccess')
    // The Desktop-owned server remains usable in an ordinary `dsh` launch,
    // where the Electron launcher capability is intentionally absent.
    return access === undefined || decideDesktopBrowserAccess(access, request) !== 'denied'
  }

  private traceHttp(route: string, handler: WebRoute['handler']): WebRoute['handler'] {
    return async (req, res) => {
      const end = diagnosticOperation('host.http', 'request', { route, method: req.method })
      const finish = () => { cleanup(); end(undefined, { status: res.statusCode, aborted: !res.writableFinished }) }
      const cleanup = () => { res.removeListener('finish', finish); res.removeListener('close', finish) }
      res.once('finish', finish)
      res.once('close', finish)
      try { await handler(req, res) } catch (error) { cleanup(); end(error); throw error }
    }
  }

  override register(route: WebRoute): () => void {
    return super.register({
      ...route,
      handler: this.traceHttp(String(route.path), async (req, res) => {
        if (!this.permits(req)) return rejectBrowserRequest(res)
        await route.handler(req, res)
      }),
    })
  }

  override registerFallback(handler: WebRoute['handler']): () => void {
    return super.registerFallback(this.traceHttp('fallback', async (req, res) => {
      if (!this.permits(req)) return rejectBrowserRequest(res)
      await handler(req, res)
    }))
  }

  override registerUpgrade(route: WebUpgradeRoute): () => void {
    return super.registerUpgrade({
      ...route,
      handler: (req, socket, head) => {
        if (!this.permits(req)) return rejectBrowserUpgrade(socket)
        return route.handler(req, socket, head)
      },
    })
  }

  override async [Service.init](): Promise<void> {
    const requestedPort = this.desktopConfig.port
    if (requestedPort === 0) {
      await super[Service.init]()
      return
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await super[Service.init]()
        return
      } catch (cause) {
        const nextPort = requestedPort + attempt + 1
        if (!isAddressInUse(cause)
          || attempt >= DESKTOP_WEB_PORT_RETRY_LIMIT
          || nextPort > 65_535) {
          throw cause
        }
        closeFailedServer(this)
        this.desktopConfig.port = nextPort
      }
    }
  }
}

export default DesktopWebServer
