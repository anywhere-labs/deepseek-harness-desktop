import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NextUpdates, type NextUpdateOptions } from '../src/updates.ts'
import { artifactRequest } from '../src/update-transport.ts'
import { serveMacUpdate } from '../src/mac-update-feed.ts'
import { updateAction, updateLabel } from '../src/update-state.ts'
import type { UpdateRequest } from '../../dsh-plugin-desktop-beta/src/update-checker.ts'

const roots: string[] = []
const owners: NextUpdates[] = []
afterEach(async () => { for (const owner of owners.splice(0)) await owner.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.useRealTimers() })
async function fixture(overrides: Partial<NextUpdateOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'next-updates-test-')); roots.push(home)
  const artifact = Buffer.alloc(1024); artifact.write('koly', 512)
  const request = vi.fn<UpdateRequest>(async url => url.includes('/version')
    ? Response.json({ version: '2.0.17-next.1', channel: 'next' }) : new Response(artifact, { headers: { 'content-length': '1024' } }))
  const options: NextUpdateOptions = { userData: home, version: '2.0.14-next', platform: 'darwin', packaged: true,
    request, prepare: vi.fn(async path => { expect(await readFile(path)).toEqual(artifact) }), install: vi.fn(async () => {}),
    changed: vi.fn(), log: vi.fn(), ...overrides }
  const updates = new NextUpdates(options); owners.push(updates)
  return { updates, options, request }
}

it('checks without downloading; download completion waits for an explicit installation', async () => {
  const { updates, options, request } = await fixture()
  await updates.check()
  expect(updates.snapshot().phase).toBe('available')
  expect(request).toHaveBeenCalledTimes(1)
  await Promise.all([updates.download(), updates.download()])
  expect(updates.snapshot()).toMatchObject({ phase: 'ready', received: 1024, total: 1024 })
  expect(options.prepare).toHaveBeenCalledOnce()
  expect(options.install).not.toHaveBeenCalled()
  await updates.install()
  expect(options.install).toHaveBeenCalledOnce()
  expect(updates.snapshot().phase).toBe('installing')
})
it('does not confuse an unpublished channel, invalid response or network failure with up to date', async () => {
  for (const response of [new Response('', { status: 400 }), new Response('', { status: 503 }), Response.json({ version: '2.0.17', channel: 'stable' })]) {
    const { updates } = await fixture({ request: async () => response })
    await updates.check()
    expect(updates.snapshot()).toMatchObject({ phase: 'error', error: 'service' })
  }
})
it('allows checks in development, but never downloads or replaces the development application', async () => {
  const { updates, options, request } = await fixture({ packaged: false })
  await updates.check(); await updates.download()
  expect(updates.snapshot()).toMatchObject({ installable: false, error: 'development' })
  expect(request).toHaveBeenCalledOnce(); expect(options.prepare).not.toHaveBeenCalled()
})
it('rechecks the selected version before downloading, and preserves preparation failures for retry', async () => {
  const { updates, options } = await fixture({ prepare: async () => { throw new Error('Signature mismatch') } })
  await updates.download()
  expect(updates.snapshot()).toMatchObject({ phase: 'error', error: 'prepare' })
  await updates.install(); expect(options.install).not.toHaveBeenCalled()
  expect(updateAction(updates.snapshot())).toBe('download-update')
})
it('stops polling and aborts an active request on shutdown', async () => {
  const request = vi.fn<UpdateRequest>(async (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })))
  const { updates } = await fixture({ request, packaged: false })
  const check = updates.check()
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
  await updates.dispose(); await check
  expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
})
it('shows progress and an actionable downloaded state in both languages', () => {
  expect(updateLabel({ phase: 'downloading', installable: true, received: 25, total: 100 }, 'zh-CN')).toContain('25%')
  expect(updateLabel({ phase: 'downloading', installable: true, received: 2 * 1048576 }, 'en')).toContain('2 MB')
  expect(updateAction({ phase: 'preparing', installable: true })).toBeUndefined()
  expect(updateAction({ phase: 'ready', installable: true })).toBe('install-update')
})
it('follows the ModelScope CDN redirect and drops release headers before contacting artifact storage', async () => {
  const mirror = 'https://modelscope.cn/models/t4wefan/deepseek-harness-desktop/resolve/master/next.dmg'
  const cdn = 'https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/next.dmg?signature=test'
  const request = vi.fn<UpdateRequest>()
  request.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: mirror } }))
  request.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: cdn } }))
  request.mockResolvedValueOnce(new Response('artifact'))
  const result = await artifactRequest(request)('https://www.dshdesktop.cn/api/downloads/mac', { headers: { 'X-DSH-Desktop-Channel': 'next' } })
  expect(result.finalUrl).toBe(cdn)
  expect(new Headers(request.mock.calls[1]?.[1]?.headers).get('X-DSH-Desktop-Channel')).toBeNull()
  expect(new Headers(request.mock.calls[2]?.[1]?.headers).get('X-DSH-Desktop-Channel')).toBeNull()
  expect(request.mock.calls[2]?.[1]?.credentials).toBe('omit')
  request.mockReset().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }))
  await expect(artifactRequest(request)('https://www.dshdesktop.cn/api/downloads/mac', {})).rejects.toThrow()
  expect(request).toHaveBeenCalledOnce()
})
it('downloads a Next installer that settles on an external HTTPS CDN', async () => {
  const cdn = 'https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/next.dmg'
  const artifact = Buffer.alloc(1024); artifact.write('koly', 512)
  const request = vi.fn<UpdateRequest>(async url => url.includes('/version')
    ? Response.json({ version: '2.0.17-next.1', channel: 'next' })
    : url.includes('/api/downloads/')
      ? new Response(null, { status: 302, headers: { location: cdn } })
      : new Response(artifact))
  const { updates, options } = await fixture({ request })
  await updates.download()
  expect(updates.snapshot().phase).toBe('ready')
  expect(options.prepare).toHaveBeenCalledOnce()
  expect(request.mock.calls.at(-1)?.[0]).toBe(cdn)
})
it('serves only the private archive to the native updater and closes its loopback listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-feed-test-')); roots.push(root)
  const path = join(root, 'update.zip'); await writeFile(path, 'test archive')
  const feed = await serveMacUpdate(path, '2.0.17-next.1')
  try {
    const metadata = await (await fetch(feed.url)).json() as { url: string; name: string }
    expect(metadata.name).toBe('2.0.17-next.1')
    expect(await (await fetch(metadata.url)).text()).toBe('test archive')
    expect((await fetch(new URL('/update.zip', feed.url))).status).toBe(404)
    expect((await fetch(feed.url, { method: 'POST' })).status).toBe(404)
  } finally { await feed.close() }
  await expect(fetch(feed.url)).rejects.toThrow()
})
