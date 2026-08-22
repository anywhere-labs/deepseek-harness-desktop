import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyWindowsInstaller } from '../scripts/verify-win-installer.ts'
import { writeWslRuntimeBundleFixture } from './helpers/wsl-runtime-bundle.ts'

const temporaryRoots: string[] = []

function portableExecutable(): Buffer {
  const executable = Buffer.alloc(132)
  executable.write('MZ', 0, 'ascii')
  executable.writeUInt32LE(128, 0x3c)
  executable.write('PE\0\0', 128, 'binary')
  return executable
}

function fixture(version = '2.0.0'): {
  readonly root: string
  readonly installer: string
  readonly application: string
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-win-installer-'))
  temporaryRoots.push(root)
  const dist = join(root, 'dist')
  const unpacked = join(dist, 'win-unpacked')
  mkdirSync(unpacked, { recursive: true })
  const installer = join(dist, `DSH-Desktop-${version}-x64-Setup.exe`)
  const application = join(unpacked, 'DSH Desktop.exe')
  const runtimeBundle = join(unpacked, 'resources', 'wsl-runtime')
  writeFileSync(installer, portableExecutable())
  writeFileSync(application, portableExecutable())
  writeWslRuntimeBundleFixture(runtimeBundle, version)
  return { root, installer, application }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Windows installer artifact verification', () => {
  it('accepts the exact versioned NSIS installer and unpacked application', () => {
    const value = fixture()

    expect(verifyWindowsInstaller({ desktopRoot: value.root, version: '2.0.0' })).toEqual({
      installerPath: value.installer,
      applicationPath: value.application,
      runtimeBundlePath: join(value.root, 'dist', 'win-unpacked', 'resources', 'wsl-runtime'),
    })
  })

  it('rejects a stale installer from a different version', () => {
    const value = fixture('1.9.0')

    expect(() => verifyWindowsInstaller({ desktopRoot: value.root, version: '2.0.0' }))
      .toThrow('DSH-Desktop-2.0.0-x64-Setup.exe')
  })

  it('rejects an artifact without a Windows PE header', () => {
    const value = fixture()
    const invalid = portableExecutable()
    invalid.write('NO', 0, 'ascii')
    writeFileSync(value.installer, invalid)

    expect(() => verifyWindowsInstaller({ desktopRoot: value.root, version: '2.0.0' }))
      .toThrow('does not have a Windows PE header')
  })

  it('rejects an unpacked application without a Windows PE signature', () => {
    const value = fixture()
    const invalid = portableExecutable()
    invalid.fill(0, 128, 132)
    writeFileSync(value.application, invalid)

    expect(() => verifyWindowsInstaller({ desktopRoot: value.root, version: '2.0.0' }))
      .toThrow('does not have a Windows PE signature')
  })

  it('rejects an unpacked application whose WSL runtime bundle is missing', () => {
    const value = fixture()
    rmSync(join(value.root, 'dist', 'win-unpacked', 'resources', 'wsl-runtime', 'manifest.json'))
    expect(() => verifyWindowsInstaller({ desktopRoot: value.root, version: '2.0.0' }))
      .toThrow('manifest is unavailable')
  })
})
