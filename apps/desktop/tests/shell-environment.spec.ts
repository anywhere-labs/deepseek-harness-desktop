import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureLoginShellEnvironment, parseShellEnvironment, resolveDesktopEnvironment } from '../src/shell-environment.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fakeShell(body: string): { home: string; shell: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-shell-environment-'))
  temporaryDirectories.push(home)
  const shell = join(home, 'test-shell')
  writeFileSync(shell, `#!/bin/sh\n${body}\n`)
  chmodSync(shell, 0o700)
  return { home, shell }
}

describe('desktop shell environment parser', () => {
  it('reads NUL-delimited values between private markers', () => {
    const payload = Buffer.from('noise\0start\0PATH=/opt/homebrew/bin:/usr/bin\0MULTILINE=first\nsecond\0EMPTY=\0end\0trailing')

    expect(parseShellEnvironment(payload, 'start', 'end')).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      MULTILINE: 'first\nsecond',
      EMPTY: '',
    })
  })

  it('rejects missing framing and malformed records', () => {
    expect(() => parseShellEnvironment(Buffer.from('PATH=/usr/bin\0'), 'start', 'end')).toThrow('start marker')
    expect(() => parseShellEnvironment(Buffer.from('start\0PATH=/usr/bin\0'), 'start', 'end')).toThrow('end marker')
    expect(() => parseShellEnvironment(Buffer.from('start\0invalid\0end\0'), 'start', 'end')).toThrow('invalid record')
  })
})

describe.skipIf(process.platform === 'win32')('desktop login shell capture', () => {
  it('reads only the private descriptor framed by the generated command', async () => {
    const { home, shell } = fakeShell('printf ordinary-output; exec /bin/sh -c "$2"')

    await expect(captureLoginShellEnvironment(shell, home, { CAPTURED_VALUE: 'available' }, 10_000))
      .resolves.toMatchObject({ CAPTURED_VALUE: 'available' })
  }, 15_000)

  it('enforces its deadline when a shell and background child retain the capture descriptor', async () => {
    const { home, shell } = fakeShell('sleep 30 >&3 &\nsleep 30')
    const startedAt = Date.now()

    await expect(captureLoginShellEnvironment(shell, home, {}, 25)).rejects.toThrow('timed out after 25ms')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('rejects an oversized capture and terminates the shell tree', async () => {
    const { home, shell } = fakeShell('head -c 1048577 /dev/zero >&3\nsleep 30')

    await expect(captureLoginShellEnvironment(shell, home, {}, 10_000)).rejects.toThrow('exceeded 1048576 bytes')
  }, 15_000)
})

describe('desktop shell environment resolution', () => {
  it.each([
    { isPackaged: false, platform: 'darwin' as const, reason: 'not-packaged' },
    { isPackaged: true, platform: 'win32' as const, reason: 'windows' },
    { isPackaged: true, platform: 'aix' as const, reason: 'unsupported-platform' },
  ])('keeps the inherited environment for $reason', async ({ isPackaged, platform, reason }) => {
    const capture = vi.fn()

    await expect(resolveDesktopEnvironment({
      environment: { PATH: '/inherited' },
      home: '/Users/tester',
      isPackaged,
      platform,
      shell: '/bin/zsh',
      capture,
    })).resolves.toEqual({
      environment: { PATH: '/inherited' },
      source: 'process',
      fallbackReason: reason,
    })
    expect(capture).not.toHaveBeenCalled()
  })

  it('uses the login PATH while preserving explicit process values', async () => {
    const capture = vi.fn(async () => ({
      PATH: '/opt/homebrew/bin:/usr/bin',
      DEEPSEEK_API_KEY: 'shell-key',
      SHELL_ONLY: 'available',
      PWD: '/stale',
      SHLVL: '2',
    }))

    await expect(resolveDesktopEnvironment({
      environment: {
        PATH: '/usr/bin:/bin',
        DEEPSEEK_API_KEY: 'explicit-key',
        EXPLICIT_ONLY: 'available',
      },
      home: '/Users/tester',
      isPackaged: true,
      platform: 'darwin',
      shell: '/bin/zsh',
      timeoutMs: 75,
      capture,
    })).resolves.toEqual({
      environment: {
        PATH: '/opt/homebrew/bin:/usr/bin',
        HOME: '/Users/tester',
        DEEPSEEK_API_KEY: 'explicit-key',
        SHELL_ONLY: 'available',
        EXPLICIT_ONLY: 'available',
      },
      source: 'login-shell',
    })
    expect(capture).toHaveBeenCalledWith('/bin/zsh', '/Users/tester', expect.any(Object), 75)
  })

  it('falls back without exposing a capture failure', async () => {
    const capture = vi.fn(async () => { throw new Error('secret shell output') })

    await expect(resolveDesktopEnvironment({
      environment: { PATH: '/usr/bin' },
      home: '/Users/tester',
      isPackaged: true,
      platform: 'linux',
      shell: '/bin/bash',
      capture,
    })).resolves.toEqual({
      environment: { PATH: '/usr/bin' },
      source: 'process',
      fallbackReason: 'capture-failed',
    })
  })
})
