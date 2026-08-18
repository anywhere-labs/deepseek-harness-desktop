/** Verify the unsigned Linux x64 deb package and unpacked executable. */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Paths returned after Linux deb verification succeeds. */
export interface LinuxPackageArtifacts {
  /** deb archive path. */
  readonly debPath: string
  /** Unpacked application executable path. */
  readonly applicationPath: string
}

/** Injectable Linux deb verification boundary. */
export interface LinuxPackageVerificationOptions {
  /** Desktop package root containing package.json. */
  readonly desktopRoot: string
  /** Directory containing the completed deb package and unpacked application. */
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

function assertDebArchive(path: string, label: string): void {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size < 8) {
    throw new Error(`${label} is not a non-empty regular file: ${path}`)
  }
  const descriptor = openSync(path, 'r')
  const magic = Buffer.alloc(8)
  try {
    const bytesRead = readSync(descriptor, magic, 0, magic.byteLength, 0)
    if (bytesRead !== magic.byteLength || !magic.equals(Buffer.from('!<arch>\n'))) {
      throw new Error(`${label} does not have an ar archive header: ${path}`)
    }
  } finally {
    closeSync(descriptor)
  }
}

function assertElfExecutable(path: string, label: string): void {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size < 4) {
    throw new Error(`${label} is not a non-empty regular file: ${path}`)
  }
  const descriptor = openSync(path, 'r')
  const magic = Buffer.alloc(4)
  try {
    const bytesRead = readSync(descriptor, magic, 0, magic.byteLength, 0)
    if (bytesRead !== magic.byteLength || !magic.equals(Buffer.from('\x7fELF'))) {
      throw new Error(`${label} does not have an ELF header: ${path}`)
    }
  } finally {
    closeSync(descriptor)
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
 * Verify the exact deb archive and unpacked application executable.
 * @param options - Artifact root and expected product version.
 * @returns The verified artifact paths.
 */
export function verifyLinuxPackage(
  options: LinuxPackageVerificationOptions = defaultOptions(),
): LinuxPackageArtifacts {
  const debPath = join(options.outputDir, `DSH-Desktop-${options.version}-amd64.deb`)
  const applicationPath = join(options.outputDir, 'linux-unpacked', 'dsh-desktop')

  assertDebArchive(debPath, 'Linux deb archive')
  assertElfExecutable(applicationPath, 'unpacked Linux application')
  return { debPath, applicationPath }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const verified = verifyLinuxPackage()
    console.log(`Linux deb verification passed: ${verified.debPath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
