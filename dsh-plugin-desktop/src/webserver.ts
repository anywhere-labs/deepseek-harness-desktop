/** Desktop-owned WebServer wrapper with bounded bind-conflict retry. */

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

  override register(route: WebRoute): () => void {
    return super.register({
      ...route,
      handler: async (req, res) => {
        if (!this.permits(req)) return rejectBrowserRequest(res)
        await route.handler(req, res)
      },
    })
  }

  override registerFallback(handler: WebRoute['handler']): () => void {
    return super.registerFallback(async (req, res) => {
      if (!this.permits(req)) return rejectBrowserRequest(res)
      await handler(req, res)
    })
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
        if (!isAddressInUse(cause)) throw cause
        closeFailedServer(this)
        if (attempt < DESKTOP_WEB_PORT_RETRY_LIMIT) {
          const nextPort = requestedPort + attempt + 1
          if (nextPort <= 65_535) {
            this.desktopConfig.port = nextPort
            continue
          }
        }
        // When sequential port attempts are exhausted (e.g. blocked by Windows
        // excluded port range or consecutive collisions), fall back to an
        // ephemeral OS-assigned port rather than failing Host boot into recovery.
        this.desktopConfig.port = 0
        try {
          await super[Service.init]()
          return
        } catch {
          throw cause
        }
      }
    }
  }
}

export default DesktopWebServer
