import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { WebContents } from 'electron'
import { APP_BOOT_SCRIPT, appRequestHeaders, authenticateWebHost, forwardWebRequest, serveWebDocument } from '../src/web-document.ts'
import { NATIVE_ACCESS_HEADER } from '../src/desktop-contract.ts'

const roots: string[] = []
const NATIVE_TOKEN = 'native-token'
function ownedRequest(url: string, init?: RequestInit): Request {
  const request = new Request(url, init)
  request.headers.set(NATIVE_ACCESS_HEADER, NATIVE_TOKEN)
  return request
}
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('serves the Web entry and assets without starting or contacting a Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-web-'))
  roots.push(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<html><head></head><body><script src="assets/entry.js"></script></body></html>')
  await writeFile(join(root, 'assets/entry.js'), 'globalThis.entryLoaded = true')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await serveWebDocument(new Request('dsh-app://app/'), root)
  const html = await response.text()
  expect(html.indexOf('Promise.withResolvers()')).toBeLessThan(html.indexOf('assets/entry.js'))
  expect(await (await serveWebDocument(new Request('dsh-app://app/assets/entry.js'), root)).text()).toContain('entryLoaded')
  expect(fetch).not.toHaveBeenCalled()
  expect((await serveWebDocument(new Request('dsh-app://app/%2e%2e%2fprivate'), root)).status).toBe(403)
  expect((await serveWebDocument(new Request('dsh-app://app/missing.js'), root)).status).toBe(404)
})

it('installs the file-upload page carrier before the application entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-web-'))
  roots.push(root)
  await writeFile(join(root, 'index.html'), '<html><head></head><body><script src="assets/entry.js"></script></body></html>')
  const html = await (await serveWebDocument(new Request('dsh-app://app/'), root)).text()
  expect(html.indexOf(APP_BOOT_SCRIPT)).toBeGreaterThan(0)
  expect(html.indexOf(APP_BOOT_SCRIPT)).toBeLessThan(html.indexOf('assets/entry.js'))
  // Electron never shows custom-protocol Worker requests to webRequest; uploads must use the page's fetch.
  const response = Promise.resolve(new Response('{}'))
  const page = { fetch: vi.fn(() => response), Promise }
  runInNewContext(APP_BOOT_SCRIPT.slice('<script>'.length, -'</script>'.length), page)
  const carrier = (page as unknown as { __DSH_FILE_UPLOAD__: { fetch: typeof fetch } }).__DSH_FILE_UPLOAD__
  const init = { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'bytes' }
  expect(carrier.fetch('api/session/uploadFileBinary?sessionId=s', init)).toBe(response)
  expect(page.fetch).toHaveBeenCalledWith('api/session/uploadFileBinary?sessionId=s', init)
  expect(await serveWebDocument(new Request('dsh-app://app/'), root, false).then(r => r.text())).not.toContain('__DSH_FILE_UPLOAD__')
})

it('requires the Host authentication exchange and retains only its cookie value', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 303, headers: { 'set-cookie': 'session=owned; HttpOnly; SameSite=Strict' } }))
    .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
  vi.stubGlobal('fetch', fetch)
  expect(await authenticateWebHost('http://127.0.0.1:1234/?token=owned')).toBe('session=owned')
  await expect(authenticateWebHost('http://127.0.0.1:1234/')).rejects.toThrow('authentication failed')
})

it('forwards upload bytes and cancellation with Host credentials while keeping the response streaming', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream')); controller.close() } })
  const fetch = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-encoding': 'gzip', 'set-cookie': 'private' } }))
  vi.stubGlobal('fetch', fetch)
  const request = ownedRequest('dsh-app://app/api/upload?name=file', {
    method: 'POST', body: 'upload bytes', headers: { origin: 'dsh-app://app', cookie: 'untrusted' },
  })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/?token=secret', 'session=owned', NATIVE_TOKEN)
  const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
  expect(target.href).toBe('http://127.0.0.1:1234/api/upload?name=file')
  expect(new Headers(init.headers).get('cookie')).toBe('session=owned')
  expect(new Headers(init.headers).get('origin')).toBe('http://127.0.0.1:1234')
  expect(init.signal).toBe(request.signal)
  expect(init.body).toBe(request.body)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(await response.text()).toBe('stream')
})

