/** App-local command environments available to desktop Host plugins. */

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, win32 as windowsPath } from 'node:path'
import { PNPM_IGNORE_MINIMUM_RELEASE_AGE } from './pnpm-policy.ts'
import { assertDesktopProfileName } from './profile-manager.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const DEFAULT_PROFILE = 'DSH_DESKTOP_DEFAULT_PROFILE'
const DSH_HOME = 'DSH_HOME'
const RUNTIME_CODEPAGE = 'DSH_RUNTIME_CODEPAGE'
const RUNTIME_EXIT = 'DSH_RUNTIME_EXIT'
const PATH = 'PATH'
const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'
const DIRECTORY_MODE = 0o700
const EXECUTABLE_FILE_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const GENERATION_SCHEMA_VERSION = 1
const GENERATION_NAME = /^(?<hash>[0-9a-f]{64})-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MANIFEST_NAME = '.generation.json'

/** Inputs used to install one app-local pnpm command environment. */
export interface DesktopPnpmRuntimeOptions {
  /** Host platform selecting POSIX or Windows command shims. */
  platform: NodeJS.Platform
  /** Electron executable reused in RunAsNode mode. */
  appExecutable: string
  /** Packaged pnpm JavaScript entry executable by Electron RunAsNode, including an ASAR logical path. */
  pnpmBinPath: string
  /** Electron version used when pnpm installs native dependencies. */
  electronVersion: string
  /** Private application-owned directory receiving generated files. */
  stateDir: string
  /** Parent environment whose PATH is updated; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv
}

/** Files and reversible PATH update created for the Host runtime. */
export interface DesktopPnpmRuntimeInstallation {
  /** Public directory prepended to the Host PATH; it contains only pnpm. */
  pathDir: string
  /** Public pnpm command shim. */
  pnpmShimPath: string
  /** Private directory made visible only inside the pnpm process tree. */
  nodeBinDir: string
  /** Private Node command shim used by pnpm lifecycle scripts. */
  nodeShimPath: string
  /** Preloaded module that preserves the platform's safe Node descendant identity. */
  clearEnvironmentPath: string
  /** Remove this installation's PATH entry without deleting persistent generated files. */
  dispose(): void
}

/** Inputs used to publish the packaged DSH command to Host plugins. */
export interface DesktopDshRuntimeOptions {
  platform: NodeJS.Platform
  appExecutable: string
  dshBootstrapPath: string
  profileName: string
  homeDir: string
  stateDir: string
  environment?: NodeJS.ProcessEnv
}

/** Generated DSH command and its reversible Host PATH update. */
export interface DesktopDshRuntimeInstallation {
  pathDir: string
  dshShimPath: string
  dispose(): void
}

/** Reject a value that cannot be represented in a generated command file. */
function assertScriptValue(label: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`dsh-plugin-desktop: command runtime ${label} must not be empty`)
  }
  if (/[\0\r\n]/u.test(value)) {
    throw new Error(`dsh-plugin-desktop: command runtime ${label} must not contain NUL or newlines`)
  }
}

/** Quote one arbitrary value as a POSIX shell word. */
function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** Quote one Windows batch argv word without permitting quote injection. */
function quoteBatchWord(value: string): string {
  if (/["\r\n]/u.test(value)) {
    throw new Error('dsh-plugin-desktop: pnpm runtime Windows arguments must not contain quotes or newlines')
  }
  return `"${value.replaceAll('%', '%%')}"`
}

/** Escape a value inside the quoted right-hand side of a batch `set` command. */
function escapeBatchSetValue(value: string): string {
  if (/["\r\n]/u.test(value)) {
    throw new Error('dsh-plugin-desktop: pnpm runtime Windows environment values must not contain quotes or newlines')
  }
  return value.replaceAll('%', '%%')
}

/** Create one owner-only real directory and reject a pre-existing alternate file type. */
function preparePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`dsh-plugin-desktop: command runtime path is not a private directory: ${directory}`)
  }
  chmodSync(directory, DIRECTORY_MODE)
}

type RuntimeGenerationKind = 'dsh' | 'pnpm'

interface RuntimeArtifact {
  relativePath: string
  contents: string
  mode: number
}

