import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, Session } from 'electron'
import { appDownloadRoute, downloadFilename, installAppDownloads } from '../src/app-downloads.ts'
import { NATIVE_ACCESS_HEADER } from '../src/desktop-contract.ts'
import { forwardWebRequest } from '../src/web-document.ts'

const fixture = vi.hoisted(() => ({ save: vi.fn(), message: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showSaveDialog: fixture.save, showMessageBox: fixture.message } }))

const ROUTE = 'dsh-app://app/api/session.export?sessionId=s1'
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-next-download-'))
  fixture.save.mockReset().mockImplementation(async (_owner: unknown, options: { defaultPath: string }) => ({ canceled: false, filePath: options.defaultPath }))
  fixture.message.mockReset().mockResolvedValue({ response: 0 })
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

function setup(forward: (url: string) => Promise<Response>) {
  let listener!: (event: { preventDefault(): void }, item: { getURL(): string, getFilename(): string }, contents: unknown) => void
  const contents = { getURL: () => 'dsh-app://app/', isDestroyed: () => false }
  const owner = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow
  const warn = vi.fn()
  const forwarded = vi.fn(forward)
  installAppDownloads({ on: (_name: string, handler: typeof listener) => { listener = handler } } as unknown as Pick<Session, 'on'>, {
    window: () => owner, forward: forwarded, downloads: () => directory, language: () => 'zh-CN', warn,
  })
  const download = (url: string, from: unknown = contents, filename = 'dsh-session-s1.zip') => {
    const event = { preventDefault: vi.fn() }
    listener(event, { getURL: () => url, getFilename: () => filename }, from)
    return event
  }
  return { download, owner, contents, warn, forwarded }
}

const zip = (body = 'PK-archive', disposition = 'attachment; filename="dsh-session-s1.zip"') =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/zip', 'content-disposition': disposition } })

it('recognizes only application Host routes', () => {
  expect(appDownloadRoute(ROUTE)).toBe(true)
  expect(appDownloadRoute('dsh-app://app/assets/index.js')).toBe(false)
  expect(appDownloadRoute('dsh-app://shell/api/x')).toBe(false)
  expect(appDownloadRoute('dsh-app://user:pass@app/api/x')).toBe(false)
  expect(appDownloadRoute('https://example.com/api/x')).toBe(false)
  expect(appDownloadRoute('blob:dsh-app://app/1234')).toBe(false)
  expect(appDownloadRoute('not a url')).toBe(false)
})

it('leaves ordinary downloads to Chromium', () => {
  const { download, forwarded } = setup(async () => zip())
  const event = download('blob:dsh-app://app/1234')
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(forwarded).not.toHaveBeenCalled()
})

it('replaces the unauthenticated item and saves the authenticated Host response', async () => {
  const { download, owner, forwarded } = setup(async () => zip())
  const event = download(ROUTE)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(existsSync(join(directory, 'dsh-session-s1.zip'))).toBe(true))
  await vi.waitFor(() => expect(readFileSync(join(directory, 'dsh-session-s1.zip'), 'utf8')).toBe('PK-archive'))
  expect(forwarded).toHaveBeenCalledWith(ROUTE)
  expect(fixture.save).toHaveBeenCalledWith(owner, { defaultPath: join(directory, 'dsh-session-s1.zip') })
  expect(fixture.message).not.toHaveBeenCalled()
})

it('drops application downloads started outside the main window', () => {
  const { download, warn, forwarded } = setup(async () => zip())
  const event = download(ROUTE, { getURL: () => 'dsh-app://app/', isDestroyed: () => false })
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(forwarded).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledOnce()
})

it('reports Host failures instead of failing silently', async () => {
  const { download, owner, warn } = setup(async () => new Response(null, { status: 403 }))
  download(ROUTE)
  await vi.waitFor(() => expect(fixture.message).toHaveBeenCalledOnce())
  expect(fixture.message).toHaveBeenCalledWith(owner, expect.objectContaining({ type: 'error', message: '下载失败', detail: 'Host responded with HTTP 403' }))
  expect(fixture.save).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledOnce()
})

