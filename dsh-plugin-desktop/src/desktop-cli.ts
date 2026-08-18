/** Private RunAsNode bootstrap for the packaged DeepSeek Harness CLI. */

import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import {
  DESKTOP_INSTALL_RECOVERY_STATE_ENV,
  DesktopInstallRecoveryStore,
  desktopInstallRecoveryStatePath,
} from './install-recovery.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import { assertDesktopProfileName } from './profile-manager.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const DEFAULT_PROFILE = 'DSH_DESKTOP_DEFAULT_PROFILE'
const DSH_HOME = 'DSH_HOME'
const DSH_ENTRY_URL = pathToFileURL(
  packagedDependencyPath(import.meta.url, '@deepseek-ai/dsh/lib/bin.js'),
).href

/** Remove Electron Node mode before the DSH CLI creates any child process. */
export function clearElectronRunAsNode(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === RUN_AS_NODE) delete environment[key]
  }
}

/**
 * Apply the terminal-owned default without overriding global help or an explicit profile.
 * @param argv - arguments after the executable and bootstrap entry.
 * @param profileName - validated profile selected by the desktop launcher.
 * @returns argv accepted by the upstream DSH command parser.
 */
export function withDefaultDesktopProfile(argv: readonly string[], profileName: string): string[] {
  assertDesktopProfileName(profileName)
  if (argv.some(argument => argument === '--profile' || argument.startsWith('--profile='))) {
    return [...argv]
  }
  const first = argv[0]
  if (first === 'web' || first === '--help' || first === '-h' || first === '--version' || first === '-V') {
    return [...argv]
  }
  if (first === 'plugin') {
    return ['plugin', '--profile', profileName, ...argv.slice(1)]
  }
  return ['--profile', profileName, ...argv]
}

/** Remove and return the case-insensitive terminal default-profile marker. */
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

/** Remove and return one case-insensitive Desktop-owned environment hand-off. */
function takeEnvironmentValue(environment: NodeJS.ProcessEnv, expectedName: string): string | undefined {
  let result: string | undefined
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() !== expectedName) continue
    const value = environment[key]
    if (value !== undefined && result !== undefined && value !== result) {
      throw new Error(`dsh-desktop: conflicting ${expectedName} environment values`)
    }
    result ??= value
    delete environment[key]
  }
  return result
}

/** Resolve the exact profile mutated by one built-in-terminal plugin-add command. */
function pluginAddProfile(argv: readonly string[]): string | undefined {
  if (argv[0] !== 'plugin') return undefined
  const forwarded: string[] = []
  let profileName: string | undefined
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--profile') {
      const value = argv[index + 1]
      if (value === undefined) return undefined
      if (profileName !== undefined && profileName !== value) {
        throw new Error('dsh-desktop: conflicting plugin profile arguments')
      }
      profileName = value
      index += 1
      continue
    }
    if (argument.startsWith('--profile=')) {
      const value = argument.slice('--profile='.length)
      if (profileName !== undefined && profileName !== value) {
        throw new Error('dsh-desktop: conflicting plugin profile arguments')
      }
      profileName = value
      continue
    }
    forwarded.push(argument)
  }
  if (forwarded[0] !== 'add' || profileName === undefined) return undefined
  assertDesktopProfileName(profileName)
  return profileName
}

class CapturedDesktopCliExit {
  constructor(readonly code: number) {}
}

/** Run one built-in-terminal add inside the same durable recovery boundary as Market installs. */
async function loadWithInstallRecovery(
  load: (url: string) => Promise<unknown>,
  store: DesktopInstallRecoveryStore,
): Promise<void> {
  const transaction = await store.begin({
    packageName: 'manual-plugin-install',
    packageVersion: 'unresolved',
    receiptId: `manual:${randomUUID()}`,
  })
  const originalExit = process.exit
  let capturedExitCode: number | undefined
  let failure: unknown
  process.exit = ((code?: string | number | null): never => {
    const normalized = typeof code === 'number'
      ? code
      : code === undefined || code === null
        ? process.exitCode ?? 0
        : Number(code)
    throw new CapturedDesktopCliExit(
      typeof normalized === 'number' && Number.isSafeInteger(normalized) ? normalized : 1,
    )
  }) as typeof process.exit
  try {
    await load(DSH_ENTRY_URL)
  } catch (cause) {
    if (cause instanceof CapturedDesktopCliExit) capturedExitCode = cause.code
    else failure = cause
  } finally {
    process.exit = originalExit
  }

  const effectiveExitCode = capturedExitCode ?? process.exitCode
  const commandSucceeded = failure === undefined && (effectiveExitCode === undefined || effectiveExitCode === 0)
  if (commandSucceeded) {
    try {
      await store.seal(transaction.transactionId)
    } catch (cause) {
      const restored = await store.restoreCurrentInstall(transaction.transactionId, 'install-failed')
      if (restored.status !== 'manual-recovery-required') await store.clear(transaction.transactionId)
      throw cause
    }
  } else {
    const restored = await store.restoreCurrentInstall(transaction.transactionId, 'install-failed')
    if (restored.status !== 'manual-recovery-required') await store.clear(transaction.transactionId)
  }
  if (failure !== undefined) throw failure
  if (capturedExitCode !== undefined) process.exitCode = capturedExitCode
}

/**
 * Enter the packaged DSH CLI after removing the Electron-only launch marker.
 * @param environment - process environment inherited from the generated shim.
 * @param load - ESM loader used by the executable and focused tests.
 * @param argv - mutable process arguments presented to the upstream CLI.
 * @returns once the imported CLI entry completes its top-level work.
 */
export async function runDesktopDshCli(
  environment: NodeJS.ProcessEnv = process.env,
  load: (url: string) => Promise<unknown> = url => import(url),
  argv: string[] = process.argv,
): Promise<void> {
  const profileName = takeDefaultProfile(environment)
  const installRecoveryStatePath = takeEnvironmentValue(
    environment,
    DESKTOP_INSTALL_RECOVERY_STATE_ENV,
  )
  clearElectronRunAsNode(environment)
  if (profileName !== undefined) {
    argv.splice(2, argv.length - 2, ...withDefaultDesktopProfile(argv.slice(2), profileName))
  }
  const homeDir = environment[DSH_HOME]
  const installProfileName = pluginAddProfile(argv.slice(2))
  if (
    installRecoveryStatePath !== undefined
    && installProfileName !== undefined
    && homeDir !== undefined
  ) {
    const store = new DesktopInstallRecoveryStore({
      statePath: desktopInstallRecoveryStatePath('/', {
        [DESKTOP_INSTALL_RECOVERY_STATE_ENV]: installRecoveryStatePath,
      }),
      profileName: installProfileName,
      profileDir: resolveProfileDir(installProfileName, homeDir),
      generationId: `terminal:${randomUUID()}`,
    })
    await loadWithInstallRecovery(load, store)
    return
  }
  await load(DSH_ENTRY_URL)
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
