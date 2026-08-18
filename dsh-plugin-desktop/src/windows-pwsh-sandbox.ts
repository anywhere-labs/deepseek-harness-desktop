/** Electron adapter for the upstream Windows ACL PowerShell executor. */

import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { win32 } from 'node:path'
import type { ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import type { Config as PwshConfig } from '@deepseek-ai/dsh-pwsh-local'
import { unpackedAsarPath } from './packaged-runtime-path.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const UPSTREAM_RUNNER = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
const DESKTOP_TRAMPOLINE = fileURLToPath(new URL('./windows-acl-runner.js', import.meta.url))

/**
 * Relative extraResource name for the vendored Node executable shipped beside
 * the packaged app (`resources/node.exe`). Running the ACL runner inside the
 * ELECTRON_RUN_AS_NODE process produces restricted tokens whose children all
 * die with 0xC0000142 during DLL init (issue #203); a standalone Node keeps
 * the runner outside that process and the sandbox behaves identically to the
 * CLI. The trampoline remains only for unpackaged development, where no
 * vendored Node exists and the known-broken path is logged.
 */
const VENDORED_NODE_RESOURCE = 'node.exe'
const VENDORED_NODE_PROBE_TIMEOUT_MS = 5_000
const TRAMPOLINE_FALLBACK_WARNED = new Set<string>()

/** Inputs controlling one exact ACL-runner argv rewrite. */
export interface WindowsAclAdaptation {
  /** Host platform; only Windows is adapted. */
  platform: NodeJS.Platform
  /** Whether the current Host executable is Electron. */
  electron: boolean
  /** Current Electron executable path. */
  execPath: string
  /** Resolved upstream ACL runner path (logical ASAR path). */
  upstreamRunner: string
  /** Desktop-owned Node-mode trampoline path. */
  trampoline: string
  /** Absolute vendored Node executable; undefined keeps the trampoline fallback. */
  nodeExecutable?: string
  /** Probe the vendored Node once (`-v`); injectable for tests. */
  probe?: (path: string) => boolean
}

/** Adapted execution inputs passed to the ordinary local executor. */
export interface AdaptedWindowsAclExecution {
  /** Spec carrying the runner-only environment. */
  spec: ShellExecSpec
  /** Exact argv, with the runner host selected (vendored Node or trampoline). */
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

/** Keep explicit user config, otherwise avoid PATH-resolved portable pwsh in the Windows ACL sandbox. */
export function desktopWindowsPwshConfig(
  config: PwshConfig,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): PwshConfig {
  if (config.pwshPath !== undefined && config.pwshPath.length > 0) return config
  const pwshPath = desktopWindowsPwshPath(env, platform, exists)
  return pwshPath === undefined ? config : { ...config, pwshPath }
}

/**
 * Resolve the vendored Node executable shipped beside the packaged app.
 * @param execPath - current Electron executable path.
 * @param exists - injectable existence check.
 * @returns the physical node.exe, or undefined when unpackaged or absent.
 */
export function resolveVendoredNodeExecutable(
  execPath: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  // Windows path semantics on every host, matching desktopWindowsPwshPath,
  // so the resolution is deterministic in cross-platform test runs.
  const candidate = win32.join(win32.dirname(execPath), 'resources', VENDORED_NODE_RESOURCE)
  return exists(candidate) ? candidate : undefined
}

/** Per-path memo of successful `node -v` probes; the executable never changes for a given install. */
const probedVendoredNodes = new Set<string>()

/**
 * Probe that the vendored Node actually launches, not merely exists. AV/EDR
 * products can quarantine unsigned bundled executables (issue #203 branch B);
 * a file that exists but cannot run must not silently masquerade as a sandbox
 * failure.
 * @param path - absolute node.exe path.
 * @param spawn - injectable spawn for tests.
 * @returns true when `node -v` exits 0 with a version string.
 */
export function probeVendoredNodeExecutable(
  path: string,
  spawn: typeof spawnSync = spawnSync,
): boolean {
  if (probedVendoredNodes.has(path)) return true
  const result = spawn(path, ['-v'], {
    timeout: VENDORED_NODE_PROBE_TIMEOUT_MS,
    windowsHide: true,
  })
  const ok = result.status === 0 && /^v\d+\./u.test(String(result.stdout).trim())
  if (ok) probedVendoredNodes.add(path)
  return ok
}

/**
 * Insert the desktop runner host for the exact upstream ACL runner argv.
 * Prefers the vendored standalone Node (verified against issue #203); the
 * Electron trampoline is only a development fallback and logs a one-time
 * warning because it is the known-broken shape for Windows sandboxed pwsh.
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

  const nodeExecutable = adaptation.nodeExecutable
  if (nodeExecutable !== undefined) {
    // Preferred path: standalone vendored Node. The upstream runner receives
    // the physical unpacked path — stock Node cannot read app.asar.
    const probe = adaptation.probe ?? probeVendoredNodeExecutable
    if (!probe(nodeExecutable)) {
      throw new Error(
        `[dsh-plugin-desktop] vendored Node at ${nodeExecutable} exists but does not launch. ` +
        'It may be quarantined or blocked by security software (issue #203). ' +
        'Reinstall DSH Desktop or whitelist the bundled node.exe.',
      )
    }
    return {
      spec: { ...spec, env },
      argv: [nodeExecutable, unpackedAsarPath(adaptation.upstreamRunner), ...args],
    }
  }

  // Development fallback: the RunAsNode trampoline is known-broken for the
  // Windows workspace-write sandbox (issue #203); warn once per trampoline.
  if (!TRAMPOLINE_FALLBACK_WARNED.has(adaptation.trampoline)) {
    TRAMPOLINE_FALLBACK_WARNED.add(adaptation.trampoline)
    console.warn(
      '[dsh-plugin-desktop] no vendored Node found; falling back to the RunAsNode trampoline. ' +
      'On Windows, workspace-write sandboxed pwsh fails with 0xC0000142 in this mode (issue #203).',
    )
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
    const nodeExecutable = resolveVendoredNodeExecutable(process.execPath)
    return adaptWindowsAclExecution(spec, argv, {
      platform: process.platform,
      electron: process.versions.electron !== undefined,
      execPath: process.execPath,
      upstreamRunner: UPSTREAM_RUNNER,
      trampoline: DESKTOP_TRAMPOLINE,
      ...(nodeExecutable === undefined ? {} : { nodeExecutable }),
    })
  }

  protected override async runArgv(spec: ShellExecSpec, argv: readonly string[]): Promise<ShellRunResult> {
    const adapted = this.adapt(spec, argv)
    return super.runArgv(adapted.spec, adapted.argv)
  }

  protected override startArgv(spec: ShellExecSpec, argv: readonly string[]): ShellProcess {
    const adapted = this.adapt(spec, argv)
    return super.startArgv(adapted.spec, adapted.argv)
  }
}

export default DesktopWindowsPwshSandbox
