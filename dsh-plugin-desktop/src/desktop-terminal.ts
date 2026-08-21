/** Isolated command-line environment launched from the DSH Desktop tray. */

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, win32 } from 'node:path'
import { DESKTOP_INSTALL_RECOVERY_STATE_ENV } from './install-recovery.ts'
import { assertDesktopProfileName } from './profile-manager.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const DEFAULT_PROFILE = 'DSH_DESKTOP_DEFAULT_PROFILE'
const DSH_HOME = 'DSH_HOME'
const PATH = 'PATH'
const WINDOWS_APP_EXECUTABLE = 'DSH_DESKTOP_APP_EXECUTABLE'
const WINDOWS_DSH_BOOTSTRAP = 'DSH_DESKTOP_DSH_BOOTSTRAP'
const WINDOWS_ELECTRON_VERSION = 'DSH_DESKTOP_ELECTRON_VERSION'
const WINDOWS_PNPM_ENTRY = 'DSH_DESKTOP_PNPM_ENTRY'
const WINDOWS_PROFILE_DIRECTORY = 'DSH_DESKTOP_PROFILE_DIRECTORY'
const WINDOWS_PRODUCT_VERSION = 'DSH_DESKTOP_PRODUCT_VERSION'
const WINDOWS_SHIM_DIRECTORY = 'DSH_DESKTOP_SHIM_DIRECTORY'
const WINDOWS_POWERSHELL_WELCOME = 'DSH_DESKTOP_POWERSHELL_WELCOME'
const WINDOWS_CMD_WELCOME = 'DSH_DESKTOP_CMD_WELCOME'
const WINDOWS_SHELL_EXECUTABLE = 'DSH_DESKTOP_SHELL_EXECUTABLE'
const WINDOWS_GENERATED_ENVIRONMENT_KEYS = new Set([
  DEFAULT_PROFILE,
  WINDOWS_APP_EXECUTABLE,
  WINDOWS_DSH_BOOTSTRAP,
  WINDOWS_ELECTRON_VERSION,
  WINDOWS_PNPM_ENTRY,
  WINDOWS_PROFILE_DIRECTORY,
  WINDOWS_PRODUCT_VERSION,
  WINDOWS_SHIM_DIRECTORY,
  WINDOWS_POWERSHELL_WELCOME,
  WINDOWS_CMD_WELCOME,
  WINDOWS_SHELL_EXECUTABLE,
])
const STATE_DIRECTORY_MODE = 0o700
const EXECUTABLE_FILE_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const WINDOWS_SHELL_COMMANDS = ['pwsh.exe', 'powershell.exe', 'cmd.exe'] as const
const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'

/** Platforms with a native terminal launch contract owned by DSH Desktop. */
export type DesktopTerminalPlatform = 'darwin' | 'win32'

/** Process launcher injected by the Electron adapter. */
export type DesktopTerminalSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

/** Filesystem probe used while resolving a Windows terminal shell. */
export type DesktopTerminalExecutableExists = (filename: string) => boolean

/** Resolver used to locate one Windows terminal shell without a command interpreter. */
export type DesktopTerminalExecutableResolver = (
  command: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  exists: DesktopTerminalExecutableExists,
) => string | undefined

/** Optional Windows terminal accepting a selected shell command after its argument prefix. */
export interface WindowsTerminalLauncher {
  /** Terminal executable, for example `wt.exe`. */
  executable: string
  /** Arguments placed before the selected shell child command. */
  arguments?: readonly string[]
}

