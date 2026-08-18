/** Verify one Linux x64 AppImage and the unpacked Electron application. */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ELF_HEADER_BYTES = 20
const ELF_CLASS_64 = 2
const ELF_LITTLE_ENDIAN = 1
const ELF_MACHINE_X86_64 = 62

/** Paths returned after AppImage verification succeeds. */
export interface LinuxAppImageArtifacts {
  /** AppImage artifact path. */
  readonly appImagePath: string
  /** Unpacked Electron executable path. */
  readonly applicationPath: string
}

/** Injectable Linux AppImage verification boundary. */
export interface LinuxAppImageVerificationOptions {
  /** Dedicated directory containing the AppImage and linux-unpacked tree. */
  readonly distDir: string
  /** Product version embedded in the expected artifact name. */
  readonly version: string
  /** Stable executable and desktop-entry basename. */
  readonly executableName: string
  /** Create a private empty extraction directory. */
  readonly makeExtractionRoot: () => string
  /** Extract the AppImage into the supplied directory. */
  readonly extract: (appImagePath: string, extractionRoot: string) => void
  /** Remove the private extraction directory. */
  readonly removeExtractionRoot: (extractionRoot: string) => void
  /** Report portable file metadata for an artifact or extracted entry. */
  readonly stat: (path: string) => {
    readonly size: number
    readonly isFile: boolean
    readonly mode: number
  }
  /** Headless FUSE-less smoke that loads node-pty through the packaged Electron runtime. */
  readonly runNodePtySmoke?: (appImagePath: string) => void
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

function assertLinuxX64Executable(
  path: string,
  label: string,
  stat: LinuxAppImageVerificationOptions['stat'],
): void {
  let metadata: ReturnType<LinuxAppImageVerificationOptions['stat']>
  try {
    metadata = stat(path)
  } catch {
    throw new Error(`${label} is not a non-empty executable file: ${path}`)
  }
  if (!metadata.isFile || metadata.size < ELF_HEADER_BYTES || (metadata.mode & 0o111) === 0) {
    throw new Error(`${label} is not a non-empty executable file: ${path}`)
  }

  const descriptor = openSync(path, 'r')
  const header = Buffer.alloc(ELF_HEADER_BYTES)
  try {
    const bytesRead = readSync(descriptor, header, 0, header.byteLength, 0)
    if (
      bytesRead !== header.byteLength
      || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    ) {
      throw new Error(`${label} does not have an ELF header: ${path}`)
    }
    if (header[4] !== ELF_CLASS_64 || header[5] !== ELF_LITTLE_ENDIAN) {
      throw new Error(`${label} is not a little-endian 64-bit ELF file: ${path}`)
    }
    if (header.readUInt16LE(18) !== ELF_MACHINE_X86_64) {
      throw new Error(`${label} is not an x86-64 ELF file: ${path}`)
    }
  } finally {
    closeSync(descriptor)
  }
}

function assertRegularFile(
  path: string,
  label: string,
  stat: LinuxAppImageVerificationOptions['stat'],
): void {
  let metadata: ReturnType<LinuxAppImageVerificationOptions['stat']>
  try {
    metadata = stat(path)
  } catch {
    throw new Error(`${label} is not a non-empty regular file: ${path}`)
  }
  if (!metadata.isFile || metadata.size === 0) {
    throw new Error(`${label} is not a non-empty regular file: ${path}`)
  }
}

function assertExecutableFile(
  path: string,
  label: string,
  stat: LinuxAppImageVerificationOptions['stat'],
): void {
  let metadata: ReturnType<LinuxAppImageVerificationOptions['stat']>
  try {
    metadata = stat(path)
  } catch {
    throw new Error(`${label} is not a non-empty executable file: ${path}`)
  }
  if (!metadata.isFile || metadata.size === 0 || (metadata.mode & 0o111) === 0) {
    throw new Error(`${label} is not a non-empty executable file: ${path}`)
  }
}

function extract(appImagePath: string, extractionRoot: string): void {
  const result = spawnSync(appImagePath, ['--appimage-extract'], {
    cwd: extractionRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${appImagePath} --appimage-extract exited with ${String(result.status)}`)
  }
}

/**
 * Load node-pty from the sealed AppImage without opening a window or requiring FUSE.
 * AppRun adds --no-sandbox when user namespaces are unavailable; a private no-op
 * unshare shim keeps Electron's Node mode free of GUI-only flags for this smoke.
 */
function runNodePtySmoke(appImagePath: string): void {
  const shimRoot = mkdtempSync(join(tmpdir(), 'dsh-appimage-smoke-'))
  const unshareShim = join(shimRoot, 'unshare')
  writeFileSync(unshareShim, '#!/bin/sh\nexit 0\n')
  chmodSync(unshareShim, 0o755)
  const source = [
    "const {createRequire}=require('node:module')",
    "const {join}=require('node:path')",
    "const requirePackaged=createRequire(join(process.resourcesPath,'app.asar.unpacked','package.json'))",
    "const nodePty=requirePackaged('node-pty')",
    "if(typeof nodePty.spawn!=='function') throw new Error('node-pty spawn export missing')",
  ].join(';')
  try {
    const result = spawnSync(appImagePath, ['--appimage-extract-and-run', '-e', source], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PATH: `${shimRoot}${delimiter}${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120_000,
      maxBuffer: 128 * 1024,
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim()
      throw new Error(
        `${appImagePath} --appimage-extract-and-run node-pty smoke exited with ${String(result.status)}${stderr === undefined || stderr.length === 0 ? '' : `: ${stderr}`}`,
      )
    }
  } finally {
    rmSync(shimRoot, { recursive: true, force: true })
  }
}

function defaultOptions(): LinuxAppImageVerificationOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return {
    distDir: process.argv[2] === undefined
      ? join(desktopRoot, 'dist', 'linux')
      : resolve(process.argv[2]),
    version: readVersion(desktopRoot),
    executableName: 'dsh-plugin-desktop',
    makeExtractionRoot: () => mkdtempSync(join(tmpdir(), 'dsh-desktop-appimage-')),
    extract,
    removeExtractionRoot: root => rmSync(root, { recursive: true, force: true }),
    stat: path => {
      const result = statSync(path)
      return { size: result.size, isFile: result.isFile(), mode: result.mode }
    },
  }
}

function assertDesktopEntry(
  path: string,
  stat: LinuxAppImageVerificationOptions['stat'],
): void {
  assertRegularFile(path, 'AppImage desktop entry', stat)
  const content = readFileSync(path, 'utf8')
  for (const required of [
    /^\[Desktop Entry\]$/mu,
    /^Type=Application$/mu,
    /^Name=DSH Desktop$/mu,
    /^Exec=AppRun(?:\s|$)/mu,
  ]) {
    if (!required.test(content)) {
      throw new Error(`AppImage desktop entry is missing ${String(required)}: ${path}`)
    }
  }
  if (/^Exec=.*--no-sandbox(?:\s|$)/mu.test(content)) {
    throw new Error(`AppImage desktop entry must not disable the Chromium sandbox: ${path}`)
  }
}

/**
 * Verify the exact AppImage, unpacked runtime, and extracted desktop payload.
 * @param options - Artifact root and extraction boundaries.
 * @returns The verified artifact paths.
 */
export function verifyLinuxAppImage(
  options: LinuxAppImageVerificationOptions = defaultOptions(),
): LinuxAppImageArtifacts {
  const appImagePath = join(
    options.distDir,
    `DSH-Desktop-${options.version}-x86_64.AppImage`,
  )
  const unpackedRoot = join(options.distDir, 'linux-unpacked')
  const applicationPath = join(unpackedRoot, options.executableName)
  const appAsarPath = join(unpackedRoot, 'resources', 'app.asar')
  const nativeAddonRelative = join(
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'prebuilds',
    'linux-x64',
    'pty.node',
  )

  assertLinuxX64Executable(appImagePath, 'Linux AppImage', options.stat)
  assertLinuxX64Executable(applicationPath, 'unpacked Linux application', options.stat)
  assertRegularFile(appAsarPath, 'unpacked application archive', options.stat)
  assertLinuxX64Executable(
    join(unpackedRoot, nativeAddonRelative),
    'unpacked Linux node-pty addon',
    options.stat,
  )

  const extractionRoot = options.makeExtractionRoot()
  let failure: unknown
  try {
    options.extract(appImagePath, extractionRoot)
    const appDir = join(extractionRoot, 'squashfs-root')
    const appRunPath = join(appDir, 'AppRun')
    const desktopEntryPath = join(appDir, `${options.executableName}.desktop`)
    const packagedExecutable = join(appDir, options.executableName)
    const packagedAsar = join(appDir, 'resources', 'app.asar')
    const packagedNativeAddon = join(appDir, nativeAddonRelative)

    assertExecutableFile(appRunPath, 'AppImage launcher', options.stat)
    assertDesktopEntry(desktopEntryPath, options.stat)
    assertLinuxX64Executable(packagedExecutable, 'AppImage application', options.stat)
    assertRegularFile(packagedAsar, 'AppImage application archive', options.stat)
    assertLinuxX64Executable(packagedNativeAddon, 'AppImage Linux node-pty addon', options.stat)
    const smoke = options.runNodePtySmoke ?? runNodePtySmoke
    smoke(appImagePath)
  } catch (cause) {
    failure = cause
  }

  try {
    options.removeExtractionRoot(extractionRoot)
  } catch (cause) {
    const failures = failure === undefined ? [cause] : [failure, cause]
    throw new AggregateError(failures, `failed to verify Linux AppImage ${appImagePath}`)
  }
  if (failure !== undefined) throw failure

  return { appImagePath, applicationPath }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const verified = verifyLinuxAppImage()
    console.log(`Linux AppImage verification passed: ${verified.appImagePath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    if (error instanceof AggregateError) {
      for (const inner of error.errors) {
        console.error(`  ${inner instanceof Error ? inner.message : String(inner)}`)
      }
    }
    process.exitCode = 1
  }
}
