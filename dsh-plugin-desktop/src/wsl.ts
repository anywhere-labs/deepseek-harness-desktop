/** Windows-side WSL discovery, prerequisite probing, and bounded process capture. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute as isPosixAbsolute } from 'node:path/posix'
import { isAbsolute as isWindowsAbsolute } from 'node:path/win32'
import type { DesktopHostTargetView } from './host-target.ts'
import { assertWslDistributionName } from './host-target.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const DEFAULT_CAPTURE_LIMIT = 1024 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000

/** Captured child-process result with byte-bounded output. */
export interface DesktopCommandResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: Buffer
  readonly stderr: Buffer
}

/** Injectable process boundary used by discovery and focused tests. */
export type DesktopCommandCapture = (
  executable: string,
  args: readonly string[],
  options?: DesktopCommandCaptureOptions,
) => Promise<DesktopCommandResult>

export interface DesktopCommandCaptureOptions {
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly signal?: AbortSignal
  readonly environment?: NodeJS.ProcessEnv
}

/** One installed distribution reported by `wsl.exe --list --verbose`. */
export interface WslDistribution {
  readonly name: string
  readonly state: string
  readonly version: 1 | 2
  readonly default: boolean
}

/** Linux runtime facts required before a managed Host can be provisioned. */
export interface WslHostPrerequisites {
  readonly distribution: string
  readonly homeDir: string
  readonly nodeVersion: string
  readonly npmVersion: string
  readonly bashVersion: string
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number }, limit: number): void {
  state.bytes += chunk.length
  if (state.bytes > limit) throw new Error(`${BIN_NAME}: child process output exceeded byte limit`)
  chunks.push(chunk)
}

