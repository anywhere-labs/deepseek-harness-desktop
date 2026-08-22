/** Windows owner for provisioning and supervising one complete DSH Host in WSL. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join as joinPosix } from 'node:path/posix'
import { DesktopControlPeer } from './control-protocol.ts'
import { NativeDesktopControlBridge } from './native-control-bridge.ts'
import type { DesktopRuntime } from './runtime.ts'
import type { DesktopStartupGenerationHost } from './startup-generation.ts'
import {
  captureDesktopCommand,
  decodeWslOutput,
  probeWslHostPrerequisites,
  type DesktopCommandCapture,
  type WslHostPrerequisites,
  windowsPathToWsl,
  wslExecArguments,
} from './wsl.ts'
import {
  verifyWslRuntimeBundle,
  WSL_RUNTIME_BUNDLE_MANIFEST,
  type WslRuntimeBundle,
} from './wsl-runtime-bundle.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const INSTALL_OUTPUT_LIMIT = 16 * 1024 * 1024
const VERIFY_RUNTIME_SCRIPT = [
  "const crypto = require('node:crypto')",
  "const fs = require('node:fs')",
  'try {',
  '  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))',
  '  if (manifest.version !== process.argv[3]) process.exit(2)',
  '  fs.accessSync(process.argv[2], fs.constants.R_OK)',
  '  const bundle = fs.readFileSync(process.argv[4])',
  '  if (crypto.createHash("sha256").update(bundle).digest("hex") !== process.argv[5]) process.exit(2)',
  '} catch { process.exit(2) }',
].join('; ')
const COPY_BUNDLE_SCRIPT = [
  "const crypto = require('node:crypto')",
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  'const source = process.argv[1]',
  'const target = process.argv[2]',
  'const expected = process.argv[3]',
  'fs.rmSync(target, { recursive: true, force: true })',
  'fs.mkdirSync(path.dirname(target), { recursive: true })',
  'fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false })',
  `const manifestPath = path.join(target, ${JSON.stringify(WSL_RUNTIME_BUNDLE_MANIFEST)})`,
  'const manifestBytes = fs.readFileSync(manifestPath)',
  'const digest = value => crypto.createHash("sha256").update(value).digest("hex")',
  'if (digest(manifestBytes) !== expected) throw new Error("manifest hash changed")',
  'const manifest = JSON.parse(manifestBytes)',
  'for (const file of manifest.files) {',
  '  const absolute = path.resolve(target, file.path)',
  '  const relative = path.relative(target, absolute)',
  '  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("bundle path escaped")',
  '  const bytes = fs.readFileSync(absolute)',
  '  if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error("bundle file changed")',
  '}',
].join('; ')
const COMMIT_RUNTIME_SCRIPT = [
  "const fs = require('node:fs')",
  'const target = process.argv[1]',
  'const staging = process.argv[2]',
  'const backup = process.argv[3]',
  'fs.rmSync(backup, { recursive: true, force: true })',
  'const hadTarget = fs.existsSync(target)',
  'if (hadTarget) fs.renameSync(target, backup)',
  'try {',
  '  fs.renameSync(staging, target)',
  '} catch (cause) {',
  '  if (hadTarget && !fs.existsSync(target)) fs.renameSync(backup, target)',
  '  throw cause',
  '}',
].join('; ')
const REMOVE_RUNTIME_SCRIPT = "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })"
const RECOVER_RUNTIME_SCRIPT = [
  "const fs = require('node:fs')",
  'const target = process.argv[1]',
  'const staging = process.argv[2]',
  'const backup = process.argv[3]',
  'if (fs.existsSync(backup)) {',
  '  fs.rmSync(target, { recursive: true, force: true })',
  '  fs.renameSync(backup, target)',
  '} else if (!fs.existsSync(staging)) {',
  '  fs.rmSync(target, { recursive: true, force: true })',
  '}',
  'fs.rmSync(staging, { recursive: true, force: true })',
].join('; ')

export interface WslManagedRuntime {
  readonly prerequisites: WslHostPrerequisites
  readonly runtimeRoot: string
  readonly packageRoot: string
  readonly hostEntryPath: string
  readonly stateDir: string
  readonly homeDir: string
  readonly installed: boolean
}

export interface WslHostReady {
  readonly generationId: string
  readonly profileName: string
  readonly profileDir: string
  readonly homeDir: string
  readonly port: number
  readonly selectedProfile: string
}

export interface WslHostSupervisorLogger {
  error(message: string): void
}

export interface WslHostSupervisorOptions {
  readonly distribution: string
  readonly productVersion: string
  readonly runtime: DesktopRuntime
  readonly runtimeBundlePath: string
  readonly capture?: DesktopCommandCapture
  readonly verifyBundle?: typeof verifyWslRuntimeBundle
  readonly spawn?: typeof spawn
  readonly startupTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly logger: WslHostSupervisorLogger
  pickDirectory(runtime: WslManagedRuntime): Promise<string | null>
  validateDirectory(runtime: WslManagedRuntime, path: string): Promise<boolean>
  openTerminal(runtime: WslManagedRuntime, ready: WslHostReady): void
  exportRecoveryDiagnostics(): Promise<void>
  showProfileRestoreNotice(profileName: string): Promise<void>
  showRecoveryFailure(message: string): Promise<'local' | 'quit'>
  requestQuit(code: number): void
}

function version(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error(`${BIN_NAME}: invalid desktop product version`)
  }
  return value
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${BIN_NAME}: ${label} must be positive`)
  return value
}

async function runtimeIsReady(
  capture: DesktopCommandCapture,
  distribution: string,
  runtime: Pick<WslManagedRuntime, 'packageRoot' | 'hostEntryPath'>,
  productVersion: string,
  bundle: WslRuntimeBundle,
): Promise<boolean> {
  const result = await capture('wsl.exe', wslExecArguments(distribution, [
    'node', '-e', VERIFY_RUNTIME_SCRIPT,
    joinPosix(runtime.packageRoot, 'package.json'),
    runtime.hostEntryPath,
    productVersion,
    joinPosix(runtime.packageRoot, '..', '..', WSL_RUNTIME_BUNDLE_MANIFEST),
    bundle.manifestSha256,
  ]))
  return result.exitCode === 0 && result.signal === null
}

async function removeRuntimePath(
  capture: DesktopCommandCapture,
  distribution: string,
  path: string,
): Promise<void> {
  await capture('wsl.exe', wslExecArguments(distribution, [
    'node', '-e', REMOVE_RUNTIME_SCRIPT, path,
  ]), { timeoutMs: 120_000, maxOutputBytes: INSTALL_OUTPUT_LIMIT }).catch(() => {})
}

async function recoverRuntimeCommit(
  capture: DesktopCommandCapture,
  distribution: string,
  target: string,
  staging: string,
  backup: string,
): Promise<void> {
  await capture('wsl.exe', wslExecArguments(distribution, [
    'node', '-e', RECOVER_RUNTIME_SCRIPT, target, staging, backup,
  ]), { timeoutMs: 120_000, maxOutputBytes: INSTALL_OUTPUT_LIMIT }).catch(() => {})
}

/** Validate prerequisites and install the exact desktop package into WSL when absent. */
export async function prepareWslHostRuntime(options: {
  readonly distribution: string
  readonly productVersion: string
  readonly runtimeBundlePath: string
  readonly capture?: DesktopCommandCapture
  readonly verifyBundle?: typeof verifyWslRuntimeBundle
}): Promise<WslManagedRuntime> {
  const productVersion = version(options.productVersion)
  const capture = options.capture ?? captureDesktopCommand
  const bundle = (options.verifyBundle ?? verifyWslRuntimeBundle)(options.runtimeBundlePath, productVersion)
  const prerequisites = await probeWslHostPrerequisites(options.distribution, capture)
  const runtimeRoot = joinPosix(
    prerequisites.homeDir,
    '.local', 'share', 'dsh-desktop', 'runtime', productVersion,
  )
  const packageRoot = joinPosix(runtimeRoot, 'node_modules', 'dsh-plugin-desktop')
  const hostEntryPath = joinPosix(packageRoot, 'lib', 'wsl-host.js')
  const stateDir = joinPosix(prerequisites.homeDir, '.local', 'state', 'dsh-desktop')
  const homeDir = joinPosix(prerequisites.homeDir, '.local', 'share', 'dsh-desktop', 'home')
  const candidate = { prerequisites, runtimeRoot, packageRoot, hostEntryPath, stateDir, homeDir }
  if (await runtimeIsReady(capture, options.distribution, candidate, productVersion, bundle)) {
    return Object.freeze({ ...candidate, installed: false })
  }
  const wslBundlePath = await windowsPathToWsl(options.distribution, bundle.root, capture)
  const suffix = randomUUID()
  const stagingRoot = `${runtimeRoot}.installing-${suffix}`
  const backupRoot = `${runtimeRoot}.previous-${suffix}`
  try {
    const copied = await capture('wsl.exe', wslExecArguments(options.distribution, [
      'node', '-e', COPY_BUNDLE_SCRIPT, wslBundlePath, stagingRoot, bundle.manifestSha256,
    ]), {
      timeoutMs: 120_000,
      maxOutputBytes: INSTALL_OUTPUT_LIMIT,
    })
    if (copied.exitCode !== 0 || copied.signal !== null) {
      throw new Error(`${BIN_NAME}: failed to copy the WSL Host runtime bundle`)
    }
    const install = await capture('wsl.exe', wslExecArguments(options.distribution, [
      'npm', 'ci',
      '--prefix', stagingRoot,
      '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund',
    ]), {
      timeoutMs: INSTALL_TIMEOUT_MS,
      maxOutputBytes: INSTALL_OUTPUT_LIMIT,
    })
    if (install.exitCode !== 0 || install.signal !== null) {
      const detail = decodeWslOutput(install.stderr).trim().split(/\r?\n/u).at(-1)
      throw new Error(`${BIN_NAME}: failed to install the WSL Host runtime${detail === undefined || detail.length === 0 ? '' : `: ${detail}`}`)
    }
    const staged = {
      packageRoot: joinPosix(stagingRoot, 'node_modules', 'dsh-plugin-desktop'),
      hostEntryPath: joinPosix(stagingRoot, 'node_modules', 'dsh-plugin-desktop', 'lib', 'wsl-host.js'),
    }
    if (!await runtimeIsReady(capture, options.distribution, staged, productVersion, bundle)) {
      throw new Error(`${BIN_NAME}: installed WSL Host runtime failed version verification`)
    }
    let commitVerified = false
    try {
      const committed = await capture('wsl.exe', wslExecArguments(options.distribution, [
        'node', '-e', COMMIT_RUNTIME_SCRIPT, runtimeRoot, stagingRoot, backupRoot,
      ]), {
        timeoutMs: 120_000,
        maxOutputBytes: INSTALL_OUTPUT_LIMIT,
      })
      commitVerified = committed.exitCode === 0 && committed.signal === null
        && await runtimeIsReady(capture, options.distribution, candidate, productVersion, bundle)
    } catch (cause) {
      await recoverRuntimeCommit(
        capture, options.distribution, runtimeRoot, stagingRoot, backupRoot,
      )
      throw cause
    }
    if (!commitVerified) {
      await recoverRuntimeCommit(
        capture, options.distribution, runtimeRoot, stagingRoot, backupRoot,
      )
      throw new Error(`${BIN_NAME}: failed to commit the WSL Host runtime`)
    }
    await removeRuntimePath(capture, options.distribution, backupRoot)
    return Object.freeze({ ...candidate, installed: true })
  } catch (cause) {
    await removeRuntimePath(capture, options.distribution, stagingRoot)
    throw cause
  }
}

