import { fileURLToPath } from 'node:url'
import type { Config as PwshConfig } from '@deepseek-ai/dsh-pwsh-local'
import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureWindowsConsoleHost,
  type WindowsConsoleDonorLauncher,
  type WindowsConsoleHostApi,
} from '../src/windows-console-host.ts'
import {
  adaptWindowsAclExecution,
  desktopWindowsPwshConfig,
  desktopWindowsPwshPath,
  type WindowsAclAdaptation,
} from '../src/windows-pwsh-sandbox.ts'
const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

function consoleApi(overrides: Partial<WindowsConsoleHostApi> = {}): WindowsConsoleHostApi {
  return {
    hasConsole: vi.fn(() => true),
    attachConsole: vi.fn(() => 1),
    getConsoleWindow: vi.fn(() => ({})),
    allocConsole: vi.fn(() => 1),
    getLastError: vi.fn(() => 0),
    showWindow: vi.fn(() => 1),
    ...overrides,
  }
}

function consoleDonor(pid = 4242): { launch: WindowsConsoleDonorLauncher, release: () => void } {
  const release = vi.fn()
  return { launch: vi.fn(async () => ({ pid, release })), release }
}

function shellSpec(env?: Record<string, string>): ShellExecSpec {
  return {
    command: 'Write-Output ok',
    workdir: 'C:\\workspace',
    timeoutMs: 60_000,
    onExpiry: 'kill',
    stdoutMaxBytes: 64_000,
    sandboxPolicy: undefined,
    ...(env === undefined ? {} : { env }),
  }
}

/** A settings-runtime live config reference, editable the way the loader commits one. */
interface LiveRef<T> {
  get: () => T
  set: (next: T) => void
}

function live<T>(value: T): LiveRef<T> {
  let current = value
  return { get: () => current, set: (next) => { current = next } }
}

/** A plugin config whose fields are live references, as dsh 0.1.7 hands them to the executor. */
function pwshConfig(pwshPath: LiveRef<string | undefined>, cwd = 'C:\\workspace'): PwshConfig {
  return {
    cwd: live<string | undefined>(cwd),
    timeoutMs: live(120_000),
    maxTimeoutMs: live(600_000),
    maxOutputBytes: live(64_000),
    maxSpillBytes: live(64 * 1024 * 1024),
    graceMs: live(2_000),
    pwshPath,
  }
}

const adaptation: WindowsAclAdaptation = {
  platform: 'win32',
  electron: true,
  execPath: 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe',
  upstreamRunner: 'C:\\Program Files\\DSH Desktop\\resources\\app.asar\\runner.js',
  trampoline: 'C:\\Program Files\\DSH Desktop\\resources\\app.asar\\desktop-runner.js',
}

