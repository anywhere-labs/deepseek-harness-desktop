/** Private RunAsNode bootstrap for the packaged DeepSeek Harness CLI. */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { createRequire } from 'node:module'
import { NEXT_PACKAGE } from './profiles.ts'
import { profileName as assertDesktopProfileName } from './profiles.ts'
import { applyDesktopPackageAgePolicy, withoutForwardedDesktopPnpmPolicy } from './pnpm-policy.ts'
import { disableAsarArchiveView, type AsarArchiveProcess } from './asar-archive-policy.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const DEFAULT_PROFILE = 'DSH_DESKTOP_DEFAULT_PROFILE'
const DSH_ENTRY_URL = pathToFileURL(
  join(dirname(createRequire(NEXT_PACKAGE).resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js'),
).href

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
      throw new Error('dsh-desktop-next: conflicting default profile environment values')
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
    throw new Error(`dsh-desktop-next: unsafe CLI profile path for ${JSON.stringify(profileName)}`)
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
  applyDesktopPackageAgePolicy(environment)
  const profileName = takeDefaultProfile(environment)
  clearElectronRunAsNode(environment)
  // The CLI's agent lists and reads user workspaces; see asar-archive-policy.ts.
  disableAsarArchiveView(DSH_ENTRY_URL, asarProcess)
  const selected = profileName === undefined
    ? argv.slice(2)
    : withDefaultDesktopProfile(argv.slice(2), profileName)
  argv.splice(2, argv.length - 2, ...withoutForwardedDesktopPnpmPolicy(selected))
  await (await load(DSH_ENTRY_URL)).runCli({ manageDesktopProfile: true })
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && fileURLToPath(import.meta.url) === entry
}

if (isDirectExecution()) {
  void runDesktopDshCli().catch((cause: unknown) => {
    process.stderr.write(`dsh-desktop-next: failed to start packaged dsh: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
    process.exitCode = 1
  })
}
