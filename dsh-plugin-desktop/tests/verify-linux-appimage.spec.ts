import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  verifyLinuxAppImage,
  type LinuxAppImageVerificationOptions,
} from '../scripts/verify-linux-appimage.ts'

const temporaryRoots: string[] = []

function elfX64(): Buffer {
  const executable = Buffer.alloc(64)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(executable)
  executable[4] = 2
  executable[5] = 1
  executable.writeUInt16LE(62, 18)
  return executable
}

function writeExecutable(path: string, content: string | Uint8Array = elfX64()): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

function fixture(version = '2.0.1'): {
  readonly root: string
  readonly appImage: string
  readonly application: string
  readonly options: LinuxAppImageVerificationOptions
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-linux-appimage-'))
  temporaryRoots.push(root)
  const dist = join(root, 'dist')
  const unpacked = join(dist, 'linux-unpacked')
  const resources = join(unpacked, 'resources')
  const nativeAddon = join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'prebuilds',
    'linux-x64',
    'pty.node',
  )
  mkdirSync(resources, { recursive: true })
  mkdirSync(join(nativeAddon, '..'), { recursive: true })

  const appImage = join(dist, `DSH-Desktop-${version}-x86_64.AppImage`)
  const application = join(unpacked, 'dsh-plugin-desktop')
  writeExecutable(appImage)
  writeExecutable(application)
  writeFileSync(join(resources, 'app.asar'), 'asar')
  writeExecutable(nativeAddon)

  let extractionRoot = ''
  const options: LinuxAppImageVerificationOptions = {
    distDir: dist,
    version: '2.0.1',
    executableName: 'dsh-plugin-desktop',
    makeExtractionRoot: () => {
      extractionRoot = mkdtempSync(join(tmpdir(), 'dsh-linux-appimage-extract-'))
      temporaryRoots.push(extractionRoot)
      return extractionRoot
    },
    extract: () => {
      const appDir = join(extractionRoot, 'squashfs-root')
      const packagedResources = join(appDir, 'resources')
      const packagedNativeAddon = join(
        packagedResources,
        'app.asar.unpacked',
        'node_modules',
        'node-pty',
        'prebuilds',
        'linux-x64',
        'pty.node',
      )
      mkdirSync(packagedResources, { recursive: true })
      mkdirSync(join(packagedNativeAddon, '..'), { recursive: true })
      writeExecutable(join(appDir, 'AppRun'), '#!/usr/bin/env bash\n')
      writeExecutable(join(appDir, 'dsh-plugin-desktop'))
      writeFileSync(join(packagedResources, 'app.asar'), 'asar')
      writeExecutable(packagedNativeAddon)
      writeFileSync(
        join(appDir, 'dsh-plugin-desktop.desktop'),
        '[Desktop Entry]\nType=Application\nName=DSH Desktop\nExec=AppRun %U\n',
      )
    },
    removeExtractionRoot: rootPath => rmSync(rootPath, { recursive: true, force: true }),
    stat: path => {
      const result = statSync(path)
      return { size: result.size, isFile: result.isFile(), mode: result.mode | 0o111 }
    },
  }
  return { root, appImage, application, options }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Linux AppImage artifact verification', () => {
  it('accepts one x64 AppImage and its extracted desktop runtime', () => {
    const value = fixture()

    expect(verifyLinuxAppImage(value.options)).toEqual({
      appImagePath: value.appImage,
      applicationPath: value.application,
    })
  })

  it('rejects a stale artifact from another version', () => {
    const value = fixture('1.9.0')

    expect(() => verifyLinuxAppImage(value.options))
      .toThrow('DSH-Desktop-2.0.1-x86_64.AppImage')
  })

  it('rejects an AppImage for another ELF architecture', () => {
    const value = fixture()
    const arm64 = elfX64()
    arm64.writeUInt16LE(183, 18)
    writeExecutable(value.appImage, arm64)

    expect(() => verifyLinuxAppImage(value.options)).toThrow('is not an x86-64 ELF file')
  })

  it('rejects a desktop entry that disables Chromium sandboxing', () => {
    const value = fixture()
    const originalExtract = value.options.extract
    const options: LinuxAppImageVerificationOptions = {
      ...value.options,
      extract: (appImagePath, extractionRoot) => {
        originalExtract(appImagePath, extractionRoot)
        writeFileSync(
          join(extractionRoot, 'squashfs-root', 'dsh-plugin-desktop.desktop'),
          '[Desktop Entry]\nType=Application\nName=DSH Desktop\nExec=AppRun --no-sandbox %U\n',
        )
      },
    }

    expect(() => verifyLinuxAppImage(options)).toThrow('must not disable the Chromium sandbox')
  })

  it('rejects an extracted payload without app.asar', () => {
    const value = fixture()
    const originalExtract = value.options.extract
    const options: LinuxAppImageVerificationOptions = {
      ...value.options,
      extract: (appImagePath, extractionRoot) => {
        originalExtract(appImagePath, extractionRoot)
        rmSync(
          join(extractionRoot, 'squashfs-root', 'resources', 'app.asar'),
        )
      },
    }

    expect(() => verifyLinuxAppImage(options)).toThrow('AppImage application archive')
  })
})