it('drops connection-level headers the Host wrote for its own transport', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('body', { headers: {
    'transfer-encoding': 'chunked', connection: 'keep-alive', 'keep-alive': 'timeout=5', trailer: 'x', te: 'trailers',
    'content-type': 'text/plain', 'cache-control': 'no-cache', etag: '"1"',
  } }))
  vi.stubGlobal('fetch', fetch)
  const response = await forwardWebRequest(ownedRequest('dsh-app://app/api/read'), 'http://127.0.0.1:1234/', 'session=owned', NATIVE_TOKEN)
  for (const name of ['transfer-encoding', 'connection', 'keep-alive', 'trailer', 'te']) expect(response.headers.get(name)).toBeNull()
  expect(response.headers.get('content-type')).toBe('text/plain')
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(response.headers.get('etag')).toBe('"1"')
})

it('replaces the immutable cache header of plugin bundles with no-store and leaves other routes alone', async () => {
  const immutable = 'public, max-age=31536000, immutable'
  const fetch = vi.fn().mockImplementation(async () => new Response('js', { headers: { 'cache-control': immutable } }))
  vi.stubGlobal('fetch', fetch)
  const bundle = await forwardWebRequest(ownedRequest('dsh-app://app/plugins/??a/client.js&rev=1'), 'http://127.0.0.1:1234/', 'c', NATIVE_TOKEN)
  expect(bundle.headers.get('cache-control')).toBe('no-store')
  const chunk = await forwardWebRequest(ownedRequest('dsh-app://app/plugins/a/client.x.js?rev=1'), 'http://127.0.0.1:1234/', 'c', NATIVE_TOKEN)
  expect(chunk.headers.get('cache-control')).toBe('no-store')
  const asset = await forwardWebRequest(ownedRequest('dsh-app://app/api/plugins/list'), 'http://127.0.0.1:1234/', 'c', NATIVE_TOKEN)
  expect(asset.headers.get('cache-control')).toBe(immutable)
})

