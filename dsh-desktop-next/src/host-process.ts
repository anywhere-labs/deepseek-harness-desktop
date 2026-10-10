/** Electron Node-mode child lifecycle for the shared Web application. */

import type { LogInput } from './log-record.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { desktopNodeEnvironment } from './node-environment.ts'
import type { DesktopNotification } from './desktop-contract.ts'
import { isDesktopNotification } from './notifications.ts'
import type { DesktopPermission, DesktopPermissionAction, DesktopPermissionSnapshot } from './permissions.ts'

interface ReadyEvent {
  readonly type: 'ready'
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

interface FatalEvent {
  readonly type: 'fatal'
  readonly message: string
  /** The Host's complete inspected error: stack, enumerable properties, cause chain. */
  readonly diagnostic?: string
}

/**
 * Host-only credentials for an embedded Platform document, mirroring
 * `PlatformSession` in dsh 0.1.7's `@deepseek-ai/dsh-deepseek-account`
 * (`packages/credentials/deepseek-account/src/index.ts:13-20`). Declared here
 * rather than imported: Next does not depend on that package, and this shape is
 * only ever reached by structural validation of a child IPC payload.
 */
export interface PlatformSession {
  readonly origin: string
  readonly token: string
  /** Optional dist query value selecting the embedded frontend deployment. */
  readonly embeddedPageDist?: string
  /** Private deployment headers for native requests; excluded from renderer bootstrap. */
  readonly requestHeaders?: Readonly<Record<string, string>>
}

interface PlatformSessionEvent {
  readonly type: 'platform-session'
  readonly session: PlatformSession | null
}

/** Platform sign-in hand-off from the Host's account watcher (src/host/platform-login.ts). */
export type DesktopPlatformLoginRequest = { readonly action: 'open'; readonly url: string } | { readonly action: 'close'; readonly focus: boolean }

type PlatformLoginEvent = { readonly type: 'platform-login' } & DesktopPlatformLoginRequest

/** Same destination rule as upstream Desktop's account backend: HTTPS, or loopback HTTP for development. */
function isPlatformLoginDestination(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return !url.username && !url.password
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  } catch { return false }
}

interface InjectionsEvent {
  readonly type: 'injections'
  readonly requestId: number
  readonly injections?: readonly unknown[] | undefined
  readonly error?: string
}

type DesktopHostEvent = ReadyEvent | FatalEvent | PlatformSessionEvent | PlatformLoginEvent | InjectionsEvent | { type: 'permission'; requestId: number; action: DesktopPermissionAction; permission: DesktopPermission } | { type: 'logging-config'; requestId: number; error?: string } | { type: 'browser-access'; requestId: number; error?: string } | { type: 'notification'; notification: DesktopNotification } | { readonly type: 'shutdown-complete' } | { readonly type: 'desktop-action'; readonly action: 'restart' | 'terminal' } | {
  readonly type: 'update-tasks'
  readonly requestId: number
  readonly active: boolean
  readonly error?: string
}

const MAX_HOST_DIAGNOSTIC_CHARS = 64 * 1024

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'shutdown-complete':
      return true
    case 'ready':
      return typeof candidate.url === 'string'
    case 'platform-session': {
      const session = candidate.session
      if (session === null) return true
      if (typeof session !== 'object' || !('origin' in session) || !('token' in session)
        || typeof session.origin !== 'string' || typeof session.token !== 'string' || session.token.length === 0) return false
      if ('embeddedPageDist' in session && typeof session.embeddedPageDist !== 'string') return false
      if ('requestHeaders' in session && (typeof session.requestHeaders !== 'object' || session.requestHeaders === null
        || Array.isArray(session.requestHeaders)
        || Object.entries(session.requestHeaders).some(([name, value]) => typeof value !== 'string'
          || name !== name.toLowerCase() || /[\r\n]/.test(value)
          || ['authorization', 'x-dsh-auth-token', 'host', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(name)))) return false
      try {
        const url = new URL(session.origin)
        return url.origin === session.origin && !url.username && !url.password
          && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      } catch { return false }
    }
    case 'platform-login':
      return (candidate.action === 'close' && typeof candidate.focus === 'boolean') || (candidate.action === 'open' && isPlatformLoginDestination(candidate.url))
    case 'fatal':
      return typeof candidate.message === 'string' && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'notification':
      return isDesktopNotification(candidate.notification)
    case 'permission':
      return Number.isSafeInteger(candidate.requestId) && (candidate.requestId as number) > 0
        && typeof candidate.action === 'string' && ['query', 'request', 'open-settings'].includes(candidate.action)
        && typeof candidate.permission === 'string' && ['microphone', 'screen', 'accessibility'].includes(candidate.permission)
    case 'desktop-action':
      return candidate.action === 'restart' || candidate.action === 'terminal'
    case 'update-tasks':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.active === 'boolean'
        && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'logging-config':
    case 'browser-access':
      return Number.isSafeInteger(candidate.requestId) && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'injections':
      return Number.isSafeInteger(candidate.requestId) && (candidate.error === undefined || typeof candidate.error === 'string')
        && (candidate.injections === undefined || Array.isArray(candidate.injections))
    default:
      return false
  }
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Browser authentication URL reported by the running Web application. */
export interface DesktopHostReady {
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

/** The child has exited, but task teardown did not finish successfully. */
export class DesktopHostUncleanExitError extends Error {}

/**
 * A Host failure reported over IPC before the process exited. `message` is what
 * the Host chose to show; `diagnostic` is its complete inspected error, kept
 * separately so a crash report can print it verbatim instead of a string escaped
 * inside another error's properties.
 */
export class DesktopHostFatalError extends Error {
  readonly #diagnostic: string | undefined

