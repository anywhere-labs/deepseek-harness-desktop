import { describe, expect, it, vi } from 'vitest'
import {
  decodeWslOutput,
  discoverWslHostTargets,
  parseWslDistributionList,
  probeWslHostPrerequisites,
  type DesktopCommandCapture,
  type DesktopCommandResult,
  windowsPathToWsl,
  wslExecArguments,
} from '../src/wsl.ts'

function result(stdout: string, exitCode = 0, encoding: BufferEncoding = 'utf8'): DesktopCommandResult {
  return { exitCode, signal: null, stdout: Buffer.from(stdout, encoding), stderr: Buffer.alloc(0) }
}

describe('WSL Host discovery', () => {
  it('decodes UTF-16 output and parses only WSL2 distributions', async () => {
    const listing = [
      '  NAME                   STATE           VERSION',
      '* Ubuntu-24.04           Running         2',
      '  Debian                 Stopped         2',
      '  Legacy                 Stopped         1',
      '',
    ].join('\r\n')
    const bytes = Buffer.from(`\uFEFF${listing}`, 'utf16le')
    expect(decodeWslOutput(bytes)).toContain('Ubuntu-24.04')
    expect(parseWslDistributionList(decodeWslOutput(bytes))).toEqual([
      { name: 'Debian', state: 'Stopped', version: 2, default: false },
      { name: 'Legacy', state: 'Stopped', version: 1, default: false },
      { name: 'Ubuntu-24.04', state: 'Running', version: 2, default: true },
    ])
    const capture = vi.fn<DesktopCommandCapture>(async () => ({
      exitCode: 0,
      signal: null,
      stdout: bytes,
      stderr: Buffer.alloc(0),
    }))
    await expect(discoverWslHostTargets('win32', capture)).resolves.toEqual({
      current: { mode: 'local' },
      distributions: ['Debian', 'Ubuntu-24.04'],
      wslSupported: true,
    })
  })

  it('is headless-safe off Windows and sanitizes unavailable WSL', async () => {
    const capture = vi.fn<DesktopCommandCapture>()
    await expect(discoverWslHostTargets('linux', capture)).resolves.toEqual({
      current: { mode: 'local' },
      distributions: [],
      wslSupported: false,
    })
    expect(capture).not.toHaveBeenCalled()

    const failed = vi.fn<DesktopCommandCapture>(async () => { throw new Error('localized secret path') })
    const view = await discoverWslHostTargets('win32', failed)
    expect(view.problem).toBe('WSL is not available on this Windows installation.')
    expect(JSON.stringify(view)).not.toContain('secret')
  })

  it('probes Node, npm, Bash, home, and kernel without interpolating the distribution into a shell', async () => {
    const capture = vi.fn<DesktopCommandCapture>(async (_executable, args) => {
      const command = args.at(-1)
      if (command === '"$HOME"') throw new Error('unexpected split')
      if (args.includes('uname')) return result('Linux\n')
      if (args.includes('node')) return result('v22.19.0\n')
      if (args.includes('npm')) return result('11.6.0\n')
      if (args.includes('bash')) return result('GNU bash, version 5.2.21\n')
      return result('/home/alice\n')
    })

    await expect(probeWslHostPrerequisites('Ubuntu-24.04', capture)).resolves.toEqual({
      distribution: 'Ubuntu-24.04',
      homeDir: '/home/alice',
      nodeVersion: 'v22.19.0',
      npmVersion: '11.6.0',
      bashVersion: 'GNU bash, version 5.2.21',
    })
    expect(capture.mock.calls.every(call => call[1][1] === 'Ubuntu-24.04')).toBe(true)
  })

  it('rejects an old Node release and invalid command vectors', async () => {
    const capture = vi.fn<DesktopCommandCapture>(async (_executable, args) => {
      if (args.includes('uname')) return result('Linux\n')
      if (args.includes('node')) return result('v20.19.0\n')
      if (args.includes('npm')) return result('10.0.0\n')
      return result('/home/alice\n')
    })
    await expect(probeWslHostPrerequisites('Ubuntu', capture)).rejects.toThrow('requires Node.js')
    expect(() => wslExecArguments('Ubuntu', [])).toThrow('invalid WSL command arguments')
    expect(wslExecArguments('Ubuntu', ['node', 'host.js'])).toEqual([
      '--distribution', 'Ubuntu', '--exec', 'node', 'host.js',
    ])
  })

  it('translates an absolute Windows bundle path with wslpath and no shell', async () => {
    const capture = vi.fn<DesktopCommandCapture>(async () => result('/mnt/d/DSH Desktop/wsl-runtime\n'))

    await expect(windowsPathToWsl(
      'Ubuntu-24.04',
      'D:\\DSH Desktop\\resources\\wsl-runtime',
      capture,
    )).resolves.toBe('/mnt/d/DSH Desktop/wsl-runtime')
    expect(capture).toHaveBeenCalledWith('wsl.exe', [
      '--distribution', 'Ubuntu-24.04', '--exec',
      'wslpath', '-a', '-u', '--', 'D:\\DSH Desktop\\resources\\wsl-runtime',
    ])
    await expect(windowsPathToWsl('Ubuntu', '/mnt/c/runtime', capture))
      .rejects.toThrow('absolute Windows path')
  })
})
