import { describe, expect, it, vi } from 'vitest'
import {
  acceptWslHostShutdown,
  parseWslHostArguments,
  reserveControlOutput,
} from '../src/wsl-host.ts'

describe('WSL Host bootstrap arguments', () => {
  it('preserves the inherited stdout descriptor for control frames', () => {
    const stdout = { fd: 17, write: vi.fn() as unknown as typeof process.stdout.write }
    const stderr = { write: vi.fn() as unknown as typeof process.stderr.write }
    const output = { write: vi.fn() } as unknown as NodeJS.WritableStream
    const createOutput = vi.fn(() => output)
    expect(reserveControlOutput(stdout, stderr, createOutput)).toBe(output)
    expect(createOutput).toHaveBeenCalledWith(17)
    stdout.write('third-party-noise')
    expect(stderr.write).toHaveBeenCalledWith('third-party-noise')
  })

  it('accepts exact Linux-owned state and DSH roots', () => {
    expect(parseWslHostArguments([
      '--state-dir', '/home/alice/.local/state/dsh-desktop',
      '--home-dir', '/home/alice/.local/share/dsh-desktop/home',
    ])).toEqual({
      stateDir: '/home/alice/.local/state/dsh-desktop',
      homeDir: '/home/alice/.local/share/dsh-desktop/home',
    })
  })

  it('rejects missing, relative, repeated, and unknown arguments', () => {
    expect(() => parseWslHostArguments([])).toThrow('--state-dir and --home-dir are required')
    expect(() => parseWslHostArguments(['--state-dir', '../state', '--home-dir', '/home/a']))
      .toThrow('absolute Linux path')
    expect(() => parseWslHostArguments([
      '--state-dir', '/state', '--state-dir', '/other', '--home-dir', '/home/a',
    ])).toThrow('unknown or repeated')
    expect(() => parseWslHostArguments(['--wat', '/state'])).toThrow('unknown or repeated')
    expect(() => parseWslHostArguments([
      '--state-dir', '/state', '--home-dir', '/home/a', '--profile', 'desktop',
    ])).toThrow('unknown or repeated')
  })

  it('keeps shutdown pending until generation effects release on the live channel', async () => {
    let finishRelease!: () => void
    const release = vi.fn(() => new Promise<void>(resolve => { finishRelease = resolve }))
    const setExitCode = vi.fn()
    let settled = false
    const operation = acceptWslHostShutdown({ code: 7 }, release, setExitCode)
      .then(result => { settled = true; return result })

    await Promise.resolve()
    expect(release).toHaveBeenCalledOnce()
    expect(setExitCode).toHaveBeenCalledWith(7)
    expect(settled).toBe(false)
    finishRelease()
    await expect(operation).resolves.toBeNull()
    await expect(acceptWslHostShutdown({ code: 1.5 }, release, setExitCode))
      .rejects.toThrow('invalid shutdown code')
  })
})
