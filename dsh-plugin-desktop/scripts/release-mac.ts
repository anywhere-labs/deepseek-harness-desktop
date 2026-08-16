/** Build a signed and notarized macOS DMG from validated release credentials. */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adaptMacReleaseEnvironment,
  assertMacReleaseReady,
  withoutMacReleaseSecrets,
} from './release-preflight.ts'

/** Supported Electron architectures for one macOS release artifact. */
export type MacReleaseArch = 'x64' | 'arm64'

/** Environment variable that selects the macOS release architecture. */
export const MAC_ARCH_ENV = 'DSH_MAC_ARCH'

/**
 * Resolve the architecture the release should build.
 * @param env - Environment containing the optional architecture selector.
 * @returns the requested architecture, defaulting to `arm64` when the selector is absent.
 * @throws when the selector is present but not a supported architecture.
 */
export function readMacReleaseArch(env: NodeJS.ProcessEnv): MacReleaseArch {
  const arch = env[MAC_ARCH_ENV]
  if (arch === undefined || arch.length === 0) return 'arm64'
  if (arch === 'x64' || arch === 'arm64') return arch
  throw new Error(
    `${MAC_ARCH_ENV} must be "x64", "arm64", or unset (defaults to arm64); received ${JSON.stringify(arch)}`,
  )
}

/** Injectable release boundary used by focused tests. */
export interface MacReleaseOptions {
  /** Environment containing the selected signing and notarization credentials. */
  readonly env: NodeJS.ProcessEnv
  /** Platform executing the release. */
  readonly platform: NodeJS.Platform
  /** Desktop package root containing package.json. */
  readonly desktopRoot: string
  /** Read code-signing identities with a credential-free environment. */
  readonly listCodeSigningIdentities: (env: NodeJS.ProcessEnv) => string
  /** Resolve the architecture the DMG builder must produce. */
  readonly arch: (env: NodeJS.ProcessEnv) => MacReleaseArch
  /** Execute one release command. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void
  /** Report non-secret release progress. */
  readonly log: (message: string) => void
}

function listCodeSigningIdentities(env: NodeJS.ProcessEnv): string {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
    env,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`security find-identity exited with ${String(result.status)}`)
  }
  return result.stdout
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function defaultReleaseOptions(): MacReleaseOptions {
  return {
    env: process.env,
    platform: process.platform,
    desktopRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    listCodeSigningIdentities,
    arch: readMacReleaseArch,
    run,
    log: message => console.log(message),
  }
}

/**
 * Build the macOS artifact while exposing release secrets only to Electron Builder.
 * @param options - Injectable process and command boundaries.
 */
export function releaseMac(options: MacReleaseOptions = defaultReleaseOptions()): void {
  const releaseEnvironment = adaptMacReleaseEnvironment(options.env)
  const buildEnvironment = withoutMacReleaseSecrets(releaseEnvironment)
  const arch = options.arch(releaseEnvironment)
  const result = assertMacReleaseReady({
    env: releaseEnvironment,
    platform: options.platform,
    listCodeSigningIdentities: () => options.listCodeSigningIdentities(buildEnvironment),
  })
  options.log(
    `macOS release preflight passed: ${result.identity}; signing via ${result.signing}; notarization via ${result.notarization}`,
  )

  // The workspace check includes the package build and repository-layout gate. Signing
  // material is withheld from every build, test, Loader smoke, and layout subprocess.
  options.run('yarn', ['run', 'check'], resolve(options.desktopRoot, '..'), buildEnvironment)
  options.run('yarn', [
    'exec', 'electron-builder', '--mac', 'dmg', `--${arch}`,
    '--config.forceCodeSigning=true', '--config.mac.notarize=true',
  ], options.desktopRoot, {
    ...releaseEnvironment,
    [MAC_ARCH_ENV]: arch,
  })
  options.run(process.execPath, ['scripts/verify-mac-release.ts'], options.desktopRoot, {
    ...buildEnvironment,
    [MAC_ARCH_ENV]: arch,
  })
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    releaseMac()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
