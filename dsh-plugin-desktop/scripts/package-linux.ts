/** Build and verify an unsigned Linux x64 AppImage on a native Linux host. */

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareLinuxNativeRuntimeAt } from './linux-native-runtime.ts'

const PUBLISHING_SECRET_KEYS = [
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const

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
  /** Dedicated Linux artifact directory. */
  readonly outputDir: string
  /** Remove only the dedicated generated Linux output before packaging. */
  readonly resetOutput: () => void
  /** Stage Linux native modules under stable package loader paths. */
  readonly prepareRuntime: () => void
  /** Absolute electron-builder CLI module. */
  readonly builderCli: string
  /** Absolute AppImage verification script. */
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
 * Remove publisher credentials that an artifact build never needs.
 * @param environment - Environment that may contain release credentials.
 * @returns A copy suitable for checks and non-publishing packaging.
 */
export function withoutLinuxPublishingSecrets(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment }
  const publishingKeys = new Set<string>(PUBLISHING_SECRET_KEYS)
  for (const key of Object.keys(sanitized)) {
    if (publishingKeys.has(key.toUpperCase())) delete sanitized[key]
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

function defaultOptions(): LinuxPackageOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspaceRoot = resolve(desktopRoot, '..')
  const outputDir = resolve(desktopRoot, 'dist', 'linux')
  const require = createRequire(import.meta.url)
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    workspaceRoot,
    desktopRoot,
    outputDir,
    resetOutput: () => rmSync(outputDir, { recursive: true, force: true }),
    prepareRuntime: () => prepareLinuxNativeRuntimeAt(desktopRoot),
    builderCli: require.resolve('electron-builder/cli.js'),
    verifier: fileURLToPath(new URL('./verify-linux-appimage.ts', import.meta.url)),
    nodeExecutable: process.execPath,
    run,
    log: message => console.log(message),
  }
}

/**
 * Run Linux package gates, build one x64 AppImage, and inspect the result.
 * @param options - Injectable process and command boundaries.
 */
export function packageLinuxAppImage(
  options: LinuxPackageOptions = defaultOptions(),
): void {
  if (options.platform !== 'linux') {
    throw new Error('Linux AppImage must be built on a native Linux host')
  }
  if (options.arch !== 'x64') {
    throw new Error(`Linux AppImage requires x64 Node; received ${options.arch}`)
  }
  const versionMatch = /^(\d+)\.(\d+)\./u.exec(options.nodeVersion)
  const major = Number(versionMatch?.[1])
  const minor = Number(versionMatch?.[2])
  if (!((major === 22 && minor >= 19) || major === 24)) {
    throw new Error(
      `Linux AppImage requires Node 22.19+ or Node 24.x with bundled Corepack; received ${options.nodeVersion}`,
    )
  }

  const cleanEnvironment = withoutLinuxPublishingSecrets(options.env)
  options.log('Building an unsigned Linux x64 AppImage; release publication is a separate step.')
  options.run(
    'corepack',
    ['yarn', 'workspace', 'dsh-plugin-desktop', 'check:linux-package'],
    options.workspaceRoot,
    cleanEnvironment,
  )
  options.prepareRuntime()
  options.resetOutput()
  options.run(
    options.nodeExecutable,
    [
      options.builderCli,
      '--linux',
      'AppImage',
      '--x64',
      '--publish',
      'never',
      '--config.npmRebuild=false',
      `--config.directories.output=${options.outputDir}`,
    ],
    options.desktopRoot,
    cleanEnvironment,
  )
  options.run(
    options.nodeExecutable,
    [options.verifier, options.outputDir],
    options.desktopRoot,
    cleanEnvironment,
  )
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    packageLinuxAppImage()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
