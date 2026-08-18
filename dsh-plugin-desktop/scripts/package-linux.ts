/** Build an unsigned Linux x64 deb package on a native Linux host. */

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Injectable native Linux packaging boundary used by focused tests. */
export interface LinuxPackageOptions {
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
  /** Dedicated deb output directory, isolated from other platform artifacts. */
  readonly outputDir: string
  /** Remove only the dedicated generated output before packaging. */
  readonly resetOutput: () => void
  /** Absolute electron-builder CLI module. */
  readonly builderCli: string
  /** Absolute packaged-deb verification script. */
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

function defaultOptions(): LinuxPackageOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspaceRoot = resolve(desktopRoot, '..')
  const require = createRequire(import.meta.url)
  const outputDir = resolve(desktopRoot, 'dist', 'linux')
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    workspaceRoot,
    desktopRoot,
    outputDir,
    resetOutput: () => rmSync(outputDir, { recursive: true, force: true }),
    builderCli: require.resolve('electron-builder/cli.js'),
    verifier: fileURLToPath(new URL('./verify-linux-package.ts', import.meta.url)),
    nodeExecutable: process.execPath,
    run,
    log: message => console.log(message),
  }
}

/**
 * Run the headless release gates and package unsigned Linux x64 artifacts.
 * @param options - Injectable process and command boundaries.
 */
export function packageLinux(options: LinuxPackageOptions = defaultOptions()): void {
  if (options.platform !== 'linux') {
    throw new Error('Linux package must be built on a native Linux host')
  }
  if (options.arch !== 'x64') {
    throw new Error(`Linux package requires x64 Node; received ${options.arch}`)
  }
  const versionMatch = /^(\d+)\.(\d+)\./u.exec(options.nodeVersion)
  const major = Number(versionMatch?.[1])
  const minor = Number(versionMatch?.[2])
  if (!((major === 22 && minor >= 19) || major === 24)) {
    throw new Error(
      `Linux package requires Node 22.19+ or Node 24.x with bundled Corepack; received ${options.nodeVersion}`,
    )
  }

  options.log('Building unsigned Linux x64 deb, rpm, and AppImage artifacts; signing is a separate release step.')
  options.run(
    'corepack',
    ['yarn', 'workspace', 'dsh-plugin-desktop', 'check:linux-package'],
    options.workspaceRoot,
    options.env,
  )
  options.resetOutput()
  options.run(
    options.nodeExecutable,
    [
      options.builderCli,
      '--linux',
      'deb',
      'rpm',
      'AppImage',
      '--x64',
      '--publish',
      'never',
      '--config.npmRebuild=false',
      `--config.directories.output=${options.outputDir}`,
    ],
    options.desktopRoot,
    {
      ...options.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  )
  options.run(
    options.nodeExecutable,
    [options.verifier, options.outputDir],
    options.desktopRoot,
    options.env,
  )
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    packageLinux()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
