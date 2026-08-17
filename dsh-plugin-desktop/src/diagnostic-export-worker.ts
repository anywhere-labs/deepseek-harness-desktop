/** Worker-owned diagnostic archive construction and retention. */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  type Stats,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import AdmZip from 'adm-zip'
import { isDesktopLogFileName } from './log-files.ts'

const DIAGNOSTIC_ARCHIVE = /^diagnostics-\d+(?:-[0-9a-f-]+)?\.zip$/u
const MAX_DIAGNOSTIC_ARCHIVES = 3
const SKIPPABLE_FILE_ERRORS = new Set(['EACCES', 'EBUSY', 'ELOOP', 'ENOENT', 'ENOTDIR', 'EPERM'])

interface DiagnosticExportWorkerData {
  readonly logsDir: string
  readonly userDataDir: string
  readonly maxLogBytes: number
}

export type DiagnosticExportWorkerResult =
  | { readonly ok: true, readonly path: string }
  | { readonly ok: false, readonly error: string }

interface LogEntry {
  readonly name: string
  readonly path: string
  readonly stats: Stats
}

function skippableFileError(cause: unknown): boolean {
  return cause instanceof Error
    && 'code' in cause
    && typeof cause.code === 'string'
    && SKIPPABLE_FILE_ERRORS.has(cause.code)
}

function regularLogEntry(logsDir: string, name: string): LogEntry | undefined {
  if (!isDesktopLogFileName(name)) return undefined
  const path = join(logsDir, name)
  try {
    const stats = lstatSync(path)
    return !stats.isSymbolicLink() && stats.isFile() ? { name, path, stats } : undefined
  } catch (cause) {
    if (skippableFileError(cause)) return undefined
    throw cause
  }
}

function readStableLog(entry: LogEntry, remainingBytes: number): Buffer | undefined {
  if (entry.stats.size > remainingBytes) return undefined
  let descriptor: number | undefined
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
    descriptor = openSync(entry.path, constants.O_RDONLY | noFollow)
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== entry.stats.dev || opened.ino !== entry.stats.ino) return undefined
    if (opened.size > remainingBytes) return undefined
    const data = readFileSync(descriptor)
    return data.byteLength <= remainingBytes ? data : undefined
  } catch (cause) {
    if (skippableFileError(cause)) return undefined
    throw cause
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function regularArchive(path: string): { path: string, modifiedAt: number } | undefined {
  try {
    const stats = lstatSync(path)
    return !stats.isSymbolicLink() && stats.isFile() ? { path, modifiedAt: stats.mtimeMs } : undefined
  } catch (cause) {
    if (skippableFileError(cause)) return undefined
    throw cause
  }
}

async function createDiagnosticsArchive(data: DiagnosticExportWorkerData): Promise<string> {
  const logsStats = lstatSync(data.logsDir)
  if (logsStats.isSymbolicLink() || !logsStats.isDirectory()) {
    throw new Error('dsh-plugin-desktop: refusing linked log directory')
  }
  const outDir = join(data.userDataDir, 'diagnostics')
  mkdirSync(outDir, { recursive: true })
  const outputStats = lstatSync(outDir)
  if (outputStats.isSymbolicLink() || !outputStats.isDirectory()) {
    throw new Error('dsh-plugin-desktop: refusing linked diagnostics directory')
  }

  const candidates = readdirSync(data.logsDir)
    .flatMap(name => regularLogEntry(data.logsDir, name) ?? [])
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs || b.name.localeCompare(a.name, 'en'))
  const zip = new AdmZip()
  let includedBytes = 0
  let omittedFiles = 0
  for (const entry of candidates) {
    const content = readStableLog(entry, data.maxLogBytes - includedBytes)
    if (content === undefined) {
      omittedFiles += 1
      continue
    }
    zip.addFile(entry.name, content)
    includedBytes += content.byteLength
  }
  const info = [
    'app: dsh-plugin-desktop',
    `platform: ${process.platform}`,
    `arch: ${process.arch}`,
    `node: ${process.version}`,
    `electron: ${process.versions.electron ?? 'unknown'}`,
    `exported: ${new Date().toISOString()}`,
    `included-log-files: ${String(candidates.length - omittedFiles)}`,
    `included-log-bytes: ${String(includedBytes)}`,
    `omitted-log-files: ${String(omittedFiles)}`,
    `log-byte-limit: ${String(data.maxLogBytes)}`,
    'privacy: logs may contain local paths, workspace IDs, and session IDs',
  ].join('\n')
  zip.addFile('system-info.txt', Buffer.from(`${info}\n`, 'utf8'))

  const outPath = join(outDir, `diagnostics-${Date.now()}-${randomUUID()}.zip`)
  const temporaryPath = `${outPath}.tmp`
  try {
    await zip.writeZipPromise(temporaryPath)
    renameSync(temporaryPath, outPath)
  } catch (cause) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The write may have failed before creating its temporary archive.
    }
    throw cause
  }

  const archives = readdirSync(outDir)
    .flatMap((name) => {
      if (!DIAGNOSTIC_ARCHIVE.test(name)) return []
      return regularArchive(join(outDir, name)) ?? []
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt || b.path.localeCompare(a.path, 'en'))
  for (const archive of archives.slice(MAX_DIAGNOSTIC_ARCHIVES)) {
    try {
      unlinkSync(archive.path)
    } catch {
      // A file manager or support upload may temporarily hold an older archive.
    }
  }
  return outPath
}

if (!isMainThread) {
  void createDiagnosticsArchive(workerData as DiagnosticExportWorkerData).then(
    path => { parentPort?.postMessage({ ok: true, path } satisfies DiagnosticExportWorkerResult) },
    (cause: unknown) => {
      const error = cause instanceof Error ? cause.message : String(cause)
      parentPort?.postMessage({ ok: false, error } satisfies DiagnosticExportWorkerResult)
    },
  )
}
