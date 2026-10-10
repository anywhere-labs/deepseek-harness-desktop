import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopDiagnostics } from '../src/diagnostics.ts'
import { DEFAULT_PREFERENCES, type DesktopState } from '../src/desktop-contract.ts'

const fixture = vi.hoisted(() => ({ workers: [] as any[] }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return { Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0)
    constructor(readonly entry: URL, readonly options: unknown) { super(); fixture.workers.push(this) }
  } }
})
const logs: DesktopDiagnostics[] = []
const homes: string[] = []
afterEach(() => { for (const log of logs.splice(0)) log.flush(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); fixture.workers = []; vi.useRealTimers() })
function exportJob() {
  const home = mkdtempSync(join(tmpdir(), 'next-export-test-')); homes.push(home)
  const log = new DesktopDiagnostics(home); logs.push(log)
  log.record({ source: 'electron', event: 'export-test' })
  const state = { version: 'test', platform: 'test', selected: 'desktop', profiles: [], phase: 'ready', safeMode: false,
    failure: '', preferences: { ...DEFAULT_PREFERENCES }, features: { market: false, remoteControl: false }, trayAvailable: true, browserUrl: null, lan: null, unavailableProfiles: [], busy: false, home, notificationsAvailable: true, checkpoint: null, logs: '' } satisfies DesktopState
  return { task: log.exportTo(join(home, 'report.json'), state), worker: fixture.workers.at(-1) }
}

it('exports off-thread and settles success once even when a worker subsequently exits', async () => {
  const { task, worker } = exportJob()
  expect(worker.entry.pathname).toContain('diagnostics-export.ts')
  expect(JSON.parse(worker.options.workerData.summary)).toMatchObject({ version: 2, log: expect.stringContaining('export-test') })
  worker.emit('message', { ok: true }); worker.emit('exit', 0)
  await expect(task).resolves.toBeUndefined()
  expect(worker.terminate).toHaveBeenCalledOnce()
})

it.each(['error', 'exit'])('reports a worker %s without leaving an unresolved export', async type => {
  const { task, worker } = exportJob()
  const result = expect(task).rejects.toThrow(type === 'error' ? 'failed worker' : 'before completion')
  worker.emit(type, type === 'error' ? new Error('failed worker') : 1)
  await result
  expect(worker.terminate).toHaveBeenCalledOnce()
})

it('terminates and rejects a stalled export after sixty seconds', async () => {
  vi.useFakeTimers()
  const { task, worker } = exportJob()
  const result = expect(task).rejects.toThrow('60 seconds')
  await vi.advanceTimersByTimeAsync(60_000)
  await result
  expect(worker.terminate).toHaveBeenCalledOnce()
})
