import type { LogFileSink } from './log-files.ts'
import { maskSecrets } from './mask-secrets.ts'

/** Logger for Electron-main-scope messages that bypass Cordis `ctx.logger`. */
export interface DesktopLogger {
  /** Log an error message to the sink (and stderr for dev visibility). */
  error(message: string): void
  /** Log an unknown cause, normalizing errors/objects/strings. */
  errorCause(cause: unknown): void
}

/** Process events needed to make uncaught exceptions observable and fatal. */
export interface DesktopUncaughtExceptionProcess {
  once(event: 'uncaughtException', listener: (error: Error) => void): unknown
  off(event: 'uncaughtException', listener: (error: Error) => void): unknown
}

/** Persist the first uncaught exception before requesting a fatal exit. */
export function installDesktopUncaughtExceptionLogging(
  proc: DesktopUncaughtExceptionProcess,
  logger: DesktopLogger,
  exit: (code: number) => void,
): () => void {
  let handled = false
  const handler = (error: Error): void => {
    if (handled) return
    handled = true
    proc.off('uncaughtException', handler)
    logger.errorCause(error)
    exit(1)
  }
  proc.once('uncaughtException', handler)
  return () => { proc.off('uncaughtException', handler) }
}

/** DesktopLogger that writes to the shared sink and mirrors to process.stderr. */
export class ElectronStderrLogger implements DesktopLogger {
  constructor(private readonly sink: LogFileSink | undefined) {}

  /** Accept one fail-loud stderr diagnostic through the persistent logger. */
  write(chunk: string): boolean {
    this.error(chunk.replace(/\r?\n$/u, ''))
    return true
  }

  error(message: string): void {
    const masked = maskSecrets(message)
    try {
      this.sink?.write('error', masked)
    } catch {
      // Persistent diagnostics are best-effort; stderr must remain available.
    }
    process.stderr.write(`${masked}\n`)
  }

  errorCause(cause: unknown): void {
    const text = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
    this.error(text)
  }
}