interface RuntimeGenerationManifest {
  schemaVersion: typeof GENERATION_SCHEMA_VERSION
  kind: RuntimeGenerationKind
  platform: NodeJS.Platform
  contentHash: string
  files: Array<{
    path: string
    sha256: string
    mode: number
  }>
}

interface RuntimeGenerationPlan {
  kind: RuntimeGenerationKind
  platform: NodeJS.Platform
  contentHash: string
  directories: string[]
  artifacts: RuntimeArtifact[]
}

interface RuntimeGeneration {
  root: string
  obsoletePathDirectories: string[]
}

/** Hash deterministic generated content without depending on its eventual directory name. */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Create a content-addressed plan and its self-describing ownership marker. */
function runtimeGenerationPlan(
  kind: RuntimeGenerationKind,
  platform: NodeJS.Platform,
  directories: readonly string[],
  artifacts: readonly RuntimeArtifact[],
): RuntimeGenerationPlan {
  const orderedDirectories = [...directories].sort()
  const orderedArtifacts = [...artifacts].sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  const contentHash = sha256(JSON.stringify({
    schemaVersion: GENERATION_SCHEMA_VERSION,
    kind,
    platform,
    directories: orderedDirectories,
    files: orderedArtifacts.map(artifact => ({
      path: artifact.relativePath,
      contents: artifact.contents,
      mode: artifact.mode,
    })),
  }))
  const manifest: RuntimeGenerationManifest = {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    kind,
    platform,
    contentHash,
    files: orderedArtifacts.map(artifact => ({
      path: artifact.relativePath,
      sha256: sha256(artifact.contents),
      mode: artifact.mode,
    })),
  }
  return {
    kind,
    platform,
    contentHash,
    directories: orderedDirectories,
    artifacts: [
      { relativePath: MANIFEST_NAME, contents: `${JSON.stringify(manifest, undefined, 2)}\n`, mode: PRIVATE_FILE_MODE },
      ...orderedArtifacts,
    ],
  }
}

function pathSegments(relativePath: string): string[] {
  return relativePath.split('/')
}

function generationPath(root: string, relativePath: string): string {
  return join(root, ...pathSegments(relativePath))
}

/** Inspect a generation tree without following symlinks. */
function generationTree(root: string): { directories: string[]; files: string[] } | undefined {
  try {
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined
    const directories: string[] = []
    const files: string[] = []
    const visit = (directory: string, prefix: string): boolean => {
      for (const entry of readdirSync(directory)) {
        const relativePath = prefix.length === 0 ? entry : `${prefix}/${entry}`
        const stat = lstatSync(join(directory, entry))
        if (stat.isSymbolicLink()) return false
        if (stat.isDirectory()) {
          directories.push(relativePath)
          if (!visit(join(directory, entry), relativePath)) return false
          continue
        }
        if (!stat.isFile()) return false
        files.push(relativePath)
      }
      return true
    }
    if (!visit(root, '')) return undefined
    return { directories: directories.sort(), files: files.sort() }
  } catch {
    return undefined
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Verify exact content before making an existing immutable generation executable via PATH. */
function reusableGeneration(root: string, plan: RuntimeGenerationPlan): boolean {
  const tree = generationTree(root)
  if (tree === undefined) return false
  const expectedFiles = plan.artifacts.map(artifact => artifact.relativePath).sort()
  if (!sameStrings(tree.directories, plan.directories) || !sameStrings(tree.files, expectedFiles)) return false
  try {
    for (const artifact of plan.artifacts) {
      const filename = generationPath(root, artifact.relativePath)
      const stat = lstatSync(filename)
      if (!stat.isFile() || stat.isSymbolicLink()) return false
      if (process.platform !== 'win32' && (stat.mode & 0o777) !== artifact.mode) return false
      if (readFileSync(filename, 'utf8') !== artifact.contents) return false
    }
    return true
  } catch {
    return false
  }
}

function reportCleanupFailure(filename: string, cause: unknown): void {
  const code = (cause as NodeJS.ErrnoException).code
  try {
    process.stderr.write(
      `dsh-plugin-desktop: deferred command runtime cleanup for ${JSON.stringify(filename)}`
        + `${code === undefined ? '' : ` (${code})`}\n`,
    )
  } catch {
    // Diagnostics must not turn best-effort generation cleanup into a startup failure.
  }
}

/** Materialize a new generation privately, then publish it under a never-reused name. */
function createRuntimeGeneration(generationsDir: string, plan: RuntimeGenerationPlan): string {
  const temporaryRoot = join(generationsDir, `.staging.${process.pid}.${randomUUID()}`)
  mkdirSync(temporaryRoot, { mode: DIRECTORY_MODE })
  chmodSync(temporaryRoot, DIRECTORY_MODE)
  try {
    for (const relativePath of [...plan.directories].sort((left, right) => {
      return pathSegments(left).length - pathSegments(right).length || left.localeCompare(right)
    })) {
      const directory = generationPath(temporaryRoot, relativePath)
      mkdirSync(directory, { mode: DIRECTORY_MODE })
      chmodSync(directory, DIRECTORY_MODE)
    }
    for (const artifact of plan.artifacts) {
      const filename = generationPath(temporaryRoot, artifact.relativePath)
      writeFileSync(filename, artifact.contents, { encoding: 'utf8', flag: 'wx', mode: artifact.mode })
      chmodSync(filename, artifact.mode)
    }
    const root = join(generationsDir, `${plan.contentHash}-${randomUUID()}`)
    renameSync(temporaryRoot, root)
    return root
  } catch (cause) {
    try {
      rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 0 })
    } catch (cleanupCause) {
      reportCleanupFailure(temporaryRoot, cleanupCause)
    }
    throw cause
  }
}

