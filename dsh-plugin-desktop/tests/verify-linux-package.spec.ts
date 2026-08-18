import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyLinuxPackage } from '../scripts/verify-linux-package.ts'

const temporaryRoots: string[] = []

function debArchive(): Buffer {
  return Buffer.from('!<arch>\n')
}

function rpmArchive(): Buffer {
  return Buffer.from([0xed, 0xab, 0xee, 0xdb])
}

function elfExecutable(): Buffer {
  return Buffer.from('\x7fELF')
}

function appImage(): Buffer {
  const image = Buffer.alloc(64)
  Buffer.from('\x7fELF').copy(image, 0)
  Buffer.from('AI\x02').copy(image, 8)
  return image
}

function fixture(version = '2.0.0'): {
  readonly root: string
  readonly outputDir: string
  readonly deb: string
  readonly rpm: string
  readonly appImage: string
  readonly application: string
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-linux-package-'))
  temporaryRoots.push(root)
  const outputDir = join(root, 'dist', 'linux')
  const unpacked = join(outputDir, 'linux-unpacked')
  mkdirSync(unpacked, { recursive: true })
  const deb = join(outputDir, `DSH-Desktop-${version}-amd64.deb`)
  const rpm = join(outputDir, `DSH-Desktop-${version}-x86_64.rpm`)
  const appImagePath = join(outputDir, `DSH-Desktop-${version}-x86_64.AppImage`)
  const application = join(unpacked, 'dsh-desktop')
  writeFileSync(deb, debArchive())
  writeFileSync(rpm, rpmArchive())
  writeFileSync(appImagePath, appImage(), { mode: 0o755 })
  writeFileSync(application, elfExecutable())
  return { root, outputDir, deb, rpm, appImage: appImagePath, application }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Linux package artifact verification', () => {
  it('accepts the exact versioned deb, rpm, AppImage, and unpacked application', () => {
    const value = fixture()

    expect(verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toEqual({
      debPath: value.deb,
      rpmPath: value.rpm,
      appImagePath: value.appImage,
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

  it('rejects a missing rpm from a different version', () => {
    const value = fixture()
    rmSync(value.rpm)

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('DSH-Desktop-2.0.0-x86_64.rpm')
  })

  it('rejects an artifact without an ar archive header', () => {
    const value = fixture()
    writeFileSync(value.deb, Buffer.from('not-an-archive'))

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('does not have the expected header')
  })

  it('rejects an artifact without an rpm lead magic', () => {
    const value = fixture()
    writeFileSync(value.rpm, Buffer.from('not-an-rpm'))

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('does not have the expected header')
  })

  it('rejects an AppImage without an AppImage header', () => {
    const value = fixture()
    const elfOnly = Buffer.alloc(64)
    Buffer.from('\x7fELF').copy(elfOnly, 0)
    writeFileSync(value.appImage, elfOnly, { mode: 0o755 })

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('does not have an AppImage header')
  })

  it('rejects an AppImage without the executable bit', () => {
    const value = fixture()
    chmodSync(value.appImage, 0o644)

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('is not an executable file')
  })

  it('rejects an unpacked application without an ELF header', () => {
    const value = fixture()
    writeFileSync(value.application, Buffer.from('nope'))

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('does not have the expected header')
  })
})
