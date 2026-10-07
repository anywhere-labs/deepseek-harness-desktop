/** Electron adapter for the upstream Windows ACL PowerShell executor. */

import { fileURLToPath } from 'node:url'
import { win32 } from 'node:path'
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import type { Config as PwshConfig } from '@deepseek-ai/dsh-pwsh-local'
import { windowsExecutableProbe } from './windows-executable.ts'

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
  exists: (path: string) => boolean = windowsExecutableProbe,
): string | undefined {
  if (platform !== 'win32') return undefined
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const localAppData = env.LOCALAPPDATA ?? env.LocalAppData
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const candidates = [win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe')]
  // A Microsoft Store install publishes no Program Files directory; its shell is
  // reachable only through the app execution alias, which the probe accepts.
  if (localAppData !== undefined && localAppData.length > 0) {
    candidates.push(win32.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
  }
  candidates.push(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
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
  exists: (path: string) => boolean = windowsExecutableProbe,
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
    if (typeof argvOrPrepare !== 'function') {
      const adapted = this.adapt(spec, argvOrPrepare)
      return super.executeArgv(adapted.spec, adapted.argv, onStarted)
    }
    const pending: ShellExecSpec = { ...spec }
    return super.executeArgv(pending, async signal => {
      const adapted = this.adapt(spec, await argvOrPrepare(signal))
      pending.env = adapted.spec.env
      return adapted.argv
    }, onStarted)
  }
}

export default DesktopWindowsPwshSandbox