it('refuses another page origin without forwarding its request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const request = ownedRequest('dsh-app://app/api/read', { headers: { origin: 'https://other.example' } })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned', NATIVE_TOKEN)
  expect(response.status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['/api/community-market/sources', '/api/community-market/operations/preview', '/api/community-market/operations/execute', '/dsh-market/update', '/other-plugin/mutation'])('forwards native plugin route %s without an Origin header', async path => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  // The main-process network hook supplies the marker even when Origin is absent.
  const request = ownedRequest(`dsh-app://app${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned', NATIVE_TOKEN)
  expect(response.status).toBe(200)
  const headers = new Headers(fetch.mock.calls[0]![1].headers)
  expect(headers.get('origin')).toBe('http://127.0.0.1:1234')
  expect(headers.get('sec-fetch-site')).toBe('same-origin')
  expect(headers.get('cookie')).toBe('session=owned')
  expect(headers.get('x-dsh-desktop-renderer')).toBe('native-token')
})

it('preserves Market mutation authority only for the owned application origin', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const url = 'dsh-app://app/api/community-market/operations/preview'
  expect((await forwardWebRequest(new Request(url, { method: 'POST', body: '{}' }), 'http://127.0.0.1:1234/', 'session=owned', NATIVE_TOKEN)).status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
  const request = ownedRequest(url, { method: 'POST', headers: { origin: 'dsh-app://app' }, body: '{}' })
  await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned', NATIVE_TOKEN)
  const headers = new Headers(fetch.mock.calls[0]![1].headers)
  expect(headers.get('origin')).toBe('http://127.0.0.1:1234')
  expect(headers.get('sec-fetch-site')).toBe('same-origin')
  expect(headers.get('cookie')).toBe('session=owned')
})

it.each([undefined, 'wrong-token'])(
  'rejects native marker %s even with app-looking headers and referrer', async marker => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const request = new Request('dsh-app://app/api/community-market/sources', {
      method: 'POST', body: '{}', referrer: 'dsh-app://app/',
      headers: { origin: 'dsh-app://app', 'sec-fetch-site': 'same-origin' },
    })
    if (marker) request.headers.set(NATIVE_ACCESS_HEADER, marker)
    expect((await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned', NATIVE_TOKEN)).status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  },
)

it.each(['dsh-app://shell/api/read', 'dsh-app://app:1234/api/read', 'https://app/api/read'])(
  'does not forward credentials for another request authority: %s', async url => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const request = ownedRequest(url)
    expect((await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned', NATIVE_TOKEN)).status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  },
)

it('marks owned application requests and strips caller markers from every other target', () => {
  const frame = { origin: 'dsh-app://app', detached: false } as WebContents['mainFrame']
  const owner = { id: 7, mainFrame: frame }
  const request = { url: 'dsh-app://app/api/community-market/sources', webContentsId: owner.id,
    frame, resourceType: 'xhr' as const, requestHeaders: { 'X-Dsh-Desktop-Renderer': 'caller', 'content-type': 'application/json' } }
  const headers = appRequestHeaders(request, owner, NATIVE_TOKEN)
  expect(headers).toEqual({ 'content-type': 'application/json', [NATIVE_ACCESS_HEADER]: NATIVE_TOKEN })
  const refused = [
    { ...request, webContentsId: 8 },
    { ...request, webContents: { id: 8 } as WebContents },
    { ...request, frame: null },
    { ...request, frame: undefined },
    { ...request, frame: { ...frame, detached: true } as WebContents['mainFrame'] },
    { ...request, frame: { ...frame, origin: 'https://other.example' } as WebContents['mainFrame'] },
    { ...request, frame: { ...frame, origin: 'null' } as WebContents['mainFrame'] },
    { ...request, resourceType: 'mainFrame' as const },
    { ...request, url: 'dsh-app://shell/api/test' },
    { ...request, url: 'dsh-app://app:1234/api/test' },
    { ...request, url: 'dsh-app://user:password@app/api/test' },
    { ...request, url: 'https://other.example/redirected' },
    { ...request, url: 'http://127.0.0.1:1234/api/test' },
  ]
  for (const input of refused) expect(new Headers(appRequestHeaders(input, owner, NATIVE_TOKEN)).get(NATIVE_ACCESS_HEADER)).toBeNull()
  expect(new Headers(appRequestHeaders(request, undefined, NATIVE_TOKEN)).get(NATIVE_ACCESS_HEADER)).toBeNull()
  expect(new Headers(appRequestHeaders(request, owner, undefined)).get(NATIVE_ACCESS_HEADER)).toBeNull()
})

it.each(['subFrame', 'script', 'xhr'] as const)('marks the owned same-origin child frame %s request', resourceType => {
  const mainFrame = { origin: 'dsh-app://app', detached: false } as WebContents['mainFrame']
  const childFrame = { origin: 'dsh-app://app', detached: false, parent: mainFrame, top: mainFrame } as WebContents['mainFrame']
  const owner = { id: 7, mainFrame }
  const headers = appRequestHeaders({ url: 'dsh-app://app/plugin/studio/', webContentsId: owner.id,
    webContents: owner as WebContents, frame: childFrame, resourceType,
    requestHeaders: { [NATIVE_ACCESS_HEADER]: 'caller', accept: 'text/html' } }, owner, NATIVE_TOKEN)
  expect(headers).toEqual({ accept: 'text/html', [NATIVE_ACCESS_HEADER]: NATIVE_TOKEN })
})

it.each(['null', 'https://other.example', 'dsh-app://shell', 'dsh-app://app.evil', 'dsh-app://app:1234'])(
  'does not trust main-frame origin %s', origin => {
    const frame = { origin, detached: false } as WebContents['mainFrame']
    const owner = { id: 7, mainFrame: frame }
    const headers = appRequestHeaders({ url: 'dsh-app://app/api/community-market/sources', webContentsId: owner.id,
      frame, resourceType: 'xhr', requestHeaders: { [NATIVE_ACCESS_HEADER]: NATIVE_TOKEN, origin: 'dsh-app://app' } }, owner, NATIVE_TOKEN)
    expect(new Headers(headers).get(NATIVE_ACCESS_HEADER)).toBeNull()
  },
)
