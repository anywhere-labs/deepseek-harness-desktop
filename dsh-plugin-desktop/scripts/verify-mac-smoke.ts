/** Verify the unsigned application structure sealed inside one macOS smoke DMG. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MACOS_UNIVERSAL_NATIVE_ENTRIES } from './mac-universal.ts'

/** Injectable filesystem and command boundaries for smoke verification. */
export interface MacSmokeVerificationOptions {
  /** Directory containing exactly one smoke DMG. */
  readonly distDir: string
  /** Installed application name inside the mounted image. */
  readonly productName: string
  /** Return regular DMG files in the distribution directory. */
  readonly listDmgs: (distDir: string) => readonly string[]
  /** Create a private empty mount point. */
  readonly makeMountPoint: () => string
  /** Execute one macOS verification command. */
  readonly run: (command: string, args: readonly string[]) => void
  /** Remove the detached empty mount point. */
  readonly removeMountPoint: (mountPoint: string) => void
  /** Probe a physical path inside the mounted application. */
  readonly exists: (path: string) => boolean
  /** Report file metadata for a physical path inside the mounted application. */
  readonly stat: (path: string) => {
    readonly size: number
    readonly isFile: boolean
    readonly mode: number
  }
}

function listDmgs(distDir: string): readonly string[] {
  return readdirSync(distDir)
    .filter(name => name.endsWith('.dmg'))
    .map(name => join(distDir, name))
    .filter(path => statSync(path).isFile())
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function defaultOptions(): MacSmokeVerificationOptions {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return {
    distDir: process.argv[2] === undefined
      ? join(packageRoot, 'dist', 'mac-smoke')
      : resolve(process.argv[2]),
    productName: 'DSH Desktop',
    listDmgs,
    makeMountPoint: () => mkdtempSync(join(tmpdir(), 'dsh-desktop-dmg-smoke-')),
    run,
    removeMountPoint: mountPoint => rmdirSync(mountPoint),
    exists: existsSync,
    stat: path => {
      const result = statSync(path)
      return { size: result.size, isFile: result.isFile(), mode: result.mode }
    },
  }
}

/**
 * Mount and verify the application structure of the unique smoke DMG without
 * requiring code-signing material: signature, Gatekeeper, and stapler checks
 * remain exclusive to the signed release verification.
 * @param options - Filesystem and command boundaries.
 * @returns The verified DMG and application paths.
 */
export function verifyMacSmoke(
  options: MacSmokeVerificationOptions = defaultOptions(),
): { readonly appPath: string; readonly dmgPath: string } {
  const dmgs = options.listDmgs(options.distDir)
  if (dmgs.length !== 1) {
    throw new Error(
      `macOS DMG smoke verification requires exactly one DMG in ${options.distDir}; found ${String(dmgs.length)}`,
    )
  }

  const dmgPath = dmgs[0]!
  const mountPoint = options.makeMountPoint()
  const appPath = join(mountPoint, `${options.productName}.app`)
  let mounted = false
  let failure: unknown

  try {
    options.run('hdiutil', ['attach', dmgPath, '-mountpoint', mountPoint, '-nobrowse', '-readonly'])
    mounted = true

    const infoPlistPath = join(appPath, 'Contents', 'Info.plist')
    if (!options.exists(infoPlistPath)) {
      throw new Error(`packaged application is missing ${infoPlistPath}`)
    }
    options.run('plutil', ['-lint', infoPlistPath])

    const macosDirectory = join(appPath, 'Contents', 'MacOS')
    if (!options.exists(macosDirectory)) {
      throw new Error(`packaged application is missing ${macosDirectory}`)
    }
    const executablePath = join(macosDirectory, options.productName)
    if (!options.exists(executablePath)) {
      throw new Error(`packaged application is missing its main executable: ${executablePath}`)
    }
    const executableStat = options.stat(executablePath)
    if (
      !executableStat.isFile
      || executableStat.size === 0
      || (executableStat.mode & 0o111) === 0
    ) {
      throw new Error(`packaged application has an invalid main executable: ${executablePath}`)
    }
    options.run('lipo', [executablePath, '-verify_arch', 'x86_64'])
    options.run('lipo', [executablePath, '-verify_arch', 'arm64'])

    const appAsarPath = join(appPath, 'Contents', 'Resources', 'app.asar')
    if (!options.exists(appAsarPath)) {
      throw new Error(`packaged application is missing ${appAsarPath}`)
    }
    const appAsarStat = options.stat(appAsarPath)
    if (!appAsarStat.isFile || appAsarStat.size === 0) {
      throw new Error(`packaged application archive is empty: ${appAsarPath}`)
    }

    const unpackedRoot = `${appAsarPath}.unpacked`
    for (const entry of MACOS_UNIVERSAL_NATIVE_ENTRIES) {
      const nativePath = join(unpackedRoot, entry.path)
      if (!options.exists(nativePath)) {
        throw new Error(`universal application is missing ${nativePath}`)
      }
      const nativeStat = options.stat(nativePath)
      if (!nativeStat.isFile || nativeStat.size === 0) {
        throw new Error(`universal application has an invalid native file: ${nativePath}`)
      }
      if (entry.path.endsWith('/spawn-helper') && (nativeStat.mode & 0o111) === 0) {
        throw new Error(`universal application has a non-executable node-pty helper: ${nativePath}`)
      }
      options.run('lipo', [nativePath, '-verify_arch', entry.arch])
    }
  } catch (cause) {
    failure = cause
  }

  const cleanupFailures: unknown[] = []
  if (mounted) {
    try {
      options.run('hdiutil', ['detach', mountPoint])
    } catch (cause) {
      cleanupFailures.push(cause)
    }
  }
  try {
    options.removeMountPoint(mountPoint)
  } catch (cause) {
    cleanupFailures.push(cause)
  }

  if (failure !== undefined || cleanupFailures.length > 0) {
    const failures = failure === undefined ? cleanupFailures : [failure, ...cleanupFailures]
    throw new AggregateError(failures, `failed to verify macOS smoke DMG ${basename(dmgPath)}`)
  }
  return { appPath, dmgPath }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const verified = verifyMacSmoke()
    console.log(`macOS DMG smoke verification passed: ${verified.dmgPath}`)
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