/** Inputs for one isolated desktop terminal launch. */
export interface DesktopTerminalOptions {
  /** Host platform selecting the generated scripts and native launcher. */
  platform: NodeJS.Platform
  /** Electron executable reused as Node by command shims. */
  appExecutable: string
  /** Desktop-owned bootstrap that clears Node mode before importing the `dsh` CLI. */
  dshBootstrapPath: string
  /** Packaged JavaScript entry for the `pnpm` CLI. */
  pnpmBinPath: string
  /** Electron version used by pnpm native dependency installation. */
  electronVersion: string
  /** DSH profile selected by the desktop application. */
  profileName: string
  /** Product version displayed in the welcome message. */
  productVersion: string
  /** Absolute working directory of the selected profile. */
  profileDir: string
  /** Harness home exported as `DSH_HOME` inside the terminal. */
  homeDir: string
  /** Desktop-private recovery WAL used by plugin installs from this terminal. */
  installRecoveryStatePath: string
  /** Private directory receiving the generated terminal files. */
  stateDir: string
  /** Process launcher; production passes `node:child_process.spawn`. */
  spawn: DesktopTerminalSpawn
  /** Environment copied into the terminal child; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv
  /** Optional Windows terminal wrapper. Windows Terminal is discovered when omitted. */
  windowsTerminal?: WindowsTerminalLauncher
  /** Windows executable existence probe; defaults to `existsSync`. */
  windowsExecutableExists?: DesktopTerminalExecutableExists
  /** Windows executable resolver; defaults to a trusted PATH/SystemRoot lookup. */
  windowsExecutableResolver?: DesktopTerminalExecutableResolver
  /** Reporter attached before the platform launcher can emit an asynchronous failure. */
  onLaunchError?: (cause: Error) => void
}

/** Files and process created for one desktop terminal launch. */
export interface DesktopTerminalLaunch {
  /** Private directory prepended to this terminal's `PATH`. */
  shimDir: string
  /** Generated platform-specific `dsh` shim. */
  dshShimPath: string
  /** Generated platform-specific `pnpm` shim. */
  pnpmShimPath: string
  /** Generated platform-specific `node` shim backed by Electron's Node mode. */
  nodeShimPath: string
  /** Generated script that configures and welcomes the interactive shell. */
  welcomePath: string
  /** Windows command broker that creates the visible console, when applicable. */
  windowsLauncherPath?: string
  /** Short-lived platform launcher; callers may observe its asynchronous failure. */
  child: ChildProcess
}

/**
 * Keep generated command shims stable for one selected profile.
 * @param userDataDir - Electron-owned persistent data directory.
 * @param profileName - profile embedded in the generated DSH shim.
 * @returns private per-profile terminal state directory.
 */
export function desktopTerminalStateDirectory(userDataDir: string, profileName: string): string {
  assertScriptValue('user data directory', userDataDir)
  assertDesktopProfileName(profileName)
  const identity = createHash('sha256').update(profileName, 'utf8').digest('hex')
  return join(userDataDir, 'cli', identity)
}

interface DesktopTerminalFiles {
  shimDir: string
  dshShimPath: string
  pnpmShimPath: string
  nodeShimPath: string
  welcomePath: string
  windowsCmdWelcomePath?: string
}

/** Reject values that cannot be represented safely in generated command files. */
function assertScriptValue(label: string, value: string): void {
  if (value.length === 0) throw new Error(`dsh-plugin-desktop: terminal ${label} must not be empty`)
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`dsh-plugin-desktop: terminal ${label} must not contain NUL or newlines`)
  }
}

/** Quote one arbitrary value as a POSIX shell word. */
function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** Escape printable text following an `echo(` batch builtin. */
function escapeBatchText(value: string): string {
  if (/\r|\n/.test(value)) {
    throw new Error('dsh-plugin-desktop: terminal Windows welcome text must not contain newlines')
  }
  return value
    .replaceAll('^', '^^')
    .replaceAll('%', '%%')
    .replaceAll('&', '^&')
    .replaceAll('|', '^|')
    .replaceAll('<', '^<')
    .replaceAll('>', '^>')
    .replaceAll('(', '^(')
    .replaceAll(')', '^)')
}