/** Run one shell-free command with bounded stdout, stderr, time, and cancellation. */
export const captureDesktopCommand: DesktopCommandCapture = async (
  executable,
  args,
  options = {},
) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_CAPTURE_LIMIT
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${BIN_NAME}: command timeout must be a positive integer`)
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024) {
    throw new Error(`${BIN_NAME}: command output limit must be at least 1024 bytes`)
  }
  options.signal?.throwIfAborted()
  return await new Promise<DesktopCommandResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(options.environment === undefined ? {} : { env: options.environment }),
      })
    } catch (cause) {
      reject(cause)
      return
    }
    child.stdin.end()
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const output = { bytes: 0 }
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      action()
    }
    const fail = (cause: unknown): void => {
      if (!child.killed) child.kill()
      finish(() => { reject(cause) })
    }
    const accept = (target: Buffer[]) => (chunk: Buffer): void => {
      try {
        appendBounded(target, chunk, output, maxOutputBytes)
      } catch (cause) {
        fail(cause)
      }
    }
    child.stdout.on('data', accept(stdout))
    child.stderr.on('data', accept(stderr))
    child.once('error', fail)
    child.once('exit', (exitCode, signal) => {
      finish(() => {
        resolve({ exitCode, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
      })
    })
    const abort = (): void => { fail(options.signal?.reason ?? new Error(`${BIN_NAME}: command aborted`)) }
    options.signal?.addEventListener('abort', abort, { once: true })
    timeout = setTimeout(() => {
      fail(new Error(`${BIN_NAME}: command timed out: ${executable}`))
    }, timeoutMs)
  })
}

/** Decode WSL output, which is UTF-16LE on some Windows builds when redirected. */
export function decodeWslOutput(value: Buffer): string {
  if (value.length === 0) return ''
  const sampleLength = Math.min(value.length, 256)
  let zeroes = 0
  for (let index = 1; index < sampleLength; index += 2) {
    if (value[index] === 0) zeroes += 1
  }
  const pairs = Math.floor(sampleLength / 2)
  const encoding = pairs > 0 && zeroes / pairs > 0.3 ? 'utf16le' : 'utf8'
  return value.toString(encoding).replace(/^\uFEFF/u, '').replaceAll('\0', '')
}

/** Parse the stable right edge of `wsl.exe --list --verbose` output. */
export function parseWslDistributionList(output: string): WslDistribution[] {
  const distributions: WslDistribution[] = []
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trimEnd()
    const match = /^\s*(\*)?\s*(.+?)\s{2,}([^\s].*?)\s{2,}([12])\s*$/u.exec(line)
    if (match === null) continue
    const name = match[2]?.trim() ?? ''
    if (name.toLowerCase() === 'name') continue
    try {
      distributions.push({
        name: assertWslDistributionName(name),
        state: match[3]?.trim() ?? 'Unknown',
        version: match[4] === '1' ? 1 : 2,
        default: match[1] === '*',
      })
    } catch {
      // Ignore malformed OS output instead of making it selectable.
    }
  }
  return distributions.sort((left, right) => left.name.localeCompare(right.name, 'en'))
}

/** Discover installed WSL2 distributions without surfacing localized command output. */
export async function discoverWslHostTargets(
  platform: NodeJS.Platform = process.platform,
  capture: DesktopCommandCapture = captureDesktopCommand,
): Promise<DesktopHostTargetView> {
  if (platform !== 'win32') {
    return Object.freeze({ current: { mode: 'local' } as const, distributions: [], wslSupported: false })
  }
  try {
    const result = await capture('wsl.exe', ['--list', '--verbose'])
    if (result.exitCode !== 0 || result.signal !== null) {
      return Object.freeze({
        current: { mode: 'local' } as const,
        distributions: [],
        wslSupported: true,
        problem: 'WSL is installed but its distribution list is unavailable.',
      })
    }
    const installed = parseWslDistributionList(decodeWslOutput(result.stdout))
    const distributions = Object.freeze(installed.filter(entry => entry.version === 2).map(entry => entry.name))
    return Object.freeze({
      current: { mode: 'local' } as const,
      distributions,
      wslSupported: true,
      ...(distributions.length === 0
        ? { problem: 'Install or upgrade a distribution to WSL 2 before selecting the WSL Host.' }
        : {}),
    })
  } catch {
    return Object.freeze({
      current: { mode: 'local' } as const,
      distributions: [],
      wslSupported: false,
      problem: 'WSL is not available on this Windows installation.',
    })
  }
}

function successfulText(result: DesktopCommandResult, operation: string): string {
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new Error(`${BIN_NAME}: WSL ${operation} failed`)
  }
  return decodeWslOutput(result.stdout).trim()
}

function supportedNodeVersion(value: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major >= 24 || (major === 22 && minor >= 19)
}

function fullyQualifiedWindowsPath(value: string): boolean {
  return isWindowsAbsolute(value)
    && (/^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value))
}

/** Prove that one WSL2 distribution has the Linux Node/npm runtime DSH requires. */
export async function probeWslHostPrerequisites(
  distribution: string,
  capture: DesktopCommandCapture = captureDesktopCommand,
): Promise<WslHostPrerequisites> {
  const name = assertWslDistributionName(distribution)
  const prefix = ['--distribution', name, '--exec'] as const
  const [homeResult, nodeResult, npmResult, bashResult, kernelResult] = await Promise.all([
    capture('wsl.exe', [...prefix, 'sh', '-lc', 'printf %s "$HOME"']),
    capture('wsl.exe', [...prefix, 'node', '--version']),
    capture('wsl.exe', [...prefix, 'npm', '--version']),
    capture('wsl.exe', [...prefix, 'bash', '--version']),
    capture('wsl.exe', [...prefix, 'uname', '-s']),
  ])
  const kernel = successfulText(kernelResult, 'kernel probe')
  if (kernel !== 'Linux') throw new Error(`${BIN_NAME}: selected distribution did not report a Linux kernel`)
  const homeDir = successfulText(homeResult, 'home-directory probe')
  if (!isPosixAbsolute(homeDir) || homeDir.includes('\0') || /[\r\n]/u.test(homeDir)) {
    throw new Error(`${BIN_NAME}: selected distribution returned an invalid home directory`)
  }
  const nodeVersion = successfulText(nodeResult, 'Node.js probe')
  if (!supportedNodeVersion(nodeVersion)) {
    throw new Error(`${BIN_NAME}: WSL Host requires Node.js ^22.19.0 or >=24.0.0`)
  }
  const npmVersion = successfulText(npmResult, 'npm probe')
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(npmVersion)) {
    throw new Error(`${BIN_NAME}: selected distribution returned an invalid npm version`)
  }
  const bashVersion = successfulText(bashResult, 'Bash probe').split(/\r?\n/u, 1)[0] ?? ''
  if (!/^GNU bash, version /u.test(bashVersion)) {
    throw new Error(`${BIN_NAME}: WSL Host requires GNU Bash`)
  }
  return Object.freeze({ distribution: name, homeDir, nodeVersion, npmVersion, bashVersion })
}

/** Resolve one absolute Windows package-resource path under the selected distribution's mount policy. */
export async function windowsPathToWsl(
  distribution: string,
  windowsPath: string,
  capture: DesktopCommandCapture = captureDesktopCommand,
): Promise<string> {
  const name = assertWslDistributionName(distribution)
  if (!fullyQualifiedWindowsPath(windowsPath)
    || windowsPath.length > 32_767
    || windowsPath.includes('\0')
    || /[\r\n]/u.test(windowsPath)) {
    throw new Error(`${BIN_NAME}: WSL runtime bundle path must be an absolute Windows path`)
  }
  const result = await capture('wsl.exe', wslExecArguments(name, [
    'wslpath', '-a', '-u', '--', windowsPath,
  ]))
  const path = successfulText(result, 'path translation')
  if (!isPosixAbsolute(path) || path.includes('\0') || /[\r\n]/u.test(path)) {
    throw new Error(`${BIN_NAME}: selected distribution returned an invalid translated path`)
  }
  return path
}

/** Build the shell-free prefix for one exact WSL distribution command. */
export function wslExecArguments(distribution: string, argv: readonly string[]): string[] {
  assertWslDistributionName(distribution)
  if (argv.length === 0 || argv.some(value => value.length === 0 || value.includes('\0'))) {
    throw new Error(`${BIN_NAME}: invalid WSL command arguments`)
  }
  return ['--distribution', distribution, '--exec', ...argv]
}
