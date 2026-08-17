import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  REQUIRED_MACOS_UNIVERSAL_ENTRIES,
  REQUIRED_UNPACKED_PACKAGE_SPECIFIERS,
  REQUIRED_UNPACKED_RUNTIME_ENTRIES,
  REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES,
  resolvePackagedAsarPath,
  resolvePackagedUnpackedRoot,
  verifyPackagedRuntime,
  type ArchiveLister,
  type FileProbe,
  type PackageResolver,
  type PackagedRuntimeContext,
} from '../scripts/verify-packaged-runtime.ts'
import { FORBIDDEN_MACOS_UNIVERSAL_ENTRIES } from '../scripts/mac-universal.ts'

function context(
  appOutDir: string,
  electronPlatformName: string,
  arch?: number,
): PackagedRuntimeContext {
  return {
    appOutDir,
    electronPlatformName,
    ...(arch === undefined ? {} : { arch }),
    packager: { appInfo: { productFilename: 'DSH Desktop' } },
  }
}

function completeArchiveEntries(separator = '/'): string[] {
  return REQUIRED_PACKAGED_RUNTIME_ENTRIES.map(entry => `${separator}${entry.replaceAll('/', separator)}`)
}

function completePackageResolver(unpackedRoot: string): PackageResolver {
  return specifier => join(unpackedRoot, 'resolved', `${specifier.replaceAll('/', '-')}.js`)
}

describe('packaged desktop runtime verification', () => {
  it.each([
    [
      'darwin',
      join('/build', 'DSH Desktop.app', 'Contents', 'Resources', 'app.asar'),
    ],
    [
      'win32',
      join('/build', 'resources', 'app.asar'),
    ],
  ])('inspects the %s app.asar path', (platform, expectedPath) => {
    const list = vi.fn<ArchiveLister>(() => completeArchiveEntries(platform === 'win32' ? '\\' : '/'))

    const exists = vi.fn<FileProbe>(() => true)
    const unpackedRoot = `${expectedPath}.unpacked`
    const resolvePackage = vi.fn<PackageResolver>(completePackageResolver(unpackedRoot))

    verifyPackagedRuntime(context('/build', platform), list, exists, resolvePackage)

    expect(resolvePackagedAsarPath(context('/build', platform))).toBe(expectedPath)
    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(expectedPath, { isPack: false })
    expect(resolvePackagedUnpackedRoot(context('/build', platform))).toBe(unpackedRoot)
    expect(exists).toHaveBeenCalledTimes(
      REQUIRED_UNPACKED_RUNTIME_ENTRIES.length
        + (platform === 'win32' ? REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES.length : 0),
    )
    expect(resolvePackage.mock.calls.map(([specifier]) => specifier))
      .toEqual(REQUIRED_UNPACKED_PACKAGE_SPECIFIERS)
  })

  it('rejects an unsupported platform instead of guessing an archive layout', () => {
    expect(() => resolvePackagedAsarPath(context('/build', 'mas')))
      .toThrow('unsupported Electron afterPack platform "mas"')
  })

  it('requires both CPU variants from a universal macOS runtime', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const missing = 'node_modules/@vscode/ripgrep-darwin-x64/bin/rg'

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename !== join(unpackedRoot, missing),
      completePackageResolver(unpackedRoot),
    )).toThrow(`missing required physical entries: ${missing}`)

    const exists = vi.fn<FileProbe>(filename => !FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
      .some(entry => filename === join(unpackedRoot, entry)))
    verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      exists,
      completePackageResolver(unpackedRoot),
    )
    expect(exists).toHaveBeenCalledTimes(
      REQUIRED_UNPACKED_RUNTIME_ENTRIES.length
        + REQUIRED_MACOS_UNIVERSAL_ENTRIES.length
        + FORBIDDEN_MACOS_UNIVERSAL_ENTRIES.length,
    )
  })

  it('rejects a host-architecture node-pty build from a universal app', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const forbidden = FORBIDDEN_MACOS_UNIVERSAL_ENTRIES[0]

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename === join(unpackedRoot, forbidden)
        || !FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
          .some(entry => filename === join(unpackedRoot, entry)),
      completePackageResolver(unpackedRoot),
    )).toThrow(`contains host-architecture build output: ${forbidden}`)
  })

  it.each([
    'lib/client.js',
    'lib/desktop-runtime-environment.js',
    'lib/profile-service.js',
    'lib/pnpm.js',
    'lib/update-download.js',
  ])('fails loud when required runtime entry %s is absent', (missing) => {
    const entries = completeArchiveEntries().filter(entry => entry !== `/${missing}`)

    expect(() => verifyPackagedRuntime(context('/build', 'win32'), () => entries, () => true))
      .toThrow(`missing required ASAR entries: ${missing}`)
  })

  it.each([
    'package.json',
    'build/app-icon-mac.png',
    'build/tray-iconTemplate.png',
    'lib/terminal.js',
    'lib/update-download.js',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/pnpm/bin/pnpm.mjs',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  ])('fails loud when physical runtime entry %s is absent from app.asar.unpacked', (missing) => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const missingPath = join(unpackedRoot, missing)

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename !== missingPath,
      completePackageResolver(unpackedRoot),
    )).toThrow(`missing required physical entries: ${missing}`)
  })

  it('fails loud when a required package export cannot resolve from app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const resolvePackage = vi.fn<PackageResolver>((specifier) => {
      if (specifier === 'dsh-plugin-desktop/profiles') {
        throw new Error('missing export')
      }
      return completePackageResolver(unpackedRoot)(specifier)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      () => true,
      resolvePackage,
    )).toThrow(
      `packaged runtime at ${unpackedRoot} cannot resolve required package export dsh-plugin-desktop/profiles`,
    )
  })

  it('fails loud when a required package export escapes app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const escapedPath = join('/workspace', 'node_modules', '@deepseek-ai', 'dsh-base', 'lib', 'index.js')
    const resolvePackage = vi.fn<PackageResolver>((specifier) => {
      if (specifier === '@deepseek-ai/dsh-base/package.json') return escapedPath
      return completePackageResolver(unpackedRoot)(specifier)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      () => true,
      resolvePackage,
    )).toThrow(
      `required package export @deepseek-ai/dsh-base/package.json resolved outside ${unpackedRoot}: ${escapedPath}`,
    )
  })
})
