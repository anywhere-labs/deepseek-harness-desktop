/** Recover selected login-shell exports for packaged Unix desktop launches. */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { basename, isAbsolute } from 'node:path'
import {
  DSH_ENV_PREFIX,
  SENSITIVE_ENV_PATTERN,
  scrubbedParentEnv,
} from '@deepseek-ai/dsh-subprocess'

const DEFAULT_CAPTURE_TIMEOUT_MS = 2_000
const MAX_CAPTURE_BYTES = 1024 * 1024

const SUPPORTED_SHELL_ARGUMENTS = new Map<string, readonly string[]>([
  ['bash', ['-ilc']],
  ['fish', ['--login', '--interactive', '--command']],
  ['zsh', ['-ilc']],
])

/**
 * Exported rc variables that Desktop may recover in addition to PATH.
 *
 * Keep this list deliberately narrow: shell startup files are trusted user
 * code, but their complete exported environment is not an appropriate ambient
 * API for Electron or model-facing subprocesses.
 */
export const DESKTOP_SHELL_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ASDF_DATA_DIR',
  'ASDF_DIR',
  'BUN_INSTALL',
  'CARGO_HOME',
  'CONDA_DEFAULT_ENV',
  'CONDA_PREFIX',
  'DENO_INSTALL',
  'DOTNET_ROOT',
  'FLUTTER_ROOT',
  'GEM_HOME',
  'GEM_PATH',
  'GOBIN',
  'GOMODCACHE',
  'GOPATH',
  'GOROOT',
  'HOMEBREW_CELLAR',
  'HOMEBREW_PREFIX',
  'HOMEBREW_REPOSITORY',
  'JAVA_HOME',
  'LANG',
  'LANGUAGE',
  'MISE_CACHE_DIR',
  'MISE_CONFIG_DIR',
  'MISE_DATA_DIR',
  'MISE_STATE_DIR',
  'NVM_BIN',
  'NVM_DIR',
  'NVM_INC',
  'PNPM_HOME',
  'PYENV_ROOT',
  'RBENV_ROOT',
  'RUSTUP_HOME',
  'SDKMAN_DIR',
  'SDKROOT',
  'TZ',
  'VIRTUAL_ENV',
  'VOLTA_HOME',
])

/** Environment updates recovered for the desktop Host. */
export interface DesktopShellEnvironmentResolution {
  /** Selected entries to merge into `process.env`; inherited entries are omitted. */
  readonly updates: Readonly<Record<string, string>>
  /** Whether a login shell contributed any updates. */
  readonly source: 'process' | 'login-shell'
  /** Stable diagnostic reason when the inherited process environment was retained. */
  readonly fallbackReason?:
    | 'not-packaged'
    | 'windows'
    | 'unsupported-platform'
    | 'missing-shell'
    | 'unsupported-shell'
    | 'capture-failed'
    | 'missing-path'
}

/** Inputs for {@link resolveDesktopShellEnvironment}. */
export interface ResolveDesktopShellEnvironmentOptions {
  readonly environment: NodeJS.ProcessEnv
  readonly home: string
  readonly isPackaged: boolean
  readonly platform: NodeJS.Platform
  readonly shell?: string
  readonly timeoutMs?: number
  readonly capture?: (shell: string, home: string, environment: NodeJS.ProcessEnv, timeoutMs: number) => Promise<NodeJS.ProcessEnv>
  /** Test seam for the official parent-environment scrub. */
  readonly scrubParent?: () => Readonly<Record<string, string>>
}

/**
 * Parse the NUL-delimited payload emitted by the shell capture command.
 * @param payload - Captured bytes from the command's private file descriptor.
 * @param startMarker - Random record that begins the environment payload.
 * @param endMarker - Random record that ends the environment payload.
 * @returns Environment entries found between the markers.
 */
export function parseShellEnvironment(payload: Buffer, startMarker: string, endMarker: string): NodeJS.ProcessEnv {
  const start = `${startMarker}\0`
  const end = `${endMarker}\0`
  const text = payload.toString('utf8')
  const startIndex = text.indexOf(start)
  if (startIndex < 0) throw new Error('desktop shell environment did not emit its start marker')
  const bodyStart = startIndex + start.length
  const endIndex = text.indexOf(end, bodyStart)
  if (endIndex < 0) throw new Error('desktop shell environment did not emit its end marker')

  const environment: NodeJS.ProcessEnv = {}
  for (const record of text.slice(bodyStart, endIndex).split('\0')) {
    if (record === '') continue
    const separator = record.indexOf('=')
    if (separator <= 0) throw new Error('desktop shell environment emitted an invalid record')
    environment[record.slice(0, separator)] = record.slice(separator + 1)
  }
  return environment
}

/**
 * Capture one interactive login shell's exported environment without accepting
 * startup-file stdout or stderr as environment records.
 * @param shell - Absolute zsh, bash, or fish executable.
 * @param home - Working directory for shell startup.
 * @param environment - Already-scrubbed environment inherited by the shell.
 * @param timeoutMs - Hard deadline before the shell is killed.
 * @returns Environment printed after the shell startup files finish.
 */