it('carries the Host explanation into the failure prompt', async () => {
  const { download } = setup(async () => new Response('session not found\n', { status: 404 }))
  download(ROUTE)
  await vi.waitFor(() => expect(fixture.message).toHaveBeenCalledOnce())
  expect(fixture.message.mock.calls[0]![1].detail).toBe('Host responded with HTTP 404: session not found')
})

it('cancels the Host stream when the save dialog is dismissed', async () => {
  const cancel = vi.fn()
  const body = new ReadableStream({ pull() {}, cancel })
  fixture.save.mockResolvedValue({ canceled: true, filePath: '' })
  const { download } = setup(async () => new Response(body, { status: 200 }))
  download(ROUTE)
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  expect(fixture.message).not.toHaveBeenCalled()
})

it('removes a partial file when the stream fails', async () => {
  let sent = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('partial')); return }
      controller.error(new Error('Host stream closed'))
    },
  })
  const { download } = setup(async () => new Response(body, { status: 200 }))
  download(ROUTE)
  await vi.waitFor(() => expect(fixture.message).toHaveBeenCalledOnce())
  expect(fixture.message.mock.calls[0]![1].detail).toBe('Host stream closed')
  expect(existsSync(join(directory, 'dsh-session-s1.zip'))).toBe(false)
})

it('reports a missing save directory as a failure', async () => {
  const target = join(directory, 'missing', 'out.zip')
  fixture.save.mockResolvedValue({ canceled: false, filePath: target })
  const { download } = setup(async () => zip())
  download(ROUTE)
  await vi.waitFor(() => expect(fixture.message).toHaveBeenCalledOnce())
  expect(existsSync(target)).toBe(false)
})

it('names files from the Host disposition, then the Chromium suggestion', () => {
  expect(downloadFilename('attachment; filename="dsh-session-s1.zip"', 'x')).toBe('dsh-session-s1.zip')
  expect(downloadFilename('attachment; filename=plain.zip', 'x')).toBe('plain.zip')
  expect(downloadFilename(`attachment; filename="ascii.zip"; filename*=UTF-8''%E4%BC%9A%E8%AF%9D.zip`, 'x')).toBe('会话.zip')
  expect(downloadFilename(`attachment; filename*=UTF-8''%E0%A4%A; filename="fallback.zip"`, 'x')).toBe('fallback.zip')
  expect(downloadFilename('attachment; filename="..\\..\\evil.zip"', 'x')).toBe('evil.zip')
  expect(downloadFilename('attachment; filename="../../etc/passwd"', 'x')).toBe('passwd')
  expect(downloadFilename('attachment; filename=".."', 'suggested.zip')).toBe('suggested.zip')
  expect(downloadFilename(null, 'dsh-session-s1.zip')).toBe('dsh-session-s1.zip')
  expect(downloadFilename(null, '')).toBe('download')
})

it('satisfies the protocol gate with the main-process marker', async () => {
  const seen: Array<string | undefined> = []
  const server: Server = createServer((request, response) => {
    seen.push(request.headers[NATIVE_ACCESS_HEADER] as string | undefined, request.headers.cookie, request.url)
    response.writeHead(200, { 'content-disposition': 'attachment; filename="dsh-session-s1.zip"' }).end('PK')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    const unmarked = await forwardWebRequest(new Request(ROUTE), host, 'dsh=1', 'token')
    expect(unmarked.status).toBe(403)
    const marked = await forwardWebRequest(new Request(ROUTE, { headers: { [NATIVE_ACCESS_HEADER]: 'token' } }), host, 'dsh=1', 'token')
    expect(marked.status).toBe(200)
    expect(await marked.text()).toBe('PK')
    expect(seen).toEqual(['token', 'dsh=1', '/api/session.export?sessionId=s1'])
  } finally { server.close() }
})
