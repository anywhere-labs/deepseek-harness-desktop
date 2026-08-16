import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { markDesktopUpdateMetadata } from '../scripts/mark-update-metadata.ts'
import { verifyDesktopReleaseVersion } from '../scripts/verify-release-version.ts'
import {
  expectedDesktopArtifacts,
  verifyDesktopUpdateArtifacts,
} from '../scripts/verify-update-artifacts.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-update-artifacts-'))
  roots.push(root)
  return root
}

function digest(value: Buffer, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): string {
  return createHash(algorithm).update(value).digest(encoding)
}

function writeMetadata(
  root: string,
  name: string,
  version: string,
  mode: 'automatic' | 'manual',
  files: readonly string[],
): void {
  const entries = files.map((filename) => {
    const value = readFileSync(join(root, filename))
    return { url: filename, sha512: digest(value, 'sha512', 'base64'), size: value.byteLength }
  })
  writeFileSync(join(root, name), stringify({
    version,
    files: entries,
    path: entries[0]!.url,
    sha512: entries[0]!.sha512,
    desktopUpdateMode: mode,
  }))
}

function completeArtifacts(version = '2.0.1', windowsMode: 'automatic' | 'manual' = 'manual'): string {
  const root = temporaryRoot()
  const names = expectedDesktopArtifacts(version)
  for (const name of names) {
    if (!name.endsWith('.yml')) writeFileSync(join(root, name), Buffer.from(`artifact:${name}`))
  }
  writeMetadata(root, 'latest-mac.yml', version, 'automatic', [names[1]!])
  writeMetadata(root, 'latest.yml', version, windowsMode, [names[3]!])
  writeFileSync(join(root, 'macos-verified.txt'), 'signed=true\nnotarized=true\n')
  writeFileSync(join(root, 'windows-verified.txt'), windowsMode === 'automatic'
    ? 'signed=true\n'
    : 'signed=false\ninstall=manual\n')
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop release version', () => {
  it('requires the tag and both package versions to match', () => {
    const root = temporaryRoot()
    const workspace = join(root, 'package.json')
    const desktop = join(root, 'desktop.json')
    writeFileSync(workspace, '{"version":"2.0.1"}\n')
    writeFileSync(desktop, '{"version":"2.0.1"}\n')

    expect(verifyDesktopReleaseVersion('v2.0.1', workspace, desktop)).toBe('2.0.1')
    expect(() => verifyDesktopReleaseVersion('v2.0.2', workspace, desktop)).toThrow('must equal v2.0.1')
    writeFileSync(desktop, '{"version":"2.0.2"}\n')
    expect(() => verifyDesktopReleaseVersion('v2.0.1', workspace, desktop)).toThrow('must equal desktop package')
  })
})

describe('update metadata marking', () => {
  it('adds and replaces one target capability field', () => {
    const path = join(temporaryRoot(), 'latest.yml')
    writeFileSync(path, 'version: 2.0.1\n')
    markDesktopUpdateMetadata(path, 'manual')
    markDesktopUpdateMetadata(path, 'automatic')
    expect(readFileSync(path, 'utf8')).toBe('version: 2.0.1\ndesktopUpdateMode: automatic\n')
  })
})

describe('complete updater artifact verification', () => {
  it.each(['manual', 'automatic'] as const)('accepts a verified %s Windows release', (mode) => {
    const root = completeArtifacts('2.0.1', mode)
    const sums = verifyDesktopUpdateArtifacts(root, '2.0.1')

    expect(sums.split('\n').filter(Boolean)).toHaveLength(6)
    for (const name of expectedDesktopArtifacts('2.0.1')) {
      expect(sums).toContain(`${digest(readFileSync(join(root, name)), 'sha256', 'hex')}  ${name}`)
    }
  })

  it('rejects stale size or SHA-512 metadata before publication', () => {
    const root = completeArtifacts()
    const path = join(root, 'latest.yml')
    writeFileSync(path, readFileSync(path, 'utf8').replace(/size: \d+/u, 'size: 1'))
    expect(() => verifyDesktopUpdateArtifacts(root, '2.0.1')).toThrow('size and SHA-512')
  })

  it('rejects mismatched target capability and verification markers', () => {
    const root = completeArtifacts('2.0.1', 'manual')
    writeFileSync(join(root, 'windows-verified.txt'), 'signed=true\n')
    expect(() => verifyDesktopUpdateArtifacts(root, '2.0.1')).toThrow('must declare automatic')
  })
})
