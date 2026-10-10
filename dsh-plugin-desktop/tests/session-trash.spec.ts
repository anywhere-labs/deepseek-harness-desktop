import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { spawn } from 'node:child_process'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DesktopSessionTrash from '../src/session-trash.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<unknown>
vi.mock('@deepseek-ai/dsh-atomic-write', async importOriginal => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})
const disposers: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })
async function mount(supported = true, initialize?: (home: string) => Promise<void>, persistence?: Context['sessionPersistence'], live = true) {
  const home = await mkdtemp(join(tmpdir(), 'desktop-trash-host-'))
  await initialize?.(home)
  const ctx = new Context()
  const flush = vi.fn(async () => {})
  let active = false
  let rejectRequest: number | undefined
  let handler!: Handler
  const controller = {
    desktopSessionTrashSupported: supported,
    list: vi.fn(async () => ({ items: ctx.get('desktopSessionTrash')?.has(SessionId('target')) ? [] : [{ sessionId: SessionId('target') }] })),
  }
  ctx.provide('profileContext', { home } as Context['profileContext'])
  ctx.provide('desktopSessionTrashRequired', true)
  const liveSession = { id: 'target' }
  ctx.provide('sessions', { get: () => live ? liveSession : undefined } as unknown as Context['sessions'])
  ctx.provide('agents', { get: () => live ? ({ session: liveSession }) : undefined } as unknown as Context['agents'])
  ctx.provide('sessionPersistence', persistence ?? { flush } as unknown as Context['sessionPersistence'])
  ctx.provide('workspaceRegistry', {} as Context['workspaceRegistry'])
  ctx.provide('sessionController', controller as unknown as Context['sessionController'])
  ctx.provide('webServer', { port: 12345, register(entry: { handler: Handler }) { handler = entry.handler; return () => {} } } as unknown as Context['webServer'])
  ctx.provide('connection', { requestRejection: () => rejectRequest } as unknown as Context['connection'])
  ctx.on('workspace/session-activity', async (_request, next) => active ? [{ kind: 'turn' }] as never : next())
  const removed = vi.fn(); ctx.on('api-session/removed', removed)
  const fiber = ctx.plugin(DesktopSessionTrash)
  await fiber
  disposers.push(async () => { await fiber.dispose(); await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  async function request(body?: unknown, origin = 'http://127.0.0.1:12345') {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage
    Object.assign(req, { method: body === undefined ? 'GET' : 'POST', headers: { host: '127.0.0.1:12345', origin, 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } })
    let text = ''; const res = { statusCode: 0, setHeader() {}, end(value: string) { text = value } } as unknown as ServerResponse
    await handler(req, res)
    return { status: res.statusCode, value: JSON.parse(text) as Record<string, unknown> }
  }
  return { ctx, fiber, service: ctx.desktopSessionTrash, flush, removed, controller, request, setActive(value: boolean) { active = value }, reject(value: number) { rejectRequest = value } }
}

async function nativeStore(root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'desktop-trash-native-'))
  const ctx = new Context(); await ctx.plugin(JsonlSessionPersistence, { root: directory, compression: 'none' })
  disposers.push(async () => { await ctx.fiber.dispose(); if (root === undefined) await rm(directory, { recursive: true, force: true }) })
  if (root === undefined) {
    const handle = await ctx.sessionPersistence.create({ id: SessionId('target'), version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: directory })
    await handle.flush(); await handle.close()
  }
  return { directory, ctx, persistence: ctx.sessionPersistence }
}

