import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionTrashStore } from '../src/session-trash-store.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

vi.mock('@deepseek-ai/dsh-atomic-write', async importOriginal => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})
const homes: string[] = []
afterEach(async () => { vi.mocked(writeFileAtomic).mockClear(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }) })
async function setup() { const home = await mkdtemp(join(tmpdir(), 'desktop-trash-')); homes.push(home); return { home, store: new SessionTrashStore(home) } }

describe('persistent logical session deletion', () => {
  it('is observed by another Host and after reload, independently of other ids', async () => {
    const { home, store } = await setup(); const other = new SessionTrashStore(home)
    await store.set('parent', 'Parent', true)
    expect(other.has('parent')).toBe(true)
    await other.set('branch', 'Branch', true)
    expect(store.list().map(item => item.sessionId).sort()).toEqual(['branch', 'parent'])
    await other.set('parent', '', false)
    expect(store.has('parent')).toBe(false)
    expect(new SessionTrashStore(home).has('branch')).toBe(true)
    expect(new SessionTrashStore(home).list()).toHaveLength(1)
  })
  it('observes a marker committed by an independent Host process', async () => {
    const { home, store } = await setup()
    const source = new URL('../src/session-trash-store.ts', import.meta.url).href
    await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      `const { SessionTrashStore } = await import(${JSON.stringify(source)}); await new SessionTrashStore(${JSON.stringify(home)}).set('remote', 'Remote', true);`], { timeout: 10_000 })
    expect(store.has('remote')).toBe(true)
    expect(store.list()).toContainEqual(expect.objectContaining({ sessionId: 'remote', title: 'Remote' }))
  })
  it('serializes competing changes and preserves complete JSON through rename', async () => {
    const { home, store } = await setup(); const other = new SessionTrashStore(home)
    await Promise.all([store.set('one', 'One', true), other.set('two', 'Two', true)])
    expect(store.list()).toHaveLength(2)
    const names = (await readdir(store.directory)).filter(name => name.endsWith('.json'))
    for (const name of names) expect(JSON.parse(await readFile(join(store.directory, name), 'utf8'))).toMatchObject({ version: 1, deleted: true })
    await Promise.all([store.set('one', 'One', true), other.set('one', 'One', true)])
    expect(store.list()).toHaveLength(2)
  })
  it('preserves the committed state if admission/flush or atomic replacement fails', async () => {
    const { store } = await setup()
    await expect(store.set('one', 'One', true, async () => { throw new Error('flush failed') })).rejects.toThrow('flush failed')
    expect(store.has('one')).toBe(false)
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error('rename denied'))
    await expect(store.set('one', 'One', true)).rejects.toThrow('rename denied')
    expect(store.has('one')).toBe(false)
    await store.set('one', 'One', true)
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error('restore denied'))
    await expect(store.set('one', '', false)).rejects.toThrow('restore denied')
    expect(store.has('one')).toBe(true)
  })
  it('fails closed on damaged membership rather than treating it as absence', async () => {
    const { store } = await setup(); await store.set('one', 'One', true)
    const name = (await readdir(store.directory)).find(entry => entry.endsWith('.json'))!
    await writeFile(join(store.directory, name), '{')
    expect(() => store.has('one')).toThrow()
    expect(() => store.list()).toThrow()
  })
  it('fails closed if the marker root is moved, including a new Host launch', async () => {
    const { home, store } = await setup(); await store.set('one', 'One', true)
    await rename(store.directory, store.directory + '-moved')
    expect(() => store.has('one')).toThrow()
    expect(() => store.list()).toThrow()
    await expect(store.set('one', '', false)).rejects.toThrow()
    expect(() => new SessionTrashStore(home)).toThrow()
  })
  it('refuses reads and writes through a replacement symlink', async () => {
    const { store } = await setup(); await store.set('one', 'One', true)
    await rename(store.directory, store.directory + '-moved')
    await symlink(store.directory + '-moved', store.directory, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => store.has('one')).toThrow()
    expect(() => store.list()).toThrow()
    await expect(store.set('one', '', false)).rejects.toThrow()
  })
  it('retains stored session data and original archive metadata byte for byte', async () => {
    const { home, store } = await setup()
    const history = join(home, 'history-fixture.jsonl'); const archive = join(home, 'archive-fixture.json')
    await writeFile(history, '{"id":"parent"}\n{"parentSession":"parent","id":"branch"}\n')
    await writeFile(archive, '{"archivedSessionIds":["parent"]}\n')
    const before = await Promise.all([readFile(history), readFile(archive)])
    await store.set('parent', 'Parent', true); await store.set('parent', '', false)
    expect(await readFile(history)).toEqual(before[0]); expect(await readFile(archive)).toEqual(before[1])
  })
})