  /**
   * @param message - The Host's failure message.
   * @param diagnostic - The Host's inspected error, when the Host supplied one.
   */
  constructor(message: string, diagnostic: string | undefined) {
    super(message)
    this.#diagnostic = diagnostic
  }

  /** The Host's inspected error; a getter so `util.inspect` of this error does not repeat it as an escaped property. */
  get diagnostic(): string | undefined { return this.#diagnostic }
}

/** One Web backend running under the Electron executable in Node mode. */
export class DesktopHostProcess {
  private child: ChildProcess | undefined
  private readyResolve!: (ready: DesktopHostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  private stderr = ''
  private failureReported = false
  private stopping = false
  private shutdownCompleted = false
  private nextControlId = 1
  private readonly taskQueries = new Map<number, { resolve: (active: boolean) => void; reject: (error: Error) => void }>()
  private readonly accessRequests = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  private readonly loggingRequests = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  private readonly injectionRequests = new Map<number, { resolve: (injections: readonly unknown[]) => void; reject: (error: Error) => void }>()

  /**
   * @param node - Absolute Electron executable in Node mode.
   * @param runtimeDir - Immutable packages carried by the current application.
   * @param projectDir - Desktop plugin profile and child working directory.
   * @param inspectPort - Optional loopback inspector port for workspace development.
   * @param environment - Environment inherited by the Host and its plugin subprocesses.
   * @param onFailure - Receives the first unexpected child failure, including after readiness.
   * @param primaryRuntime - Optional bundled dependency payload; when supplied, missing sibling
   *   `office-skills` resources fail Host startup.
   * @param packageManager - Bundled pnpm entry and Node launcher directory, scoped to package operations.
   * @param onPlatformSession - Private credential updates for embedded Platform views.
   * @param onPlatformLogin - Opens a sign-in attempt's authorization page, or settles an ended attempt.
   */
  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
    private readonly primaryRuntime?: string,
    private readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string },
    private readonly hostEntry?: string,
    private readonly onRestart?: () => void,
    private readonly onNotification?: (notification: DesktopNotification) => void,
    private readonly onLog?: (chunk: string, stream?: string, pid?: number) => void,
    private readonly onTerminal?: () => void,
    private readonly onPermission?: (action: DesktopPermissionAction, permission: DesktopPermission) => Promise<DesktopPermissionSnapshot>,
    private readonly onPlatformSession?: (session: PlatformSession | null) => void,
    private readonly onPlatformLogin?: (request: DesktopPlatformLoginRequest) => void,
    private readonly onDiagnostic?: (input: LogInput) => void,
  ) {}