function readyMessage(value: unknown, runtime: WslManagedRuntime): WslHostReady {
  if (value === null || typeof value !== 'object') throw new Error(`${BIN_NAME}: invalid WSL Host ready message`)
  const record = value as Record<string, unknown>
  for (const name of ['generationId', 'profileName', 'profileDir', 'homeDir', 'selectedProfile'] as const) {
    const field = record[name]
    if (typeof field !== 'string' || field.length === 0 || field.length > 4096 || field.includes('\0')) {
      throw new Error(`${BIN_NAME}: invalid WSL Host ready message`)
    }
  }
  if (!Number.isSafeInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65_535) {
    throw new Error(`${BIN_NAME}: invalid WSL Host port`)
  }
  const homeDir = record.homeDir as string
  const profileDir = record.profileDir as string
  if (homeDir !== runtime.homeDir || !profileDir.startsWith(`${runtime.homeDir}/profiles/`)) {
    throw new Error(`${BIN_NAME}: WSL Host reported paths outside its managed home`)
  }
  return Object.freeze({
    generationId: record.generationId as string,
    profileName: record.profileName as string,
    profileDir,
    homeDir,
    port: record.port as number,
    selectedProfile: record.selectedProfile as string,
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error(message)) }, timeoutMs)
    promise.then(
      value => { clearTimeout(timeout); resolve(value) },
      cause => { clearTimeout(timeout); reject(cause) },
    )
  })
}

