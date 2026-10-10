/** Electron adapter for the upstream Windows ACL PowerShell executor. */

import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { isUtf8 } from 'node:buffer'
import { createRequire } from 'node:module'
import { win32 } from 'node:path'
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import type { SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import type { Config as PwshConfig } from '@deepseek-ai/dsh-pwsh-local'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const UPSTREAM_RUNNER = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
const DESKTOP_TRAMPOLINE = fileURLToPath(new URL('./windows-acl-runner.js', import.meta.url))

/** Inputs controlling one exact ACL-runner argv rewrite. */
export interface WindowsAclAdaptation {
  /** Host platform; only Windows is adapted. */
  platform: NodeJS.Platform
  /** Whether the current Host executable is Electron. */
  electron: boolean
  /** Current Electron executable path. */
  execPath: string
  /** Resolved upstream ACL runner path. */
  upstreamRunner: string
  /** Desktop-owned Node-mode trampoline path. */
  trampoline: string
}

/** Adapted execution inputs passed to the ordinary local executor. */
export interface AdaptedWindowsAclExecution {
  /** Spec carrying the runner-only Electron environment. */
  spec: ShellExecSpec
  /** Exact argv, with the desktop trampoline inserted when required. */
  argv: readonly string[]
}

/** Windows PowerShell paths that do not depend on PATH-provided portable runtimes. Built with win32 semantics on every host so results are deterministic off Windows. */
export function desktopWindowsPwshPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (platform !== 'win32') return undefined
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const candidates = [
    win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  return candidates.find(candidate => exists(candidate))
}

/**
 * Keep explicit user config, otherwise avoid PATH-resolved portable pwsh in the
 * Windows ACL sandbox. `pwshPath` is a live config reference the settings
 * runtime rewrites in place, so the desktop default is supplied by a reference
 * that reads the declared value through on every access instead of a value
 * unwrapped once at construction: a snapshot taken here would pin the desktop
 * fallback for the lifetime of the plugin and silently ignore a later edit,
 * because a volatile-only change commits into the caller's reference rather
 * than reloading this plugin.
 * @param config - the plugin config carrying the caller's live references.
 * @param env - environment the Windows install locations are derived from.
 * @param platform - host platform; only Windows gets a desktop default.
 * @param exists - existence probe for the candidate executables.
 * @returns the same config with a `pwshPath` reference that defaults only while the declared value is empty.
 */
export function desktopWindowsPwshConfig(
  config: PwshConfig,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): PwshConfig {
  const declared = config.pwshPath
  // The fallback is a property of the host, not of the config, so the
  // filesystem probe runs at most once however often the reference is read.
  let fallback: string | undefined
  let probed = false
  return {
    ...config,
    pwshPath: {
      get: () => {
        const configured = declared.get()
        if (configured !== undefined && configured.length > 0) return configured
        if (!probed) {
          probed = true
          fallback = desktopWindowsPwshPath(env, platform, exists)
        }
        return fallback
      },
    },
  }
}

/** Strict conversion of Windows console bytes; undefined means invalid input. */
export type WindowsConsoleDecoder = (bytes: Buffer) => string | undefined

let windowsConsoleDecoder: WindowsConsoleDecoder | undefined

function decodeWindowsConsole(bytes: Buffer): string | undefined {
  if (windowsConsoleDecoder === undefined) {
    const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi').default
    const kernel32 = koffi.load('kernel32.dll')
    const oemCodePage = kernel32.func('uint32 __stdcall GetOEMCP()')
    const convert = kernel32.func('int __stdcall MultiByteToWideChar(uint32, uint32, const void *, int, void *, int)')
    // Hidden local PowerShell and the ACL trampoline's newly allocated console
    // use the system OEM default, not the Host's potentially different console.
    // Never change the Host's global code page.
    const codePage = oemCodePage()
    windowsConsoleDecoder = raw => {
      const chars = convert(codePage, 8 /* MB_ERR_INVALID_CHARS */, raw, raw.length, null, 0)
      if (chars === 0) return undefined
      const wide = Buffer.alloc(chars * 2)
      return convert(codePage, 8, raw, raw.length, wide, chars) === chars
        ? wide.toString('utf16le') : undefined
    }
  }
  return windowsConsoleDecoder(bytes)
}

/** Distinguish incomplete UTF-8 at a live byte boundary from legacy bytes. */
function incompleteUtf8Suffix(bytes: Buffer): boolean {
  for (let count = 1; count <= Math.min(3, bytes.length); count++) {
    const suffix = bytes.subarray(bytes.length - count)
    const lead = suffix[0]!
    const width = lead >= 0xc2 && lead <= 0xdf ? 2
      : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0
    if (width <= count || !isUtf8(bytes.subarray(0, bytes.length - count))) continue
    if (!suffix.subarray(1).every(byte => byte >= 0x80 && byte <= 0xbf)) continue
    const second = suffix[1]
    if (second !== undefined && ((lead === 0xe0 && second < 0xa0) || (lead === 0xed && second > 0x9f)
      || (lead === 0xf0 && second < 0x90) || (lead === 0xf4 && second > 0x8f))) continue
    return true
  }
  return false
}

/**
 * Repair only non-UTF-8 PowerShell ParserError bytes from a local collector's
 * public snapshot. The preamble cannot run when the original command does not
 * parse. Do not reinterpret already-decoded text, change the command, or run a
 * second PowerShell (which changes stdin, return/exit, and restricted language).
 * Keep byte cursors, truncation and spill facts in the original coordinate
 * system. An undecidable live fragment is not consumed: the parser marker or
 * settlement releases it without losing an earlier background read.
 * @param reader - the original collect-mode stderr reader.
 * @param settled - whether its unchanged subprocess has settled.
 * @param decode - strict Windows console-code-page decoder.
 * @param report - report an unavailable optional decoder without changing execution.
 * @returns the same reader with only its per-instance read function adapted.
 */
export function desktopWindowsPwshStderr(
  reader: SubprocessOutputReader,
  settled: () => boolean,
  decode: WindowsConsoleDecoder = decodeWindowsConsole,
  report: (error: unknown) => void = () => {},
): SubprocessOutputReader {
  const collector = reader as SubprocessOutputReader & Partial<Pick<OutputCollector, 'snapshot'>>
  if (typeof collector.snapshot !== 'function') return reader
  const snapshot = collector.snapshot.bind(collector)
  const read = reader.readFrom.bind(reader)
  let reported = false
  const adapted: SubprocessOutputReader['readFrom'] = fromByte => {
    const original = read(fromByte)
    const { bytes, totalBytes } = snapshot()
    const start = totalBytes - bytes.length
    let utf8Start = 0
    // A bounded tail can start halfway through an otherwise valid UTF-8 code
    // point. Such deliberate truncation is not evidence of a legacy encoding.
    if (start > 0) {
      while (utf8Start < Math.min(3, bytes.length) && (bytes[utf8Start]! & 0xc0) === 0x80) utf8Start++
    }
    const utf8 = bytes.subarray(utf8Start)
    if (isUtf8(utf8)) return original
    if (!settled() && incompleteUtf8Suffix(utf8)) return { ...original, text: '', nextOffset: fromByte }
    const retained = original.lossy ? bytes : bytes.subarray(Math.max(0, fromByte - start))
    if (/^\s*\+\s+CategoryInfo\s*:\s*ParserError\b/m.test(bytes.toString('latin1'))) {
      try {
        const text = decode(retained)
        if (text !== undefined) return { ...original, text }
      } catch (error) {
        if (!reported) {
          reported = true
          try { report(error) } catch { /* optional diagnostics cannot break subprocess settlement */ }
        }
        return original
      }
    }
    return settled() ? original : { ...original, text: '', nextOffset: fromByte }
  }
  try { reader.readFrom = adapted } catch (error) {
    // An optional custom provider may expose a frozen reader. It has already
    // started its process, so an unavailable text repair must not lose its handle.
    try { report(error) } catch { /* keep the original provider's execution contract */ }
  }
  return reader
}

/**
 * Insert the desktop Node-mode trampoline for the exact upstream ACL runner.
 * @param spec - resolved PowerShell execution spec.
 * @param argv - argv after the upstream sandbox provider has confined it.
 * @param adaptation - executable and runner identities for this Host.
 * @returns unchanged inputs for every non-runner call, otherwise the isolated runner launch.
 */
export function adaptWindowsAclExecution(
  spec: ShellExecSpec,
  argv: readonly string[],
  adaptation: WindowsAclAdaptation,
): AdaptedWindowsAclExecution {
  const [program, runner, ...args] = argv
  if (adaptation.platform !== 'win32'
    || !adaptation.electron
    || program !== adaptation.execPath
    || runner !== adaptation.upstreamRunner) {
    return { spec, argv }
  }

  const env = { ...spec.env }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === RUN_AS_NODE) delete env[key]
  }
  env[RUN_AS_NODE] = '1'
  return {
    spec: { ...spec, env },
    argv: [adaptation.execPath, adaptation.trampoline, adaptation.upstreamRunner, ...args],
  }
}