describe('Windows Electron PowerShell sandbox adaptation', () => {
  it('prefers stable Windows PowerShell locations over PATH-provided portable pwsh', () => {
    const programFilesPwsh = desktopWindowsPwshPath({
      ProgramFiles: 'C:\\Program Files',
      SystemRoot: 'C:\\Windows',
      PATH: 'D:\\AI-Agent\\tools\\pwsh',
    }, 'win32', path => path === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')

    expect(programFilesPwsh).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('keeps the regular Program Files PowerShell 7 install as the first Windows choice', () => {
    const programFilesPwsh = desktopWindowsPwshPath({
      ProgramFiles: 'C:\\Program Files',
      SystemRoot: 'C:\\Windows',
    }, 'win32', () => true)

    expect(programFilesPwsh).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })

  it('keeps explicit pwshPath config and non-Windows config unchanged', () => {
    const explicitPath = live<string | undefined>('D:\\tools\\pwsh\\pwsh.exe')
    const explicit = pwshConfig(explicitPath)
    const adaptedExplicit = desktopWindowsPwshConfig(explicit, {}, 'win32')
    expect(adaptedExplicit.pwshPath.get()).toBe('D:\\tools\\pwsh\\pwsh.exe')

    const nonWindows = pwshConfig(live<string | undefined>(undefined), '/workspace')
    const adaptedNonWindows = desktopWindowsPwshConfig(nonWindows, {}, 'darwin')
    expect(adaptedNonWindows.pwshPath.get()).toBeUndefined()
    // Every other budget stays the caller's own live reference, so the settings
    // runtime keeps committing into the references the executor actually reads.
    expect(adaptedNonWindows.cwd).toBe(nonWindows.cwd)
    expect(adaptedNonWindows.graceMs).toBe(nonWindows.graceMs)
  })

  it('defaults Windows sandbox config to a stable system PowerShell when available', () => {
    const declared = live<string | undefined>(undefined)
    const config = pwshConfig(declared)
    const result = desktopWindowsPwshConfig(config, {
      ProgramFiles: 'C:\\missing',
      SystemRoot: 'C:\\Windows',
      PATH: 'D:\\portable\\pwsh',
    }, 'win32', path => path === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')

    expect(result.pwshPath.get()).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(result.cwd.get()).toBe('C:\\workspace')
  })

  it('reads the declared executable through on every access instead of pinning a snapshot', () => {
    const declared = live<string | undefined>(undefined)
    const exists = vi.fn(
      (path: string) => path === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    const result = desktopWindowsPwshConfig(pwshConfig(declared), {
      ProgramFiles: 'C:\\missing',
      SystemRoot: 'C:\\Windows',
    }, 'win32', exists)

    expect(result.pwshPath.get()).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    const probes = exists.mock.calls.length

    // A volatile-only settings change commits into the caller's reference
    // without reloading the plugin, so a later edit must win over the default.
    declared.set('D:\\tools\\pwsh\\pwsh.exe')
    expect(result.pwshPath.get()).toBe('D:\\tools\\pwsh\\pwsh.exe')
    // Clearing it again falls back without re-probing the filesystem.
    declared.set('')
    expect(result.pwshPath.get()).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(exists.mock.calls.length).toBe(probes)
  })

  it('adapts only the exact Electron-hosted win32 ACL runner argv', () => {
    const env = Object.freeze({ KEEP: 'value' })
    const spec = Object.freeze(shellSpec(env))
    const argv = Object.freeze([
      adaptation.execPath,
      adaptation.upstreamRunner,
      '--workspace',
      'C:\\workspace',
      '--',
      'powershell.exe',
      '-Command',
      'Write-Output ok',
    ])

    const result = adaptWindowsAclExecution(spec, argv, adaptation)

    expect(result.spec).not.toBe(spec)
    expect(result.argv).toEqual([
      adaptation.execPath,
      adaptation.trampoline,
      adaptation.upstreamRunner,
      '--workspace',
      'C:\\workspace',
      '--',
      'powershell.exe',
      '-Command',
      'Write-Output ok',
    ])
    expect(result.spec.env).toEqual({
      KEEP: 'value',
      [RUN_AS_NODE]: '1',
    })
    expect(spec.env).toBe(env)
    expect(argv).toEqual([
      adaptation.execPath,
      adaptation.upstreamRunner,
      '--workspace',
      'C:\\workspace',
      '--',
      'powershell.exe',
      '-Command',
      'Write-Output ok',
    ])
  })

  it.each([
    ['non-Windows host', { platform: 'darwin' as const }],
    ['plain Node host', { electron: false }],
    ['different executable', { execPath: 'C:\\other\\electron.exe' }],
    ['different runner', { upstreamRunner: 'C:\\other\\runner.js' }],
  ])('leaves a %s invocation and its object identities unchanged', (_label, override) => {
    const spec = shellSpec({ KEEP: 'value' })
    const argv = [adaptation.execPath, adaptation.upstreamRunner, '--', 'powershell.exe']

    const result = adaptWindowsAclExecution(spec, argv, { ...adaptation, ...override })

    expect(result.spec).toBe(spec)
    expect(result.argv).toBe(argv)
    expect(result.spec.env).toEqual({ KEEP: 'value' })
  })

  it('leaves the danger-full-access direct PowerShell argv unchanged', () => {
    const spec = shellSpec({ KEEP: 'value' })
    const argv = [
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Write-Output ok',
    ]

    const result = adaptWindowsAclExecution(spec, argv, adaptation)

    expect(result).toEqual({ spec, argv })
    expect(result.spec).toBe(spec)
    expect(result.argv).toBe(argv)
    expect(result.spec.env).not.toHaveProperty(RUN_AS_NODE)
  })

  it('removes every inherited Node-mode key case-insensitively', () => {
    const spec = shellSpec({
      electron_run_as_node: 'legacy-value',
      KEEP: 'value',
    })
    const argv = [adaptation.execPath, adaptation.upstreamRunner, '--', 'powershell.exe']

    const result = adaptWindowsAclExecution(spec, argv, adaptation)

    expect(result.spec.env).toEqual({
      KEEP: 'value',
      [RUN_AS_NODE]: '1',
    })
    expect(spec.env).toEqual({
      electron_run_as_node: 'legacy-value',
      KEEP: 'value',
    })
  })

  it('puts Node-mode variables only on the adapted child spec', () => {
    const previousRunAsNode = process.env[RUN_AS_NODE]
    process.env[RUN_AS_NODE] = 'host-value'
    try {
      const spec = shellSpec({ KEEP: 'value' })
      const result = adaptWindowsAclExecution(
        spec,
        [adaptation.execPath, adaptation.upstreamRunner, '--', 'powershell.exe'],
        adaptation,
      )

      expect(result.spec.env?.[RUN_AS_NODE]).toBe('1')
      expect(spec.env).toEqual({ KEEP: 'value' })
      expect(process.env[RUN_AS_NODE]).toBe('host-value')
    } finally {
      if (previousRunAsNode === undefined) delete process.env[RUN_AS_NODE]
      else process.env[RUN_AS_NODE] = previousRunAsNode
    }
  })
})

describe('Windows ACL runner trampoline', () => {
  const originalArgv = process.argv
  const originalExitCode = process.exitCode
  const originalRunAsNode = process.env[RUN_AS_NODE]
  const originalLowercaseRunAsNode = process.env.electron_run_as_node

  afterEach(() => {
    process.argv = originalArgv
    process.exitCode = originalExitCode
    if (originalRunAsNode === undefined) delete process.env[RUN_AS_NODE]
    else process.env[RUN_AS_NODE] = originalRunAsNode
    if (originalLowercaseRunAsNode === undefined) delete process.env.electron_run_as_node
    else process.env.electron_run_as_node = originalLowercaseRunAsNode
    vi.restoreAllMocks()
  })

  it('leaves the console untouched when the runner fails validation', async () => {
    const ensureWindowsConsoleHost = vi.fn()
    vi.doMock('../src/windows-console-host.ts', () => ({ ensureWindowsConsoleHost }))
    process.argv = [process.execPath, 'windows-acl-runner.js', 'unexpected-runner.js']
    const stderr = vi.spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write)

    const runnerModule: string = '../src/windows-acl-runner.ts?console-after-validation'
    await import(/* @vite-ignore */ runnerModule)
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(ensureWindowsConsoleHost).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(127)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('unexpected ACL runner'))
    vi.doUnmock('../src/windows-console-host.ts')
  })

  it('fails closed without importing the upstream runner when console setup fails', async () => {
    const upstreamRunner = fileURLToPath(
      import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'),
    )
    const argv = [process.execPath, 'windows-acl-runner.js', upstreamRunner, 'shell-argument']
    vi.doMock('../src/windows-console-host.ts', () => ({
      ensureWindowsConsoleHost: async () => {
        throw new Error('could not allocate a console for the Windows ACL runner (Win32 5)')
      },
    }))
    process.argv = [...argv]
    const stderr = vi.spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write)

    const runnerModule: string = '../src/windows-acl-runner.ts?console-failure'
    await import(/* @vite-ignore */ runnerModule)
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(process.exitCode).toBe(127)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
      'windows-acl-run: desktop trampoline: could not allocate a console for the Windows ACL runner (Win32 5)',
    ))
    // argv 未被改写，说明失败发生在重建上游 argv 与导入上游 runner 之前：
    // 受限子进程绝不会在没有 console 的情况下被启动。
    expect(process.argv).toEqual(argv)
    vi.doUnmock('../src/windows-console-host.ts')
  })

  it('removes Node mode from the target environment before rejecting an unexpected runner', async () => {
    process.argv = [process.execPath, 'windows-acl-runner.js', 'unexpected-runner.js']
    process.env[RUN_AS_NODE] = '1'
    process.env.electron_run_as_node = 'legacy-value'
    const stderr = vi.spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write)

    const runnerModule: string = '../src/windows-acl-runner.ts?unexpected-runner-test'
    await import(/* @vite-ignore */ runnerModule)
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(process.env[RUN_AS_NODE]).toBeUndefined()
    expect(process.env.electron_run_as_node).toBeUndefined()
    expect(process.exitCode).toBe(127)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
      'windows-acl-run: desktop trampoline: desktop trampoline received an unexpected ACL runner',
    ))
  })

})

