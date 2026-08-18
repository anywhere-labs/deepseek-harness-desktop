/** One Cordis logger severity, mirroring `@deepseek-ai/cordis`'s `LoggerType`. */
export type LogType = 'error' | 'info' | 'warn' | 'debug'

/** User-selectable log verbosity threshold. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const VERBOSITY: Record<LogType, number> = { error: 0, warn: 1, info: 2, debug: 3 }

/** Whether a message of `type` should be emitted at `threshold`. */
export function shouldEmit(type: LogType, threshold: LogLevel): boolean {
  return VERBOSITY[type] <= VERBOSITY[threshold]
}

/** Whether a message of `type` belongs in the per-day error log. */
export function isErrorType(type: LogType): boolean {
  return type === 'warn' || type === 'error'
}
