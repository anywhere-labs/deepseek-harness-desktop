/** Build an unsigned Windows x64 artifact on a native Windows host. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_SIGNING_KEYS = [
  'CSC_IDENTITY_AUTO_DISCOVERY',
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
  'CSC_NAME',
  'WIN_CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
] as const

/** Injectable native Windows packaging boundary used by focused tests. */
export interface WindowsPackageOptions {
  /** Environment inherited by the packaging command. */
  readonly env: NodeJS.ProcessEnv
  /** Platform executing the package build. */
  readonly platform: NodeJS.Platform
  /** Node architecture executing the package build. */
  readonly arch: string
  /** Node version executing the package build. */
  readonly nodeVersion: string
  /** Repository root containing the Yarn workspace. */
  readonly workspaceRoot: string
  /** Desktop package root containing electron-builder configuration. */
  readonly desktopRoot: string
  /** Absolute native Windows command interpreter. */
  readonly commandShell: string
  /** Absolute electron-builder CLI module. */
  readonly builderCli: string
  /** Absolute packaged-installer verification script. */
  readonly verifier: string
  /** Node executable used to run package-local scripts. */
  readonly nodeExecutable: string
  /** Execute one packaging command. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void
  /** Report non-secret packaging progress. */
  readonly log: (message: string) => void
}

/**
 * Remove all certificate discovery and secret variables from an unsigned build.
 * @param environment - Environment that may contain Windows signing configuration.
 * @returns A copy suitable for checks and unsigned packaging.
 */
export function withoutWindowsSigningSecrets(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment }
  const signingKeys = new Set<string>(WINDOWS_SIGNING_KEYS)
  for (const key of Object.keys(sanitized)) {
    if (signingKeys.has(key.toUpperCase())) delete sanitized[key]
  }
  return sanitized
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

/** Create the native packaging options for a verifier entry point. */
export function createWindowsPackageOptions(verifier = './verify-win-installer.ts'): WindowsPackageOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspaceRoot = resolve(desktopRoot, '..')
  const require = createRequire(import.meta.url)
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    workspaceRoot,
    desktopRoot,
    commandShell: windowsRoot === undefined || windowsRoot.length === 0
      ? 'cmd.exe'
      : join(windowsRoot, 'System32', 'cmd.exe'),
    builderCli: require.resolve('electron-builder/cli.js'),
    verifier: fileURLToPath(new URL(verifier, import.meta.url)),
    nodeExecutable: process.execPath,
    run,
    log: message => console.log(message),
  }
}

/** Run the shared host and Node release gates before packaging. */
function assertWindowsPackageHost(options: WindowsPackageOptions, artifact: string): void {
  if (options.platform !== 'win32') {
    throw new Error(`Windows ${artifact} must be built on a native Windows host`)
  }
  if (options.arch !== 'x64') {
    throw new Error(`Windows ${artifact} requires x64 Node; received ${options.arch}`)
  }
  const versionMatch = /^(\d+)\.(\d+)\./u.exec(options.nodeVersion)
  const major = Number(versionMatch?.[1])
  const minor = Number(versionMatch?.[2])
  if (!((major === 22 && minor >= 19) || major === 24)) {
    throw new Error(
      `Windows ${artifact} requires Node 22.19+ or Node 24.x with bundled Corepack; received ${options.nodeVersion}`,
    )
  }
}

/** Run the gates and package one unsigned x64 Windows artifact. */
export function packageWindowsArtifact(
  options: WindowsPackageOptions,
  target: 'nsis' | 'zip',
  artifact: 'installer' | 'portable archive',
): void {
  assertWindowsPackageHost(options, artifact)

  const cleanEnvironment = withoutWindowsSigningSecrets(options.env)
  options.log(`Building an unsigned Windows x64 ${artifact}; Authenticode is a separate release step.`)
  if (options.env.DSH_PACKAGE_CHECK_ALREADY_RAN !== '1') {
    options.run(
      options.commandShell,
      [
        '/d',
        '/s',
        '/c',
        'corepack yarn workspace dsh-plugin-desktop check:win-package',
      ],
      options.workspaceRoot,
      cleanEnvironment,
    )
  } else {
    options.log('Skipping the Windows package preflight; the package gate already passed.')
  }
  options.run(
    options.nodeExecutable,
    [
      options.builderCli,
      '--win',
      target,
      '--x64',
      '--publish',
      'never',
      '--config.win.signExecutable=false',
      '--config.npmRebuild=false',
    ],
    options.desktopRoot,
    {
      ...cleanEnvironment,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  )
  options.run(
    options.nodeExecutable,
    [options.verifier],
    options.desktopRoot,
    cleanEnvironment,
  )
}

/** Run the headless release gates and package one unsigned x64 NSIS installer. */
export function packageWindowsInstaller(
  options: WindowsPackageOptions = createWindowsPackageOptions(),
): void {
  packageWindowsArtifact(options, 'nsis', 'installer')
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    packageWindowsInstaller()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