describe('Windows ACL runner console host', () => {
  it('does not load native APIs outside Windows', async () => {
    const loadApi = vi.fn(() => consoleApi())
    const donor = consoleDonor()

    await ensureWindowsConsoleHost('darwin', loadApi, donor.launch)

    expect(loadApi).not.toHaveBeenCalled()
    expect(donor.launch).not.toHaveBeenCalled()
  })

  it('keeps an existing console unchanged, including one without a window', async () => {
    const api = consoleApi({
      getConsoleWindow: vi.fn(() => null),
      allocWindowlessConsole: vi.fn(() => true),
    })
    const donor = consoleDonor()

    await ensureWindowsConsoleHost('win32', () => api, donor.launch)

    expect(api.allocWindowlessConsole).not.toHaveBeenCalled()
    expect(donor.launch).not.toHaveBeenCalled()
    expect(api.allocConsole).not.toHaveBeenCalled()
    expect(api.showWindow).not.toHaveBeenCalled()
  })

  it('allocates a windowless console where Windows supports it', async () => {
    const api = consoleApi({
      hasConsole: vi.fn(() => false),
      allocWindowlessConsole: vi.fn(() => true),
    })
    const donor = consoleDonor()

    await ensureWindowsConsoleHost('win32', () => api, donor.launch)

    expect(api.allocWindowlessConsole).toHaveBeenCalledOnce()
    expect(donor.launch).not.toHaveBeenCalled()
    expect(api.allocConsole).not.toHaveBeenCalled()
    expect(api.showWindow).not.toHaveBeenCalled()
  })

  it.each([
    ['is unavailable', undefined],
    ['fails', () => false],
  ])('attaches to a windowless donor console when windowless allocation %s', async (_, allocWindowlessConsole) => {
    const api = consoleApi({
      hasConsole: vi.fn(() => false),
      allocWindowlessConsole,
    })
    const donor = consoleDonor(4242)

    await ensureWindowsConsoleHost('win32', () => api, donor.launch)

    expect(api.attachConsole).toHaveBeenCalledWith(4242)
    expect(donor.release).toHaveBeenCalledOnce()
    expect(api.allocConsole).not.toHaveBeenCalled()
    expect(api.showWindow).not.toHaveBeenCalled()
  })

  it('falls back to a hidden console when the donor cannot start', async () => {
    const allocatedWindow = {}
    const calls: string[] = []
    const api = consoleApi({
      hasConsole: vi.fn(() => false),
      allocConsole: vi.fn(() => {
        calls.push('allocate')
        return 1
      }),
      getConsoleWindow: vi.fn(() => {
        calls.push('get-console')
        return allocatedWindow
      }),
      showWindow: vi.fn((window, command) => {
        expect(window).toBe(allocatedWindow)
        calls.push(`hide-${command}`)
        return 1
      }),
    })
    const launch = vi.fn(async () => {
      throw new Error('console donor did not start')
    })

    await ensureWindowsConsoleHost('win32', () => api, launch)

    expect(api.attachConsole).not.toHaveBeenCalled()
    expect(calls).toEqual(['allocate', 'get-console', 'hide-0'])
  })

  it('releases the donor and falls back to a hidden console when attaching fails', async () => {
    const api = consoleApi({
      hasConsole: vi.fn(() => false),
      attachConsole: vi.fn(() => 0),
    })
    const donor = consoleDonor()

    await ensureWindowsConsoleHost('win32', () => api, donor.launch)

    expect(donor.release).toHaveBeenCalledOnce()
    expect(api.allocConsole).toHaveBeenCalledOnce()
    expect(api.showWindow).toHaveBeenCalledWith(expect.anything(), 0)
  })

  it('fails closed with the native error when every console strategy fails', async () => {
    const api = consoleApi({
      hasConsole: vi.fn(() => false),
      allocWindowlessConsole: vi.fn(() => false),
      attachConsole: vi.fn(() => 0),
      allocConsole: vi.fn(() => 0),
      getLastError: vi.fn(() => 5),
    })
    const donor = consoleDonor()

    await expect(ensureWindowsConsoleHost('win32', () => api, donor.launch)).rejects.toThrow(
      'could not allocate a console for the Windows ACL runner (Win32 5)',
    )
    expect(api.showWindow).not.toHaveBeenCalled()
  })

  it('accepts a fallback allocation without a visible console window', async () => {
    const api = consoleApi({
      hasConsole: vi.fn(() => false),
      attachConsole: vi.fn(() => 0),
      getConsoleWindow: vi.fn(() => null),
    })
    const donor = consoleDonor()

    await ensureWindowsConsoleHost('win32', () => api, donor.launch)

    expect(api.allocConsole).toHaveBeenCalledOnce()
    expect(api.showWindow).not.toHaveBeenCalled()
  })
})
