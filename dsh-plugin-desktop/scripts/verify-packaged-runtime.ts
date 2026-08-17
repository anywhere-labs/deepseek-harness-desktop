/** Fail-loud verification of the runtime entries sealed into Electron's app.asar. */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'
import { listPackage } from '@electron/asar'
import {
  FORBIDDEN_MACOS_UNIVERSAL_ENTRIES,
  MACOS_UNIVERSAL_NATIVE_ENTRIES,
} from './mac-universal.ts'

/** AfterPack fields consumed without importing Electron Builder's incomplete declaration graph. */
export interface PackagedRuntimeContext {
  /** Completed platform application directory. */
  readonly appOutDir: string
  /** Electron Builder target architecture (`4` is its stable universal enum value). */
  readonly arch?: number
  /** Electron target platform selected by the packager. */
  readonly electronPlatformName: string
  /** Product metadata used to locate the macOS application bundle. */
  readonly packager: {
    readonly appInfo: {
      readonly productFilename: string
    }
  }
}

/** Exact archive entries required by the desktop launcher on every supported platform. */
export const REQUIRED_PACKAGED_RUNTIME_ENTRIES = [
  'package.json',
  'lib/main.js',
  'lib/client.js',
  'lib/profile.js',
  'lib/profile-manager.js',
  'lib/profile-service.js',
  'lib/pnpm.js',
  'lib/profiles.js',
  'lib/desktop-cli.js',
  'lib/desktop-runtime-environment.js',
  'lib/desktop-terminal.js',
  'lib/terminal.js',
  'lib/update-checker.js',
  'lib/update-download.js',
  'lib/updates.js',
  'lib/windows-acl-runner.js',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  'node_modules/pnpm/bin/pnpm.mjs',
] as const

/** Physical entries required because profile fallback symlinks cannot target ASAR paths. */
export const REQUIRED_UNPACKED_RUNTIME_ENTRIES = [
  'package.json',
  'cordis.patch.yml',
  'build/app-icon.png',
  'build/app-icon-mac.png',
  'build/tray-iconTemplate.png',
  'build/tray-icon-blue.png',
  'lib/main.js',
  'lib/client.js',
  'lib/index.js',
  'lib/profile.js',
  'lib/profile-manager.js',
  'lib/profile-service.js',
  'lib/pnpm.js',
  'lib/profiles.js',
  'lib/terminal.js',
  'lib/update-download.js',
  'lib/updates.js',
  'lib/windows-pwsh-sandbox.js',
  'node_modules/@deepseek-ai/dsh/package.json',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'node_modules/pnpm/bin/pnpm.mjs',
] as const

/** Prebuilt Node-API modules required when the Windows package skips native source rebuilds. */
export const REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES = [
  'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
  'node_modules/node-pty/prebuilds/win32-x64/pty.node',
  'node_modules/node-pty/prebuilds/win32-x64/winpty-agent.exe',
  'node_modules/node-pty/prebuilds/win32-x64/winpty.dll',
] as const

/** CPU-specific runtime assets that must coexist in a universal macOS application. */
export const REQUIRED_MACOS_UNIVERSAL_ENTRIES = [
  ...MACOS_UNIVERSAL_NATIVE_ENTRIES.map(entry => entry.path),
] as const

/** Package exports that profile fallback links must resolve from the physical application tree. */
export const REQUIRED_UNPACKED_PACKAGE_SPECIFIERS = [
  'dsh-plugin-desktop',
  'dsh-plugin-desktop/profile',
  'dsh-plugin-desktop/client',
  'dsh-plugin-desktop/terminal',
  'dsh-plugin-desktop/pnpm',
  'dsh-plugin-desktop/profile-service',
  'dsh-plugin-desktop/profiles',
  'dsh-plugin-desktop/updates',
  'dsh-plugin-desktop/windows-pwsh-sandbox',
  'dsh-plugin-desktop/package.json',
  '@deepseek-ai/dsh-base/package.json',
  '@deepseek-ai/dsh-web-app/package.json',
] as const

/** Injectable archive listing seam used by focused tests. */
export type ArchiveLister = (archivePath: string, options: { isPack: boolean }) => readonly string[]

/** Injectable physical-file probe used by focused tests. */
export type FileProbe = (filename: string) => boolean

/** Injectable Node package resolver used by focused tests. */
export type PackageResolver = (specifier: string) => string

/**
 * Resolve the platform-specific archive produced by Electron Builder.
 * @param context - completed application directory and target platform.
 * @returns absolute path to the packaged app.asar.
 */
export function resolvePackagedAsarPath(context: PackagedRuntimeContext): string {
  if (context.electronPlatformName === 'darwin') {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'app.asar',
    )
  }
  if (context.electronPlatformName === 'win32' || context.electronPlatformName === 'linux') {
    return join(context.appOutDir, 'resources', 'app.asar')
  }
  throw new Error(
    `dsh-plugin-desktop: unsupported Electron afterPack platform ${JSON.stringify(context.electronPlatformName)}`,
  )
}

