import type { WebContents, WebRequest } from 'electron'
import type { DesktopShellSpec } from './runtime.ts'
import type { DesktopRendererAccessHeader } from './desktop-browser-access.ts'

const registrations = new WeakMap<WebRequest, { renderers: Map<number, { origin: string; header: DesktopRendererAccessHeader }> }>()

function pairedWebSocketOrigin(origin: string): string {
  const url = new URL(origin)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else throw new Error(`dsh-plugin-desktop: unsupported renderer origin protocol ${url.protocol}`)
  return url.origin
}

/**
 * Exchange the upstream process token inside the BrowserWindow's own
 * persistent session before its marker-bearing renderer URL is loaded.
 * Keeping the exchange separate preserves the Desktop query markers across
 * the upstream redirect and keeps the launch token out of renderer history.
 */
export async function authenticateRendererSession(
  renderer: WebContents,
  spec: DesktopShellSpec,
): Promise<void> {
  const session = renderer.session
  const headers = {
    [spec.rendererAccessHeader.name]: spec.rendererAccessHeader.value,
  }
  const authenticated = await session.fetch(spec.authenticationUrl, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-store',
    headers,
  })
  if (authenticated.status !== 200) {
    throw new Error(
      `dsh-plugin-desktop: browser authentication failed with HTTP ${String(authenticated.status)}`,
    )
  }
  await authenticated.body?.cancel()
}

function sameRendererCarrierOrigin(requestUrl: string, httpOrigin: string, webSocketOrigin: string): boolean {
  try {
    const origin = new URL(requestUrl).origin
    return origin === httpOrigin || origin === webSocketOrigin
  } catch {
    return false
  }
}

function withoutRendererAccessHeader(
  requestHeaders: Record<string, string>,
  headerName: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(requestHeaders)
      .filter(([name]) => name.toLowerCase() !== headerName),
  )
}

function requestBelongsToRenderer(
  details: Electron.OnBeforeSendHeadersListenerDetails,
  webContentsId: number,
): boolean {
  const providedIds = [details.webContentsId, details.webContents?.id]
    .filter((value): value is number => value !== undefined)
  return providedIds.length > 0 && providedIds.every(value => value === webContentsId)
}

function requestComesFromRendererOrigin(
  details: Electron.OnBeforeSendHeadersListenerDetails,
  origin: string,
): boolean {
  if (details.resourceType === 'mainFrame') return true
  const frame = details.frame
  if (frame === undefined || frame === null || frame.detached || frame.origin !== origin) return false
  const top = frame.top ?? (frame.parent === null ? frame : undefined)
  return top !== undefined && !top.detached && top.origin === origin
}

/**
 * Attach one generation-only capability to the renderer's HTTP and WebSocket
 * traffic. Query markers are intentionally insufficient because subresources,
 * API requests, and upgrades do not retain the main-frame query string.
 */
export function installRendererAccessHeader(
  renderer: WebContents,
  origin: string,
  header: DesktopRendererAccessHeader,
): () => void {
  const webRequest = renderer.session.webRequest
  const webContentsId = renderer.id
  let registration = registrations.get(webRequest)
  if (registration !== undefined) {
    registration.renderers.set(webContentsId, { origin, header })
    return () => {
      registration!.renderers.delete(webContentsId)
      if (registration!.renderers.size === 0) {
        registrations.delete(webRequest)
        webRequest.onBeforeSendHeaders(null)
      }
    }
  }
  const renderers = new Map([[webContentsId, { origin, header }]])
  registration = { renderers }
  registrations.set(webRequest, registration)
  const listener = (
    details: Electron.OnBeforeSendHeadersListenerDetails,
    callback: (response: Electron.BeforeSendResponse) => void,
  ): void => {
    // This listener owns a dedicated renderer session and sees every target so
    // a redirect can never carry the capability away from the local carrier.
    const owner = renderers.get(details.webContentsId ?? details.webContents?.id ?? -1)
    const requestHeaders = withoutRendererAccessHeader(details.requestHeaders, header.name)
    if (owner === undefined || !requestBelongsToRenderer(details, details.webContentsId ?? details.webContents!.id)
      || !sameRendererCarrierOrigin(details.url, owner.origin, pairedWebSocketOrigin(owner.origin))
      || !requestComesFromRendererOrigin(details, owner.origin)) {
      callback({ requestHeaders })
      return
    }
    requestHeaders[owner.header.name] = owner.header.value
    callback({ requestHeaders })
  }
  webRequest.onBeforeSendHeaders({
    urls: ['<all_urls>'],
  }, listener)
  let active = true
  return () => {
    if (!active) return
    active = false
    renderers.delete(webContentsId)
    if (renderers.size === 0) {
      registrations.delete(webRequest)
      webRequest.onBeforeSendHeaders(null)
    }
  }
}