/** Bounded child result exposed for startup races and post-health supervision. */
export interface WslHostExit {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: string
}

/** Active remote Host shaped like the in-process Cordis root for generation ownership. */
export class WslHostHandle implements DesktopStartupGenerationHost {
  readonly fiber = { dispose: async (): Promise<void> => { await this.dispose() } }
  readonly terminated: Promise<WslHostExit>
  private disposeTask: Promise<void> | undefined
  private healthCommitted = false
  private disposing = false

  constructor(
    readonly managedRuntime: WslManagedRuntime,
    readonly ready: WslHostReady,
    private readonly peer: DesktopControlPeer,
    private readonly bridge: NativeDesktopControlBridge,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly exited: Promise<WslHostExit>,
    private readonly shutdownTimeoutMs: number,
    private readonly requestQuit: (code: number) => void,
    private readonly releaseControlHandlers: () => void,
  ) {
    this.terminated = this.exited
    void this.exited.then((result) => {
      if (this.disposing || !this.healthCommitted) return
      const code = result.exitCode === null || result.exitCode === 0 ? 1 : result.exitCode
      this.requestQuit(code)
    })
  }

  /** Commit profile and install recovery only after the Windows Renderer is healthy. */
  async commitHealthy(): Promise<void> {
    await this.peer.call('host/health.commit', { generationId: this.ready.generationId })
    this.healthCommitted = true
  }

