import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installAgentErrorLogging } from '../src/agent-error-logging.ts'
import { ElectronStderrLogger } from '../src/desktop-logger.ts'
import { FileExporter } from '../src/file-exporter.ts'
import { configureDeveloperLogging, initializeDeveloperLogging } from '../src/developer-logging.ts'
import { LogFileSink } from '../src/log-files.ts'

const SESSION_ID = 'ws-1-session-9f2c1a7e-3b44-4c10-9e55-7a1d2f6b8c30'

function openLogDir(): { dir: string, sink: LogFileSink } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-log-e2e-'))
  return {
    dir,
    sink: new LogFileSink(dir, { maxFileBytes: 10 * 1024 * 1024, maxDirectoryBytes: 200 * 1024 * 1024 }),
  }
}

/** Shaped like the `LlmError` thrown by llm-deepseek: a `code` field, not a code in the text. */
function requestExtensionFailure(): Error {
  const root = new Error('cannot resolve active package')
  root.stack = 'Error: cannot resolve active package\n    at resolveActivePackage (request-extensions.ts:11:9)'
  const wrapped = Object.assign(
    new Error('DeepSeek request extension preparation failed', { cause: root }),
    { code: 'REQUEST_EXTENSION' },
  )
  wrapped.name = 'LlmError'
  wrapped.stack = 'LlmError: DeepSeek request extension preparation failed\n    at prepareRequestExtensions (request-extensions.ts:24:11)'
  return wrapped
}

function todaySuffix(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

describe('logging end-to-end', () => {
  it('routes real ctx.logger output to per-day log files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-log-e2e-'))
    const sink = new LogFileSink(dir, { maxFileBytes: 10 * 1024 * 1024, maxDirectoryBytes: 200 * 1024 * 1024 })
    const ctx = new Context()
    const dispose = ctx.logger.exporter(new FileExporter(sink))

    ctx.logger('test').info('hello from info')
    ctx.logger('test').warn('careful from warn')
    ctx.logger('test').error('boom from error')
    dispose()

    const day = todaySuffix()
    expect(readdirSync(dir).sort()).toEqual([`dsh-${day}.error.log`, `dsh-${day}.log`])
    const full = readFileSync(join(dir, `dsh-${day}.log`), 'utf8')
    const error = readFileSync(join(dir, `dsh-${day}.error.log`), 'utf8')
    expect(full).toContain('[I] [test] hello from info')
    expect(full).toContain('[W] [test] careful from warn')
    expect(full).toContain('[E] [test] boom from error')
    expect(error).toContain('[W] [test] careful from warn')
    expect(error).toContain('[E] [test] boom from error')
    expect(error).not.toContain('hello from info')
  })

  it('logs an uncaught-exception cause through ElectronStderrLogger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-log-e2e-'))
    const sink = new LogFileSink(dir, { maxFileBytes: 10 * 1024 * 1024, maxDirectoryBytes: 200 * 1024 * 1024 })
    const logger = new ElectronStderrLogger(sink)
    logger.errorCause(new Error('crash in main'))
    const day = todaySuffix()
    expect(readFileSync(join(dir, `dsh-${day}.log`), 'utf8')).toContain('crash in main')
  })
})

