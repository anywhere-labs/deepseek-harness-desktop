import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adaptWindowsAclExecution,
  desktopWindowsPwshConfig,
  desktopWindowsPwshPath,
  probeVendoredNodeExecutable,
  resolveVendoredNodeExecutable,
  type WindowsAclAdaptation,
} from '../src/windows-pwsh-sandbox.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

function shellSpec(env?: Record<string, string>): ShellExecSpec {
  return {
    command: 'Write-Output ok',
    workdir: 'C:\\workspace',
    timeoutMs: 60_000,
    stdoutMaxBytes: 64_000,
    sandboxPolicy: undefined,
    ...(env === undefined ? {} : { env }),
  }
}

const adaptation: WindowsAclAdaptation = {
  platform: 'win32',
  electron: true,
  execPath: 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe',
  upstreamRunner: 'C:\\Program Files\\DSH Desktop\\resources\\app.asar\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js',
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
    const explicit = { cwd: 'C:\\workspace', pwshPath: 'D:\\tools\\pwsh\\pwsh.exe' }
    expect(desktopWindowsPwshConfig(explicit, {}, 'win32')).toBe(explicit)

    const nonWindows = { cwd: '/workspace' }
    expect(desktopWindowsPwshConfig(nonWindows, {}, 'darwin')).toBe(nonWindows)
  })

  it('defaults Windows sandbox config to a stable system PowerShell when available', () => {
    const result = desktopWindowsPwshConfig({ cwd: 'C:\\workspace' }, {
      ProgramFiles: 'C:\\missing',
      SystemRoot: 'C:\\Windows',
      PATH: 'D:\\portable\\pwsh',
    }, 'win32', path => path === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')

    expect(result).toEqual({
      cwd: 'C:\\workspace',
      pwshPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    })
  })

  it('runs the ACL runner in the vendored Node with the unpacked physical path', () => {
    const vendoredNode = 'C:\\Program Files\\DSH Desktop\\resources\\node.exe'
    const spec = shellSpec({ KEEP: 'value' })
    const argv = [
      adaptation.execPath,
      adaptation.upstreamRunner,
      '--workspace',
      'C:\\workspace',
      '--',
      'powershell.exe',
    ]

    const result = adaptWindowsAclExecution(spec, argv, {
      ...adaptation,
      nodeExecutable: vendoredNode,
      probe: () => true,
    })

    expect(result.argv).toEqual([
      vendoredNode,
      adaptation.upstreamRunner.replace('app.asar', 'app.asar.unpacked'),
      '--workspace',
      'C:\\workspace',
      '--',
      'powershell.exe',
    ])
    expect(result.spec.env).toEqual({ KEEP: 'value' })
    expect(result.spec.env).not.toHaveProperty(RUN_AS_NODE)
  })

  it('throws a diagnostic error when the vendored Node exists but cannot launch', () => {
    const vendoredNode = 'C:\\Program Files\\DSH Desktop\\resources\\node.exe'
    const spec = shellSpec({ KEEP: 'value' })
    const argv = [adaptation.execPath, adaptation.upstreamRunner, '--', 'powershell.exe']

    expect(() => adaptWindowsAclExecution(spec, argv, {
      ...adaptation,
      nodeExecutable: vendoredNode,
      probe: () => false,
    })).toThrow(/does not launch/)
  })

  it('falls back to the trampoline without a vendored Node and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spec = shellSpec({ KEEP: 'value' })
    const argv = [
      adaptation.execPath,
      adaptation.upstreamRunner,
      '--workspace',
      'C:\\workspace',
      '--',
      'powershell.exe',
    ]

    const first = adaptWindowsAclExecution(spec, argv, adaptation)
    const second = adaptWindowsAclExecution(spec, argv, adaptation)

    expect(first.argv).toEqual([
      adaptation.execPath,
      adaptation.trampoline,
      adaptation.upstreamRunner,
      '--workspace',
      'C:\\workspace',
      '--',
      'powershell.exe',
    ])
    expect(first.spec.env).toEqual({ KEEP: 'value', [RUN_AS_NODE]: '1' })
    expect(second.argv).toEqual(first.argv)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('resolves the vendored Node beside the packaged Electron resources', () => {
    const execPath = 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe'
    const exists = (path: string) => path === 'C:\\Program Files\\DSH Desktop\\resources\\node.exe'
    expect(resolveVendoredNodeExecutable(execPath, exists)).toBe(
      'C:\\Program Files\\DSH Desktop\\resources\\node.exe',
    )
  })

  it('returns undefined vendored Node when the resource is absent', () => {
    const execPath = 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe'
    expect(resolveVendoredNodeExecutable(execPath, () => false)).toBeUndefined()
  })

  it('probes the vendored Node by running it with -v and caches the success', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: 'v22.23.2\n' }))
    expect(probeVendoredNodeExecutable('C:\\node.exe', spawn as never)).toBe(true)
    expect(probeVendoredNodeExecutable('C:\\node.exe', spawn as never)).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith('C:\\node.exe', ['-v'], expect.objectContaining({ timeout: 5_000 }))
  })

  it('probes with a failing node and does not cache the failure', () => {
    const spawn = vi.fn(() => ({ status: 1, stdout: '' }))
    expect(probeVendoredNodeExecutable('C:\\bad-node.exe', spawn as never)).toBe(false)
    expect(probeVendoredNodeExecutable('C:\\bad-node.exe', spawn as never)).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(2)
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
