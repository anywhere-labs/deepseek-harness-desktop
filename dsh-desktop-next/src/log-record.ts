/** Wire-safe diagnostic metadata. Never pass prompts, arguments or credentials as fields. */
import { maskSecrets } from './mask-secrets.ts'

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = typeof LOG_LEVELS[number]
export const HOST_LOG_PREFIX = '@@dsh-next-log '
export type LogFields = Record<string, string | number | boolean | null | undefined>
export interface LogInput {
  source: string
  event: string
  level?: LogLevel
  message?: string
  developer?: boolean
  operationId?: string
  pid?: number
  fields?: LogFields
  error?: unknown
}
export interface LogRecord {
  time: string
  runId: string
  sequence: number
  pid: number
  source: string
  event: string
  level: LogLevel
  message: string
  developer: boolean
  operationId?: string
  fields?: LogFields
  error?: unknown
}

export function errorDetails(error: unknown, seen = new Set<unknown>(), depth = 0): unknown {
  if (depth > 6) return '[error chain truncated]'
  if (seen.has(error)) return '[circular error]'
  if (!(error instanceof Error)) return maskSecrets(String(error)).slice(0, 8192)
  seen.add(error)
  const code = (error as Error & { code?: unknown }).code
  return { name: maskSecrets(error.name), message: maskSecrets(error.message).slice(0, 8192),
    stack: maskSecrets(error.stack ?? '').slice(0, 16384),
    ...(typeof code === 'string' ? { code: maskSecrets(code) } : {}),
    ...(error.cause === undefined ? {} : { cause: errorDetails(error.cause, seen, depth + 1) }),
    ...(error instanceof AggregateError ? { errors: error.errors.slice(0, 10).map(member => errorDetails(member, seen, depth + 1)) } : {}) }
}

/** Redact values and secret-named metadata while keeping diagnostic field names intact. */
export function sanitize(value: unknown, depth = 0): unknown {
  try { return sanitizeValue(value, depth) } catch { return '[unrenderable diagnostic]' }
}
function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 8) return '[truncated]'
  if (value instanceof Error) return errorDetails(value)
  if (typeof value === 'string') return maskSecrets(value).slice(0, 32768)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) =>
    [key, /^(?:authorization|cookie|password|passwd|token|.*secret.*|.*api.?key.*|credentials?)$/iu.test(key) ? '****' : sanitize(item, depth + 1)]))
  return undefined
}

export function isLogInput(value: unknown): value is LogInput {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.source === 'string' && v.source.length <= 256
    && typeof v.event === 'string' && v.event.length <= 256
    && (v.level === undefined || LOG_LEVELS.includes(v.level as LogLevel))
    && (v.message === undefined || typeof v.message === 'string')
    && (v.developer === undefined || typeof v.developer === 'boolean')
    && (v.operationId === undefined || typeof v.operationId === 'string')
    && (v.pid === undefined || Number.isSafeInteger(v.pid))
    && (v.fields === undefined || (typeof v.fields === 'object' && v.fields !== null && !Array.isArray(v.fields)
      && Object.values(v.fields).every(item => item === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof item))))
}
