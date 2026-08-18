import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ElectronStderrLogger,
  installDesktopChildProcessLogging,
  installDesktopUncaughtExceptionLogging,
} from '../src/desktop-logger.ts'
import { LogFileSink } from '../src/log-files.ts'

function todaySuffix(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function sink(): { s: LogFileSink; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-log-'))
  return { s: new LogFileSink(dir, { maxFileBytes: 1e6, maxDirectoryBytes: 1e7 }), dir }
}

describe('ElectronStderrLogger', () => {
  it('logs Electron child process crashes with the Windows exception code', () => {
    const app = new EventEmitter()
    const logger = { error: vi.fn(), errorCause: vi.fn() }
    const remove = installDesktopChildProcessLogging(app, logger)

    app.emit('child-process-gone', {}, {
      type: 'Utility',
      reason: 'crashed',
      exitCode: -1073741819,
      serviceName: 'network.mojom.NetworkService',
      name: 'Network Service',
    })

    expect(logger.error).toHaveBeenCalledWith(
      'dsh-plugin-desktop: child process gone (type: Utility, name: Network Service, service: network.mojom.NetworkService, reason: crashed, exitCode: -1073741819 / 0xc0000005)',
    )
    remove()
    expect(app.listenerCount('child-process-gone')).toBe(0)
  })

  it('writes to the sink and to stderr', () => {
    const { s, dir } = sink()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logger = new ElectronStderrLogger(s)
    logger.error('boom')
    expect(stderrSpy).toHaveBeenCalled()
    stderrSpy.mockRestore()
    const day = todaySuffix()
    expect(readFileSync(join(dir, `dsh-${day}.log`), 'utf8')).toContain('boom')
  })

  it('renders an unknown cause as a string', () => {
    const { s } = sink()
    const logger = new ElectronStderrLogger(s)
    expect(() => logger.errorCause({ code: 42 })).not.toThrow()
  })

  it('uses the error stack for Error causes', () => {
    const { s, dir } = sink()
    const logger = new ElectronStderrLogger(s)
    logger.errorCause(new Error('crash here'))
    const day = todaySuffix()
    expect(readFileSync(join(dir, `dsh-${day}.log`), 'utf8')).toContain('crash here')
  })

  it('masks secrets in the file and stderr outputs', () => {
    const { s, dir } = sink()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logger = new ElectronStderrLogger(s)

    logger.error('request failed with Bearer abc.def.secret')

    const day = todaySuffix()
    const text = readFileSync(join(dir, `dsh-${day}.log`), 'utf8')
    expect(text).toContain('Bearer ****')
    expect(text).not.toContain('abc.def.secret')
    expect(stderrSpy).toHaveBeenCalledWith('request failed with Bearer ****\n')
    stderrSpy.mockRestore()
  })

  it('accepts fail-loud stderr chunks without adding a second newline', () => {
    const { s, dir } = sink()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logger = new ElectronStderrLogger(s)

    logger.write('dsh-plugin-desktop: fatal load failure: Bearer abc.def.secret\n')

    const day = todaySuffix()
    const text = readFileSync(join(dir, `dsh-${day}.log`), 'utf8')
    expect(text).toContain('fatal load failure: Bearer ****\n')
    expect(text).not.toContain('abc.def.secret')
    expect(stderrSpy).toHaveBeenCalledWith('dsh-plugin-desktop: fatal load failure: Bearer ****\n')
    stderrSpy.mockRestore()
  })

  it('logs the first uncaught exception and requests a fatal exit', () => {
    const { s, dir } = sink()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logger = new ElectronStderrLogger(s)
    const proc = new EventEmitter()
    const exit = vi.fn()

    const remove = installDesktopUncaughtExceptionLogging(proc, logger, exit)
    proc.emit('uncaughtException', new Error('fatal Bearer abc.def.secret'))
    proc.emit('uncaughtException', new Error('second failure'))

    const day = todaySuffix()
    const text = readFileSync(join(dir, `dsh-${day}.log`), 'utf8')
    expect(text).toContain('fatal Bearer ****')
    expect(text).not.toContain('abc.def.secret')
    expect(text).not.toContain('second failure')
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
    expect(proc.listenerCount('uncaughtException')).toBe(0)
    remove()
    stderrSpy.mockRestore()
  })

  it('falls back to masked stderr when the file sink fails', () => {
    const { s } = sink()
    vi.spyOn(s, 'write').mockImplementation(() => { throw new Error('disk full') })
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logger = new ElectronStderrLogger(s)

    expect(() => { logger.error('failed with Bearer abc.def.secret') }).not.toThrow()
    expect(stderrSpy).toHaveBeenCalledWith('failed with Bearer ****\n')
    stderrSpy.mockRestore()
  })
})
