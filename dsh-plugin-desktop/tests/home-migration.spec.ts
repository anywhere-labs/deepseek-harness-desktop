import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyHomeMigration, previewHomeMigration } from '../src/home-migration.ts'

function temporaryHome(label: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-home-${label}-`))
}

describe('data-home migration', () => {
  it('previews namespaces without embedding secret values', () => {
    const source = temporaryHome('src')
    const target = temporaryHome('dst')
    writeFileSync(join(source, 'settings.yaml'), [
      'llm-pi-ai:',
      '  providers:',
      '    cloud:',
      '      apiKeyEnv: CLOUD_KEY',
      'dsh-desktop:',
      '  mode: compatibility',
      '',
    ].join('\n'))
    writeFileSync(join(target, 'settings.yaml'), 'dsh-desktop:\n  mode: advanced\n')
    mkdirSync(join(source, 'sessions', 'alpha'), { recursive: true })
    writeFileSync(join(source, 'sessions', 'alpha', 'session.jsonl'), '{"type":"session"}\n')

    const preview = previewHomeMigration(source, target)
    expect(preview.source).toBe(source)
    expect(preview.target).toBe(target)
    expect(preview.token.length).toBeGreaterThan(8)
    const settings = preview.domains.find(domain => domain.domain === 'settings')
    expect(settings?.sourceNamespaces).toEqual(['dsh-desktop', 'llm-pi-ai'])
    expect(settings?.conflicts).toEqual(['dsh-desktop'])
    expect(JSON.stringify(preview)).not.toContain('CLOUD_KEY')
    expect(JSON.stringify(preview)).not.toContain('{"type":"session"}')
  })

  it('refuses a stale token and preserves conflicting settings names only', () => {
    const source = temporaryHome('src')
    const target = temporaryHome('dst')
    writeFileSync(join(source, 'settings.yaml'), 'extra:\n  keep: true\ndsh-desktop:\n  mode: compatibility\n')
    writeFileSync(join(target, 'settings.yaml'), 'dsh-desktop:\n  mode: advanced\n')
    expect(() => applyHomeMigration(source, target, 'stale')).toThrow('stale')

    const preview = previewHomeMigration(source, target)
    const result = applyHomeMigration(source, target, preview.token)
    expect(result.copied).toContain('settings.yaml:extra')
    expect(result.preserved.some(name => name.startsWith('settings.import-conflicts-'))).toBe(true)
    expect(readFileSync(join(target, 'settings.yaml'), 'utf8')).toContain('mode: advanced')
    expect(readFileSync(join(target, 'settings.yaml'), 'utf8')).toContain('extra:')
    const sidecar = result.preserved.find(name => name.startsWith('settings.import-conflicts-'))
    expect(sidecar).toBeDefined()
    const sidecarText = readFileSync(join(target, sidecar!), 'utf8')
    expect(sidecarText).toContain('dsh-desktop')
    expect(sidecarText).not.toContain('mode: compatibility')
  })

  it('copies missing session files and keeps a conflict beside the current copy', () => {
    const source = temporaryHome('src')
    const target = temporaryHome('dst')
    writeFileSync(join(source, 'settings.yaml'), 'dsh-desktop:\n  mode: compatibility\n')
    writeFileSync(join(target, 'settings.yaml'), 'dsh-desktop:\n  mode: advanced\n')
    mkdirSync(join(source, 'sessions', 'new'), { recursive: true })
    mkdirSync(join(source, 'sessions', 'shared'), { recursive: true })
    mkdirSync(join(target, 'sessions', 'shared'), { recursive: true })
    writeFileSync(join(source, 'sessions', 'new', 'session.jsonl'), 'source-new\n')
    writeFileSync(join(source, 'sessions', 'shared', 'session.jsonl'), 'source-shared\n')
    writeFileSync(join(target, 'sessions', 'shared', 'session.jsonl'), 'target-shared\n')

    const preview = previewHomeMigration(source, target)
    const result = applyHomeMigration(source, target, preview.token)
    expect(readFileSync(join(target, 'sessions', 'new', 'session.jsonl'), 'utf8')).toBe('source-new\n')
    expect(readFileSync(join(target, 'sessions', 'shared', 'session.jsonl'), 'utf8')).toBe('target-shared\n')
    expect(result.preserved.some(name => name.includes('session.jsonl.imported-'))).toBe(true)
  })
})
