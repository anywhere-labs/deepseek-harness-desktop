/** Re-materialize a restored profile before the Cordis Host is created. */

import { spawn as childSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { delimiter, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const TERMINATION_GRACE_MS = 3_000

/** Runtime inputs resolved by the Electron bootstrap. */
export interface ProfileMaterializerOptions {
  /** Native ABI targeted by the Host process; Desktop defaults to Electron. */
  readonly runtime?: 'electron' | 'node'
  readonly appExecutable: string
  readonly clearEnvironmentPath: string
  readonly pnpmBinPath: string
  readonly nodeBinDir: string
  readonly nodeShimPath: string
  readonly homeDir: string
  readonly profileDir: string
  readonly electronVersion: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  /** Injectable only for headless tests; production uses node:child_process.spawn. */
  readonly spawn?: ProfileMaterializerSpawn
}

/** The small spawn seam used by tests and embedders. */
export type ProfileMaterializerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

/** Completed package-manager invocation. */
export interface ProfileMaterializationResult {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

/** Error raised when profile materialization cannot complete successfully. */
export class ProfileMaterializationError extends Error {
  readonly result?: ProfileMaterializationResult

  constructor(message: string, result?: ProfileMaterializationResult) {
    super(message)
    this.name = 'ProfileMaterializationError'
    if (result !== undefined) this.result = result
  }
}

function inheritedPath(): string {
  const exact = process.env.PATH
  if (exact !== undefined || process.platform !== 'win32') return exact ?? ''
  return Object.entries(process.env)
    .find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
}

function assertAbsolutePath(label: string, value: string): void {
  if (value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new ProfileMaterializationError(`profile materializer ${label} must be an absolute path without NUL`)
  }
}

function assertPositiveFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ProfileMaterializationError(`profile materializer ${label} must be positive`)
  }
}

function killProcessTree(child: ChildProcess, force = false): void {
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM'
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, signal)
    } else {
      child.kill(signal)
    }
  } catch {
    try { child.kill(signal) } catch { /* It already exited. */ }
  }
}

function appendOutput(
  chunks: Buffer[],
  chunk: Buffer | string,
  currentLength: number,
  maxBytes: number,
): number {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  const nextLength = currentLength + buffer.byteLength
  if (nextLength > maxBytes) {
    throw new ProfileMaterializationError(`profile materializer output exceeded ${String(maxBytes)} bytes`)
  }
  chunks.push(buffer)
  return nextLength
}

/**
 * Restore dependencies for an already-restored profile without creating a
 * Host or using a shell. This intentionally performs only the fixed command
 * `pnpm install --frozen-lockfile`.
 */
export async function materializeProfile(
  options: ProfileMaterializerOptions,
): Promise<ProfileMaterializationResult> {
  for (const [label, value] of [
    ['application executable', options.appExecutable],
    ['environment preloader', options.clearEnvironmentPath],
    ['pnpm entry', options.pnpmBinPath],
    ['Node command directory', options.nodeBinDir],
    ['Node command', options.nodeShimPath],
    ['Harness home', options.homeDir],
    ['profile directory', options.profileDir],
  ] as const) assertAbsolutePath(label, value)
  if (options.electronVersion.length === 0 || options.electronVersion.includes('\0')) {
    throw new ProfileMaterializationError('profile materializer Electron version must not be empty or contain NUL')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  assertPositiveFinite('timeout', timeoutMs)
  assertPositiveFinite('maximum output', maxOutputBytes)
  options.signal?.throwIfAborted()

  const argv = [
    options.appExecutable,
    '--import',
    pathToFileURL(options.clearEnvironmentPath).href,
    options.pnpmBinPath,
    'install',
    '--frozen-lockfile',
  ] as const
  const path = inheritedPath()
  const runtime = options.runtime ?? 'electron'
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: path.length === 0 ? options.nodeBinDir : `${options.nodeBinDir}${delimiter}${path}`,
    NODE: options.nodeShimPath,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: options.homeDir,
    CI: 'true',
    npm_config_runtime: runtime,
    npm_config_target: options.electronVersion,
    ...(runtime === 'electron' ? { npm_config_disturl: ELECTRON_HEADERS_URL } : {}),
  }
  const spawn = options.spawn ?? childSpawn
  const child = spawn(options.appExecutable, argv.slice(1), {
    cwd: options.profileDir,
    env: environment,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (child.stdout === null || child.stderr === null) {
    killProcessTree(child)
    throw new ProfileMaterializationError('profile materializer subprocess did not expose piped output')
  }
  const stdout = child.stdout
  const stderr = child.stderr

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let stdoutLength = 0
  let stderrLength = 0
  let failure: Error | undefined
  let terminationTimer: NodeJS.Timeout | undefined
  let timeoutTimer: NodeJS.Timeout | undefined
  let settled = false

  return await new Promise<ProfileMaterializationResult>((resolve, reject) => {
    const terminate = (cause: Error): void => {
      if (failure !== undefined) return
      failure = cause
      killProcessTree(child)
      terminationTimer = setTimeout(() => { killProcessTree(child, true) }, TERMINATION_GRACE_MS)
      terminationTimer.unref()
    }
    const acceptStdout = (chunk: Buffer | string): void => {
      try { stdoutLength = appendOutput(stdoutChunks, chunk, stdoutLength, maxOutputBytes) }
      catch (cause) { terminate(cause instanceof Error ? cause : new Error(String(cause))) }
    }
    const acceptStderr = (chunk: Buffer | string): void => {
      try { stderrLength = appendOutput(stderrChunks, chunk, stderrLength, maxOutputBytes) }
      catch (cause) { terminate(cause instanceof Error ? cause : new Error(String(cause))) }
    }
    const onAbort = (): void => { terminate(new ProfileMaterializationError('profile materializer was aborted')) }
    stdout.on('data', acceptStdout)
    stderr.on('data', acceptStderr)
    child.once('error', (cause) => { terminate(cause instanceof Error ? cause : new Error(String(cause))) })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timeoutTimer = setTimeout(() => {
      terminate(new ProfileMaterializationError(`profile materializer timed out after ${String(timeoutMs)}ms`))
    }, timeoutMs)
    timeoutTimer.unref()
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (terminationTimer !== undefined) clearTimeout(terminationTimer)
      options.signal?.removeEventListener('abort', onAbort)
      const result: ProfileMaterializationResult = {
        argv,
        cwd: options.profileDir,
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      }
      if (failure !== undefined) {
        reject(new ProfileMaterializationError(failure.message, result))
      } else if (exitCode !== 0 || signal !== null) {
        reject(new ProfileMaterializationError(
          `profile materializer exited unsuccessfully (code=${String(exitCode)}, signal=${String(signal)})`,
          result,
        ))
      } else {
        resolve(result)
      }
    })
  })
}

/** Compatibility alias for callers that describe this as re-materialization. */
export const rematerializeProfile = materializeProfile