describe('agent failure logging end-to-end', () => {
  it('writes the digest, both codes-bearing identifiers, and every cause stack to disk', () => {
    const { dir, sink } = openLogDir()
    const ctx = new Context()
    const disposeExporter = ctx.logger.exporter(new FileExporter(sink))
    const disposeListener = installAgentErrorLogging(ctx)

    ctx.emit('agent/error', {
      // Only `agent.id` is read; a live Agent needs a whole running host.
      agent: { id: SESSION_ID } as unknown as Agent,
      turn: 3,
      step: 2,
      error: requestExtensionFailure(),
    })
    disposeListener()
    disposeExporter()

    const day = todaySuffix()
    const full = readFileSync(join(dir, `dsh-${day}.log`), 'utf8')
    const error = readFileSync(join(dir, `dsh-${day}.error.log`), 'utf8')

    // The digest line: the only place the code, the session and the turn meet,
    // and the token a reporter can grep for after reproducing the failure.
    expect(full).toContain('[E] [dsh-agent-error]')
    expect(full).toContain(`agent turn failed (session ${SESSION_ID}, turn 3, step 2) [REQUEST_EXTENSION]`)
    expect(full).toContain('DeepSeek request extension preparation failed: cannot resolve active package')
    // Both levels' stacks, which is what identifies the throwing call site.
    expect(full).toContain('at prepareRequestExtensions (request-extensions.ts:24:11)')
    expect(full).toContain('at resolveActivePackage (request-extensions.ts:11:9)')
    // Nothing here may be swallowed by maskSecrets on the way through the sink.
    expect(full).not.toContain('****')
    // A failure report is useless if it lands only in the file nobody sends us.
    expect(error).toContain('[REQUEST_EXTENSION]')
    expect(error).toContain('cannot resolve active package')
  })

  it('records a non-Error payload without trying to expand it', () => {
    const { dir, sink } = openLogDir()
    const ctx = new Context()
    const disposeExporter = ctx.logger.exporter(new FileExporter(sink))
    const disposeListener = installAgentErrorLogging(ctx)

    // A circular plain object would make Logger.format's JSON.stringify throw,
    // which is why the second, expanding call is reached only by real Errors.
    const payload: { code: string, message: string, self?: unknown } = {
      code: 'RPC_FAILED',
      message: 'host channel closed',
    }
    payload.self = payload
    ctx.emit('agent/error', {
      agent: { id: SESSION_ID } as unknown as Agent,
      turn: 0,
      step: 0,
      error: payload,
    })
    disposeListener()
    disposeExporter()

    expect(readFileSync(join(dir, `dsh-${todaySuffix()}.log`), 'utf8'))
      .toContain('[RPC_FAILED]: host channel closed')
  })

  // Constraint lock for the whole fix. Cordis walks `cause` only when the sole
  // argument is an Error (vendor/cordis/src/logger.ts:141-149), and only a lone
  // leading Error is rendered through `.stack` (`logger.ts:98-101`) — any other
  // position goes through the `%o` formatter, i.e. `JSON.stringify`, which
  // renders every Error as `{}`. So folding the digest and the error into one
  // `logger.error(text, err)` call — the natural-looking refactor — throws away
  // both the chain and the stack that issue #952 is about, and nothing else in
  // this repo would notice. Keep them as two separate single-argument calls.
  it('loses the whole error when it is not the only argument', () => {
    const { dir, sink } = openLogDir()
    const ctx = new Context()
    const dispose = ctx.logger.exporter(new FileExporter(sink))

    ctx.logger('constraint').error('prefixed', new Error('outer', { cause: new Error('inner') }))
    dispose()

    const full = readFileSync(join(dir, `dsh-${todaySuffix()}.log`), 'utf8')
    expect(full).toContain('[E] [constraint] prefixed {}')
    expect(full).not.toContain('outer')
    expect(full).not.toContain('inner')
  })
})

it('persists structured Cordis metadata in the existing rotating files with redaction', () => {
  const { dir, sink } = openLogDir()
  initializeDeveloperLogging((level, line) => sink.writeRecord(level, JSON.parse(line)), 'kernel-test')
  configureDeveloperLogging({ developerLogging: true, logLevel: 'debug' })
  const ctx = new Context()
  const dispose = ctx.logger.exporter(new FileExporter(sink, 'debug'))
  try {
    ctx.logger('fixture-plugin').warn('Authorization: Bearer private-value')
    const full = readFileSync(join(dir, `dsh-${todaySuffix()}.log`), 'utf8')
    const record = full.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).at(-1)
    expect(record).toMatchObject({ source: 'host.kernel.fixture-plugin', event: 'log', level: 'warn', runId: 'kernel-test', fields: { hostSequence: expect.any(Number), hostTime: expect.any(Number) } })
    expect(full).not.toContain('private-value')
  } finally {
    dispose(); sink.close()
    configureDeveloperLogging({ developerLogging: false, logLevel: 'info' })
    initializeDeveloperLogging(() => {})
  }
})
