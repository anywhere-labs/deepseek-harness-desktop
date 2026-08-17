/** Bundle recent logs and system information without blocking Electron's main thread. */

import { Worker } from 'node:worker_threads'
import type { DiagnosticExportWorkerResult } from './diagnostic-export-worker.ts'

/** Bound both worker memory and the amount of potentially sensitive log history exported. */
export const MAX_DIAGNOSTIC_LOG_BYTES = 50 * 1024 * 1024

/** Stop an export that cannot complete because its Worker or filesystem is wedged. */
export const DIAGNOSTIC_EXPORT_TIMEOUT_MS = 60_000

export interface DiagnosticExportOptions {
  /** Override used by focused tests; production exports use the 50 MB cap. */
  readonly maxLogBytes?: number
}

function workerEntryUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  return new URL(`./diagnostic-export-worker.${extension}`, import.meta.url)
}

/** Wait for one diagnostic Worker result and terminate it when it stops responding. */
export function waitForDiagnosticExportWorker(
  worker: Worker,
  timeoutMs: number = DIAGNOSTIC_EXPORT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const settle = (complete: () => void, terminate: boolean): void => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      if (terminate) void worker.terminate().catch(() => {})
      complete()
    }
    timeout = setTimeout(() => {
      settle(
        () => reject(new Error(
          `dsh-plugin-desktop: diagnostic export worker timed out after ${String(timeoutMs)}ms`,
        )),
        true,
      )
    }, timeoutMs)
    worker.once('message', (result: DiagnosticExportWorkerResult) => {
      if (result.ok) settle(() => resolve(result.path), true)
      else settle(() => reject(new Error(result.error)), true)
    })
    worker.once('error', cause => settle(() => reject(cause), true))
    worker.once('exit', (code) => {
      settle(
        () => reject(new Error(
          `dsh-plugin-desktop: diagnostic export worker exited with code ${String(code)}`,
        )),
        false,
      )
    })
  })
}

/** Write a diagnostics zip in a short-lived worker and return its published path. */
export function exportDiagnosticsZip(
  logsDir: string,
  userDataDir: string,
  options: DiagnosticExportOptions = {},
): Promise<string> {
  const maxLogBytes = options.maxLogBytes ?? MAX_DIAGNOSTIC_LOG_BYTES
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes <= 0) {
    return Promise.reject(new Error('dsh-plugin-desktop: diagnostic log byte limit must be a positive integer'))
  }

  const worker = new Worker(workerEntryUrl(), {
    name: 'dsh-diagnostic-export',
    workerData: { logsDir, userDataDir, maxLogBytes },
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  })
  return waitForDiagnosticExportWorker(worker)
}
