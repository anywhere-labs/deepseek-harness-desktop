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

function dshShim(): Buffer {
  return Buffer.from('#!/bin/sh\nexport PATH="$APP_DIR/bin:$PATH"\nexec "$APP_DIR/dsh-desktop" --expose-internals "$APP_DIR/resources/app.asar/lib/desktop-cli.js" "$@"\n')
}

function pnpmShim(): Buffer {
  return Buffer.from('#!/bin/sh\nexec "$APP_DIR/dsh-desktop" --import "file://$BIN_DIR/clear-env.mjs" "$APP_DIR/resources/app.asar.unpacked/node_modules/pnpm/bin/pnpm.mjs" "$@"\n')
}

function fixture(version = '2.0.0'): {
  readonly root: string
  readonly outputDir: string
  readonly deb: string
  readonly rpm: string
  readonly appImage: string
  readonly application: string
  readonly dshCommand: string
  readonly pnpmCommand: string
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-linux-package-'))
  temporaryRoots.push(root)
  const outputDir = join(root, 'dist', 'linux')
  const unpacked = join(outputDir, 'linux-unpacked')
  const binDir = join(unpacked, 'bin')
  mkdirSync(binDir, { recursive: true })
  const deb = join(outputDir, `DSH-Desktop-${version}-amd64.deb`)
  const rpm = join(outputDir, `DSH-Desktop-${version}-x86_64.rpm`)
  const appImagePath = join(outputDir, `DSH-Desktop-${version}-x86_64.AppImage`)
  const application = join(unpacked, 'dsh-desktop')
  const dshCommand = join(unpacked, 'dsh')
  const pnpmCommand = join(binDir, 'pnpm')
  writeFileSync(deb, debArchive())
  writeFileSync(rpm, rpmArchive())
  writeFileSync(appImagePath, appImage(), { mode: 0o755 })
  writeFileSync(application, elfExecutable())
  writeFileSync(dshCommand, dshShim(), { mode: 0o755 })
  writeFileSync(pnpmCommand, pnpmShim(), { mode: 0o755 })
  return { root, outputDir, deb, rpm, appImage: appImagePath, application, dshCommand, pnpmCommand }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Linux package artifact verification', () => {
  it('accepts the exact versioned deb, rpm, AppImage, unpacked application, and dsh command', () => {
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
      dshCommandPath: value.dshCommand,
      pnpmCommandPath: value.pnpmCommand,
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

  it('rejects a missing unpacked dsh command', () => {
    const value = fixture()
    rmSync(value.dshCommand)

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('unpacked Linux dsh command is not an executable file')
  })

  it('rejects a non-executable unpacked dsh command', () => {
    const value = fixture()
    chmodSync(value.dshCommand, 0o644)

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('unpacked Linux dsh command is not an executable file')
  })

  it('rejects an unpacked dsh command without a shell shebang', () => {
    const value = fixture()
    writeFileSync(value.dshCommand, Buffer.from('not a script'), { mode: 0o755 })

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('unpacked Linux dsh command does not start with a shell shebang')
  })

  it('rejects an unpacked dsh command that does not dispatch the packaged CLI', () => {
    const value = fixture()
    writeFileSync(value.dshCommand, Buffer.from('#!/bin/sh\necho hello\n'), { mode: 0o755 })

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('is missing required dispatch markers')
  })

  it('rejects a missing unpacked pnpm command', () => {
    const value = fixture()
    rmSync(value.pnpmCommand)

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('unpacked Linux pnpm command is not an executable file')
  })

  it('rejects a non-executable unpacked pnpm command', () => {
    const value = fixture()
    chmodSync(value.pnpmCommand, 0o644)

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('unpacked Linux pnpm command is not an executable file')
  })

  it('rejects an unpacked pnpm command that does not dispatch the bundled pnpm', () => {
    const value = fixture()
    writeFileSync(value.pnpmCommand, Buffer.from('#!/bin/sh\necho nope\n'), { mode: 0o755 })

    expect(() => verifyLinuxPackage({
      desktopRoot: value.root,
      outputDir: value.outputDir,
      version: '2.0.0',
    })).toThrow('is missing required dispatch markers')
  })
})
