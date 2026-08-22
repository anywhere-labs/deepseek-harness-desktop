import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  verifyWslRuntimeBundle,
  WSL_RUNTIME_BUNDLE_MANIFEST,
} from '../src/wsl-runtime-bundle.ts'
import {
  FIXTURE_WSL_RUNTIME_VERSION,
  writeWslRuntimeBundleFixture,
} from './helpers/wsl-runtime-bundle.ts'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wsl-runtime-bundle-'))
  roots.push(root)
  writeWslRuntimeBundleFixture(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('WSL runtime bundle integrity', () => {
  it('accepts sealed package metadata and reports the manifest fingerprint', () => {
    const root = fixture()
    const bundle = verifyWslRuntimeBundle(root, FIXTURE_WSL_RUNTIME_VERSION)
    expect(bundle.manifest.packageCount).toBe(3)
    expect(bundle.manifestSha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('rejects a package source whose bytes changed after sealing', () => {
    const root = fixture()
    writeFileSync(join(root, 'sources', 'dsh-plugin-desktop-2.0.2.tgz'), 'tampered archive')
    expect(() => verifyWslRuntimeBundle(root)).toThrow('file size changed')
  })

  it('rejects lockfile drift even when an attacker rewrites its manifest hash', () => {
    const root = fixture()
    const lockPath = join(root, 'package-lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      packages: Record<string, { dependencies?: Record<string, string> }>
    }
    lock.packages['']!.dependencies!['@deepseek-ai/dsh'] = '0.1.1-rc.2'
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
    const manifestPath = join(root, WSL_RUNTIME_BUNDLE_MANIFEST)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Array<{ path: string, bytes: number, sha256: string }>
    }
    const record = manifest.files.find(file => file.path === 'package-lock.json')!
    const bytes = readFileSync(lockPath)
    record.bytes = bytes.length
    record.sha256 = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    expect(() => verifyWslRuntimeBundle(root)).toThrow('lockfile dependencies do not match')
  })

  it('rejects a product version different from the desktop release', () => {
    const root = fixture()
    expect(() => verifyWslRuntimeBundle(root, '2.0.3')).toThrow('does not match 2.0.3')
  })
})
