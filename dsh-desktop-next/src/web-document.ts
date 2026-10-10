/** Local Web document and authenticated HTTP forwarding for the application window. */
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { OnBeforeSendHeadersListenerDetails, WebContents } from 'electron'
import { NATIVE_ACCESS_HEADER } from './desktop-contract.ts'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
}
/**
 * Pre-Cordis globals injected into the application index.
 *
 * `__DSH_FILE_UPLOAD__` is the file-upload plugin's documented page-owned carrier. Without it the
 * plugin posts Blob and stream bodies from a blob-URL dedicated Worker, and Electron never shows
 * Worker requests on a custom protocol to `webRequest` (verified on Electron 44.0.0): they cannot
 * carry the native renderer marker, and the protocol handler cannot tell an owned Worker from one
 * started by another window or a foreign frame. Every non-image attachment therefore received the
 * gate's 403. The page's own `fetch` runs in the owned main frame, which the gate already marks.
 * The carrier reports no byte progress; uploads go to the loopback Host, so the card only skips
 * its intermediate progress.
 */
export const APP_BOOT_SCRIPT = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers();'
  + 'globalThis.__DSH_FILE_UPLOAD__ = { fetch: (input, init) => fetch(input, init) }</script>'
// Cover both the empty document and the official boot page; normal UI keeps its own palette.
const LOADING_STYLE = `<style id="dsh-next-loading-style">
html:has(#root:empty), html:has([data-dsh-boot]) { color-scheme: dark; background: #000 !important; }
body:has(#root:empty), body:has([data-dsh-boot]) { background: #000 !important; }
[data-dsh-boot] {
  background: #000 !important;
  --dsw-alias-bg-base: #000;
  --dsw-alias-label-primary: #f9fafb;
  --dsw-alias-label-secondary: #cfd3d6;
  --dsw-alias-label-tertiary: #adb2b8;
  --dsw-alias-border-l2: rgb(255 255 255 / 12%);
  --dsw-alias-brand-primary: #f9fafb;
}
</style>`

/** Mark live same-origin frames in the owned window; strip the marker from other targets and redirects. */
export function appRequestHeaders(
  request: Pick<OnBeforeSendHeadersListenerDetails, 'url' | 'webContentsId' | 'webContents' | 'frame' | 'resourceType' | 'requestHeaders'>,
  owner: Pick<WebContents, 'id' | 'mainFrame'> | undefined,
  nativeToken: string | undefined,
): Record<string, string> {
  const headers = Object.fromEntries(Object.entries(request.requestHeaders)
    .filter(([name]) => name.toLowerCase() !== NATIVE_ACCESS_HEADER))
  const target = new URL(request.url)
  if (target.protocol === 'dsh-app:' && target.host === 'app' && !target.username && !target.password && owner && nativeToken
    && request.webContentsId === owner.id && (!request.webContents || request.webContents.id === owner.id)
    && request.resourceType !== 'mainFrame' && request.frame
    && !request.frame.detached && request.frame.origin === 'dsh-app://app') headers[NATIVE_ACCESS_HEADER] = nativeToken
  return headers
}

/**
 * Read an application-owned static asset; the index waits for asynchronous Host injections.
 * @param request - Local application request.
 * @param root - Packaged Web dist directory.
 * @returns Static response, or a missing/invalid path response.
 */
export async function serveWebDocument(request: Request, root: string, waitForHost = true): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }
  const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  const directory = resolve(root)
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 })
  let body: Buffer
  try { body = await readFile(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
    throw error
  }
  const content = waitForHost && (pathname === '/' || pathname === '/index.html')
    ? body.toString().replace('<head>', '<head>' + LOADING_STYLE + APP_BOOT_SCRIPT) : new Uint8Array(body)
  return new Response(request.method === 'HEAD' ? null : content, {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/**
 * Exchange the Host launch URL for an authority-bound browser cookie.
 * @param url - Authenticated URL reported by the owned Host process.
 * @returns Cookie header for requests forwarded to that Host.
 */
export async function authenticateWebHost(url: string, nativeToken?: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual', ...(nativeToken ? { headers: { [NATIVE_ACCESS_HEADER]: nativeToken } } : {}) })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) throw new Error('Desktop Host authentication failed')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/**
 * Response headers not relayed to the renderer. `set-cookie` would hand the
 * Host's authentication cookie to the page's cookie jar, which the shell owns
 * instead; the rest describe the Node `fetch` connection (its encoding, length,
 * and hop-by-hop transport), which Chromium never sees.
 */
const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
]

/** Host routes whose responses carry immutable cache headers keyed by a per-process revision. */
const PLUGIN_BUNDLE_PATH = /^\/plugins\//u

/**
 * Forward local application requests to its authenticated Host, preserving streaming and cancellation.
 * Plugin bundle responses lose their `cache-control` for `no-store`: the Host marks them immutable
 * under a revision that changes every launch, so Chromium's disk cache would only accumulate bundles
 * no later launch can reuse.
 * @param request - Request from the application origin.
 * @param host - Owned Host URL.
 * @param cookie - Host-issued authentication cookie.
 * @returns Host response without connection-level headers.
 */
export async function forwardWebRequest(request: Request, host: string, cookie: string, nativeToken: string): Promise<Response> {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  // Custom-protocol fetches can omit Origin. The native session marks only
  // requests from live same-origin frames in our owned window; an HTTP header or referrer alone is
  // insufficient. Keep this compatible with the upstream's Electron 44.0 ABI.
  if (source.protocol !== 'dsh-app:' || source.host !== 'app' || source.username || source.password
    || !nativeToken || request.headers.get(NATIVE_ACCESS_HEADER) !== nativeToken) return new Response(null, { status: 403 })
  if (origin !== null && origin !== 'dsh-app://app') return new Response(null, { status: 403 })
  // The official connect.js accepts an explicit ws query. Its same-origin
  // fallback would otherwise derive ws://app from this custom-protocol iframe.
  // Keep the frontend local, and use the authenticated Host's public CDP proxy
  // (not the Inspector Worker's private port). Its CSP already permits loopback.
  if (source.pathname === '/inspector/devtools/devtools_app.html' && ['GET', 'HEAD'].includes(request.method)) {
    const endpoint = new URL(host)
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) {
      return new Response(null, { status: 503 })
    }
    endpoint.pathname = '/inspector/devtools/cdp'
    endpoint.search = ''
    endpoint.hash = ''
    for (const id of source.searchParams.getAll('clientSourceId')) endpoint.searchParams.append('clientSourceId', id)
    const connection = endpoint.host + endpoint.pathname + endpoint.search
    if (source.searchParams.getAll('ws').length !== 1 || source.searchParams.get('ws') !== connection || source.searchParams.has('wss')) {
      source.searchParams.delete('wss')
      source.searchParams.set('ws', connection)
      return new Response(null, { status: 302, headers: { location: source.href, 'cache-control': 'no-store' } })
    }
  }
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site', NATIVE_ACCESS_HEADER]) headers.delete(name)
  headers.set('cookie', cookie)
  headers.set(NATIVE_ACCESS_HEADER, nativeToken)
  // Preserve same-origin semantics for every owned plugin route, including
  // /dsh-market/*. Translate only after validating the native frame marker and
  // source origin; the HTTP client supplies Host from this owned target URL.
  headers.set('origin', target.origin)
  headers.set('sec-fetch-site', 'same-origin')
  const init = { method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual' as const }
  const response = await fetch(target, init)
  const outgoing = new Headers(response.headers)
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name)
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, headers: outgoing })
}
