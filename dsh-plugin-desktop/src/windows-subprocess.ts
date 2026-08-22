/** Electron adapter for terminal processes confined by the upstream Windows ACL sandbox. */

import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { win32 } from 'node:path'
import type {
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { WindowsAclAdaptation } from './windows-pwsh-sandbox.ts'
import {
  encodeWindowsAclRelay,
  quotedWindowsRelayPath,
  removeWindowsAclRelayEnvironment,
  WINDOWS_ACL_RELAY_ELECTRON,
  WINDOWS_ACL_RELAY_PAYLOAD,
  WINDOWS_ACL_RELAY_TRAMPOLINE,
} from './windows-acl-relay.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const POWERSHELL_EXECUTION_POLICY = 'PSExecutionPolicyPreference'
const POWERSHELL_EXECUTION_POLICY_BYPASS = 'Bypass'
const OFFICIAL_WINDOWS_POWERSHELL_ARGS = ['-NoLogo', '-NoProfile'] as const
const UPSTREAM_RUNNER = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
const DESKTOP_TRAMPOLINE = fileURLToPath(new URL('./windows-acl-runner.js', import.meta.url))
const CMD_VARIABLE_ELECTRON = `%${WINDOWS_ACL_RELAY_ELECTRON}%`
const CMD_VARIABLE_TRAMPOLINE = `%${WINDOWS_ACL_RELAY_TRAMPOLINE}%`

/** Additional host inputs needed to resolve the trusted cmd.exe relay. */
export interface WindowsAclTerminalAdaptation extends WindowsAclAdaptation {
  env: NodeJS.ProcessEnv
  isFile?: (path: string) => boolean
}

function removeEnvironmentKey(env: NodeJS.ProcessEnv, name: string): void {
  const normalized = name.toUpperCase()
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === normalized) delete env[key]
  }
}

function systemRootOf(env: NodeJS.ProcessEnv): string | undefined {
  return Object.entries(env)
    .find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1]
}

function sameWindowsPath(left: string, right: string): boolean {
  return win32.normalize(left).toUpperCase() === win32.normalize(right).toUpperCase()
}

/** Match only the official persistent-terminal argv when it falls back to Windows PowerShell 5.1. */
export function isOfficialWindowsPowerShell51Terminal(
  runnerArgs: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  const separator = runnerArgs.lastIndexOf('--')
  if (separator < 0) return false
  const childArgv = runnerArgs.slice(separator + 1)
  const [program, ...args] = childArgv
  const systemRoot = systemRootOf(env)
  if (program === undefined || systemRoot === undefined || systemRoot.length === 0) return false
  const expected = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return sameWindowsPath(program, expected)
    && args.length === OFFICIAL_WINDOWS_POWERSHELL_ARGS.length
    && args.every((arg, index) => arg === OFFICIAL_WINDOWS_POWERSHELL_ARGS[index])
}

/** Resolve cmd.exe without consulting PATH or the caller-controlled ComSpec value. */
export function desktopWindowsCommandPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isFile: (path: string) => boolean = path => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
): string | undefined {
  if (platform !== 'win32') return undefined
  const systemRoot = systemRootOf(env)
  if (systemRoot === undefined || systemRoot.length === 0) {
    throw new Error('dsh-plugin-desktop: Windows ACL terminal relay requires SystemRoot')
  }
  quotedWindowsRelayPath(systemRoot, 'SystemRoot')
  const command = win32.join(systemRoot, 'System32', 'cmd.exe')
  quotedWindowsRelayPath(command, 'cmd.exe')
  if (!isFile(command)) {
    throw new Error(`dsh-plugin-desktop: Windows ACL terminal relay cmd.exe is not a regular file: ${command}`)
  }
  return command
}

/** Adapt one persistent-terminal spawn while preserving every non-runner spec unchanged. */
export function adaptWindowsAclTerminalSpawn(
  spec: SubprocessTerminalSpawnSpec,
  adaptation: WindowsAclTerminalAdaptation,
): SubprocessTerminalSpawnSpec {
  const [program, runner, ...args] = spec.argv
  if (adaptation.platform !== 'win32'
    || !adaptation.electron
    || program !== adaptation.execPath
    || runner !== adaptation.upstreamRunner) {
    return spec
  }

  const command = desktopWindowsCommandPath(adaptation.env, adaptation.platform, adaptation.isFile)
  if (command === undefined) throw new Error('dsh-plugin-desktop: Windows ACL terminal relay has no cmd.exe')
  const env = { ...spec.env }
  removeWindowsAclRelayEnvironment(env)
  removeEnvironmentKey(env, RUN_AS_NODE)
  if (isOfficialWindowsPowerShell51Terminal(args, adaptation.env)) {
    // Execution Policy is not the ACL security boundary. Process scope only
    // suppresses Windows PowerShell 5.1's publisher prompt, which otherwise
    // consumes the persistent terminal's first command and stalls the tool.
    removeEnvironmentKey(env, POWERSHELL_EXECUTION_POLICY)
    env[POWERSHELL_EXECUTION_POLICY] = POWERSHELL_EXECUTION_POLICY_BYPASS
  }
  env[RUN_AS_NODE] = '1'
  env[WINDOWS_ACL_RELAY_PAYLOAD] = encodeWindowsAclRelay(runner, args)
  env[WINDOWS_ACL_RELAY_ELECTRON] = quotedWindowsRelayPath(adaptation.execPath, 'Electron executable')
  env[WINDOWS_ACL_RELAY_TRAMPOLINE] = quotedWindowsRelayPath(adaptation.trampoline, 'trampoline')
  return {
    ...spec,
    env,
    argv: [
      command,
      '/d',
      '/q',
      '/v:off',
      '/s',
      '/c',
      CMD_VARIABLE_ELECTRON,
      CMD_VARIABLE_TRAMPOLINE,
    ],
  }
}

/** Official local subprocess provider with the Electron ACL terminal launch repaired through cmd-owned ConPTY. */
export class DesktopWindowsSubprocess extends LocalSubprocessRuntime {
  override spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return super.spawnTerminal(adaptWindowsAclTerminalSpawn(spec, {
      platform: process.platform,
      electron: process.versions.electron !== undefined,
      execPath: process.execPath,
      upstreamRunner: UPSTREAM_RUNNER,
      trampoline: DESKTOP_TRAMPOLINE,
      env: process.env,
    }))
  }
}

export default DesktopWindowsSubprocess
