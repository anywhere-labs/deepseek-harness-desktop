/** Private RunAsNode bootstrap for the packaged DeepSeek Harness CLI. */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { delimiter, dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import { assertDesktopProfileName } from './profile-manager.ts'
import { PNPM_IGNORE_MINIMUM_RELEASE_AGE, withoutForwardedDesktopPnpmPolicy } from './pnpm-policy.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { disableAsarArchiveView, type AsarArchiveProcess } from './asar-archive-policy.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const DEFAULT_PROFILE = 'DSH_DESKTOP_DEFAULT_PROFILE'
const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'
const DSH_ENTRY_URL = pathToFileURL(
  packagedDependencyPath(import.meta.url, '@deepseek-ai/dsh/lib/bin.js'),
).href
const PACKAGED_PNPM_ENTRY = packagedDependencyPath(import.meta.url, 'pnpm/bin/pnpm.mjs')

/**
 * Guarantee that a bare `pnpm` on PATH resolves to the packaged pnpm.
 *
 * The upstream `dsh plugin` command forwards to `spawnSync('pnpm', ...)`,
 * resolving through the ambient PATH. The tray terminal prepends its own shim
 * directory, but the dsh shim (`--expose-internals desktop-cli.js`) can equally
 * be invoked outside that terminal — from scripts, automation, or a second
 * shell — where PATH is arbitrary. There pnpm may be missing entirely (Desktop
 * targets machines without a Node.js install), or be an incompatible build:
 * an ambient pnpm 11.1.1 was observed to finish the install and then keep the
 * Electron-as-node parent waiting forever instead of exiting.
 *
 * Mirror the terminal shim in a private tmpdir location and prepend it, so
 * every desktop-cli invocation runs the same packaged pnpm with the same
 * Electron native-module settings regardless of caller environment. The shim
 * is rewritten on each invocation, so an upgraded app repairs stale content.
 * Outside the Electron runtime (unit tests) PATH is left untouched.
 */
export function ensurePackagedPnpmOnPath(environment: NodeJS.ProcessEnv): void {
  const electronVersion = process.versions.electron
  if (electronVersion === undefined) return
  const dir = join(tmpdir(), `dsh-desktop-cli-${process.platform}-${process.arch}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'pnpm.cmd'), [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      `set "${RUN_AS_NODE}=1"`,
      'set "npm_config_runtime=electron"',
      `set "npm_config_target=${electronVersion}"`,
      `set "npm_config_disturl=${ELECTRON_HEADERS_URL}"`,
      `"${process.execPath}" "${PACKAGED_PNPM_ENTRY}" ${PNPM_IGNORE_MINIMUM_RELEASE_AGE} %*`,
      'exit /b %errorlevel%',
      '',
    ].join('\r\n'))
  } else {
    writeFileSync(join(dir, 'pnpm'), [
      '#!/bin/sh',
      `${RUN_AS_NODE}=1 npm_config_runtime=electron npm_config_target=${quoteSh(electronVersion)} npm_config_disturl=${quoteSh(ELECTRON_HEADERS_URL)} exec ${quoteSh(process.execPath)} ${quoteSh(PACKAGED_PNPM_ENTRY)} ${PNPM_IGNORE_MINIMUM_RELEASE_AGE} "$@"`,
      '',
    ].join('\n'), { mode: 0o700 })
  }
  environment.PATH = `${dir}${delimiter}${environment.PATH ?? ''}`
}

/** Quote one arbitrary value as a POSIX shell word. */
function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function clearElectronRunAsNode(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === RUN_AS_NODE) delete environment[key]
  }
}

export function withDefaultDesktopProfile(argv: readonly string[], profileName: string): string[] {
  assertDesktopProfileName(profileName)
  if (argv.some(argument => argument === '--profile' || argument.startsWith('--profile='))) return [...argv]
  const first = argv[0]
  if (first === 'web' || first === '--help' || first === '-h' || first === '--version' || first === '-V') {
    return [...argv]
  }
  if (first === 'plugin') return ['plugin', '--profile', profileName, ...argv.slice(1)]
  return ['--profile', profileName, ...argv]
}

function takeDefaultProfile(environment: NodeJS.ProcessEnv): string | undefined {
  let profileName: string | undefined
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() !== DEFAULT_PROFILE) continue
    const value = environment[key]
    if (value !== undefined && profileName !== undefined && value !== profileName) {
      throw new Error('dsh-desktop: conflicting default profile environment values')
    }
    profileName ??= value
    delete environment[key]
  }
  return profileName
}

/** Return the Profile selected by one normalized DSH invocation. */
export function selectedDesktopCliProfile(argv: readonly string[]): string | undefined {
  if (argv[0] === 'web') return 'web'
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--profile') {
      const profile = argv[index + 1]
      if (profile !== undefined && profile.length > 0) return profile
    }
    if (argument?.startsWith('--profile=') === true) {
      const profile = argument.slice('--profile='.length)
      if (profile.length > 0) return profile
    }
  }
  return undefined
}

/** Resolve one CLI Profile through the official home/profile path contract. */
export function desktopCliProfileManifestUrl(
  profileName: string,
  environment: NodeJS.ProcessEnv,
): string {
  const home = resolveDshHome(undefined, environment)
  const profileRoot = join(home, 'profiles')
  const profileDirectory = resolveProfileDir(profileName, home)
  // resolveProfileDir currently rejects separators. Retain this containment
  // check at the Desktop process boundary so an upstream contract regression
  // cannot turn a CLI flag into an arbitrary module-resolution anchor.
  if (dirname(profileDirectory) !== profileRoot) {
    throw new Error(`dsh-desktop: unsafe CLI profile path for ${JSON.stringify(profileName)}`)
  }
  return pathToFileURL(join(profileDirectory, 'package.json')).href
}

/**
 * Enter the packaged DSH CLI without any plugin-install transaction wrapper.
 * Manual plugin commands and Market operations rely on unified checkpoints.
 */
export async function runDesktopDshCli(
  environment: NodeJS.ProcessEnv = process.env,
  load: (url: string) => Promise<{ runCli(options: { manageDesktopProfile: boolean }): Promise<void> }> = url => import(url),
  argv: string[] = process.argv,
  asarProcess: AsarArchiveProcess = process,
): Promise<void> {
  const profileName = takeDefaultProfile(environment)
  clearElectronRunAsNode(environment)
  // The CLI's agent lists and reads user workspaces; see asar-archive-policy.ts.
  disableAsarArchiveView(DSH_ENTRY_URL, asarProcess)
  ensurePackagedPnpmOnPath(environment)
  const selected = profileName === undefined
    ? argv.slice(2)
    : withDefaultDesktopProfile(argv.slice(2), profileName)
  argv.splice(2, argv.length - 2, ...withoutForwardedDesktopPnpmPolicy(selected))
  const selectedProfile = selectedDesktopCliProfile(argv.slice(2))
  const releaseResolver = selectedProfile !== undefined
    && /([\\/])app\.asar\1/u.test(fileURLToPath(DSH_ENTRY_URL))
    ? installProfilePackageResolver(desktopCliProfileManifestUrl(selectedProfile, environment))
    : undefined
  // The DSH CLI settles once a long-lived Profile is ready;
  // later HMR and Loader imports still need the same process-wide resolver.
  // Keep it until process exit rather than treating CLI settlement as app
  // shutdown. A packaged CLI process owns exactly one Profile invocation.
  if (releaseResolver === undefined) {
    await (await load(DSH_ENTRY_URL)).runCli({ manageDesktopProfile: true })
    return
  }
  const releaseAtExit = (): void => { releaseResolver() }
  process.once('exit', releaseAtExit)
  try {
    await (await load(DSH_ENTRY_URL)).runCli({ manageDesktopProfile: true })
  } catch (cause) {
    process.off('exit', releaseAtExit)
    releaseResolver()
    throw cause
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && fileURLToPath(import.meta.url) === entry
}

if (isDirectExecution()) {
  void runDesktopDshCli().catch((cause: unknown) => {
    process.stderr.write(`dsh-desktop: failed to start packaged dsh: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
    process.exitCode = 1
  })
}