/**
 * Resolve the physical dependency tree emitted beside app.asar.
 * @param context - completed application directory and target platform.
 * @returns absolute path to app.asar.unpacked.
 */
export function resolvePackagedUnpackedRoot(context: PackagedRuntimeContext): string {
  return `${resolvePackagedAsarPath(context)}.unpacked`
}

/** Normalize the host-specific separators emitted by the ASAR reader. */
function normalizeArchiveEntry(entry: string): string {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Inspect one archive and reject an incomplete packaged runtime.
 * @param archivePath - resolved app.asar path.
 * @param list - ASAR listing implementation.
 * @returns Nothing; failure rejects the package before signing.
 */
export function verifyPackagedAsar(
  archivePath: string,
  list: ArchiveLister = listPackage,
): void {
  let entries: readonly string[]
  try {
    entries = list(archivePath, { isPack: false })
  } catch (cause) {
    throw new Error(
      `dsh-plugin-desktop: failed to inspect packaged runtime at ${archivePath}`,
      { cause },
    )
  }

  const present = new Set(entries.map(normalizeArchiveEntry))
  const missing = REQUIRED_PACKAGED_RUNTIME_ENTRIES.filter(entry => !present.has(entry))
  if (missing.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${archivePath} is missing required ASAR entries: ${missing.join(', ')}`,
    )
  }
}

/**
 * Verify package exports resolve through the physical tree instead of the build workspace.
 * @param unpackedRoot - absolute path to app.asar.unpacked.
 * @param resolvePackage - package resolver anchored at the physical root manifest.
 * @returns Nothing; failure rejects missing exports and paths outside app.asar.unpacked.
 */
export function verifyUnpackedPackageResolution(
  unpackedRoot: string,
  resolvePackage: PackageResolver = createRequire(join(unpackedRoot, 'package.json')).resolve,
): void {
  for (const specifier of REQUIRED_UNPACKED_PACKAGE_SPECIFIERS) {
    let resolvedPath: string
    try {
      resolvedPath = resolvePackage(specifier)
    } catch (cause) {
      throw new Error(
        `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} cannot resolve required package export ${specifier}`,
        { cause },
      )
    }

    const relativePath = relative(unpackedRoot, resolvedPath)
    if (
      !isAbsolute(resolvedPath)
      || relativePath === '..'
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      throw new Error(
        `dsh-plugin-desktop: required package export ${specifier} resolved outside ${unpackedRoot}: ${resolvedPath}`,
      )
    }
  }
}

/**
 * Verify Electron Builder's completed application before signing begins.
 * @param context - Electron Builder's afterPack context.
 * @param list - ASAR listing implementation.
 * @param exists - physical-file probe for the unpacked CLI dependency tree.
 * @param resolvePackage - package resolver anchored at the physical root manifest.
 * @returns Nothing; failure rejects the package before signing.
 */
export function verifyPackagedRuntime(
  context: PackagedRuntimeContext,
  list: ArchiveLister = listPackage,
  exists: FileProbe = existsSync,
  resolvePackage?: PackageResolver,
): void {
  verifyPackagedAsar(resolvePackagedAsarPath(context), list)
  const unpackedRoot = resolvePackagedUnpackedRoot(context)
  const requiredPhysicalEntries = context.electronPlatformName === 'win32'
    ? [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES]
    : context.electronPlatformName === 'darwin' && context.arch === 4
      ? [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_MACOS_UNIVERSAL_ENTRIES]
      : REQUIRED_UNPACKED_RUNTIME_ENTRIES
  const missing = requiredPhysicalEntries.filter(entry => !exists(join(unpackedRoot, entry)))
  if (missing.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} is missing required physical entries: ${missing.join(', ')}`,
    )
  }
  if (context.electronPlatformName === 'darwin' && context.arch === 4) {
    const forbidden = FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
      .filter(entry => exists(join(unpackedRoot, entry)))
    if (forbidden.length > 0) {
      throw new Error(
        `dsh-plugin-desktop: universal macOS runtime at ${unpackedRoot} contains host-architecture build output: ${forbidden.join(', ')}`,
      )
    }
  }
  verifyUnpackedPackageResolution(unpackedRoot, resolvePackage)
}

/**
 * Run the static packaged-runtime check as Electron Builder's afterPack hook.
 * @param context - Electron Builder's afterPack context.
 * @returns A promise that rejects before signing when the runtime is incomplete.
 */
export async function afterPack(context: PackagedRuntimeContext): Promise<void> {
  verifyPackagedRuntime(context)
}

export default afterPack
