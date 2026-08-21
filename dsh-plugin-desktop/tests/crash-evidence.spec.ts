import { existsSync, linkSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { beginDesktopRun, startDesktopCrashReporting } from '../src/crash-evidence.ts'

describe('desktop crash evidence', () => {
  it('starts Electron crash reporting without uploading dumps', () => {
    const reporter = { start: vi.fn() }

    startDesktopCrashReporting(reporter, {
      productName: 'DSH Desktop',
      version: '2.0.1',
      platform: 'win32',
      arch: 'x64',
    })

    expect(reporter.start).toHaveBeenCalledWith({
      productName: 'DSH Desktop',
      uploadToServer: false,
      globalExtra: {
        appVersion: '2.0.1',
        platform: 'win32',
        arch: 'x64',
      },
    })
  })

  it('reports the previous run when it did not shut down cleanly', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-run-')), 'active-run.json')
    beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:00:00.000Z',
      pid: 41,
      version: '2.0.1',
    })

    const next = beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:01:00.000Z',
      pid: 42,
      version: '2.0.1',
    })

    expect(next.previousRun).toEqual({
      startedAt: '2026-08-18T00:00:00.000Z',
      pid: 41,
      version: '2.0.1',
    })
  })

  it('does not report a run that marked its shutdown clean', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-run-')), 'active-run.json')
    const run = beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:00:00.000Z',
      pid: 41,
      version: '2.0.1',
    })

    expect(() => {
      run.markClean()
      run.markClean()
    }).not.toThrow()

    const next = beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:01:00.000Z',
      pid: 42,
      version: '2.0.1',
    })
    expect(next.previousRun).toBeUndefined()
  })

  it('reports an unreadable previous marker without blocking the next run', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-run-')), 'active-run.json')
    writeFileSync(statePath, '{partial', 'utf8')

    const run = beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:01:00.000Z',
      pid: 42,
      version: '2.0.1',
    })

    expect(run.previousRun).toEqual({ unreadable: true })
    expect(() => run.markClean()).not.toThrow()
  })

  it('only clears the marker owned by the current run', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-run-')), 'active-run.json')
    const first = beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:00:00.000Z',
      pid: 41,
      version: '2.0.1',
    })
    const second = beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:01:00.000Z',
      pid: 42,
      version: '2.0.1',
    })

    first.markClean()

    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ pid: 42 })
    expect(() => second.markClean()).not.toThrow()
    expect(existsSync(statePath)).toBe(false)
  })

  it('does not read or overwrite a linked marker', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-run-'))
    const target = join(directory, 'outside.json')
    const statePath = join(directory, 'active-run.json')
    writeFileSync(target, '{"outside":true}\n', 'utf8')
    linkSync(target, statePath)

    expect(() => beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:01:00.000Z',
      pid: 42,
      version: '2.0.1',
    })).toThrow('active run marker is invalid')
    expect(readFileSync(target, 'utf8')).toBe('{"outside":true}\n')
  })
})