  /**
   * Start this child once and await its Web application URL.
   * @returns Ready facts supplied by the child after application startup.
   */
  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise
    const entry = this.hostEntry ?? join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
    const child = spawn(this.node, [
      '--expose-internals',
      ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
      entry,
      this.runtimeDir,
      this.projectDir,
      this.primaryRuntime ?? join(this.runtimeDir, '..', 'runtime', 'primary-runtime'),
      ...this.packageManager === undefined ? [] : [this.packageManager.pnpm, this.packageManager.nodeBin],
    ], {
      cwd: this.projectDir,
      env: desktopNodeEnvironment(this.node, undefined, this.environment),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    this.diagnostic({ source: 'host.process', event: 'spawn', pid: child.pid })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-MAX_HOST_DIAGNOSTIC_CHARS); this.onLog?.(chunk, 'stderr', child.pid) })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { this.onLog?.(chunk, 'stdout', child.pid) })
    child.stdout?.pipe(process.stdout)
    child.on('message', (message: unknown) => {
      if (!isDesktopHostEvent(message)) {
        this.fail(new Error('dsh desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      this.diagnostic({ source: 'host.ipc', event: 'received', developer: true, pid: child.pid, fields: { type: message.type, ...('requestId' in message ? { requestId: message.requestId } : {}) } })
      if (message.type === 'ready') this.readyResolve({ url: message.url, injections: message.injections })
      else if (message.type === 'platform-session') this.onPlatformSession?.(message.session)
      else if (message.type === 'platform-login') {
        if (!this.stopping && !this.failureReported) {
          this.onPlatformLogin?.(message.action === 'open' ? { action: 'open', url: message.url } : { action: 'close', focus: message.focus })
        }
      }
      else if (message.type === 'shutdown-complete') {
        if (this.stopping) this.shutdownCompleted = true
        else this.fail(new Error('dsh desktop host acknowledged an unrequested shutdown'))
      }
      else if (message.type === 'fatal') this.fail(new DesktopHostFatalError(message.message, message.diagnostic))
      else if (message.type === 'notification') {
        if (!this.stopping && !this.failureReported) this.onNotification?.(message.notification)
      }
      else if (message.type === 'permission') {
        const reply = (result: object): void => {
          if (child.connected && !this.stopping && !this.failureReported) child.send({ type: 'permission-result', requestId: message.requestId, ...result }, () => {})
        }
        void Promise.resolve().then(() => {
          if (this.stopping || this.failureReported || !this.onPermission) throw new Error('Desktop permissions are unavailable')
          return this.onPermission(message.action, message.permission)
        }).then(snapshot => reply({ snapshot }), () => reply({ error: 'Desktop permissions are unavailable' }))
      }
      else if (message.type === 'desktop-action') {
        if (!this.stopping && !this.failureReported) {
          if (message.action === 'restart') this.onRestart?.()
          else this.onTerminal?.()
        }
      }
      else if (message.type === 'logging-config') {
        const request = this.loggingRequests.get(message.requestId)
        if (message.error === undefined) request?.resolve()
        else request?.reject(new Error(message.error))
      }
      else if (message.type === 'browser-access') {
        const request = this.accessRequests.get(message.requestId)
        if (message.error === undefined) request?.resolve()
        else request?.reject(new Error(message.error))
      }
      else if (message.type === 'injections') {
        const request = this.injectionRequests.get(message.requestId)
        if (message.error === undefined && message.injections !== undefined) request?.resolve(message.injections)
        else request?.reject(new Error(message.error ?? 'Next Host omitted Web boot injections'))
      }
      else {
        const query = this.taskQueries.get(message.requestId)
        if (message.error === undefined) query?.resolve(message.active)
        else query?.reject(new Error(message.error))
      }
    })
    child.once('error', (error) => { this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('close', (code, signal) => {
        this.diagnostic({ source: 'host.process', event: 'exit', pid: child.pid, level: this.stopping && code === 0 ? 'info' : 'error', fields: { exitCode: code, signal, expected: this.stopping, acknowledged: this.shutdownCompleted } })
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
        else this.fail(new Error(`dsh desktop host stopped${suffix}`))
        resolve()
      })
    })
    return this.readyPromise
  }

  private diagnostic(input: LogInput): void { try { this.onDiagnostic?.(input) } catch { /* Observational only. */ } }

  private controlOperation(type: string, requestId: number): (error?: unknown) => void {
    const started = Date.now()
    const pid = this.child?.pid
    const operationId = `host-${pid ?? 0}-control-${requestId}`
    this.diagnostic({ source: 'host.ipc', event: 'control.start', operationId, pid, developer: true, fields: { type, requestId } })
    let finished = false
    return error => {
      if (finished) return
      finished = true
      this.diagnostic({ source: 'host.ipc', event: error === undefined ? 'control.complete' : 'control.failed', operationId, pid,
        developer: error === undefined, level: error === undefined ? 'info' : 'error', error, fields: { type, requestId, durationMs: Date.now() - started } })
    }
  }

  async setLogging(value: { developerLogging: boolean; logLevel: string }): Promise<void> {
    const child = this.child
    if (!child?.connected || this.stopping || this.failureReported) throw new Error('Next Host is unavailable')
    const requestId = this.nextControlId++
    const end = this.controlOperation('logging-config', requestId)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        this.loggingRequests.set(requestId, { resolve, reject })
        timer = setTimeout(() => reject(new Error('Host logging configuration timed out')), 10_000)
        child.send({ type: 'logging-config', requestId, ...value }, error => { if (error) reject(error) })
      }).catch(error => { end(error); throw error })
    } finally { end(); clearTimeout(timer); this.loggingRequests.delete(requestId) }
  }

  /** Acknowledge the live request gate before publishing browser access as enabled. */
  async setBrowserAccess(enabled: boolean): Promise<void> {
    const child = this.child
    if (!child?.connected || this.stopping || this.failureReported) throw new Error('Next Host is unavailable')
    const requestId = this.nextControlId++
    const end = this.controlOperation('browser-access', requestId)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        this.accessRequests.set(requestId, { resolve, reject })
        timer = setTimeout(() => reject(new Error('Browser access change timed out')), 5_000)
        child.send({ type: 'browser-access', requestId, enabled }, error => { if (error) reject(error) })
      }).catch(error => { end(error); throw error })
    } finally { end(); clearTimeout(timer); this.accessRequests.delete(requestId) }
  }

  /**
   * Re-read the Web boot table from the running application.
   * @returns The injection rows the Web server publishes right now. dsh 0.1.7 addresses the boot
   * graph by bundle revision, and registering a plugin republishes it, so a document that reloads
   * has to boot from the current table rather than the one captured at startup.
   */
  async collectInjections(): Promise<readonly unknown[]> {
    const child = this.child
    if (!child?.connected || this.stopping || this.failureReported) throw new Error('Next Host is unavailable')
    const requestId = this.nextControlId++
    const end = this.controlOperation('injections', requestId)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<readonly unknown[]>((resolve, reject) => {
        this.injectionRequests.set(requestId, { resolve, reject })
        timer = setTimeout(() => { reject(new Error('Web boot injection collection timed out')) }, 10_000)
        child.send({ type: 'injections', requestId }, error => { if (error !== null) reject(error) })
      }).catch(error => { end(error); throw error })
    } finally { end(); clearTimeout(timer); this.injectionRequests.delete(requestId) }
  }

  /**
   * Inspect active work or lock request admission for update handoff.
   * @param action - Read-only inspection, admission lock, or recovery unlock.
   * @returns Whether live tasks would be affected. Locking drains admitted API requests before inspecting tasks;
   * an unanswered drain fails at the control-request deadline without authorizing installation.
   */
  async updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    const child = this.child
    if (child === undefined || !child.connected || this.failureReported || this.stopping) {
      throw new Error('desktop update: Host is unavailable')
    }
    const requestId = this.nextControlId++
    const end = this.controlOperation('update-tasks', requestId)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<boolean>((resolve, reject) => {
        this.taskQueries.set(requestId, { resolve, reject })
        timer = setTimeout(() => { reject(new Error('desktop update: task inspection timed out')) }, 10_000)
        child.send({ type: 'update-tasks', requestId, action }, (error) => { if (error !== null) reject(error) })
      }).catch(error => { end(error); throw error })
    } finally { end();
      clearTimeout(timer)
      this.taskQueries.delete(requestId)
    }
  }

  /**
   * Request teardown and await child exit, escalating termination when needed.
   * @param requireGraceful - Reject update handoff after forced termination or unsuccessful child exit.
   * @returns Completion of owned process teardown. DesktopHostUncleanExitError confirms exit but refuses installation;
   * other failures do not confirm exit.
   */
  async stop(requireGraceful = false): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    this.diagnostic({ source: 'host.process', event: 'shutdown.request', pid: child.pid })
    this.onPlatformSession?.(null)
    if (child.connected) child.send({ type: 'shutdown' }, (error) => { if (error !== null) this.fail(error) })
    const exited = this.exitPromise ?? Promise.resolve()
    const graceful = await exitsWithin(exited, 10_000)
    if (!graceful) { this.diagnostic({ source: 'host.process', event: 'shutdown.escalate', level: 'warn', pid: child.pid, fields: { signal: 'SIGTERM' } }); child.kill('SIGTERM') }
    if (!await exitsWithin(exited, 5_000)) {
      this.diagnostic({ source: 'host.process', event: 'shutdown.escalate', level: 'warn', pid: child.pid, fields: { signal: 'SIGKILL' } })
      child.kill('SIGKILL')
      if (!await exitsWithin(exited, 5_000)) {
        throw new Error('dsh desktop host did not exit after SIGKILL')
      }
    }
    this.child = undefined
    if (requireGraceful && (!graceful || child.exitCode !== 0 || !this.shutdownCompleted)) {
      // This diagnostic reaches expandable UI; arbitrary plugin stderr can contain credentials.
      throw new DesktopHostUncleanExitError(`desktop update: Host did not complete graceful task teardown (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, shutdown acknowledged ${String(this.shutdownCompleted)}, graceful deadline exceeded ${String(!graceful)})`)
    }
  }

  private fail(error: Error): void {
    this.onPlatformSession?.(null)
    this.readyReject(error)
    for (const query of this.taskQueries.values()) query.reject(error)
    this.taskQueries.clear()
    for (const request of this.accessRequests.values()) request.reject(error)
    this.accessRequests.clear()
    for (const request of this.loggingRequests.values()) request.reject(error)
    this.loggingRequests.clear()
    for (const request of this.injectionRequests.values()) request.reject(error)
    this.injectionRequests.clear()
    if (!this.failureReported && !this.stopping) {
      this.failureReported = true
      try { this.onFailure?.(error) } catch (listenerError) {
        console.error('desktop host failure listener failed', listenerError)
      }
    }
  }
}