  dispose(): Promise<void> {
    this.disposeTask ??= this.release()
    return this.disposeTask
  }

  private async release(): Promise<void> {
    this.disposing = true
    try {
      await withTimeout(
        this.peer.call('host/shutdown', { code: 0 }),
        this.shutdownTimeoutMs,
        `${BIN_NAME}: WSL Host shutdown timed out`,
      )
    } catch {
      if (!this.child.killed) this.child.kill()
    } finally {
      this.child.stdin.end()
      await withTimeout(this.exited, this.shutdownTimeoutMs, `${BIN_NAME}: wsl.exe did not exit`).catch(() => {
        if (!this.child.killed) this.child.kill()
      })
      this.releaseControlHandlers()
      try {
        await this.bridge.dispose()
      } finally {
        this.peer.close()
      }
    }
  }
}

/** Provision, spawn, handshake, and return one supervised WSL Host generation. */
export async function startWslHost(options: WslHostSupervisorOptions): Promise<WslHostHandle> {
  const startupTimeoutMs = positiveTimeout(
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    'WSL Host startup timeout',
  )
  const shutdownTimeoutMs = positiveTimeout(
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    'WSL Host shutdown timeout',
  )
  const managedRuntime = await prepareWslHostRuntime({
    distribution: options.distribution,
    productVersion: options.productVersion,
    runtimeBundlePath: options.runtimeBundlePath,
    ...(options.capture === undefined ? {} : { capture: options.capture }),
    ...(options.verifyBundle === undefined ? {} : { verifyBundle: options.verifyBundle }),
  })
  const spawnProcess = options.spawn ?? spawn
  const args = wslExecArguments(options.distribution, [
    'node', managedRuntime.hostEntryPath,
    '--state-dir', managedRuntime.stateDir,
    '--home-dir', managedRuntime.homeDir,
  ])
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnProcess('wsl.exe', args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
  } catch (cause) {
    throw new Error(`${BIN_NAME}: failed to start wsl.exe`, { cause })
  }
  const peer = new DesktopControlPeer(child.stdout, child.stdin, { logger: options.logger })
  let currentReady: WslHostReady | undefined
  const bridge = new NativeDesktopControlBridge(peer, {
    runtime: options.runtime,
    pickDirectory: async () => await options.pickDirectory(managedRuntime),
    validateDirectory: async path => await options.validateDirectory(managedRuntime, path),
    openTerminal: () => {
      if (currentReady === undefined) throw new Error(`${BIN_NAME}: WSL Host terminal is not ready`)
      options.openTerminal(managedRuntime, currentReady)
    },
    exportRecoveryDiagnostics: options.exportRecoveryDiagnostics,
    showProfileRestoreNotice: options.showProfileRestoreNotice,
    showRecoveryFailure: options.showRecoveryFailure,
    reportError: (operation, cause) => {
      options.logger.error(
        `${BIN_NAME}: ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    },
  })
  child.stderr.on('data', (chunk: Buffer | string) => {
    const message = (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk).trimEnd()
    if (message.length > 0) options.logger.error(`[WSL ${options.distribution}] ${message}`)
  })
  const exited = new Promise<WslHostExit>(resolve => {
    let settled = false
    const finish = (result: WslHostExit): void => {
      if (settled) return
      settled = true
      resolve(Object.freeze(result))
    }
    child.once('exit', (exitCode, signal) => { finish({ exitCode, signal }) })
    child.once('error', cause => { finish({ exitCode: null, signal: null, error: cause.message }) })
  })
  let resolveReady!: (value: WslHostReady) => void
  let rejectReady!: (cause: unknown) => void
  const ready = new Promise<WslHostReady>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const removeReady = peer.register('host/ready', params => {
    currentReady = readyMessage(params, managedRuntime)
    resolveReady(currentReady)
    return null
  })
  const removeFatal = peer.register('host/fatal', params => {
    const message = params !== null && typeof params === 'object'
      ? (params as { message?: unknown }).message
      : undefined
    const failure = `${BIN_NAME}: WSL Host failed${typeof message === 'string' ? `: ${message.slice(0, 4096)}` : ''}`
    if (currentReady === undefined) rejectReady(new Error(failure))
    else options.logger.error(failure)
    return null
  })
  const removeExit = peer.register('host/exit', params => {
    const code = params !== null && typeof params === 'object' ? (params as { code?: unknown }).code : undefined
    if (!Number.isSafeInteger(code)) throw new Error(`${BIN_NAME}: invalid WSL Host exit request`)
    options.requestQuit(code as number)
    return null
  })
  child.once('error', cause => { rejectReady(new Error(`${BIN_NAME}: wsl.exe failed`, { cause })) })
  void exited.then(() => {
    if (currentReady === undefined) rejectReady(new Error(`${BIN_NAME}: WSL Host exited before readiness`))
  })
  try {
    const accepted = await withTimeout(
      ready,
      startupTimeoutMs,
      `${BIN_NAME}: WSL Host did not become ready in time`,
    )
    removeReady()
    return new WslHostHandle(
      managedRuntime,
      accepted,
      peer,
      bridge,
      child,
      exited,
      shutdownTimeoutMs,
      options.requestQuit,
      () => {
        removeFatal()
        removeExit()
      },
    )
  } catch (cause) {
    removeReady()
    removeFatal()
    removeExit()
    child.stdin.end()
    if (!child.killed) child.kill()
    await withTimeout(exited, shutdownTimeoutMs, `${BIN_NAME}: failed WSL Host did not exit`).catch(() => {})
    try {
      await bridge.dispose()
    } finally {
      peer.close()
    }
    throw cause
  }
}
