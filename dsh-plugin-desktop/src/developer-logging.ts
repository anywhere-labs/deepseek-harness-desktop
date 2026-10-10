/** Process-local metadata tracing; the existing rotating logs and ZIP own persistence. */
import { randomUUID } from 'node:crypto'
import { LOG_LEVELS, sanitize, type LogInput, type LogLevel } from './diagnostic-record.ts'

export interface DiagnosticPreferences { developerLogging?: boolean; logLevel: LogLevel }
type Writer = (level: LogLevel, line: string) => void
let preferences: DiagnosticPreferences = { developerLogging: false, logLevel: 'info' }
let writer: Writer | undefined
let runId = randomUUID() as string
let sequence = 0
export function initializeDeveloperLogging(write: Writer, id = runId): void {
  writer = write
  runId = id
}
export function diagnosticRunId(): string { return runId }
export function configureDeveloperLogging(value: DiagnosticPreferences): void {
  preferences = { developerLogging: value.developerLogging === true, logLevel: value.logLevel }
}
export function developerLoggingEnabled(): boolean { return preferences.developerLogging === true }
export function diagnosticLog(input: LogInput): void {
  if (input.developer && !developerLoggingEnabled()) return
  if (input.developer && LOG_LEVELS.indexOf(input.level ?? 'info') < LOG_LEVELS.indexOf(preferences.logLevel)) return
  try {
    writer?.(input.level ?? 'info', JSON.stringify(sanitize({ ...input, time: new Date().toISOString(),
      runId, sequence: ++sequence, pid: process.pid, level: input.level ?? 'info' })))
  } catch { /* Observability must not change application behavior. */ }
}
export function diagnosticOperation(source: string, event: string, fields?: LogInput['fields'], developer = true) {
  const operationId = randomUUID()
  const started = performance.now()
  diagnosticLog({ source, event: `${event}.start`, ...(fields ? { fields } : {}), operationId, developer })
  let finished = false
  return (error?: unknown, result?: LogInput['fields']) => {
    if (finished) return
    finished = true
    diagnosticLog({ source, event: `${event}.${error === undefined ? 'complete' : 'failed'}`, operationId,
      fields: { ...fields, ...result, durationMs: Math.round(performance.now() - started) },
      level: error === undefined ? 'info' : 'error', developer: error === undefined && developer, error })
  }
}
