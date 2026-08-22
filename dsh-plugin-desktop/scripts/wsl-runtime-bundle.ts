/** Build the deterministic package bundle installed by the managed WSL Host. */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  describeWslRuntimeBundleFile,
  verifyWslRuntimeBundle,
  WSL_RUNTIME_BUNDLE_MANIFEST,
  WSL_RUNTIME_BUNDLE_SCHEMA_VERSION,
  WSL_RUNTIME_PACKAGE_NAME,
  type WslRuntimeBundle,
} from '../src/wsl-runtime-bundle.ts'

const FIRST_PARTY_SCOPE = '@deepseek-ai'
const INSTALL_SCRIPT_ALLOWLIST = Object.freeze({
  '@deepseek-ai/dsh-subprocess-local': true,
  '@google/genai': true,
  koffi: true,
  'node-pty': true,
  protobufjs: true,
})
const PATCHED_RUNTIME_PACKAGES = Object.freeze([
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-sandbox-windows-acl',
  '@deepseek-ai/dsh-web-app',
  'dshmarket',
])

interface PackageIdentity {
  readonly name: string
  readonly version: string
}

export interface WslRuntimeBundleCommandResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: Error
}

export interface WslRuntimeBundleGenerationOptions {
  readonly desktopRoot: string
  readonly marketRoot: string
  readonly outputRoot: string
  readonly nodeExecutable?: string
  readonly npmCli?: string
  readonly run?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => WslRuntimeBundleCommandResult
}

function packageIdentity(root: string): PackageIdentity {
  const value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  if (typeof value.name !== 'string' || value.name.length === 0
    || typeof value.version !== 'string' || value.version.length === 0) {
    throw new Error(`WSL runtime package at ${root} has no valid identity`)
  }
  return Object.freeze({ name: value.name, version: value.version })
}

function packageCanBePinnedAtBundleRoot(root: string): boolean {
  const value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    os?: unknown
    cpu?: unknown
  }
  const validate = (constraint: unknown, label: string): boolean => {
    if (constraint === undefined) return false
    if (!Array.isArray(constraint) || constraint.some(entry => typeof entry !== 'string')) {
      throw new Error(`WSL runtime package at ${root} has an invalid ${label} constraint`)
    }
    return true
  }
  // Platform packages cannot be direct dependencies of a lockfile generated on
  // Windows. Their exact versions remain locked through the portable wrapper's
  // optionalDependencies and npm selects the Linux binary during `npm ci` in WSL.
  const hasOsConstraint = validate(value.os, 'os')
  const hasCpuConstraint = validate(value.cpu, 'cpu')
  return !hasOsConstraint && !hasCpuConstraint
}

function defaultNpmCli(nodeExecutable: string): string {
  const candidate = join(dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(candidate)) throw new Error(`bundled npm CLI is unavailable beside ${nodeExecutable}`)
  return candidate
}

function defaultRun(
  command: string,
  args: readonly string[],
  cwd: string,
): WslRuntimeBundleCommandResult {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

function runChecked(
  run: NonNullable<WslRuntimeBundleGenerationOptions['run']>,
  command: string,
  args: readonly string[],
  cwd: string,
): string {
  const result = run(command, args, cwd)
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/u).at(-1)
    throw new Error(`WSL runtime bundle command failed${detail === undefined ? '' : `: ${detail}`}`)
  }
  return result.stdout
}

function packPackage(options: {
  readonly root: string
  readonly sourcesRoot: string
  readonly nodeExecutable: string
  readonly npmCli: string
  readonly run: NonNullable<WslRuntimeBundleGenerationOptions['run']>
}): { readonly identity: PackageIdentity, readonly filename: string } {
  const identity = packageIdentity(options.root)
  const output = runChecked(options.run, options.nodeExecutable, [
    options.npmCli,
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination', options.sourcesRoot,
    options.root,
  ], options.root)
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    throw new Error(`npm pack returned invalid JSON for ${identity.name}`)
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`npm pack returned an invalid result for ${identity.name}`)
  }
  const filename = (value[0] as { filename?: unknown }).filename
  if (typeof filename !== 'string' || filename.length === 0 || filename.includes('/') || filename.includes('\\')) {
    throw new Error(`npm pack returned an invalid filename for ${identity.name}`)
  }
  if (!existsSync(join(options.sourcesRoot, filename))) {
    throw new Error(`npm pack did not create ${filename}`)
  }
  return Object.freeze({ identity, filename })
}

