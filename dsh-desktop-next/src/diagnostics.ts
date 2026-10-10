/** Recent readable diagnostics plus private structured history. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { atomicJson, atomicText, readPrivateFile } from './private-files.ts'
import { maskSecrets } from './mask-secrets.ts'
import { LogHistory, type LogHistoryOptions } from './log-history.ts'
import { HOST_LOG_PREFIX, LOG_LEVELS, isLogInput, sanitize, type LogInput, type LogRecord } from './log-record.ts'
import type { DesktopPreferences, DesktopState } from './desktop-contract.ts'

const LIMIT = 128 * 1024
const MAX_PENDING = 1024 * 1024
export class DesktopDiagnostics {
  readonly file: string
  readonly runId = randomUUID()
  private readonly marker: string
  private history: LogHistory | undefined
  private text = ''
  private partial = new Map<string, { text: string; dropping: boolean; pid?: number }>()
  private pending: string[] = []
  private pendingBytes = 0
  private sequence = 0
  private storageError: string | undefined
  private droppedRecords = 0
  private active = new Map<string, { source: string; event: string; started: number }>()
  private timer: ReturnType<typeof setTimeout> | undefined
  level: DesktopPreferences['logLevel'] = 'info'
  developer = false
  constructor(home: string, options?: LogHistoryOptions) {
    const directory = join(home, 'logs')
    this.file = join(directory, 'desktop-next.log')
    this.marker = join(directory, 'active-run.json')
    try { this.text = readPrivateFile(this.file, LIMIT * 4)?.slice(-LIMIT) ?? '' } catch { /* Logging cannot prevent recovery. */ }
    try { this.history = new LogHistory(directory, options) } catch { /* Retain the recent log when history is unavailable. */ }
  }
  /** Called only by the single-instance owner, after preferences are loaded. */
  begin(fields: LogInput['fields']): void {
    try {
      const previous = readPrivateFile(this.marker)
      if (previous) {
        const run = JSON.parse(previous) as { runId?: unknown; clean?: unknown; started?: unknown }
        if (run.clean !== true) this.record({ source: 'electron', event: 'run.previous-unclean', level: 'warn',
          fields: { previousRunId: typeof run.runId === 'string' ? run.runId : 'unknown', previousStarted: typeof run.started === 'string' ? run.started : 'unknown' } })
      }
      atomicJson(this.marker, { runId: this.runId, pid: process.pid, started: new Date().toISOString(), clean: false })
    } catch (error) { this.record({ source: 'logging', event: 'run.marker-failed', level: 'warn', error }) }
    this.record({ source: 'electron', event: 'run.start', fields })
    this.flush()
  }
  end(clean: boolean): void {
    this.record({ source: 'electron', event: clean ? 'run.end' : 'run.forced-exit', level: clean ? 'info' : 'error', fields: { pendingOperations: this.active.size } })
    this.flush()
    try { atomicJson(this.marker, { runId: this.runId, pid: process.pid, ended: new Date().toISOString(), clean }) } catch { /* Best effort. */ }
  }
  record(input: LogInput): void {
    const level = input.level ?? 'info'
    // Basic lifecycle evidence is never disabled by a verbosity setting.
    if (input.developer && (!this.developer || LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.level))) return
    if (input.operationId) {
      if (input.event.endsWith('.start')) this.active.set(input.operationId, { source: input.source, event: input.event.slice(0, -6), started: Date.now() })
      else if (/\.(complete|failed)$/u.test(input.event)) this.active.delete(input.operationId)
    }
    if (this.active.size > 4096) { this.active.delete(this.active.keys().next().value!); this.droppedRecords++ }
    const record = sanitize({ time: new Date().toISOString(), runId: this.runId, sequence: ++this.sequence,
      pid: input.pid ?? process.pid, source: input.source, event: input.event, level,
      message: input.message ?? '', developer: input.developer ?? false, operationId: input.operationId,
      fields: input.fields, error: input.error }) as LogRecord
    const line = JSON.stringify(record)
    this.pending.push(line); this.pendingBytes += Buffer.byteLength(line) + 1
    const detail = record.error === undefined ? '' : ` ${JSON.stringify(record.error)}`
    this.text = (this.text + `${record.time} [${level}] ${record.message ? record.message + ' ' : ''}[${record.source}] ${record.event}${record.operationId ? ` (${record.operationId})` : ''}${record.fields ? ` ${JSON.stringify(record.fields)}` : ''}${detail}\n`).slice(-LIMIT)
    if (level === 'error' || this.pendingBytes >= MAX_PENDING) this.flush()
    else { this.timer ??= setTimeout(() => this.flush(), 200); this.timer.unref() }
  }
  append(message: string, level: DesktopPreferences['logLevel'] = 'info'): void {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.level)) return
    this.record({ source: 'desktop', event: 'message', message, level, developer: level === 'debug' })
  }
  operation(source: string, event: string, fields?: LogInput['fields'], developer = false): (error?: unknown) => void {
    const operationId = randomUUID()
    const started = Date.now()
    this.active.set(operationId, { source, event, started })
    this.record({ source, event: `${event}.start`, fields, operationId, developer })
    let finished = false
    return (error?: unknown) => {
      if (finished) return
      finished = true; this.active.delete(operationId)
      this.record({ source, event: `${event}.${error === undefined ? 'complete' : 'failed'}`, operationId,
        fields: { ...fields, durationMs: Date.now() - started }, developer: error === undefined && developer,
        level: error === undefined ? 'info' : 'error', error })
    }
  }
  pendingOperations(): LogInput['fields'][] {
    return [...this.active].map(([operationId, operation]) => ({ operationId, source: operation.source, event: operation.event, durationMs: Date.now() - operation.started }))
  }
  /** Independent buffers prevent stdout/stderr fragments from being joined together. */
  hostChunk(chunk: string, stream = 'stdout', pid?: number): void {
    const key = `${pid ?? 0}:${stream}`
    const buffer = this.partial.get(key) ?? { text: '', dropping: false, pid }
    for (const part of chunk.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
      const complete = part.endsWith('\n')
      if (!buffer.dropping) {
        if (buffer.text.length + part.length > LIMIT) {
          buffer.text = ''; buffer.dropping = true
          this.record({ source: `host.${stream}`, event: 'line.omitted', level: 'warn', pid, message: 'Oversized process output line omitted' })
        } else buffer.text += part
      }
      if (complete) {
        if (!buffer.dropping) this.hostLine(buffer.text.replace(/\r?\n$/u, ''), stream, pid)
        buffer.text = ''; buffer.dropping = false
      }
    }
    this.partial.set(key, buffer)
  }
  hostClosed(pid?: number): void {
    for (const [key, buffer] of this.partial) {
      if (buffer.pid !== pid) continue
      if (buffer.text) this.hostLine(buffer.text, key.slice(key.indexOf(':') + 1), pid)
      this.partial.delete(key)
    }
    this.flush()
  }
  private hostLine(line: string, stream: string, pid?: number): void {
    if (line.startsWith(HOST_LOG_PREFIX)) {
      try {
        const input: unknown = JSON.parse(line.slice(HOST_LOG_PREFIX.length))
        if (isLogInput(input)) { this.record({ ...input, pid }); return }
      } catch { /* Malformed framing remains a plain process-output diagnostic. */ }
    }
    const level = /\b(error|fatal)\b/iu.test(line) ? 'error' : /\bwarn/iu.test(line) ? 'warn' : /\bdebug\b/iu.test(line) ? 'debug' : 'info'
    if (LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(this.level)) this.record({ source: `host.${stream}`, event: 'output', level, message: line, pid, developer: level === 'debug' })
  }
  snapshot(): string { return maskSecrets(this.text + [...this.partial.values()].filter(buffer => buffer.text).map(buffer => `\n${buffer.text}`).join('')).slice(-LIMIT) }
  flush(): void {
    clearTimeout(this.timer); this.timer = undefined
    try {
      if (this.pending.length) {
        this.history ??= new LogHistory(join(this.file, '..'))
        this.history.append(this.pending)
        this.pending = []; this.pendingBytes = 0
      }
      atomicText(this.file, this.snapshot())
      this.storageError = undefined
    } catch (error) {
      this.storageError = maskSecrets(String(error)).slice(0, 2048)
      // Bound memory even when disk remains full; never recurse through console logging.
      while (this.pendingBytes > MAX_PENDING && this.pending.length) { this.pendingBytes -= Buffer.byteLength(this.pending.shift()!) + 1; this.droppedRecords++ }
    }
  }
  export(state: DesktopState): string {
    return JSON.stringify({ format: 'dsh-desktop-next-diagnostics', version: 2, created: new Date().toISOString(), runId: this.runId,
      application: { version: state.version, platform: state.platform, versions: process.versions },
      runtime: sanitize({ profile: state.selected, profiles: state.profiles, phase: state.phase, safeMode: state.safeMode,
        failure: state.failure, features: state.features, preferences: state.preferences,
        trayAvailable: state.trayAvailable, browserUrl: state.browserUrl, lan: state.lan }),
      logging: { storageError: this.storageError ?? null, droppedRecords: this.droppedRecords }, pendingOperations: this.pendingOperations(), log: this.snapshot() }, null, 2) + '\n'
  }
  /** Export history off the Electron main thread; terminate stalled workers. */
  exportTo(file: string, state: DesktopState): Promise<void> {
    this.flush()
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
    const worker = new Worker(new URL(`./diagnostics-export.${extension}`, import.meta.url), {
      workerData: { kind: 'dsh-next-diagnostics-export', directory: join(this.file, '..'), file, summary: this.export(state) },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    })
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true; clearTimeout(timer)
        void worker.terminate().catch(() => {})
        if (error === undefined) resolve(); else reject(error)
      }
      const timer = setTimeout(() => finish(new Error('Diagnostic export exceeded 60 seconds')), 60_000)
      worker.once('message', result => finish(result.ok ? undefined : new Error(result.error)))
      worker.once('error', finish)
      worker.once('exit', code => finish(new Error(`Diagnostic export worker exited before completion (${code})`)))
    })
  }
}
