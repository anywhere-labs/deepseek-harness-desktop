/** Native Windows Terminal launch for the managed WSL DSH environment. */

import { spawn, type ChildProcess } from 'node:child_process'
import { assertWslDistributionName } from './host-target.ts'
import { wslExecArguments } from './wsl.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const TERMINAL_SCRIPT = [
  'export DSH_HOME="$1"',
  'export DSH_DESKTOP_DEFAULT_PROFILE="$2"',
  'export PATH="$3/node_modules/.bin:$PATH"',
  'cd "$4"',
  'printf "DSH Desktop WSL terminal (%s)\\n" "$2"',
  'exec bash -l',
].join('; ')

export interface WslTerminalOptions {
  readonly distribution: string
  readonly homeDir: string
  readonly profileName: string
  readonly profileDir: string
  readonly runtimeRoot: string
  readonly spawn?: typeof spawn
  onLaunchError(cause: unknown): void
}

function linuxValue(value: string, label: string): string {
  if (!value.startsWith('/') || value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new Error(`${BIN_NAME}: WSL terminal ${label} must be an absolute Linux path`)
  }
  return value
}

/** Open Windows Terminal, falling back to the system console host when absent. */
export function openWslDesktopTerminal(options: WslTerminalOptions): void {
  const distribution = assertWslDistributionName(options.distribution)
  const homeDir = linuxValue(options.homeDir, 'home')
  const profileDir = linuxValue(options.profileDir, 'profile')
  const runtimeRoot = linuxValue(options.runtimeRoot, 'runtime')
  if (options.profileName.length === 0 || options.profileName.includes('\0') || /[\r\n]/u.test(options.profileName)) {
    throw new Error(`${BIN_NAME}: invalid WSL terminal profile`)
  }
  const spawnProcess = options.spawn ?? spawn
  const command = [
    'bash', '-lc', TERMINAL_SCRIPT, 'dsh-terminal',
    homeDir, options.profileName, runtimeRoot, profileDir,
  ]
  const wslArgs = wslExecArguments(distribution, command)
  const launch = (executable: string, args: readonly string[], fallback: boolean): void => {
    let child: ChildProcess
    try {
      child = spawnProcess(executable, [...args], {
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: false,
      })
    } catch (cause) {
      if (fallback) options.onLaunchError(cause)
      else launch('conhost.exe', ['wsl.exe', ...wslArgs], true)
      return
    }
    child.once('error', cause => {
      if (fallback) options.onLaunchError(cause)
      else launch('conhost.exe', ['wsl.exe', ...wslArgs], true)
    })
    child.once('spawn', () => { child.unref() })
  }
  launch('wt.exe', [
    'new-tab', '--title', 'DSH Desktop WSL',
    'wsl.exe', ...wslArgs,
  ], false)
}