/** Reuse an exact immutable generation or publish a clean sibling when any candidate is tainted. */
function installRuntimeGeneration(stateDir: string, plan: RuntimeGenerationPlan): RuntimeGeneration {
  preparePrivateDirectory(stateDir)
  const generationsDir = join(stateDir, 'generations')
  preparePrivateDirectory(generationsDir)
  const entries = readdirSync(generationsDir)
  let root: string | undefined
  for (const entry of entries.sort()) {
    const match = GENERATION_NAME.exec(entry)
    if (match?.groups?.hash !== plan.contentHash) continue
    const candidate = join(generationsDir, entry)
    if (reusableGeneration(candidate, plan)) {
      root = candidate
      break
    }
  }
  root ??= createRuntimeGeneration(generationsDir, plan)
  const obsoletePathDirectories = [
    join(stateDir, 'bin'),
    join(stateDir, 'private', 'node-bin'),
    ...entries.flatMap(entry => [
      join(generationsDir, entry, 'bin'),
      join(generationsDir, entry, 'private', 'node-bin'),
    ]),
  ].filter(directory => {
    return directory !== join(root, 'bin') && directory !== join(root, 'private', 'node-bin')
  })
  // Published generations may still back child processes after the desktop lifecycle advances.
  // Keep them immutable and isolate them from PATH; safe garbage collection requires explicit leases.
  return { root, obsoletePathDirectories }
}

/** Keep descendants in Node mode on Windows, where the private shim is a non-executable batch file. */
function clearEnvironmentModule(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return [
      '// process.execPath is the Electron executable; its Node descendants must retain RunAsNode.',
      '',
    ].join('\n')
  }
  return [
    `process.execPath = require('node:path').join(__dirname, 'node-bin', 'node')`,
    `for (const name of Object.keys(process.env)) {`,
    `  if (name.toUpperCase() === '${RUN_AS_NODE}') delete process.env[name]`,
    '}',
    '',
  ].join('\n')
}

/** Build the private POSIX Node command used only by pnpm lifecycle scripts. */
function posixNodeShim(appExecutable: string): string {
  return [
    '#!/bin/sh',
    'runtime_node_bin_dir=${0%/*}',
    'runtime_private_dir=${runtime_node_bin_dir%/*}',
    'runtime_clear_environment="$runtime_private_dir/clear-env.cjs"',
    `${RUN_AS_NODE}=1 exec ${quoteSh(appExecutable)} --require "$runtime_clear_environment" "$@"`,
    '',
  ].join('\n')
}

