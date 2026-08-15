import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { redactDesktopDiagnostic } from '../src/startup-diagnostics.ts'
import { createDesktopStartupLogger } from '../src/startup-log.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('desktop startup diagnostics', () => {
  it('redacts credential assignments, bearer tokens and DeepSeek-style keys', () => {
    const diagnostic = redactDesktopDiagnostic([
      'DEEPSEEK_API_KEY=sk-secretvalue123',
      'TOKEN:plain-secret',
      'Authorization: Bearer bearer-secret',
      'ordinary failure',
    ].join('\n'))

    expect(diagnostic).toContain('DEEPSEEK_API_KEY=[REDACTED]')
    expect(diagnostic).toContain('TOKEN:[REDACTED]')
    expect(diagnostic).toContain('Bearer [REDACTED]')
    expect(diagnostic).toContain('ordinary failure')
    expect(diagnostic).not.toContain('secretvalue')
    expect(diagnostic).not.toContain('plain-secret')
    expect(diagnostic).not.toContain('bearer-secret')
  })

  it('writes only structured fields to the daily application log', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-log-'))
    temporaryDirectories.push(directory)
    const logger = createDesktopStartupLogger(directory, '1.2.3', 'darwin')
    logger.write({ event: 'starting-normal', mode: 'normal', elapsedMs: 12 })

    const date = new Date().toISOString().slice(0, 10)
    expect(JSON.parse(readFileSync(join(directory, `desktop-startup-${date}.jsonl`), 'utf8'))).toMatchObject({
      version: '1.2.3',
      platform: 'darwin',
      event: 'starting-normal',
      mode: 'normal',
      elapsedMs: 12,
    })
  })
})
