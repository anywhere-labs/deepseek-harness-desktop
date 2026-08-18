import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ElectronStderrLogger } from '../src/desktop-logger.ts'
import { FileExporter } from '../src/file-exporter.ts'
import { LogFileSink } from '../src/log-files.ts'

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