/** Build the public POSIX pnpm command. */
function posixPnpmShim(options: DesktopPnpmRuntimeOptions): string {
  return [
    '#!/bin/sh',
    'runtime_public_dir=${0%/*}',
    'runtime_root_dir=${runtime_public_dir%/*}',
    'runtime_private_dir="$runtime_root_dir/private"',
    'runtime_node_bin_dir="$runtime_private_dir/node-bin"',
    'runtime_node_shim="$runtime_node_bin_dir/node"',
    'runtime_clear_environment="$runtime_private_dir/clear-env.cjs"',
    [
      'PATH="$runtime_node_bin_dir:${PATH:-}"',
      'NODE="$runtime_node_shim"',
      `${RUN_AS_NODE}=1`,
      'npm_config_runtime=electron',
      `npm_config_target=${quoteSh(options.electronVersion)}`,
      `npm_config_disturl=${quoteSh(ELECTRON_HEADERS_URL)}`,
      `exec ${quoteSh(options.appExecutable)} --require "$runtime_clear_environment" ${quoteSh(options.pnpmBinPath)} ${PNPM_IGNORE_MINIMUM_RELEASE_AGE} "$@"`,
    ].join(' '),
    '',
  ].join('\n')
}

/**
 * Pin the console to UTF-8 so cmd.exe decodes this file the same way it was written.
 *
 * Batch files are decoded with the console code page, not with their own encoding. These shims are
 * written as UTF-8 and embed absolute paths, so on an OEM code page every non-ASCII path byte
 * decodes to a different character and the command fails with ERROR_PATH_NOT_FOUND. The prologue
 * is pure ASCII, which decodes identically under every code page, and it precedes every embedded
 * path. Losing `chcp` only restores the previous behavior, so the recovery stays silent.
 */
function windowsCodePagePrologue(): string[] {
  return [
    `for /f "tokens=2 delims=:" %%c in ('chcp 2^>nul') do set "${RUNTIME_CODEPAGE}=%%c"`,
    'chcp 65001>nul 2>nul',
  ]
}

/** Restore the caller's console code page, which outlives this process, and keep the exit code. */
function windowsCodePageEpilogue(): string[] {
  return [
    `set "${RUNTIME_EXIT}=%errorlevel%"`,
    `chcp %${RUNTIME_CODEPAGE}% >nul 2>nul`,
    `exit /b %${RUNTIME_EXIT}%`,
  ]
}

/** Build the private Windows Node command used only by pnpm lifecycle scripts. */
function windowsNodeShim(appExecutable: string): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    ...windowsCodePagePrologue(),
    'set "DSH_RUNTIME_PRIVATE=%~dp0.."',
    `set "${RUN_AS_NODE}=1"`,
    `${quoteBatchWord(appExecutable)} --require "%DSH_RUNTIME_PRIVATE%\\clear-env.cjs" %*`,
    ...windowsCodePageEpilogue(),
    '',
  ].join('\r\n')
}

/** Build the public Windows pnpm command. */
function windowsPnpmShim(options: DesktopPnpmRuntimeOptions): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    ...windowsCodePagePrologue(),
    'set "DSH_RUNTIME_ROOT=%~dp0.."',
    'set "DSH_RUNTIME_PRIVATE=%DSH_RUNTIME_ROOT%\\private"',
    'set "DSH_RUNTIME_NODE_BIN=%DSH_RUNTIME_PRIVATE%\\node-bin"',
    'set "PATH=%DSH_RUNTIME_NODE_BIN%;%PATH%"',
    'set "NODE=%DSH_RUNTIME_NODE_BIN%\\node.cmd"',
    `set "${RUN_AS_NODE}=1"`,
    'set "npm_config_runtime=electron"',
    `set "npm_config_target=${escapeBatchSetValue(options.electronVersion)}"`,
    `set "npm_config_disturl=${ELECTRON_HEADERS_URL}"`,
    `${quoteBatchWord(options.appExecutable)} --require "%DSH_RUNTIME_PRIVATE%\\clear-env.cjs" ${quoteBatchWord(options.pnpmBinPath)} ${PNPM_IGNORE_MINIMUM_RELEASE_AGE} %*`,
    ...windowsCodePageEpilogue(),
    '',
  ].join('\r\n')
}

