/**
 * Runtime inventory + resolution. A runtime installation is a directory
 * containing `node_modules/@deepseek-ai/dsh/lib/bin.js` plus the web
 * frontend dist. The bundled runtime ships inside the app resources; the
 * version manager installs additional runtimes under the Desktop data dir
 * (`userData/runtime-versions/<version>/`).
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface RuntimePaths {
  /** Node-compatible executable that boots the Host. */
  nodeExecutable: string
  /** Official Host CLI entry (bin.js). */
  cliEntry: string
  /** Working directory passed to the Host (DSH data stays in ~/.dsh). */
  cwd: string
  /** True when the Host runs inside Electron (packaged mode). */
  electronRunAsNode: boolean
}

export interface RuntimeInstallation {
  version: string
  bundled: boolean
  paths: RuntimePaths
}

export function runtimeInstallationDir(userDataDir: string, version: string): string {
  return join(userDataDir, 'runtime-versions', version)
}

export function isRuntimeInstalled(userDataDir: string, version: string): boolean {
  return existsSync(join(runtimeInstallationDir(userDataDir, version), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
}

/** Enumerate the runtimes the user can select: bundled default + managed installs. */
export function listInstalledRuntimes(
  userDataDir: string,
  bundled: { version: string; paths: RuntimePaths },
): RuntimeInstallation[] {
  const runtimes: RuntimeInstallation[] = [{ version: bundled.version, bundled: true, paths: bundled.paths }]
  const root = join(userDataDir, 'runtime-versions')
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const version = entry.name
      if (version === bundled.version) continue
      if (!isRuntimeInstalled(userDataDir, version)) continue
      runtimes.push({
        version,
        bundled: false,
        paths: managedRuntimePaths(userDataDir, version),
      })
    }
  }
  return runtimes
}

export function managedRuntimePaths(userDataDir: string, version: string): RuntimePaths {
  return {
    nodeExecutable: process.execPath,
    cliEntry: join(runtimeInstallationDir(userDataDir, version), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    cwd: '', // filled by the caller from app.getPath('home')
    electronRunAsNode: true,
  }
}

/**
 * Resolve the runtime for the current user: global pin (already resolved by
 * the caller), then the bundled default. Pins referencing a not-installed
 * version fall back to the bundled default (the UI surfaces that fallback).
 */
export function resolveRuntime(
  userDataDir: string,
  pinnedVersion: string | undefined,
  bundled: { version: string; paths: RuntimePaths },
  homeDir: string,
): RuntimeInstallation {
  if (pinnedVersion !== undefined && pinnedVersion !== bundled.version) {
    if (isRuntimeInstalled(userDataDir, pinnedVersion)) {
      const paths = managedRuntimePaths(userDataDir, pinnedVersion)
      return { version: pinnedVersion, bundled: false, paths: { ...paths, cwd: homeDir } }
    }
    // Fall back to bundled; callers surface the fallback notice.
  }
  return { version: bundled.version, bundled: true, paths: { ...bundled.paths, cwd: homeDir } }
}
