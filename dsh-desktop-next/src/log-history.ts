/** Private JSONL history, bounded by size and age; only owned regular files are touched. */
import { appendFileSync, closeSync, lstatSync, openSync, readdirSync, readSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { privateDirectory } from './private-files.ts'

export const HISTORY_NAME = /^desktop-next-\d{4}-\d{2}-\d{2}\.\d+\.jsonl$/u
export interface LogHistoryOptions { maxFileBytes: number; maxDirectoryBytes: number; retentionDays: number }
export const DEFAULT_LOG_HISTORY: LogHistoryOptions = { maxFileBytes: 10 * 1024 * 1024, maxDirectoryBytes: 200 * 1024 * 1024, retentionDays: 7 }
export function historyFiles(directory: string) {
  return readdirSync(directory).filter(name => HISTORY_NAME.test(name)).flatMap(name => {
    const file = join(directory, name)
    const stat = lstatSync(file, { throwIfNoEntry: false })
    return stat?.isFile() && !stat.isSymbolicLink() ? [{ name, file, bytes: stat.size, modified: stat.mtimeMs }] : []
  }).sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name, undefined, { numeric: true }))
}
export class LogHistory {
  constructor(readonly directory: string, readonly options: LogHistoryOptions = DEFAULT_LOG_HISTORY) {
    if (options.maxFileBytes < 1024 || options.maxDirectoryBytes < options.maxFileBytes || options.retentionDays < 1) throw new Error('Invalid log history limits')
    privateDirectory(directory)
    this.prune()
  }
  append(lines: readonly string[]): void {
    privateDirectory(this.directory)
    const date = new Date().toISOString().slice(0, 10)
    const entries = historyFiles(this.directory).filter(file => file.name.startsWith(`desktop-next-${date}.`))
    let segment = entries.reduce((maximum, entry) => Math.max(maximum, Number(entry.name.split('.').at(-2))), 0)
    let file = join(this.directory, `desktop-next-${date}.${segment}.jsonl`)
    let stat = lstatSync(file, { throwIfNoEntry: false })
    // Skip unowned links and finish any torn last record left by an abrupt process exit.
    while (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      file = join(this.directory, `desktop-next-${date}.${++segment}.jsonl`)
      stat = lstatSync(file, { throwIfNoEntry: false })
    }
    let bytes = stat?.size ?? 0
    if (bytes && bytes <= this.options.maxFileBytes) {
      const descriptor = openSync(file, 'r')
      const tail = Buffer.alloc(1)
      try { readSync(descriptor, tail, 0, 1, bytes - 1) } finally { closeSync(descriptor) }
      if (tail[0] !== 10) { appendFileSync(file, '\n'); bytes++ }
    }
    for (const line of lines) {
      const size = Buffer.byteLength(line) + 1
      if (size > this.options.maxFileBytes) continue
      if (bytes + size > this.options.maxFileBytes) {
        do {
          file = join(this.directory, `desktop-next-${date}.${++segment}.jsonl`)
          stat = lstatSync(file, { throwIfNoEntry: false })
        } while (stat)
        bytes = 0
      }
      if (!bytes && !lstatSync(file, { throwIfNoEntry: false })) writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
      appendFileSync(file, `${line}\n`)
      bytes += size
    }
    this.prune()
  }
  private prune(): void {
    const files = historyFiles(this.directory)
    let total = files.reduce((sum, file) => sum + file.bytes, 0)
    const cutoff = Date.now() - this.options.retentionDays * 86_400_000
    for (const file of files) {
      if (file.modified >= cutoff && total <= this.options.maxDirectoryBytes) continue
      try { unlinkSync(file.file); total -= file.bytes } catch { /* Locked files are retried on the next flush. */ }
    }
  }
}