/** Build the public Windows DSH command scoped to one active profile. */
function windowsDshShim(options: DesktopDshRuntimeOptions): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    ...windowsCodePagePrologue(),
    `set "${RUN_AS_NODE}=1"`,
    `set "${DEFAULT_PROFILE}=${escapeBatchSetValue(options.profileName)}"`,
    `set "${DSH_HOME}=${escapeBatchSetValue(options.homeDir)}"`,
    `${quoteBatchWord(options.appExecutable)} --expose-internals ${quoteBatchWord(options.dshBootstrapPath)} %*`,
    ...windowsCodePageEpilogue(),
    '',
  ].join('\r\n')
}

/** Build the public POSIX DSH command scoped to one active profile. */
function posixDshShim(options: DesktopDshRuntimeOptions): string {
  return [
    '#!/bin/sh',
    `${RUN_AS_NODE}=1`,
    `${DEFAULT_PROFILE}=${quoteSh(options.profileName)}`,
    `${DSH_HOME}=${quoteSh(options.homeDir)}`,
    `export ${RUN_AS_NODE} ${DEFAULT_PROFILE} ${DSH_HOME}`,
    `exec ${quoteSh(options.appExecutable)} --expose-internals ${quoteSh(options.dshBootstrapPath)} "$@"`,
    '',
  ].join('\n')
}

interface PathEntry {
  key: string
  value: string | undefined
}

/** Return the environment entries addressing PATH on the selected platform. */
function pathEntries(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): PathEntry[] {
  return Object.entries(environment)
    .filter(([key]) => platform === 'win32' ? key.toUpperCase() === PATH : key === PATH)
    .map(([key, value]) => ({ key, value }))
}

/** Normalize one PATH component for duplicate detection. */
function normalizedPathComponent(component: string, platform: NodeJS.Platform): string {
  const unquoted = platform === 'win32' && component.startsWith('"') && component.endsWith('"')
    ? component.slice(1, -1)
    : component
  if (platform !== 'win32' || unquoted.length === 0) return unquoted
  const normalized = windowsPath.normalize(unquoted)
  const root = windowsPath.parse(normalized).root
  const withoutTrailingSeparators = normalized.length > root.length
    ? normalized.replace(/[\\/]+$/u, '')
    : normalized
  return withoutTrailingSeparators.toLowerCase()
}

/** Remove every occurrence of one directory from a PATH value. */
function withoutPathDirectory(value: string, directory: string, platform: NodeJS.Platform): string {
  const delimiter = platform === 'win32' ? ';' : ':'
  const target = normalizedPathComponent(directory, platform)
  return value
    .split(delimiter)
    .filter(component => normalizedPathComponent(component, platform) !== target)
    .join(delimiter)
}

/** Prepend one directory to PATH and return an idempotent, non-clobbering disposer. */
function installPathDirectory(
  environment: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform,
  obsoleteDirectories: readonly string[] = [],
): () => void {
  const original = pathEntries(environment, platform)
  const current = original.find(entry => entry.value !== undefined)
  const currentValue = current?.value ?? ''
  const key = current?.key ?? PATH
  const delimiter = platform === 'win32' ? ';' : ':'
  const inheritedValue = [directory, ...obsoleteDirectories].reduce(
    (value, candidate) => withoutPathDirectory(value, candidate, platform),
    currentValue,
  )
  const installedValue = inheritedValue.length === 0 ? directory : `${directory}${delimiter}${inheritedValue}`
  if (installedValue === currentValue) {
    return () => {}
  }
  for (const entry of original) delete environment[entry.key]
  environment[key] = installedValue

  let active = true
  return () => {
    if (!active) return
    active = false
    const latest = pathEntries(environment, platform)
    if (latest.length === 1 && latest[0]?.key === key && latest[0].value === installedValue) {
      delete environment[key]
      for (const entry of original) environment[entry.key] = entry.value
      return
    }
    for (const entry of latest) {
      if (entry.value === undefined) continue
      environment[entry.key] = withoutPathDirectory(entry.value, directory, platform)
    }
  }
}

