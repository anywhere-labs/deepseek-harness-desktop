/** Per-session atomic trash markers shared by Desktop Hosts using one Home. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopTrashedSession } from './session-trash-contract.ts'

interface TrashRecord extends DesktopTrashedSession { readonly version: 1; readonly deleted: boolean }
export class SessionTrashStore {
  readonly directory: string
  private readonly identity: { dev: number; ino: number }
  private readonly rootId: string
  constructor(home: string) {
    if (!isAbsolute(home) || home.includes('\0')) throw new Error('Session trash requires an absolute DSH Home.')
    this.directory = join(home, 'desktop-session-trash')
    const anchor = join(home, 'desktop-session-trash-state.json')
    let anchored = false
    let anchorId: string | undefined
    try {
      const stat = lstatSync(anchor)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) throw new Error('Invalid session trash state anchor.')
      const record = JSON.parse(readFileSync(anchor, 'utf8')) as { version?: unknown; id?: unknown }
      if (record.version !== 1 || typeof record.id !== 'string') throw new Error('Invalid session trash state anchor.')
      anchorId = record.id
      anchored = true
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
    // Once enabled, losing the entire marker directory cannot masquerade as an
    // empty Trash on the next Host launch. Never recreate a missing anchored root.
    if (!anchored) mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const stat = lstatSync(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Session trash must be a real private directory.')
    this.identity = { dev: stat.dev, ino: stat.ino }
    const identityPath = join(this.directory, '.identity')
    if (!anchored) {
      try { writeFileSync(identityPath, randomUUID() + '\n', { flag: 'wx', mode: 0o600 }) }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
    }
    const identityFile = lstatSync(identityPath)
    if (!identityFile.isFile() || identityFile.isSymbolicLink() || identityFile.size !== 37) throw new Error('Invalid session trash directory identity.')
    this.rootId = readFileSync(identityPath, 'utf8').trim()
    if (!/^[a-f0-9-]{36}$/u.test(this.rootId) || (anchored && anchorId !== this.rootId)) throw new Error('Session trash root identity does not match its Home anchor.')
    if (!anchored) {
      try { writeFileSync(anchor, JSON.stringify({ version: 1, id: this.rootId }) + '\n', { flag: 'wx', mode: 0o600 }) }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
    }
  }
  has(id: string): boolean { this.assertDirectory(); return this.readRecord(id)?.deleted === true }
  list(): DesktopTrashedSession[] {
    this.assertDirectory()
    const result: DesktopTrashedSession[] = []
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
      const record = this.readPath(join(this.directory, name))
      if (this.path(record.sessionId) !== join(this.directory, name)) throw new Error('Session trash record identity mismatch.')
      if (record.deleted) result.push({ sessionId: record.sessionId, title: record.title, updatedAt: record.updatedAt })
    }
    return result
  }
  using<T>(id: string, operation: () => Promise<T>): Promise<T> { this.assertDirectory(); return withFileLock(this.path(id), async () => { this.assertDirectory(); return operation() }) }
  async set(id: string, title: string, deleted: boolean, beforeWrite: () => Promise<void> = async () => {}): Promise<void> {
    this.assertDirectory()
    const path = this.path(id)
    await withFileLock(path, async () => {
      this.assertDirectory()
      const prior = this.readRecord(id)
      if ((prior?.deleted ?? false) === deleted) return
      await beforeWrite()
      this.assertDirectory()
      // Read again under the per-id writer lock; stale other-Host state cannot
      // overwrite the title or resurrect another session's marker.
      const record: TrashRecord = { version: 1, sessionId: id, title: deleted ? title : prior?.title ?? title, updatedAt: new Date().toISOString(), deleted }
      await writeFileAtomic(path, JSON.stringify(record) + '\n', { mode: 0o600, dirMode: 0o700 })
    })
  }
  private assertDirectory(): void {
    const stat = lstatSync(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino || readFileSync(join(this.directory, '.identity'), 'utf8').trim() !== this.rootId) throw new Error('Session trash directory is unavailable or was replaced.')
  }
  private path(id: string): string { return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json') }
  private readRecord(id: string): TrashRecord | undefined {
    this.assertDirectory()
    const path = this.path(id)
    let record: TrashRecord
    try { record = this.readPath(path) } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') { this.assertDirectory(); return undefined }
      throw cause
    }
    if (record.sessionId !== id) throw new Error('Session trash record identity mismatch.')
    return record
  }
  private readPath(path: string): TrashRecord {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) throw new Error('Invalid session trash record file.')
    const record: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof record !== 'object' || record === null || Array.isArray(record)
      || !('version' in record) || record.version !== 1 || !('sessionId' in record) || typeof record.sessionId !== 'string'
      || !('title' in record) || typeof record.title !== 'string' || !('updatedAt' in record) || typeof record.updatedAt !== 'string'
      || !('deleted' in record) || typeof record.deleted !== 'boolean') throw new Error('Invalid session trash record.')
    return record as TrashRecord
  }
}
