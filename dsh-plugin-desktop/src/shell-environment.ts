/** Resolve the login-shell PATH used by a packaged Unix desktop launch. */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'

const DEFAULT_CAPTURE_TIMEOUT_MS = 2_000
const MAX_CAPTURE_BYTES = 1024 * 1024

/** Result of resolving the PATH inherited by the desktop Host. */
export interface DesktopShellPathResolution {
  /** PATH value to use; `undefined` only when no inherited PATH exists. */
  readonly path: string | undefined
  /** Whether a login shell contributed the PATH. */
  readonly source: 'process' | 'login-shell'
  /** Stable diagnostic reason when the inherited process PATH was retained. */
  readonly fallbackReason?:
    | 'not-packaged'
    | 'windows'
    | 'unsupported-platform'
    | 'missing-shell'
    | 'capture-failed'
    | 'missing-path'
}

/** Inputs for {@link resolveDesktopShellPath}. */
export interface ResolveDesktopShellPathOptions {
  readonly environment: NodeJS.ProcessEnv
  readonly home: string
  readonly isPackaged: boolean
  readonly platform: NodeJS.Platform
  readonly shell?: string
  readonly timeoutMs?: number
  readonly capture?: (shell: string, home: string, environment: NodeJS.ProcessEnv, timeoutMs: number) => Promise<NodeJS.ProcessEnv>
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
 * Capture one login shell's environment without accepting its ordinary stdout or stderr.
 * @param shell - Absolute or PATH-resolved shell executable.
 * @param home - Working directory for shell startup.
 * @param environment - Environment inherited by the shell.
 * @param timeoutMs - Hard deadline before the shell is killed.
 * @returns Environment printed after the shell startup files finish.
 */
export async function captureLoginShellEnvironment(
  shell: string,
  home: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number = DEFAULT_CAPTURE_TIMEOUT_MS,
): Promise<NodeJS.ProcessEnv> {
  const nonce = randomBytes(16).toString('hex')
  const startMarker = `dsh-shell-env-start-${nonce}`
  const endMarker = `dsh-shell-env-end-${nonce}`
  const command = `printf '%s\\0' '${startMarker}' >&3; /usr/bin/env -0 >&3; printf '%s\\0' '${endMarker}' >&3`
  const shellName = shell.split('/').at(-1)?.toLowerCase()
  const args = shellName === 'nu' || shellName === 'nushell'
    ? ['--login', '--interactive', '--commands', command]
    : ['-ilc', command]
  const child = spawn(shell, args, {
    cwd: home,
    detached: true,
    env: environment,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  })
  const killShellTree = (): void => {
    try {
      if (child.pid === undefined) child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    } catch {
      // A spawn failure or an already-exited process needs no further cleanup.
    }
  }
  const output = child.stdio[3]
  if (output === null || output === undefined) {
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

function inheritedPath(
  environment: NodeJS.ProcessEnv,
  fallbackReason: NonNullable<DesktopShellPathResolution['fallbackReason']>,
): DesktopShellPathResolution {
  return { path: environment.PATH, source: 'process', fallbackReason }
}

/**
 * Resolve the PATH for a desktop Host launch.
 * @param options - Platform, launch environment and optional capture seam.
 * @returns A login-shell PATH on packaged Unix desktops, otherwise the inherited PATH.
 */
export async function resolveDesktopShellPath(options: ResolveDesktopShellPathOptions): Promise<DesktopShellPathResolution> {
  if (!options.isPackaged) return inheritedPath(options.environment, 'not-packaged')
  if (options.platform === 'win32') return inheritedPath(options.environment, 'windows')
  if (options.platform !== 'darwin' && options.platform !== 'linux') {
    return inheritedPath(options.environment, 'unsupported-platform')
  }

  let shell = options.shell ?? options.environment.SHELL
  if (shell === undefined || shell === '') {
    try {
      shell = userInfo().shell ?? undefined
    } catch {
      return inheritedPath(options.environment, 'missing-shell')
    }
  }
  if (shell === '') return inheritedPath(options.environment, 'missing-shell')
  if (shell === undefined) return inheritedPath(options.environment, 'missing-shell')

  try {
    const capture = options.capture ?? captureLoginShellEnvironment
    const captured = await capture(shell, options.home, options.environment, options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS)
    const capturedPath = captured.PATH
    if (capturedPath !== undefined && capturedPath !== '') {
      return { path: capturedPath, source: 'login-shell' }
    }
    return inheritedPath(options.environment, 'missing-path')
  } catch {
    return inheritedPath(options.environment, 'capture-failed')
  }
}