/** Remove a temporary file while preserving every error except absence. */
function unlinkTemporaryFile(filename: string): void {
  try {
    unlinkSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}

/** Replace one generated file without following a pre-existing target symlink. */
function replacePrivateFile(filename: string, contents: string, mode: number): void {
  const temporary = join(dirname(filename), `.${basename(filename)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode })
    chmodSync(temporary, mode)
    renameSync(temporary, filename)
  } finally {
    unlinkTemporaryFile(temporary)
  }
}

/** Create and verify the private directory holding terminal launch files. */
function prepareStateDirectory(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: STATE_DIRECTORY_MODE })
  const stat = lstatSync(stateDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`dsh-plugin-desktop: terminal state path is not a private directory: ${stateDir}`)
  }
  chmodSync(stateDir, STATE_DIRECTORY_MODE)
}

/** Build a command shim that enables Electron's Node mode only for its child. */
function macShim(appExecutable: string, binPath?: string): string {
  const entry = binPath === undefined ? '' : ` ${quoteSh(binPath)}`
  return [
    '#!/bin/sh',
    `${RUN_AS_NODE}=1 exec ${quoteSh(appExecutable)}${entry} "$@"`,
    '',
  ].join('\n')
}

/** Build a command shim that enables Electron's Node mode only for its child. */
function windowsShim(): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "${RUN_AS_NODE}=1"`,
    `"%${WINDOWS_APP_EXECUTABLE}%" %*`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

/** Build the DSH shim with Loader internals and one process-local default profile. */
function macDshShim(options: DesktopTerminalOptions): string {
  return [
    '#!/bin/sh',
    [
      `${DEFAULT_PROFILE}=${quoteSh(options.profileName)}`,
      `${RUN_AS_NODE}=1`,
      `exec ${quoteSh(options.appExecutable)} --expose-internals ${quoteSh(options.dshBootstrapPath)} "$@"`,
    ].join(' '),
    '',
  ].join('\n')
}

/** Build the Windows DSH shim with Loader internals and one local default profile. */
function windowsDshShim(): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "${RUN_AS_NODE}=1"`,
    `"%${WINDOWS_APP_EXECUTABLE}%" --expose-internals "%${WINDOWS_DSH_BOOTSTRAP}%" %*`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

/** Build a pnpm shim with Electron native-module settings scoped to its process tree. */
function macPnpmShim(options: DesktopTerminalOptions): string {
  return [
    '#!/bin/sh',
    [
      `${RUN_AS_NODE}=1`,
      'npm_config_runtime=electron',
      `npm_config_target=${quoteSh(options.electronVersion)}`,
      `npm_config_disturl=${quoteSh(ELECTRON_HEADERS_URL)}`,
      `exec ${quoteSh(options.appExecutable)} ${quoteSh(options.pnpmBinPath)} "$@"`,
    ].join(' '),
    '',
  ].join('\n')
}

/** Build a pnpm batch shim with Electron settings local to its `setlocal` child tree. */
function windowsPnpmShim(): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "${RUN_AS_NODE}=1"`,
    'set "npm_config_runtime=electron"',
    `set "npm_config_target=%${WINDOWS_ELECTRON_VERSION}%"`,
    `set "npm_config_disturl=${ELECTRON_HEADERS_URL}"`,
    `"%${WINDOWS_APP_EXECUTABLE}%" "%${WINDOWS_PNPM_ENTRY}%" %*`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

/** Build a zsh startup file that preserves the user's rc and then restores desktop variables. */
function macZshRc(options: DesktopTerminalOptions, shimDir: string): string {
  return [
    'if [[ -n "${DSH_DESKTOP_USER_ZDOTDIR:-}" && -r "${DSH_DESKTOP_USER_ZDOTDIR}/.zshrc" ]]; then',
    '  ZDOTDIR="${DSH_DESKTOP_USER_ZDOTDIR}"',
    '  source "${DSH_DESKTOP_USER_ZDOTDIR}/.zshrc"',
    'fi',
    `unset ${RUN_AS_NODE}`,
    `export ${DSH_HOME}=${quoteSh(options.homeDir)}`,
    'typeset -U path',
    `path=(${quoteSh(shimDir)} $path)`,
    'export PATH',
    `unset DSH_DESKTOP_USER_ZDOTDIR`,
    '',
  ].join('\n')
}

/** Build a bash startup file that preserves the user's rc and then restores desktop variables. */
function macBashRc(options: DesktopTerminalOptions, shimDir: string): string {
  return [
    'if [ -n "${DSH_DESKTOP_USER_BASHRC:-}" ] && [ -r "${DSH_DESKTOP_USER_BASHRC}" ]; then',
    '  . "${DSH_DESKTOP_USER_BASHRC}"',
    'fi',
    `unset ${RUN_AS_NODE}`,
    `export ${DSH_HOME}=${quoteSh(options.homeDir)}`,
    'case ":${PATH:-}:" in',
    `  *:${quoteSh(shimDir)}:*) ;;`,
    `  *) export PATH=${quoteSh(shimDir)}:"\${PATH:-}" ;;`,
    'esac',
    'unset DSH_DESKTOP_USER_BASHRC',
    '',
  ].join('\n')
}

/** Build the macOS script opened by LaunchServices in the user's terminal. */
function macWelcome(
  options: DesktopTerminalOptions,
  shimDir: string,
  bashRcPath: string,
): string {
  const commandHelp = 'dsh --dump-config'
  const pluginAdd = 'dsh plugin add <third-party-plugin>'
  const pluginRemove = 'dsh plugin remove <third-party-plugin>'
  const pluginUpdate = 'dsh plugin update'
  return [
    '#!/bin/sh',
    `unset ${RUN_AS_NODE}`,
    `export ${DSH_HOME}=${quoteSh(options.homeDir)}`,
    `export PATH=${quoteSh(shimDir)}:"\${PATH:-}"`,
    `cd ${quoteSh(options.profileDir)}`,
    "printf '\\033[2J\\033[3J\\033[H'",
    `printf '%s\\n' ${quoteSh(`DSH Desktop ${options.productVersion} terminal`)}`,
    `printf '%s\\n' ${quoteSh(`Profile: ${options.profileName}`)}`,
    `printf '%s\\n' ${quoteSh(`Profile directory: ${options.profileDir}`)}`,
    `printf '%s\\n' ${quoteSh(`Harness home: ${options.homeDir}`)}`,
    `printf '%s\\n' ${quoteSh(`Plugin commands without --profile modify the ${options.profileName} profile.`)}`,
    `printf '%s\\n' ${quoteSh('Commands:')}`,
    `printf '  %s\\n' ${quoteSh(commandHelp)}`,
    `printf '  %s\\n' ${quoteSh(pluginAdd)}`,
    `printf '  %s\\n' ${quoteSh(pluginRemove)}`,
    `printf '  %s\\n' ${quoteSh(pluginUpdate)}`,
    `printf '%s\\n' ${quoteSh('Restart DSH Desktop after plugin changes.')}`,
    'case "${SHELL:-/bin/zsh}" in',
    '  */bash)',
    '    export DSH_DESKTOP_USER_BASHRC="${HOME:-}/.bashrc"',
    `    exec "\${SHELL}" --noprofile --rcfile ${quoteSh(bashRcPath)} -i`,
    '    ;;',
    '  */zsh)',
    '    export DSH_DESKTOP_USER_ZDOTDIR="${ZDOTDIR:-${HOME:-}}"',
    `    export ZDOTDIR=${quoteSh(options.stateDir)}`,
    '    exec "${SHELL}" -i',
    '    ;;',
    '  *)',
    '    export DSH_DESKTOP_USER_ZDOTDIR="${ZDOTDIR:-${HOME:-}}"',
    `    export ZDOTDIR=${quoteSh(options.stateDir)}`,
    '    exec /bin/zsh -i',
    '    ;;',
    'esac',
    '',
  ].join('\n')
}

/** Build the PowerShell script that remains active in the new console. */
function windowsWelcome(): string {
  const commandHelp = 'dsh --dump-config'
  const pluginAdd = 'dsh plugin add <third-party-plugin>'
  const pluginRemove = 'dsh plugin remove <third-party-plugin>'
  const pluginUpdate = 'dsh plugin update'
  return [
    `Remove-Item Env:${RUN_AS_NODE} -ErrorAction SilentlyContinue`,
    `$dshDesktopShimDir = $env:${WINDOWS_SHIM_DIRECTORY}`,
    `$dshDesktopPath = @($env:${PATH} -split ';' | Where-Object { -not [string]::Equals($_, $dshDesktopShimDir, [StringComparison]::OrdinalIgnoreCase) })`,
    `$env:${PATH} = (@($dshDesktopShimDir) + $dshDesktopPath) -join ';'`,
    `Set-Location -LiteralPath $env:${WINDOWS_PROFILE_DIRECTORY}`,
    `Write-Host ("DSH Desktop {0} terminal" -f $env:${WINDOWS_PRODUCT_VERSION})`,
    `Write-Host ("Profile: {0}" -f $env:${DEFAULT_PROFILE})`,
    `Write-Host ("Profile directory: {0}" -f $env:${WINDOWS_PROFILE_DIRECTORY})`,
    `Write-Host ("Harness home: {0}" -f $env:${DSH_HOME})`,
    `Write-Host ("Plugin commands without --profile modify the {0} profile." -f $env:${DEFAULT_PROFILE})`,
    `Write-Host 'Commands:'`,
    `Write-Host '  ${commandHelp}'`,
    `Write-Host '  ${pluginAdd}'`,
    `Write-Host '  ${pluginRemove}'`,
    `Write-Host '  ${pluginUpdate}'`,
    `Write-Host 'Restart DSH Desktop after plugin changes.'`,
    '',
  ].join('\r\n')
}

/** Build the fallback batch welcome script used when PowerShell is unavailable. */
function windowsCmdWelcome(): string {
  const commandHelp = 'dsh --dump-config'
  const pluginAdd = 'dsh plugin add <third-party-plugin>'
  const pluginRemove = 'dsh plugin remove <third-party-plugin>'
  const pluginUpdate = 'dsh plugin update'
  return [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    `set "${RUN_AS_NODE}="`,
    `cd /d "!${WINDOWS_PROFILE_DIRECTORY}!"`,
    `echo(DSH Desktop !${WINDOWS_PRODUCT_VERSION}! terminal`,
    `echo(Profile: !${DEFAULT_PROFILE}!`,
    `echo(Profile directory: !${WINDOWS_PROFILE_DIRECTORY}!`,
    `echo(Harness home: !${DSH_HOME}!`,
    `echo(Plugin commands without --profile modify the !${DEFAULT_PROFILE}! profile.`,
    'echo(Commands:',
    `echo(  ${escapeBatchText(commandHelp)}`,
    `echo(  ${escapeBatchText(pluginAdd)}`,
    `echo(  ${escapeBatchText(pluginRemove)}`,
    `echo(  ${escapeBatchText(pluginUpdate)}`,
    `echo(${escapeBatchText('Restart DSH Desktop after plugin changes.')}`,
    'endlocal & set "ELECTRON_RUN_AS_NODE="',
    '',
  ].join('\r\n')
}

/** Create command shims and the interactive welcome script. */
function prepareDesktopTerminalFiles(options: DesktopTerminalOptions): DesktopTerminalFiles {
  if (options.platform !== 'darwin' && options.platform !== 'win32') {
    throw new Error(`dsh-plugin-desktop: terminal is unsupported on ${options.platform}`)
  }
  assertDesktopProfileName(options.profileName)
  for (const [label, value] of [
    ['application executable', options.appExecutable],
    ['dsh bootstrap', options.dshBootstrapPath],
    ['pnpm entry', options.pnpmBinPath],
    ['Electron version', options.electronVersion],
    ['profile directory', options.profileDir],
    ['Harness home', options.homeDir],
    ['install recovery state', options.installRecoveryStatePath],
    ['state directory', options.stateDir],
    ['product version', options.productVersion],
  ] as const) assertScriptValue(label, value)

  prepareStateDirectory(options.stateDir)
  const shimDir = join(options.stateDir, 'bin')
  prepareStateDirectory(shimDir)
  if (options.platform === 'darwin') {
    const files: DesktopTerminalFiles = {
      shimDir,
      dshShimPath: join(shimDir, 'dsh'),
      pnpmShimPath: join(shimDir, 'pnpm'),
      nodeShimPath: join(shimDir, 'node'),
      welcomePath: join(options.stateDir, 'welcome.command'),
    }
    const bashRcPath = join(options.stateDir, 'bashrc')
    replacePrivateFile(files.dshShimPath, macDshShim(options), EXECUTABLE_FILE_MODE)
    replacePrivateFile(files.pnpmShimPath, macPnpmShim(options), EXECUTABLE_FILE_MODE)
    replacePrivateFile(files.nodeShimPath, macShim(options.appExecutable), EXECUTABLE_FILE_MODE)
    replacePrivateFile(join(options.stateDir, '.zshrc'), macZshRc(options, shimDir), PRIVATE_FILE_MODE)
    replacePrivateFile(bashRcPath, macBashRc(options, shimDir), PRIVATE_FILE_MODE)
    replacePrivateFile(files.welcomePath, macWelcome(options, shimDir, bashRcPath), EXECUTABLE_FILE_MODE)
    return files
  }
  if (options.platform === 'win32') {
    const windowsCmdWelcomePath = join(options.stateDir, 'welcome.cmd')
    const files: DesktopTerminalFiles = {
      shimDir,
      dshShimPath: join(shimDir, 'dsh.cmd'),
      pnpmShimPath: join(shimDir, 'pnpm.cmd'),
      nodeShimPath: join(shimDir, 'node.cmd'),
      welcomePath: join(options.stateDir, 'welcome.ps1'),
      windowsCmdWelcomePath,
    }
    replacePrivateFile(files.dshShimPath, windowsDshShim(), PRIVATE_FILE_MODE)
    replacePrivateFile(files.pnpmShimPath, windowsPnpmShim(), PRIVATE_FILE_MODE)
    replacePrivateFile(files.nodeShimPath, windowsShim(), PRIVATE_FILE_MODE)
    replacePrivateFile(files.welcomePath, windowsWelcome(), PRIVATE_FILE_MODE)
    replacePrivateFile(windowsCmdWelcomePath, windowsCmdWelcome(), PRIVATE_FILE_MODE)
    return files
  }
  throw new Error(`dsh-plugin-desktop: terminal is unsupported on ${options.platform}`)
}

/** Copy the Host environment and scope desktop command discovery to one terminal child. */
function terminalEnvironment(options: DesktopTerminalOptions, files: DesktopTerminalFiles): NodeJS.ProcessEnv {
  const source = options.environment ?? process.env
  const env: NodeJS.ProcessEnv = {}
  let inheritedPath: string | undefined
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toUpperCase()
    if (
      normalized === RUN_AS_NODE
      || normalized === DSH_HOME
      || normalized === DESKTOP_INSTALL_RECOVERY_STATE_ENV
    ) continue
    if (options.platform === 'win32' && WINDOWS_GENERATED_ENVIRONMENT_KEYS.has(normalized)) continue
    if (normalized === PATH) {
      inheritedPath ??= value
      continue
    }
    env[key] = value
  }
  const delimiter = options.platform === 'win32' ? ';' : ':'
  env[PATH] = inheritedPath === undefined || inheritedPath.length === 0
    ? files.shimDir
    : `${files.shimDir}${delimiter}${inheritedPath}`
  env[DSH_HOME] = options.homeDir
  env[DESKTOP_INSTALL_RECOVERY_STATE_ENV] = options.installRecoveryStatePath
  if (options.platform === 'win32') {
    env[DEFAULT_PROFILE] = options.profileName
    env[WINDOWS_APP_EXECUTABLE] = options.appExecutable
    env[WINDOWS_DSH_BOOTSTRAP] = options.dshBootstrapPath
    env[WINDOWS_ELECTRON_VERSION] = options.electronVersion
    env[WINDOWS_PNPM_ENTRY] = options.pnpmBinPath
    env[WINDOWS_PROFILE_DIRECTORY] = options.profileDir
    env[WINDOWS_PRODUCT_VERSION] = options.productVersion
    env[WINDOWS_SHIM_DIRECTORY] = files.shimDir
    env[WINDOWS_POWERSHELL_WELCOME] = files.welcomePath
    if (files.windowsCmdWelcomePath !== undefined) env[WINDOWS_CMD_WELCOME] = files.windowsCmdWelcomePath
  }
  return env
}

/** Read one Windows environment value without trusting its key casing. */
function windowsEnvironmentValue(environment: Readonly<NodeJS.ProcessEnv>, name: string): string | undefined {
  const normalized = name.toUpperCase()
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === normalized) return value
  }
  return undefined
}