/** Install the packaged DSH command into the Host process PATH. */
export function installDesktopDshRuntime(options: DesktopDshRuntimeOptions): DesktopDshRuntimeInstallation {
  if (options.platform !== 'darwin' && options.platform !== 'linux' && options.platform !== 'win32') {
    throw new Error(`dsh-plugin-desktop: dsh runtime is unsupported on ${options.platform}`)
  }
  assertDesktopProfileName(options.profileName)
  for (const [label, value] of [
    ['application executable', options.appExecutable],
    ['DSH bootstrap', options.dshBootstrapPath],
    ['Harness home', options.homeDir],
    ['state directory', options.stateDir],
  ] as const) assertScriptValue(label, value)

  const windows = options.platform === 'win32'
  const dshShimName = windows ? 'dsh.cmd' : 'dsh'
  const plan = runtimeGenerationPlan('dsh', options.platform, ['bin'], [{
    relativePath: `bin/${dshShimName}`,
    contents: windows ? windowsDshShim(options) : posixDshShim(options),
    mode: windows ? PRIVATE_FILE_MODE : EXECUTABLE_FILE_MODE,
  }])
  const generation = installRuntimeGeneration(options.stateDir, plan)
  const pathDir = join(generation.root, 'bin')
  const dshShimPath = join(pathDir, dshShimName)

  return {
    pathDir,
    dshShimPath,
    dispose: installPathDirectory(
      options.environment ?? process.env,
      pathDir,
      options.platform,
      generation.obsoletePathDirectories,
    ),
  }
}

/**
 * Install the packaged pnpm command into this Electron process's PATH.
 * @param options - packaged executable paths, platform, private state, and parent environment.
 * @returns generated file paths and an idempotent PATH disposer.
 */
export function installDesktopPnpmRuntime(options: DesktopPnpmRuntimeOptions): DesktopPnpmRuntimeInstallation {
  if (options.platform !== 'darwin' && options.platform !== 'linux' && options.platform !== 'win32') {
    throw new Error(`dsh-plugin-desktop: pnpm runtime is unsupported on ${options.platform}`)
  }
  for (const [label, value] of [
    ['application executable', options.appExecutable],
    ['pnpm entry', options.pnpmBinPath],
    ['Electron version', options.electronVersion],
    ['state directory', options.stateDir],
  ] as const) assertScriptValue(label, value)

  const windows = options.platform === 'win32'
  const pnpmShimName = windows ? 'pnpm.cmd' : 'pnpm'
  const nodeShimName = windows ? 'node.cmd' : 'node'
  const plan = runtimeGenerationPlan(
    'pnpm',
    options.platform,
    ['bin', 'private', 'private/node-bin'],
    [
      {
        relativePath: 'private/clear-env.cjs',
        contents: clearEnvironmentModule(options.platform),
        mode: PRIVATE_FILE_MODE,
      },
      {
        relativePath: `private/node-bin/${nodeShimName}`,
        contents: windows ? windowsNodeShim(options.appExecutable) : posixNodeShim(options.appExecutable),
        mode: windows ? PRIVATE_FILE_MODE : EXECUTABLE_FILE_MODE,
      },
      {
        relativePath: `bin/${pnpmShimName}`,
        contents: windows ? windowsPnpmShim(options) : posixPnpmShim(options),
        mode: windows ? PRIVATE_FILE_MODE : EXECUTABLE_FILE_MODE,
      },
    ],
  )
  const generation = installRuntimeGeneration(options.stateDir, plan)
  const pathDir = join(generation.root, 'bin')
  const privateDir = join(generation.root, 'private')
  const nodeBinDir = join(privateDir, 'node-bin')
  const pnpmShimPath = join(pathDir, pnpmShimName)
  const nodeShimPath = join(nodeBinDir, nodeShimName)
  const clearEnvironmentPath = join(privateDir, 'clear-env.cjs')

  return {
    pathDir,
    pnpmShimPath,
    nodeBinDir,
    nodeShimPath,
    clearEnvironmentPath,
    dispose: installPathDirectory(
      options.environment ?? process.env,
      pathDir,
      options.platform,
      generation.obsoletePathDirectories,
    ),
  }
}
