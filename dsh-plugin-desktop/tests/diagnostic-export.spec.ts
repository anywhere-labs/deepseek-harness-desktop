import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import {
  exportDiagnosticsZip,
  waitForDiagnosticExportWorker,
} from '../src/diagnostic-export.ts'

describe('exportDiagnosticsZip', () => {
  it('terminates a diagnostic Worker that does not respond before its deadline', async () => {
    const worker = new Worker('setInterval(() => {}, 1_000)', { eval: true })
    const exited = once(worker, 'exit')

    try {
      await expect(waitForDiagnosticExportWorker(worker, 25))
        .rejects.toThrow('diagnostic export worker timed out after 25ms')
      await expect(exited).resolves.toEqual(expect.any(Array))
    } finally {
      await worker.terminate()
    }
  })

  it('produces a zip containing the log files and system info', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dx-'))
    writeFileSync(join(dir, 'dsh-2026-08-16.log'), 'hello\n')
    const out = await exportDiagnosticsZip(dir, dir)
    expect(existsSync(out)).toBe(true)
    expect(out.endsWith('.zip')).toBe(true)

    const zip = new AdmZip(out)
    const names = zip.getEntries().map(entry => entry.entryName)
    expect(names).toContain('dsh-2026-08-16.log')
    expect(names).toContain('system-info.txt')
    expect(zip.readAsText('dsh-2026-08-16.log')).toBe('hello\n')
    expect(zip.readAsText('system-info.txt')).toContain('platform:')
  })

  it('archives only owned regular log files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dx-'))
    writeFileSync(join(dir, 'dsh-2026-08-16.error.log'), 'owned\n')
    writeFileSync(join(dir, 'notes.txt'), 'foreign\n')
    mkdirSync(join(dir, 'dsh-2020-01-01.log'))

    const out = await exportDiagnosticsZip(dir, dir)

    const names = new AdmZip(out).getEntries().map(entry => entry.entryName).sort()
    expect(names).toEqual(['dsh-2026-08-16.error.log', 'system-info.txt'])
  })

  it('rejects a linked diagnostics output directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-link-'))
    const logs = join(root, 'logs')
    const target = join(root, 'target')
    mkdirSync(logs)
    mkdirSync(target)
    writeFileSync(join(logs, 'dsh-2026-08-16.log'), 'owned\n')
    symlinkSync(target, join(root, 'diagnostics'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(exportDiagnosticsZip(logs, root)).rejects.toThrow(/linked diagnostics directory/u)
  })

  it('rejects a linked log directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-logs-link-'))
    const target = join(root, 'target')
    const logs = join(root, 'logs')
    mkdirSync(target)
    writeFileSync(join(target, 'dsh-2026-08-16.log'), 'owned\n')
    symlinkSync(target, logs, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(exportDiagnosticsZip(logs, root)).rejects.toThrow(/linked log directory/u)
  })

  it('retains only the three newest diagnostics archives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-retain-'))
    const logs = join(root, 'logs')
    const diagnostics = join(root, 'diagnostics')
    mkdirSync(logs)
    mkdirSync(diagnostics)
    writeFileSync(join(logs, 'dsh-2026-08-16.log'), 'owned\n')
    for (let index = 1; index <= 3; index += 1) {
      const path = join(diagnostics, `diagnostics-${String(index)}.zip`)
      writeFileSync(path, `old ${String(index)}`)
      const modified = new Date(`2020-01-0${String(index)}T00:00:00Z`)
      utimesSync(path, modified, modified)
    }

    await exportDiagnosticsZip(logs, root)

    const archives = readdirSync(diagnostics).filter(name => name.endsWith('.zip')).sort()
    expect(archives).toHaveLength(3)
    expect(archives).not.toContain('diagnostics-1.zip')
  })

  it('includes only the newest logs that fit within the archive byte limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-limit-'))
    const logs = join(root, 'logs')
    mkdirSync(logs)
    const oldest = join(logs, 'dsh-2026-08-14.log')
    const middle = join(logs, 'dsh-2026-08-15.log')
    const newest = join(logs, 'dsh-2026-08-16.log')
    writeFileSync(oldest, 'oldest')
    writeFileSync(middle, 'middle')
    writeFileSync(newest, 'newest')
    utimesSync(oldest, new Date('2026-08-14T00:00:00Z'), new Date('2026-08-14T00:00:00Z'))
    utimesSync(middle, new Date('2026-08-15T00:00:00Z'), new Date('2026-08-15T00:00:00Z'))
    utimesSync(newest, new Date('2026-08-16T00:00:00Z'), new Date('2026-08-16T00:00:00Z'))

    const out = await exportDiagnosticsZip(logs, root, { maxLogBytes: 11 })

    const zip = new AdmZip(out)
    const names = zip.getEntries().map(entry => entry.entryName).sort()
    expect(names).toContain('dsh-2026-08-16.log')
    expect(names).not.toContain('dsh-2026-08-15.log')
    expect(names).not.toContain('dsh-2026-08-14.log')
    expect(zip.readAsText('system-info.txt')).toContain('omitted-log-files: 2')
  })
})