/** PowerShell sandbox provider that repairs only Electron-hosted Windows ACL launches. */
export class DesktopWindowsPwshSandbox extends SandboxPwshExecutor {
  constructor(ctx: ConstructorParameters<typeof SandboxPwshExecutor>[0], config: PwshConfig) {
    super(ctx, desktopWindowsPwshConfig(config, process.env, process.platform))
  }

  private adapt(spec: ShellExecSpec, argv: readonly string[]): AdaptedWindowsAclExecution {
    return adaptWindowsAclExecution(spec, argv, {
      platform: process.platform,
      electron: process.versions.electron !== undefined,
      execPath: process.execPath,
      upstreamRunner: UPSTREAM_RUNNER,
      trampoline: DESKTOP_TRAMPOLINE,
    })
  }

  /**
   * Adapt the exact argv the upstream sandbox produced, keeping confinement
   * preparation inside the caller's deadline. This is the single argv seam for
   * both foreground and background callers - the executor publishes one
   * execution handle and "foreground" is only what the caller awaits - so every
   * confined launch passes through here. Preparation only yields argv after this
   * executor has handed a spec to the local executor, so the runner-only
   * Electron environment lands on this class's own spec copy at the moment the
   * argv becomes known - strictly before the local executor reads the spec to
   * build its spawn request.
   * @param spec - resolved PowerShell execution spec.
   * @param argvOrPrepare - exact argv, or preparation sharing the execution deadline.
   * @param onStarted - the caller's provider-fact installer, forwarded untouched.
   * @returns the live execution handle the local executor published.
   */
  protected override executeArgv(
    spec: ShellExecSpec,
    argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>),
    onStarted?: (process: ShellExecution) => void,
  ): Promise<ShellExecution> {
    // Shadow spawn for this execution only. A fresh receiver with an own ctx
    // descriptor survives Cordis's traced readonly ctx without mutating either
    // the registered subprocess service or this executor (concurrent calls).
    let receiver: this = this
    if (process.platform === 'win32') {
      const runtime = this.ctx.subprocess
      const subprocess = Object.create(runtime) as typeof runtime
      subprocess.spawn = (spawnSpec: SubprocessSpawnSpec) => {
        const handle = runtime.spawn(spawnSpec)
        let settled = false
        void handle.done.then(() => { settled = true }, () => { settled = true })
        if (handle.collected.stderr !== undefined) {
          desktopWindowsPwshStderr(handle.collected.stderr, () => settled, decodeWindowsConsole,
            error => this.ctx.logger.warn('Desktop could not decode a legacy PowerShell parser diagnostic; keeping its original output.', error))
        }
        return handle
      }
      receiver = Object.create(this) as this
      Object.defineProperty(receiver, 'ctx', { value: this.ctx.extend({ subprocess }) })
    }
    if (typeof argvOrPrepare !== 'function') {
      const adapted = this.adapt(spec, argvOrPrepare)
      return super.executeArgv.call(receiver, adapted.spec, adapted.argv, onStarted)
    }
    const pending: ShellExecSpec = { ...spec }
    return super.executeArgv.call(receiver, pending, async signal => {
      const adapted = this.adapt(spec, await argvOrPrepare(signal))
      pending.env = adapted.spec.env
      return adapted.argv
    }, onStarted)
  }
}

export default DesktopWindowsPwshSandbox
