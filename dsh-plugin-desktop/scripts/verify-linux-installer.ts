/** Verify the unsigned Linux x64 deb, rpm, AppImage, and unpacked application. */

import { closeSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Paths returned after Linux artifact verification succeeds. */
export interface LinuxInstallerArtifacts {
  /** Debian package path. */
  readonly debPath: string
  /** RPM package path. */
  readonly rpmPath: string
  /** AppImage path. */
  readonly appImagePath: string
  /** Unpacked application executable path. */
  readonly applicationPath: string
}

/** Injectable Linux artifact verification boundary. */
export interface LinuxInstallerVerificationOptions {
  /** Desktop package root containing package.json and dist. */
  readonly desktopRoot: string
  /** Product version embedded in the expected artifact names. */
  readonly version: string
}

/** Leading bytes of a Debian binary package, which is an ar archive. */
const AR_MAGIC = Buffer.from('!<arch>\n', 'ascii')
/** Leading bytes of the RPM lead structure. */
const RPM_MAGIC = Buffer.from([0xed, 0xab, 0xee, 0xdb])
/** Leading bytes of an ELF executable; an AppImage is an ELF runtime plus squashfs. */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])

function readVersion(desktopRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`desktop package at ${desktopRoot} has no valid version`)
  }
  return manifest.version
}

function assertSignature(path: string, label: string, magic: Buffer): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size < magic.byteLength) {
    throw new Error(`${label} is not a non-empty regular file: ${path}`)
  }
  const descriptor = openSync(path, 'r')
  const header = Buffer.alloc(magic.byteLength)
  try {
    const bytesRead = readSync(descriptor, header, 0, header.byteLength, 0)
    if (bytesRead !== header.byteLength || !header.equals(magic)) {
      throw new Error(`${label} does not start with the expected signature: ${path}`)
    }
  } finally {
    closeSync(descriptor)
  }
}

function defaultOptions(): LinuxInstallerVerificationOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return {
    desktopRoot,
    version: readVersion(desktopRoot),
  }
}

/**
 * Verify the exact Linux artifacts produced by one packaging run.
 * @param options - Artifact root and expected product version.
 * @returns The verified artifact paths.
 */
export function verifyLinuxInstallers(
  options: LinuxInstallerVerificationOptions = defaultOptions(),
): LinuxInstallerArtifacts {
  const distDir = join(options.desktopRoot, 'dist')
  const debPath = join(distDir, `DSH-Desktop-${options.version}-linux-amd64.deb`)
  const rpmPath = join(distDir, `DSH-Desktop-${options.version}-linux-x86_64.rpm`)
  const appImagePath = join(distDir, `DSH-Desktop-${options.version}-linux-x86_64.AppImage`)
  const applicationPath = join(distDir, 'linux-unpacked', 'dsh-desktop')

  assertSignature(debPath, 'Linux deb package', AR_MAGIC)
  assertSignature(rpmPath, 'Linux rpm package', RPM_MAGIC)
  assertSignature(appImagePath, 'Linux AppImage', ELF_MAGIC)
  assertSignature(applicationPath, 'unpacked Linux application', ELF_MAGIC)
  return { debPath, rpmPath, appImagePath, applicationPath }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const verified = verifyLinuxInstallers()
    console.log(`Linux installer verification passed: ${verified.debPath}, ${verified.rpmPath}, ${verified.appImagePath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
