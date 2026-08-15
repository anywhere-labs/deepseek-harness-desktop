import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listInstalledRuntimes, resolveRuntime } from '../src/runtime-manager/versions.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-desktop-versions-'))
}

function fakeBundled(version: string) {
  return {
    version,
    paths: { nodeExecutable: 'node', cliEntry: '/bundled/bin.js', cwd: '/home/u', electronRunAsNode: false },
  }
}

function installFakeRuntime(userDataDir: string, version: string): void {
  const entry = join(userDataDir, 'runtime-versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(entry, { recursive: true })
  writeFileSync(join(entry, 'bin.js'), '')
}

describe('runtime inventory and resolution', () => {
  it('resolves to the bundled runtime by default', () => {
    const dir = tempDir()
    try {
      const runtime = resolveRuntime(dir, undefined, fakeBundled('0.1.0-rc.6'), '/home/u')
      expect(runtime.version).toBe('0.1.0-rc.6')
      expect(runtime.bundled).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a global pin to an installed managed runtime', () => {
    const dir = tempDir()
    try {
      installFakeRuntime(dir, '0.1.0-rc.8')
      const runtime = resolveRuntime(dir, '0.1.0-rc.8', fakeBundled('0.1.0-rc.6'), '/home/u')
      expect(runtime.version).toBe('0.1.0-rc.8')
      expect(runtime.bundled).toBe(false)
      expect(runtime.paths.cliEntry).toContain('runtime-versions/0.1.0-rc.8')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to bundled when the pin is not installed', () => {
    const dir = tempDir()
    try {
      const runtime = resolveRuntime(dir, '0.1.0-rc.9', fakeBundled('0.1.0-rc.6'), '/home/u')
      expect(runtime.version).toBe('0.1.0-rc.6')
      expect(runtime.bundled).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lists bundled plus managed installations', () => {
    const dir = tempDir()
    try {
      installFakeRuntime(dir, '0.1.0-rc.7')
      installFakeRuntime(dir, '0.1.0-rc.8')
      mkdirSync(join(dir, 'runtime-versions', 'incomplete'), { recursive: true })
      const runtimes = listInstalledRuntimes(dir, fakeBundled('0.1.0-rc.6'))
      expect(runtimes.map(r => r.version)).toEqual(['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8'])
      expect(runtimes[0]?.bundled).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
