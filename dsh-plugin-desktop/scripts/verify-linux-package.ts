/** Verify the unsigned Linux x64 deb, rpm, AppImage, and unpacked executable. */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Paths returned after Linux package verification succeeds. */
export interface LinuxPackageArtifacts {
  /** deb archive path. */
  readonly debPath: string
  /** rpm archive path. */
  readonly rpmPath: string
  /** AppImage path. */
  readonly appImagePath: string
  /** Unpacked application executable path. */
  readonly applicationPath: string
  /** Unpacked dsh command shim path. */
  readonly dshCommandPath: string
  /** Unpacked bundled pnpm command shim path. */
  readonly pnpmCommandPath: string
}

/** Injectable Linux package verification boundary. */
export interface LinuxPackageVerificationOptions {
  /** Desktop package root containing package.json. */
  readonly desktopRoot: string
  /** Directory containing the completed packages and unpacked application. */
  readonly outputDir: string
  /** Product version embedded in the expected artifact name. */
  readonly version: string
}

function readVersion(desktopRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`desktop package at ${desktopRoot} has no valid version`)
  }
  return manifest.version
}

function assertMagic(path: string, label: string, magic: Buffer, minimumSize: number): void {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size < minimumSize) {
    throw new Error(`${label} is not a non-empty regular file: ${path}`)
  }
  const descriptor = openSync(path, 'r')
  const bytes = Buffer.alloc(magic.byteLength)
  try {
    const bytesRead = readSync(descriptor, bytes, 0, bytes.byteLength, 0)
    if (bytesRead !== bytes.byteLength || !bytes.equals(magic)) {
      throw new Error(`${label} does not have the expected header: ${path}`)
    }
  } finally {
    closeSync(descriptor)
  }
}

function assertDebArchive(path: string, label: string): void {
  assertMagic(path, label, Buffer.from('!<arch>\n'), 8)
}

function assertRpmArchive(path: string, label: string): void {
  assertMagic(path, label, Buffer.from([0xed, 0xab, 0xee, 0xdb]), 4)
}

function assertElfExecutable(path: string, label: string): void {
  assertMagic(path, label, Buffer.from('\x7fELF'), 4)
}

function assertAppImage(path: string, label: string): void {
  const stat = statSync(path)
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`${label} is not an executable file: ${path}`)
  }
  const header = Buffer.alloc(11)
  const descriptor = openSync(path, 'r')
  try {
    const bytesRead = readSync(descriptor, header, 0, header.byteLength, 0)
    if (bytesRead !== header.byteLength) {
      throw new Error(`${label} is too short to be an AppImage: ${path}`)
    }
  } finally {
    closeSync(descriptor)
  }
  // AppImage type 2 embeds the ELF magic at offset 0 and the "AI\x02" marker at offset 8.
  const isElf = header.subarray(0, 4).equals(Buffer.from('\x7fELF'))
  const isAppImage = header.subarray(8, 11).equals(Buffer.from('AI\x02'))
  if (!isElf || !isAppImage) {
    throw new Error(`${label} does not have an AppImage header: ${path}`)
  }
}

/**
 * Reject a packaged command that is not an executable shell script dispatching the expected entries.
 * @param path - packaged command file path.
 * @param label - human-readable command label used in failure messages.
 * @param markers - substrings the script must contain to prove it dispatches the intended entry.
 */
function assertExecutableScript(path: string, label: string, markers: readonly string[]): void {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} is not an executable file: ${path}`)
    }
    throw cause
  }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`${label} is not an executable file: ${path}`)
  }
  const content = readFileSync(path, 'utf8')
  if (!content.startsWith('#!/bin/sh')) {
    throw new Error(`${label} does not start with a shell shebang: ${path}`)
  }
  const missing = markers.filter(marker => !content.includes(marker))
  if (missing.length > 0) {
    throw new Error(`${label} is missing required dispatch markers: ${missing.join(', ')}`)
  }
}

function defaultOptions(): LinuxPackageVerificationOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return {
    desktopRoot,
    outputDir: process.argv[2] === undefined
      ? join(desktopRoot, 'dist', 'linux')
      : resolve(process.argv[2]),
    version: readVersion(desktopRoot),
  }
}

/**
 * Verify the exact deb, rpm, AppImage, unpacked application executable, and dsh/pnpm command shims.
 * @param options - Artifact root and expected product version.
 * @returns The verified artifact paths.
 */
export function verifyLinuxPackage(
  options: LinuxPackageVerificationOptions = defaultOptions(),
): LinuxPackageArtifacts {
  const debPath = join(options.outputDir, `DSH-Desktop-${options.version}-amd64.deb`)
  const rpmPath = join(options.outputDir, `DSH-Desktop-${options.version}-x86_64.rpm`)
  const appImagePath = join(options.outputDir, `DSH-Desktop-${options.version}-x86_64.AppImage`)
  const applicationPath = join(options.outputDir, 'linux-unpacked', 'dsh-desktop')
  const dshCommandPath = join(options.outputDir, 'linux-unpacked', 'dsh')
  const pnpmCommandPath = join(options.outputDir, 'linux-unpacked', 'bin', 'pnpm')

  assertDebArchive(debPath, 'Linux deb archive')
  assertRpmArchive(rpmPath, 'Linux rpm archive')
  assertAppImage(appImagePath, 'Linux AppImage')
  assertElfExecutable(applicationPath, 'unpacked Linux application')
  assertExecutableScript(dshCommandPath, 'unpacked Linux dsh command', [
    '--expose-internals',
    'desktop-cli.js',
    'APP_DIR/bin',
  ])
  assertExecutableScript(pnpmCommandPath, 'unpacked Linux pnpm command', ['pnpm.mjs'])
  return { debPath, rpmPath, appImagePath, applicationPath, dshCommandPath, pnpmCommandPath }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const verified = verifyLinuxPackage()
    console.log(
      `Linux package verification passed: ${verified.debPath}, ${verified.rpmPath}, ${verified.appImagePath}`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