describe('Desktop session trash Host boundary', () => {
  it('commits logical deletion and restores it through the authenticated route', async () => {
    const mounted = await mount()
    expect((await mounted.request({ action: 'delete', sessionId: 'target', title: 'Target' })).status).toBe(200)
    expect(mounted.service.has(SessionId('target'))).toBe(true)
    expect(mounted.removed).toHaveBeenCalledWith(SessionId('target'))
    expect((await mounted.request()).value).toMatchObject({ supported: true, items: [{ sessionId: 'target', title: 'Target' }] })
    expect((await mounted.request({ action: 'restore', sessionId: 'target', title: '' })).status).toBe(200)
    expect(mounted.service.has(SessionId('target'))).toBe(false)
  })
  it('refuses active and unknown sessions without flushing or publishing removal', async () => {
    const mounted = await mount(); mounted.setActive(true)
    expect((await mounted.request({ action: 'delete', sessionId: 'target', title: 'Target' })).status).toBe(409)
    mounted.setActive(false)
    expect((await mounted.request({ action: 'delete', sessionId: 'unknown', title: '' })).status).toBe(409)
    expect(mounted.flush).not.toHaveBeenCalled(); expect(mounted.removed).not.toHaveBeenCalled()
    expect(mounted.service.has(SessionId('target'))).toBe(false)
  })
  it('clears only pending admission on flush failure and retains catalog membership', async () => {
    const mounted = await mount(); mounted.flush.mockRejectedValueOnce(new Error('flush failed'))
    expect((await mounted.request({ action: 'delete', sessionId: 'target', title: 'Target' })).status).toBe(500)
    expect(mounted.service.has(SessionId('target'))).toBe(false)
    expect(mounted.service.blocks(SessionId('target'))).toBe(false)
    expect(mounted.removed).not.toHaveBeenCalled()
  })
  it('rejects cross-origin, unauthenticated and malformed requests before mutation', async () => {
    const mounted = await mount()
    expect((await mounted.request({ action: 'delete', sessionId: 'target', title: '' }, 'http://example.com')).status).toBe(403)
    mounted.reject(401)
    expect((await mounted.request({ action: 'delete', sessionId: 'target', title: '' })).status).toBe(401)
    expect(mounted.flush).not.toHaveBeenCalled(); expect(mounted.service.read().items).toEqual([])
  })
  it('keeps a live fail-closed fence when initial metadata is corrupt', async () => {
    const mounted = await mount(true, async home => {
      const directory = join(home, 'desktop-session-trash'); await mkdir(directory)
      await writeFile(join(directory, createHash('sha256').update('target').digest('hex') + '.json'), '{')
    })
    expect(mounted.ctx.get('desktopSessionTrash')).toBeDefined()
    expect(() => mounted.service.has(SessionId('target'))).toThrow('unavailable')
    expect(() => mounted.service.blocks(SessionId('target'))).toThrow('unavailable')
    expect((await mounted.request()).status).toBe(503)
    expect(mounted.flush).not.toHaveBeenCalled()
  })
  it('keeps a live fail-closed fence when the metadata directory is unusable', async () => {
    const mounted = await mount(true, async home => { await writeFile(join(home, 'desktop-session-trash'), 'not a directory') })
    expect(mounted.ctx.get('desktopSessionTrash')).toBeDefined()
    expect(() => mounted.service.blocks(SessionId('target'))).toThrow('unavailable')
    expect((await mounted.request({ action: 'delete', sessionId: 'target', title: '' })).status).toBe(503)
  })
  it('rejects an independent process holding the real JSONL write lease', async () => {
    const native = await nativeStore()
    const cordisUrl = import.meta.resolve('@deepseek-ai/cordis')
    const jsonlUrl = import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl')
    const script = `const { Context } = await import(${JSON.stringify(cordisUrl)}); const { default: Jsonl } = await import(${JSON.stringify(jsonlUrl)}); const ctx = new Context(); await ctx.plugin(Jsonl, {root:${JSON.stringify(native.directory)},compression:'none'}); const handle = await ctx.sessionPersistence.open('target','write'); process.stdout.write('ready\\n'); process.stdin.once('data', async () => { await handle.close(); await ctx.fiber.dispose(); process.exit(0) });`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
    let errors = ''; child.stderr.on('data', data => { errors += String(data) })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('writer did not become ready: ' + errors)) }, 10_000)
        child.stdout.on('data', data => { if (String(data).includes('ready')) { clearTimeout(timer); resolve() } })
        child.once('exit', code => { clearTimeout(timer); reject(new Error('writer exited ' + String(code) + ': ' + errors)) })
      })
      const mounted = await mount(true, undefined, native.persistence, false)
      const response = await mounted.request({ action: 'delete', sessionId: 'target', title: 'Target' })
      expect(response).toMatchObject({ status: 409, value: { code: 'foreign-owner' } })
      expect(mounted.service.has(SessionId('target'))).toBe(false)
    } finally {
      child.stdin.write('close')
      await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill(); resolve() }, 1000); child.once('exit', () => { clearTimeout(timer); resolve() }) })
    }
  }, 15_000)
  it('holds its ownership probe through the marker commit and releases it afterwards', async () => {
    const native = await nativeStore(); const contender = await nativeStore(native.directory)
    const mounted = await mount(true, undefined, native.persistence, false)
    let entered!: () => void; const writing = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void; const finish = new Promise<void>(resolve => { release = resolve })
    const original = vi.mocked(writeFileAtomic).getMockImplementation()!
    vi.mocked(writeFileAtomic).mockImplementationOnce(async (...args) => { entered(); await finish; await original(...args) })
    const mutation = mounted.request({ action: 'delete', sessionId: 'target', title: 'Target' })
    try {
      await writing
      const ownership = await contender.persistence.open(SessionId('target'), 'write').then(async handle => { await handle.close(); return 'acquired' }, cause => cause instanceof Error ? cause.name : String(cause))
      expect(ownership).toBe('SessionAlreadyOwnedError')
    } finally { release(); await mutation }
    expect(mounted.service.has(SessionId('target'))).toBe(true)
    const available = await contender.persistence.open(SessionId('target'), 'write'); await available.close()
  })
  it('does not mutate metadata when the controller patch is absent', async () => {
    const mounted = await mount(false)
    expect((await mounted.request()).value).toMatchObject({ supported: false })
    expect((await mounted.request({ action: 'delete', sessionId: 'target', title: '' })).status).toBe(503)
    expect(mounted.flush).not.toHaveBeenCalled(); expect(mounted.service.read().items).toEqual([])
  })
})
