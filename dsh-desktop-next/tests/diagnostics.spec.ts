import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopDiagnostics } from '../src/diagnostics.ts'
import { LogHistory, historyFiles } from '../src/log-history.ts'
import { HOST_LOG_PREFIX, sanitize } from '../src/log-record.ts'
import { exportHistory } from '../src/diagnostics-export.ts'
import { DEFAULT_PREFERENCES, type DesktopState } from '../src/desktop-contract.ts'

const homes: string[] = []
const logs: DesktopDiagnostics[] = []
const temporary = () => { const home = mkdtempSync(join(tmpdir(), 'next-logging-')); homes.push(home); return home }
const diagnostics = (home = temporary()) => { const log = new DesktopDiagnostics(home); logs.push(log); return log }
afterEach(() => { for (const log of logs.splice(0)) log.flush(); vi.useRealTimers(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const state = { version: 'next-test', platform: 'test', selected: 'desktop', profiles: ['desktop'], phase: 'ready', safeMode: false,
  failure: '', features: { market: false, remoteControl: false }, preferences: { ...DEFAULT_PREFERENCES }, trayAvailable: true,
  browserUrl: null, lan: null } as DesktopState
function records(home: string) { return historyFiles(join(home, 'logs')).flatMap(file => readFileSync(file.file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) }

it('keeps lifecycle evidence regardless of verbosity while developer events are opt-in', () => {
  const home = temporary(); const log = diagnostics(home)
  log.level = 'error'
  log.record({ source: 'electron', event: 'run.start' })
  log.record({ source: 'host.llm', event: 'request.start', developer: true })
  log.flush()
  expect(records(home).map(record => record.event)).toEqual(['run.start'])
  log.developer = true; log.level = 'info'
  log.record({ source: 'host.llm', event: 'request.start', developer: true })
  log.record({ source: 'host.kernel', event: 'debug', developer: true, level: 'debug' })
  log.level = 'debug'; log.record({ source: 'host.kernel', event: 'debug-enabled', developer: true, level: 'debug' }); log.flush()
  expect(records(home).map(record => record.event)).toEqual(['run.start', 'request.start', 'debug-enabled'])
})

it('persists related operations, complete error causes, process identity and redacted fields', () => {
  const home = temporary(); const log = diagnostics(home)
  log.begin({ version: 'test' })
  const finish = log.operation('desktop', 'host.stop')
  expect(log.pendingOperations()).toHaveLength(1)
  const cause = Object.assign(new Error('Authorization: Bearer private-value'), { code: 'ECONNRESET' })
  finish(new Error('token=private-value', { cause })); finish()
  log.record({ source: 'test', event: 'metadata', fields: { apiKey: 'secret-value', sessionId: 'session-a' } }); log.flush()
  const history = records(home)
  const start = history.find(record => record.event === 'host.stop.start')
  const failure = history.find(record => record.event === 'host.stop.failed')
  expect(failure).toMatchObject({ runId: log.runId, pid: process.pid, operationId: start.operationId, error: { cause: { code: 'ECONNRESET' } } })
  expect(failure.error.stack).toContain('Error:')
  expect(log.pendingOperations()).toEqual([])
  expect(JSON.stringify(history)).not.toContain('private-value')
  expect(JSON.stringify(history)).not.toContain('secret-value')
  expect(history.at(-1).fields.sessionId).toBe('session-a')
})

it('detects an unclean previous launch and does not report a clean launch as a crash', () => {
  const home = temporary(); const first = diagnostics(home)
  first.begin({ version: 'one' }); first.end(false)
  const second = diagnostics(home); second.begin({ version: 'two' })
  expect(records(home).filter(record => record.event === 'run.previous-unclean')).toHaveLength(1)
  second.end(true)
  const third = diagnostics(home); third.begin({ version: 'three' })
  expect(records(home).filter(record => record.event === 'run.previous-unclean')).toHaveLength(1)
})

it('separates streams and hosts, preserves structured severity and finishes partial lines at exit', () => {
  const home = temporary(); const log = diagnostics(home)
  log.hostChunk('Authorization: Bear', 'stderr', 11)
  log.hostChunk('other host\n', 'stdout', 12)
  log.hostChunk('er private-value\n', 'stderr', 11)
  const frame = HOST_LOG_PREFIX + JSON.stringify({ source: 'host.kernel.loader', event: 'log', level: 'warn', message: 'a plain warning', fields: { pluginId: 'example' } }) + '\n'
  log.hostChunk(frame.slice(0, 15), 'stdout', 11); log.hostChunk(frame.slice(15), 'stdout', 11)
  log.hostChunk('last line', 'stderr', 11); log.hostClosed(11)
  const history = records(home)
  expect(history.find(record => record.source === 'host.kernel.loader')).toMatchObject({ pid: 11, level: 'warn', fields: { pluginId: 'example' } })
  expect(history.some(record => record.message === 'last line')).toBe(true)
  expect(JSON.stringify(history)).not.toContain('private-value')
  expect(history.find(record => record.pid === 12).message).toBe('other host')
})

it('discards an entire oversized line, including its trailing secret, then recovers at newline', () => {
  const log = diagnostics()
  log.hostChunk('x'.repeat(150_000), 'stdout', 12)
  log.hostChunk('private-value\nnormal line\n', 'stdout', 12)
  expect(log.snapshot()).not.toContain('private-value')
  expect(log.snapshot()).toContain('normal line')
  expect(log.snapshot().length).toBeLessThanOrEqual(128 * 1024)
})

it('flushes fatal evidence immediately and retains errors without a developer setting', () => {
  const home = temporary(); const log = diagnostics(home)
  log.record({ source: 'electron', event: 'shutdown.timeout', level: 'error', fields: { pending: 'host.stop' } })
  expect(records(home).at(-1)).toMatchObject({ event: 'shutdown.timeout' })
})

it('rotates complete UTF-8 JSONL records, caps owned files and retains unrelated files', () => {
  const directory = join(temporary(), 'logs')
  const sink = new LogHistory(directory, { maxFileBytes: 1024, maxDirectoryBytes: 2048, retentionDays: 7 })
  writeFileSync(join(directory, 'unrelated.txt'), 'preserve')
  sink.append(Array.from({ length: 12 }, (_, index) => JSON.stringify({ index, text: '汉'.repeat(150) })))
  const files = historyFiles(directory)
  expect(files.length).toBeGreaterThan(1)
  expect(files.every(file => file.bytes <= 1024)).toBe(true)
  expect(files.reduce((sum, file) => sum + file.bytes, 0)).toBeLessThanOrEqual(2048)
  for (const file of files) expect(readFileSync(file.file, 'utf8').trim().split('\n').every(line => typeof JSON.parse(line).text === 'string')).toBe(true)
  expect(readFileSync(join(directory, 'unrelated.txt'), 'utf8')).toBe('preserve')
  if (process.platform !== 'win32') expect(lstatSync(files[0]!.file).mode & 0o777).toBe(0o600)
})

it('cleans old owned history and prevents a torn record from corrupting the next line', () => {
  const directory = join(temporary(), 'logs'); const sink = new LogHistory(directory)
  const old = join(directory, 'desktop-next-2020-01-01.0.jsonl')
  writeFileSync(old, '{}\n'); utimesSync(old, new Date(0), new Date(0))
  sink.append(['{"first":true}'])
  expect(historyFiles(directory).some(file => file.file === old)).toBe(false)
  const file = historyFiles(directory)[0]!.file
  writeFileSync(file, '{"torn":')
  sink.append(['{"second":true}'])
  const summary = JSON.stringify({ format: 'test' })
  expect(JSON.parse(exportHistory(directory, summary)).history.records).toEqual([{ second: true }])
})

it('exports bounded historical records with a second redaction pass and explicit omissions', () => {
  const home = temporary(); const log = diagnostics(home)
  const directory = join(home, 'logs')
  const sink = new LogHistory(directory, { maxFileBytes: 1024, maxDirectoryBytes: 4096, retentionDays: 7 })
  sink.append([JSON.stringify({ text: 'token=private-value', filler: 'z'.repeat(700) }), JSON.stringify({ text: 'newer', filler: 'z'.repeat(700) })])
  const exported = exportHistory(directory, log.export(state), 1024)
  const data = JSON.parse(exported)
  expect(data.version).toBe(2)
  expect(data.history.omittedFiles).toBe(1)
  expect(data.history.records).toHaveLength(1)
  expect(exported).not.toContain('private-value')
  expect(data.runtime).not.toHaveProperty('home')
})

it('ignores linked history files and refuses a linked logging directory without touching its target', () => {
  const home = temporary(); const outside = temporary(); mkdirSync(join(home, 'logs'))
  writeFileSync(join(outside, 'external.log'), 'preserve')
  if (process.platform === 'win32') return
  symlinkSync(join(outside, 'external.log'), join(home, 'logs', `desktop-next-${new Date().toISOString().slice(0, 10)}.0.jsonl`))
  const log = diagnostics(home); log.record({ source: 'test', event: 'write' }); log.flush()
  expect(readFileSync(join(outside, 'external.log'), 'utf8')).toBe('preserve')
  const linkedHome = temporary(); symlinkSync(outside, join(linkedHome, 'logs'))
  const linkedLog = diagnostics(linkedHome)
  expect(() => linkedLog.record({ source: 'test', event: 'failed-write', level: 'error' })).not.toThrow()
  expect(JSON.parse(linkedLog.export(state)).logging.storageError).toContain('directory')
})

it('safely renders cyclic and hostile diagnostic values', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  expect(() => JSON.stringify(sanitize(cycle))).not.toThrow()
  const hostile = { get message() { throw new Error('accessor') } }
  expect(sanitize(hostile)).toBe('[unrenderable diagnostic]')
})
