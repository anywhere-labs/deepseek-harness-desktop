/** Electron owns the child lifetime; the child owns the unchanged DSH Web server. */
import { createProcessOutputLogging } from './process-output-logging.ts'
import { serializeHostEnvironment } from './host-launch-environment.ts'
import { utilityProcess } from 'electron'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import { HostRpc } from './host-rpc.ts'
import { bindNativeRuntime, runtimeSnapshot } from './host-runtime-bridge.ts'
import type { DesktopHostOptions } from './host-bootstrap.ts'
import type { DesktopRuntime } from './runtime.ts'
import type { DesktopStartupGenerationHost } from './startup-generation.ts'
import type { DesktopLanHttpsRuntimeOptions } from './lan-https-runtime.ts'

export interface IsolatedHostOptions {
  host: DesktopHostOptions
  runtime: DesktopRuntime
  rendererToken: string
  prepareCertificate: NonNullable<DesktopLanHttpsRuntimeOptions['prepareCertificate']>
  bindHost(host: DesktopStartupGenerationHost): void
  requestQuit(code: number): void
  onFailure(error: Error, exit: IsolatedHostExit): void
}

/** What an unexpected Host exit leaves behind for evidence. */
export interface IsolatedHostExit {
  /** Electron's reported code. A terminated Host reports the terminator's code, not a self-chosen one. */
  readonly exitCode: number
  /** Milliseconds between fork and exit; separates an instant death from one hours in. */
  readonly uptimeMs: number
  /**
   * The Host's last stderr output, bounded to {@link HOST_STDERR_TAIL_CHARS}. A fatal Host writes
   * its reason there (the fail-loud diagnostic, or Node's own crash stack) and nowhere else.
   */
  readonly stderrTail: string
}

/** Enough for a fail-loud diagnostic with its inspected cause chain, small enough for one log entry. */
export const HOST_STDERR_TAIL_CHARS = 16 * 1024

/** The Desktop log entry for an unexpected Host exit: the reason, then what the Host said last. */
export function formatUnexpectedHostExit(error: Error, exit: IsolatedHostExit): string {
  const tail = exit.stderrTail.trimEnd()
  return tail === '' ? error.message : `${error.message}\nLast DSH Host stderr:\n${tail}`
}

export async function startIsolatedDesktopHost(options: IsolatedHostOptions): Promise<void> {
  const forkedAt = performance.now()
  const child = utilityProcess.fork(fileURLToPath(new URL('./host-process-entry.js', import.meta.url)), [], {
    serviceName: 'DSH Host', stdio: 'pipe', cwd: process.cwd(), env: { ...process.env },
  })
  // Keep normal Host logs in its own files; stderr includes bootstrap failures.
  const stdoutLog = createProcessOutputLogging('stdout', () => child.pid)
  const stderrLog = createProcessOutputLogging('stderr', () => child.pid)
  child.stdout?.on('data', (data: Buffer) => { process.stdout.write(data); stdoutLog.write(data) })
  child.stdout?.once('end', () => stdoutLog.end())
  child.stderr?.once('end', () => stderrLog.end())
  const stderrDecoder = new StringDecoder('utf8')
  let stderrTail = ''
  child.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(data)
    stderrLog.write(data)
    stderrTail = (stderrTail + stderrDecoder.write(data)).slice(-HOST_STDERR_TAIL_CHARS)
  })
  const rpc = new HostRpc({
    send: message => child.postMessage(message),
    listen: receive => { child.on('message', receive); return () => { child.removeListener('message', receive) } },
  }, 120_000)
  const releaseNative = bindNativeRuntime(rpc, options.runtime)
  rpc.handle('certificate', () => options.prepareCertificate())
  rpc.handle('quit', ([code]) => { setImmediate(() => options.requestQuit(code)) })
  let stopping = false
  let exited = false
  let booted = false
  let resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  child.once('exit', (code) => {
    stdoutLog.end(); stderrLog.end()
    exited = true
    rpc.close(`DSH Host exited (${code})`)
    resolveExit()
    if (!stopping && booted) {
      options.onFailure(
        new Error(`DSH Host exited (${code}); restart the application to reconnect`),
        { exitCode: code, uptimeMs: Math.max(0, performance.now() - forkedAt), stderrTail },
      )
    }
  })
  let stopTask: Promise<void> | undefined
  const stop = (): Promise<void> => stopTask ??= (async () => {
    stopping = true
    if (!exited) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3_000)
      try { await rpc.call('stop', [], controller.signal) } catch { /* terminate an unresponsive Host */ }
      finally { clearTimeout(timeout) }
      if (!exited) child.kill()
      const timeoutExit = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('DSH Host termination was not confirmed')), 1_000)
        void exit.then(() => clearTimeout(timer))
      })
      await Promise.race([exit, timeoutExit])
    }
    await releaseNative()
    rpc.close()
  })()
  options.bindHost({ fiber: { dispose: stop } })
  try {
    const { desktopLaunchEnvironment, ...host } = options.host
    await rpc.call('boot', [{ ...host, launchEnvironmentLayers: serializeHostEnvironment(desktopLaunchEnvironment) }, runtimeSnapshot(options.runtime), options.rendererToken])
    booted = true
  } catch (cause) {
    await stop()
    throw cause
  }
}
