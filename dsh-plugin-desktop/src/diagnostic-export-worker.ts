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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import AdmZip from 'adm-zip'
import {
  DESKTOP_LIFECYCLE_EVIDENCE_ENTRY,
  DESKTOP_LIFECYCLE_SUMMARY_ENTRY,
  summarizeDesktopLifecycleEvidence,
} from './lifecycle-events.ts'
import { isDesktopLogFileName } from './log-files.ts'

const DIAGNOSTIC_ARCHIVE = /^diagnostics-\d+(?:-[0-9a-f-]+)?\.zip$/u
const MAX_DIAGNOSTIC_ARCHIVES = 3
const SKIPPABLE_FILE_ERRORS = new Set(['EACCES', 'EBUSY', 'ELOOP', 'ENOENT', 'ENOTDIR', 'EPERM'])

interface DiagnosticExportWorkerData {
  readonly logsDir: string
  readonly userDataDir: string
  readonly appVersion: string
  readonly maxEvidenceBytes: number
  readonly crashDumpsDir?: string
  readonly runStatePath?: string
  readonly lifecycleEvidencePath?: string
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

function regularEvidenceEntry(path: string, name: string, ownerDir: string): LogEntry | undefined {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink() || !stats.isFile() || hasLinkedParent(path, ownerDir)) return undefined
    return { name, path, stats }
  } catch (cause) {
    if (skippableFileError(cause)) return undefined
    throw cause
  }
}

function hasLinkedParent(path: string, ownerDir: string): boolean {
  const owner = resolve(ownerDir)
  let current = dirname(resolve(path))
  const relativeParent = relative(owner, current)
  if (relativeParent === '..' || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) return true
  while (true) {
    const stats = lstatSync(current)
    if (stats.isSymbolicLink()) return true
    if (relative(owner, current) === '') return false
    const parent = dirname(current)
    if (parent === current) return true
    current = parent
  }
}

function crashDumpEntries(crashDumpsDir: string | undefined): LogEntry[] {
  if (crashDumpsDir === undefined) return []
  let rootStats: Stats
  try {
    rootStats = lstatSync(crashDumpsDir)
  } catch (cause) {
    if (skippableFileError(cause)) return []
    throw cause
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('dsh-plugin-desktop: refusing linked crash dump directory')
  }
  const entries: LogEntry[] = []
  const pending = [{ path: crashDumpsDir, relativePath: '' }]
  while (pending.length > 0) {
    const directory = pending.pop()!
    let names: string[]
    try {
      names = readdirSync(directory.path)
    } catch (cause) {
      if (skippableFileError(cause)) continue
      throw cause
    }
    for (const name of names) {
      const path = join(directory.path, name)
      const relativePath = directory.relativePath === '' ? name : `${directory.relativePath}/${name}`
      try {
        const stats = lstatSync(path)
        if (stats.isSymbolicLink()) continue
        if (stats.isDirectory()) {
          pending.push({ path, relativePath })
        } else if (stats.isFile() && name.toLowerCase().endsWith('.dmp')) {
          entries.push({ name: `crash-dumps/${relativePath}`, path, stats })
        }
      } catch (cause) {
        if (!skippableFileError(cause)) throw cause
      }
    }
  }
  return entries
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
  const crashCandidates = crashDumpEntries(data.crashDumpsDir)
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs || b.name.localeCompare(a.name, 'en'))
  const runStateCandidate = data.runStatePath === undefined
    ? undefined
    : regularEvidenceEntry(data.runStatePath, 'crash-evidence/active-run.json', data.userDataDir)
  const lifecycleCandidate = data.lifecycleEvidencePath === undefined
    ? undefined
    : regularEvidenceEntry(data.lifecycleEvidencePath, DESKTOP_LIFECYCLE_EVIDENCE_ENTRY, data.userDataDir)
  const zip = new AdmZip()
  let includedBytes = 0
  let omittedFiles = 0
  let includedCrashDumps = 0
  let omittedCrashDumps = 0
  let includedActiveRunMarker = false
  let omittedActiveRunMarker = false
  let includedLifecycleEvidence = false
  let omittedLifecycleEvidence = false
  let includedLifecycleSummary = false
  let omittedLifecycleSummary = false
  if (lifecycleCandidate !== undefined) {
    const content = readStableLog(lifecycleCandidate, data.maxEvidenceBytes - includedBytes)
    if (content === undefined) {
      omittedLifecycleEvidence = true
    } else {
      zip.addFile(lifecycleCandidate.name, content)
      includedBytes += content.byteLength
      includedLifecycleEvidence = true
      const summary = summarizeDesktopLifecycleEvidence(content)
      if (summary !== undefined) {
        if (summary.byteLength <= data.maxEvidenceBytes - includedBytes) {
          zip.addFile(DESKTOP_LIFECYCLE_SUMMARY_ENTRY, summary)
          includedBytes += summary.byteLength
          includedLifecycleSummary = true
        } else {
          omittedLifecycleSummary = true
        }
      }
    }
  }
  for (const entry of [...(runStateCandidate === undefined ? [] : [runStateCandidate]), ...crashCandidates, ...candidates]) {
    const content = readStableLog(entry, data.maxEvidenceBytes - includedBytes)
    if (content === undefined) {
      if (entry.name.startsWith('crash-dumps/')) omittedCrashDumps += 1
      else if (entry.name === 'crash-evidence/active-run.json') omittedActiveRunMarker = true
      else omittedFiles += 1
      continue
    }
    zip.addFile(entry.name, content)
    includedBytes += content.byteLength
    if (entry.name.startsWith('crash-dumps/')) includedCrashDumps += 1
    else if (entry.name === 'crash-evidence/active-run.json') includedActiveRunMarker = true
  }
  const info = [
    'app: dsh-plugin-desktop',
    `desktop-version: ${data.appVersion}`,
    `platform: ${process.platform}`,
    `arch: ${process.arch}`,
    `node: ${process.version}`,
    `electron: ${process.versions.electron ?? 'unknown'}`,
    `exported: ${new Date().toISOString()}`,
    `included-log-files: ${String(candidates.length - omittedFiles)}`,
    `included-evidence-bytes: ${String(includedBytes)}`,
    `omitted-log-files: ${String(omittedFiles)}`,
    `included-crash-dumps: ${String(includedCrashDumps)}`,
    `omitted-crash-dumps: ${String(omittedCrashDumps)}`,
    `included-active-run-marker: ${String(includedActiveRunMarker)}`,
    `omitted-active-run-marker: ${String(omittedActiveRunMarker)}`,
    `included-lifecycle-evidence: ${String(includedLifecycleEvidence)}`,
    `omitted-lifecycle-evidence: ${String(omittedLifecycleEvidence)}`,
    `included-lifecycle-summary: ${String(includedLifecycleSummary)}`,
    `omitted-lifecycle-summary: ${String(omittedLifecycleSummary)}`,
    `evidence-byte-limit: ${String(data.maxEvidenceBytes)}`,
    'privacy: logs may contain local paths, workspace IDs, and session IDs; crash dumps may contain process memory; lifecycle evidence contains startup timings and bounded plugin IDs',
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