function installedFirstParty(desktopRoot: string): Map<string, { readonly root: string, readonly version: string }> {
  const scopeRoot = join(desktopRoot, 'node_modules', FIRST_PARTY_SCOPE)
  const packages = new Map<string, { readonly root: string, readonly version: string }>()
  for (const entry of readdirSync(scopeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const root = join(scopeRoot, entry.name)
    const identity = packageIdentity(root)
    if (identity.name !== `${FIRST_PARTY_SCOPE}/${entry.name}`) {
      throw new Error(`unexpected first-party package identity at ${root}`)
    }
    if (!packageCanBePinnedAtBundleRoot(root)) continue
    packages.set(identity.name, Object.freeze({ root, version: identity.version }))
  }
  if (packages.size < 1) throw new Error('no installed first-party packages were found')
  return packages
}

function sortedRecord(values: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...values].sort(([left], [right]) => left.localeCompare(right, 'en')))
}

/** Generate and immediately verify one release-grade WSL runtime bundle. */
export function generateWslRuntimeBundle(
  options: WslRuntimeBundleGenerationOptions,
): WslRuntimeBundle {
  const desktopRoot = resolve(options.desktopRoot)
  const marketRoot = resolve(options.marketRoot)
  const outputRoot = resolve(options.outputRoot)
  const sourcesRoot = join(outputRoot, 'sources')
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  const npmCli = options.npmCli ?? defaultNpmCli(nodeExecutable)
  const run = options.run ?? defaultRun
  const desktop = packageIdentity(desktopRoot)
  if (desktop.name !== 'dsh-plugin-desktop') throw new Error('desktop workspace identity is invalid')
  const market = packageIdentity(marketRoot)
  if (market.name !== 'dsh-community-market') throw new Error('market workspace identity is invalid')

  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(sourcesRoot, { recursive: true })

  const firstParty = installedFirstParty(desktopRoot)
  const dependencies = new Map<string, string>()
  for (const [name, installed] of firstParty) dependencies.set(name, installed.version)

  const localRoots = new Map<string, string>([
    [desktop.name, desktopRoot],
    [market.name, marketRoot],
    ['dshmarket', join(desktopRoot, 'node_modules', 'dshmarket')],
  ])
  for (const name of PATCHED_RUNTIME_PACKAGES) {
    if (name === 'dshmarket') continue
    const installed = firstParty.get(name)
    if (installed === undefined) throw new Error(`patched runtime package is not installed: ${name}`)
    localRoots.set(name, installed.root)
  }

  for (const [name, root] of [...localRoots].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    const packed = packPackage({ root, sourcesRoot, nodeExecutable, npmCli, run })
    if (packed.identity.name !== name) throw new Error(`packed runtime package identity changed: ${name}`)
    dependencies.set(name, `file:./sources/${packed.filename}`)
  }

  const packageJson = {
    name: WSL_RUNTIME_PACKAGE_NAME,
    version: desktop.version,
    private: true,
    engines: { node: '^22.19.0 || >=24.0.0' },
    dependencies: sortedRecord(dependencies),
    allowScripts: INSTALL_SCRIPT_ALLOWLIST,
  }
  writeFileSync(join(outputRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o644 })
  runChecked(run, nodeExecutable, [
    npmCli,
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--legacy-peer-deps',
    '--no-audit',
    '--no-fund',
  ], outputRoot)

  const paths = [
    'package-lock.json',
    'package.json',
    ...readdirSync(sourcesRoot)
      .filter(name => name.endsWith('.tgz'))
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map(name => `sources/${name}`),
  ].sort((left, right) => left.localeCompare(right, 'en'))
  const manifest = {
    schemaVersion: WSL_RUNTIME_BUNDLE_SCHEMA_VERSION,
    productVersion: desktop.version,
    packageCount: dependencies.size,
    files: paths.map(path => describeWslRuntimeBundleFile(outputRoot, path)),
  }
  writeFileSync(
    join(outputRoot, WSL_RUNTIME_BUNDLE_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  )
  return verifyWslRuntimeBundle(outputRoot, desktop.version)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const outputRoot = process.argv[2] === undefined
      ? join(desktopRoot, 'build', 'wsl-runtime')
      : resolve(process.argv[2])
    const bundle = generateWslRuntimeBundle({
      desktopRoot,
      marketRoot: resolve(desktopRoot, '..', 'dsh-community-market'),
      outputRoot,
    })
    console.log(
      `WSL runtime bundle prepared: ${bundle.root} (${String(bundle.manifest.packageCount)} pinned packages)`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