export async function captureLoginShellEnvironment(
  shell: string,
  home: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number = DEFAULT_CAPTURE_TIMEOUT_MS,
): Promise<NodeJS.ProcessEnv> {
  if (!isAbsolute(shell)) throw new Error('desktop shell environment requires an absolute shell path')
  const shellArguments = SUPPORTED_SHELL_ARGUMENTS.get(basename(shell).toLowerCase())
  if (shellArguments === undefined) throw new Error('desktop shell environment does not support this shell')

  const nonce = randomBytes(16).toString('hex')
  const startMarker = `dsh-shell-env-start-${nonce}`
  const endMarker = `dsh-shell-env-end-${nonce}`
  const command = `/usr/bin/printf '%s\\0' '${startMarker}'; /usr/bin/env -0; /usr/bin/printf '%s\\0' '${endMarker}'`
  const child = spawn(shell, [...shellArguments, command], {
    cwd: home,
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const killShellTree = (): void => {
    try {
      if (child.pid === undefined) child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    } catch {
      // If the process group is not visible yet, still terminate its leader.
      try {
        child.kill('SIGKILL')
      } catch {
        // A spawn failure or an already-exited process needs no further cleanup.
      }
    }
  }
  const output = child.stdout
  if (output === null) {
    const closed = new Promise<void>((resolve) => {
      child.once('error', () => {})
      child.once('close', () => { resolve() })
    })
    killShellTree()
    await closed
    throw new Error('desktop shell environment has no capture stream')
  }

  return await new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
    const chunks: Buffer[] = []
    let byteLength = 0
    let failure: Error | undefined
    let reading = true

    const stopReading = (): void => {
      if (!reading) return
      reading = false
      output.off('data', accept)
    }
    const failAndKill = (error: Error): void => {
      if (failure !== undefined) return
      failure = error
      stopReading()
      output.destroy()
      killShellTree()
    }
    const accept = (chunk: Buffer | string): void => {
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        byteLength += buffer.byteLength
        if (byteLength > MAX_CAPTURE_BYTES) {
          failAndKill(new Error(`desktop shell environment exceeded ${String(MAX_CAPTURE_BYTES)} bytes`))
          return
        }
        chunks.push(buffer)
      } catch (error) {
        failAndKill(error instanceof Error ? error : new Error(String(error)))
      }
    }

    output.on('data', accept)
    child.once('error', failAndKill)
    const timer = setTimeout(() => {
      failAndKill(new Error(`desktop shell environment timed out after ${String(timeoutMs)}ms`))
    }, timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      stopReading()
      if (failure !== undefined) {
        reject(failure)
        return
      }
      try {
        resolve(parseShellEnvironment(Buffer.concat(chunks), startMarker, endMarker))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

function inheritedEnvironment(
  fallbackReason: NonNullable<DesktopShellEnvironmentResolution['fallbackReason']>,
): DesktopShellEnvironmentResolution {
  return { updates: {}, source: 'process', fallbackReason }
}

function isOfficiallyScrubbedName(name: string): boolean {
  return !SENSITIVE_ENV_PATTERN.test(name) && !name.toUpperCase().startsWith(DSH_ENV_PREFIX)
}

function isSelectedShellEnvironmentName(name: string): boolean {
  return name === 'PATH' || name.startsWith('LC_') || DESKTOP_SHELL_ENVIRONMENT_KEYS.has(name)
}

/**
 * Select safe, useful login-shell exports without overriding an explicit app
 * launch environment. PATH is the sole exception: its login-shell value wins.
 */
export function selectDesktopShellEnvironment(
  captured: Readonly<NodeJS.ProcessEnv>,
  inherited: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const updates: Record<string, string> = {}
  for (const [name, value] of Object.entries(captured)) {
    if (
      value === undefined
      || !isOfficiallyScrubbedName(name)
      || !isSelectedShellEnvironmentName(name)
    ) continue
    if (name === 'PATH') {
      if (value !== '') updates.PATH = value
      continue
    }
    if (inherited[name] === undefined) updates[name] = value
  }
  return updates
}

function resolveUserShell(options: ResolveDesktopShellEnvironmentOptions): string | undefined {
  if (options.shell !== undefined) return options.shell
  try {
    const accountShell = userInfo().shell
    if (accountShell !== '' && accountShell !== null) return accountShell
  } catch {
    // The inherited SHELL remains a safe compatibility fallback.
  }
  return options.environment.SHELL
}

/**
 * Resolve selected login-shell exports for a desktop Host launch.
 * @param options - Platform, launch environment and optional capture seams.
 * @returns Updates for packaged Unix desktops, otherwise an empty update set.
 */
export async function resolveDesktopShellEnvironment(
  options: ResolveDesktopShellEnvironmentOptions,
): Promise<DesktopShellEnvironmentResolution> {
  if (!options.isPackaged) return inheritedEnvironment('not-packaged')
  if (options.platform === 'win32') return inheritedEnvironment('windows')
  if (options.platform !== 'darwin' && options.platform !== 'linux') {
    return inheritedEnvironment('unsupported-platform')
  }

  const shell = resolveUserShell(options)
  if (shell === undefined || shell === '') return inheritedEnvironment('missing-shell')
  if (!isAbsolute(shell) || !SUPPORTED_SHELL_ARGUMENTS.has(basename(shell).toLowerCase())) {
    return inheritedEnvironment('unsupported-shell')
  }

  try {
    const scrubParent = options.scrubParent ?? scrubbedParentEnv
    const captureEnvironment: NodeJS.ProcessEnv = {
      ...scrubParent(),
      HOME: options.home,
      SHELL: shell,
    }
    const capture = options.capture ?? captureLoginShellEnvironment
    const captured = await capture(shell, options.home, captureEnvironment, options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS)
    const updates = selectDesktopShellEnvironment(captured, options.environment)
    if (updates.PATH === undefined) return inheritedEnvironment('missing-path')
    return { updates, source: 'login-shell' }
  } catch {
    return inheritedEnvironment('capture-failed')
  }
}
