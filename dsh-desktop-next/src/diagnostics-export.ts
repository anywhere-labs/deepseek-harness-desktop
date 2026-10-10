/** Standalone export worker. Read only Next-owned history, never user session files. */
import { readFileSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { historyFiles } from './log-history.ts'
import { atomicText, privateDirectory } from './private-files.ts'
import { sanitize } from './log-record.ts'

export function exportHistory(directory: string, summary: string, maxBytes = 50 * 1024 * 1024): string {
  privateDirectory(directory)
  const files = historyFiles(directory).reverse()
  const records: unknown[] = []
  const included: string[] = []
  let bytes = 0
  let omitted = 0
  for (const file of files) {
    if (file.bytes > 10 * 1024 * 1024 || bytes + file.bytes > maxBytes) { omitted++; continue }
    try {
      const content = readFileSync(file.file, 'utf8')
      bytes += Buffer.byteLength(content); included.push(file.name)
      const batch: unknown[] = []
      for (const line of content.split('\n')) {
        if (!line) continue
        try { batch.push(sanitize(JSON.parse(line))) } catch { /* Skip torn/corrupt records. */ }
      }
      records.splice(0, 0, batch)
    } catch { omitted++ }
  }
  return JSON.stringify({ ...JSON.parse(summary), history: { files: included.reverse(), omittedFiles: omitted, maxBytes, records: records.flat() } }, null, 2) + '\n'
}
if (parentPort && workerData?.kind === 'dsh-next-diagnostics-export') {
  try { atomicText(workerData.file, exportHistory(workerData.directory, workerData.summary)); parentPort.postMessage({ ok: true }) }
  catch (error) { parentPort.postMessage({ ok: false, error: String(error) }) }
}
