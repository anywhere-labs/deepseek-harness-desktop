import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyLinuxPackage } from '../scripts/verify-linux-package.ts'

const temporaryRoots: string[] = []

function debArchive(): Buffer {
  return Buffer.from('!<arch>\n')
}

function elfExecutable(): Buffer {
  return Buffer.from('\x7fELF')
}

function fixture(version = '2.0.0'): {
  readonly root: string
  readonly outputDir: string
  readonly deb: string
  readonly application: string
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-linux-package-'))
  temporaryRoots.push(root)
  const outputDir = join(root, 'dist', 'linux')
  const unpacked = join(outputDir, 'linux-unpacked')
  mkdirSync(unpacked, { recursive: true })
  const deb = join(outputDir, `DSH-Desktop-${version}-amd64.deb`)
  const application = join(unpacked, 'dsh-desktop')
  writeFileSync(deb, debArchive())
  writeFileSync(application, elfExecutable())
  return { root, outputDir, deb, application }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Linux deb artifact verification', () => {
  it('accepts the exact versioned deb archive and unpacked application', () => {
    const value = fixture()

    expect(verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toEqual({
      debPath: value.deb,
      applicationPath: value.application,
    })
  })

  it('rejects a stale deb from a different version', () => {
    const value = fixture('1.9.0')

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('DSH-Desktop-2.0.0-amd64.deb')
  })

  it('rejects an artifact without an ar archive header', () => {
    const value = fixture()
    writeFileSync(value.deb, Buffer.from('not-an-archive'))

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('does not have an ar archive header')
  })

  it('rejects an unpacked application without an ELF header', () => {
    const value = fixture()
    writeFileSync(value.application, Buffer.from('nope'))

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('does not have an ELF header')
  })
})
