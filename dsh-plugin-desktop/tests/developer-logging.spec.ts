import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { configureDeveloperLogging, diagnosticLog, diagnosticOperation, initializeDeveloperLogging } from '../src/developer-logging.ts'
import { observeDesktopRenderer } from '../src/renderer-logging.ts'
import { createProcessOutputLogging } from '../src/process-output-logging.ts'
import { sanitize } from '../src/diagnostic-record.ts'

const records: any[] = []
function capture(developerLogging = true, logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  records.length = 0
  initializeDeveloperLogging((_level, line) => records.push(JSON.parse(line)), 'test-run')
  configureDeveloperLogging({ developerLogging, logLevel })
}
afterEach(() => {
  configureDeveloperLogging({ developerLogging: false, logLevel: 'info' })
  initializeDeveloperLogging(() => {})
  vi.restoreAllMocks()
})
it('applies live opt-in and severity without hiding failures', () => {
  capture(false)
  diagnosticLog({ source: 'fixture', event: 'hidden', developer: true })
  const end = diagnosticOperation('fixture', 'work')
  end(new Error('failed', { cause: new Error('socket closed') }))
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ event: 'work.failed', runId: 'test-run', pid: process.pid, error: { cause: { message: 'socket closed' } } })
  configureDeveloperLogging({ developerLogging: true, logLevel: 'warn' })
  diagnosticLog({ source: 'fixture', event: 'hidden-info', developer: true })
  diagnosticLog({ source: 'fixture', event: 'warning', developer: true, level: 'warn' })
  expect(records.map(record => record.event)).toEqual(['work.failed', 'warning'])
})
it('correlates operations and finishes exactly once', () => {
  capture()
  const end = diagnosticOperation('fixture', 'work', { sessionId: 'session' })
  end(undefined, { outcome: 'cancelled' }); end(new Error('ignored'))
  expect(records).toHaveLength(2)
  expect(records[0].operationId).toBe(records[1].operationId)
  expect(records[1].fields).toMatchObject({ sessionId: 'session', outcome: 'cancelled', durationMs: expect.any(Number) })
})
it('redacts secrets and bounds hostile or recursive error metadata', () => {
  capture()
  const error = new Error('Authorization: Bearer private-value')
  error.cause = error
  diagnosticLog({ source: 'fixture', event: 'failed', error, fields: { apiKey: 'private-key' } })
  expect(JSON.stringify(records)).not.toContain('private-value')
  expect(JSON.stringify(records)).not.toContain('private-key')
  expect(records[0].error.cause).toBe('[circular error]')
  expect(sanitize(Object.defineProperty({}, 'hostile', { enumerable: true, get() { throw new Error() } }))).toBe('[unrenderable diagnostic]')
})
it('isolates writer failures from observed work', () => {
  initializeDeveloperLogging(() => { throw new Error('disk full') })
  expect(() => diagnosticLog({ source: 'fixture', event: 'failed', level: 'error' })).not.toThrow()
  expect(() => diagnosticOperation('fixture', 'work')(new Error('failure'))).not.toThrow()
})
it('captures renderer failures while disabled, supports both Electron console signatures and keeps an error rate budget', () => {
  capture(false)
  const contents = Object.assign(new EventEmitter(), { id: 7 })
  observeDesktopRenderer(contents as unknown as WebContents, 'application')
  contents.emit('console-message', { level: 'info', message: 'hidden' })
  contents.emit('console-message', {}, 3, 'legacy error')
  expect(records).toHaveLength(1)
  configureDeveloperLogging({ developerLogging: true, logLevel: 'debug' })
  for (let i = 0; i < 105; i++) contents.emit('console-message', { level: 'info', message: 'noise' })
  contents.emit('console-message', { level: 'error', message: 'important failure Authorization: Bearer private-value' })
  expect(records.at(-1)).toMatchObject({ level: 'error', fields: { scope: 'application', webContentsId: 7 } })
  expect(JSON.stringify(records)).not.toContain('private-value')
  expect(records.filter(record => record.event === 'console.rate-limited')).toHaveLength(1)
})

it('assembles split UTF-8 and secret-bearing Host output, bounds long lines and flushes once', () => {
  capture()
  const output = createProcessOutputLogging('stderr', () => 42)
  const bytes = Buffer.from('中文 Authorization: Bearer private-value\n')
  output.write(bytes.subarray(0, 2)); output.write(bytes.subarray(2, bytes.length - 4)); output.write(bytes.subarray(bytes.length - 4))
  output.write(Buffer.from('x '.repeat(10000)))
  output.end(); output.end()
  expect(records).toHaveLength(2)
  expect(records[0].message).toContain('中文')
  expect(JSON.stringify(records)).not.toContain('private-value')
  expect(records[1]).toMatchObject({ fields: { hostPid: 42, truncated: true } })
  expect(records[1].message).toHaveLength(16384)
})
it('retains Host stderr while stdout tracing is disabled', () => {
  capture(false)
  const stdout = createProcessOutputLogging('stdout', () => 42)
  stdout.write(Buffer.from('hidden\n')); stdout.end()
  const stderr = createProcessOutputLogging('stderr', () => 42)
  stderr.write(Buffer.from('bootstrap failure')); stderr.end()
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ source: 'host.stderr', message: 'bootstrap failure' })
})