/** Resolve known Windows shells from explicit system paths and then the inherited PATH. */
function defaultWindowsExecutableResolver(
  command: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  exists: DesktopTerminalExecutableExists,
): string | undefined {
  const candidates: string[] = []
  const systemRoot = windowsEnvironmentValue(environment, 'SystemRoot')
  if (command.toLowerCase() === 'powershell.exe' && systemRoot !== undefined) {
    candidates.push(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  }
  if (command.toLowerCase() === 'cmd.exe') {
    const comSpec = windowsEnvironmentValue(environment, 'ComSpec')
    if (comSpec !== undefined) candidates.push(comSpec)
    if (systemRoot !== undefined) candidates.push(win32.join(systemRoot, 'System32', 'cmd.exe'))
  }
  const inheritedPath = windowsEnvironmentValue(environment, PATH)
  if (inheritedPath !== undefined) {
    for (const rawDir of inheritedPath.split(';')) {
      const dir = rawDir.startsWith('"') && rawDir.endsWith('"') ? rawDir.slice(1, -1) : rawDir
      if (dir.length > 0) candidates.push(win32.join(dir, command))
    }
  }
  return candidates.find(candidate => exists(candidate))
}

interface ResolvedWindowsShell {
  kind: 'powershell' | 'cmd'
  executable: string
}

/** Resolve the preferred Windows Terminal host, preserving an explicit adapter. */
function resolveWindowsTerminal(
  options: DesktopTerminalOptions,
  _environment: Readonly<NodeJS.ProcessEnv>,
): WindowsTerminalLauncher | undefined {
  return options.windowsTerminal
}

/** Select PowerShell 7, Windows PowerShell, or the built-in command prompt. */
function resolveWindowsShell(
  options: DesktopTerminalOptions,
  environment: Readonly<NodeJS.ProcessEnv>,
): ResolvedWindowsShell {
  const exists = options.windowsExecutableExists ?? existsSync
  const resolveExecutable = options.windowsExecutableResolver ?? defaultWindowsExecutableResolver
  for (const command of WINDOWS_SHELL_COMMANDS) {
    const executable = resolveExecutable(command, environment, exists)
    if (executable === undefined) continue
    assertScriptValue(`${command} executable`, executable)
    return {
      kind: command === 'cmd.exe' ? 'cmd' : 'powershell',
      executable,
    }
  }
  throw new Error('dsh-plugin-desktop: terminal requires pwsh.exe, powershell.exe, or cmd.exe on Windows')
}

/** Convert one selected Windows shell into an argv-only launch. */
function windowsShellArgv(
  shell: ResolvedWindowsShell,
  files: DesktopTerminalFiles,
): string[] {
  if (shell.kind === 'cmd') {
    const welcome = files.windowsCmdWelcomePath
    if (welcome === undefined) {
      throw new Error('dsh-plugin-desktop: terminal did not generate the Windows command prompt welcome script')
    }
    return ['/D', '/K', 'call', welcome]
  }
  return [
    '-NoLogo',
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    files.welcomePath,
  ]
}

/** Resolve the trusted command processor used only to invoke the `start` broker. */
function resolveWindowsCommandProcessor(
  options: DesktopTerminalOptions,
  environment: Readonly<NodeJS.ProcessEnv>,
  shell: ResolvedWindowsShell,
): string {
  if (shell.kind === 'cmd') return shell.executable
  const exists = options.windowsExecutableExists ?? existsSync
  const resolveExecutable = options.windowsExecutableResolver ?? defaultWindowsExecutableResolver
  const executable = resolveExecutable('cmd.exe', environment, exists)
  if (executable === undefined) {
    throw new Error('dsh-plugin-desktop: terminal requires cmd.exe to create a visible Windows console')
  }
  assertScriptValue('cmd.exe executable', executable)
  return executable
}

/** Build the trusted batch broker whose `start` command owns the visible console. */
function windowsLaunchBroker(
  shell: ResolvedWindowsShell,
): string {
  const target = shell.kind === 'cmd'
    ? `"!${WINDOWS_SHELL_EXECUTABLE}!" /D /K call "!${WINDOWS_CMD_WELCOME}!"`
    : `"!${WINDOWS_SHELL_EXECUTABLE}!" -NoLogo -NoExit -ExecutionPolicy Bypass -File "!${WINDOWS_POWERSHELL_WELCOME}!"`
  return [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    `start "DSH Desktop" /D "!${WINDOWS_PROFILE_DIRECTORY}!" ${target}`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

/** Report a launcher error without leaving an unhandled EventEmitter error. */
function reportLaunchError(options: DesktopTerminalOptions, cause: Error): void {
  if (options.onLaunchError !== undefined) {
    try {
      options.onLaunchError(cause)
      return
    } catch (reportCause) {
      const detail = reportCause instanceof Error ? reportCause.message : String(reportCause)
      process.stderr.write(`dsh-plugin-desktop: terminal error reporter failed: ${detail}\n`)
      return
    }
  }
  process.stderr.write(`dsh-plugin-desktop: failed to open terminal: ${cause.message}\n`)
}

/**
 * Generate a private desktop CLI environment and open it in a native terminal.
 * @param options - packaged CLI paths, profile identity, private state, and process adapter.
 * @returns generated file paths and the platform launcher process.
 */
export function openDesktopTerminal(options: DesktopTerminalOptions): DesktopTerminalLaunch {
  const files = prepareDesktopTerminalFiles(options)
  const env = terminalEnvironment(options, files)
  let command: string
  let args: string[]
  let detached = true
  let windowsHide = false
  let launcherCwd = options.profileDir
  let windowsLauncherPath: string | undefined
  if (options.platform === 'darwin') {
    command = '/usr/bin/open'
    args = ['-a', 'Terminal', files.welcomePath]
  } else {
    const shell = resolveWindowsShell(options, env)
    const shellArgs = windowsShellArgv(shell, files)
    const windowsTerminal = resolveWindowsTerminal(options, env)
    if (windowsTerminal !== undefined) {
      command = windowsTerminal.executable
      args = [...(windowsTerminal.arguments ?? []), shell.executable, ...shellArgs]
    } else {
      command = resolveWindowsCommandProcessor(options, env, shell)
      env[WINDOWS_SHELL_EXECUTABLE] = shell.executable
      windowsLauncherPath = join(options.stateDir, 'launch.cmd')
      replacePrivateFile(
        windowsLauncherPath,
        windowsLaunchBroker(shell),
        PRIVATE_FILE_MODE,
      )
      args = ['/D', '/S', '/C', basename(windowsLauncherPath)]
      detached = false
      windowsHide = true
      launcherCwd = options.stateDir
    }
  }
  const spawnOptions: SpawnOptions = {
    cwd: launcherCwd,
    detached,
    env,
    shell: false,
    stdio: 'ignore',
    windowsHide,
  }
  const child = options.spawn(command, args, spawnOptions)
  let launchFailureReported = false
  const reportLaunchFailure = (cause: Error): void => {
    if (launchFailureReported) return
    launchFailureReported = true
    reportLaunchError(options, cause)
  }
  child.once('error', reportLaunchFailure)
  child.once('exit', (code, signal) => {
    if (code === 0) return
    const outcome = code === null
      ? `signal ${signal ?? 'unknown'}`
      : `code ${String(code)}`
    reportLaunchFailure(new Error(`terminal launcher exited with ${outcome}`))
  })
  child.unref()
  return {
    shimDir: files.shimDir,
    dshShimPath: files.dshShimPath,
    pnpmShimPath: files.pnpmShimPath,
    nodeShimPath: files.nodeShimPath,
    welcomePath: files.welcomePath,
    ...(windowsLauncherPath === undefined ? {} : { windowsLauncherPath }),
    child,
  }
}
