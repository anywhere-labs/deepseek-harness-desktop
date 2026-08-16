import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureLoginShellEnvironment,
  parseShellEnvironment,
  resolveDesktopShellPath,
} from '../src/shell-environment.ts'

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

describe('desktop shell PATH resolution', () => {
  it.each([
    { isPackaged: false, platform: 'darwin' as const, reason: 'not-packaged' },
    { isPackaged: true, platform: 'win32' as const, reason: 'windows' },
    { isPackaged: true, platform: 'aix' as const, reason: 'unsupported-platform' },
  ])('keeps the inherited PATH for $reason', async ({ isPackaged, platform, reason }) => {
    const capture = vi.fn()

    await expect(resolveDesktopShellPath({
      environment: { PATH: '/inherited' },
      home: '/Users/tester',
      isPackaged,
      platform,
      shell: '/bin/zsh',
      capture,
    })).resolves.toEqual({
      path: '/inherited',
      source: 'process',
      fallbackReason: reason,
    })
    expect(capture).not.toHaveBeenCalled()
  })

  it('uses the captured login PATH on packaged macOS', async () => {
    const capture = vi.fn(async () => ({
      PATH: '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin',
      DEEPSEEK_API_KEY: 'shell-secret',
      SHELL_ONLY: 'do-not-import',
    }))

    await expect(resolveDesktopShellPath({
      environment: { PATH: '/usr/bin:/bin', DEEPSEEK_API_KEY: 'explicit-key' },
      home: '/Users/tester',
      isPackaged: true,
      platform: 'darwin',
      shell: '/bin/zsh',
      capture,
    })).resolves.toEqual({
      path: '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin',
      source: 'login-shell',
    })
    expect(capture).toHaveBeenCalledWith('/bin/zsh', '/Users/tester', expect.any(Object), 2_000)
  })

  it('uses the captured login PATH on packaged Linux', async () => {
    const capture = vi.fn(async () => ({
      PATH: '/home/tester/.local/bin:/usr/local/bin:/usr/bin:/bin',
      OTHER: 'value',
    }))

    await expect(resolveDesktopShellPath({
      environment: { PATH: '/usr/bin:/bin' },
      home: '/home/tester',
      isPackaged: true,
      platform: 'linux',
      shell: '/bin/bash',
      timeoutMs: 75,
      capture,
    })).resolves.toEqual({
      path: '/home/tester/.local/bin:/usr/local/bin:/usr/bin:/bin',
      source: 'login-shell',
    })
    expect(capture).toHaveBeenCalledWith('/bin/bash', '/home/tester', expect.any(Object), 75)
  })

  it('falls back without exposing a capture failure', async () => {
    const capture = vi.fn(async () => { throw new Error('secret shell output') })

    const resolution = await resolveDesktopShellPath({
      environment: { PATH: '/usr/bin' },
      home: '/Users/tester',
      isPackaged: true,
      platform: 'linux',
      shell: '/bin/bash',
      capture,
    })

    expect(resolution).toEqual({
      path: '/usr/bin',
      source: 'process',
      fallbackReason: 'capture-failed',
    })
    expect(JSON.stringify(resolution)).not.toContain('secret shell output')
  })

  it.each([
    { captured: { OTHER: 'value' }, description: 'missing PATH' },
    { captured: { PATH: '' }, description: 'empty PATH' },
  ])('retains the inherited PATH when capture reports $description', async ({ captured }) => {
    const capture = vi.fn(async () => captured)

    await expect(resolveDesktopShellPath({
      environment: { PATH: '/usr/bin:/bin' },
      home: '/Users/tester',
      isPackaged: true,
      platform: 'darwin',
      shell: '/bin/zsh',
      capture,
    })).resolves.toEqual({
      path: '/usr/bin:/bin',
      source: 'process',
      fallbackReason: 'missing-path',
    })
  })

  it('imports only PATH from the login shell, never other shell variables', async () => {
    const capture = vi.fn(async () => ({
      PATH: '/opt/homebrew/bin:/usr/bin',
      DEEPSEEK_API_KEY: 'shell-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      SHELL_ONLY: 'do-not-import',
    }))
    const environment: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      DEEPSEEK_API_KEY: 'explicit-key',
      EXPLICIT_ONLY: 'available',
    }

    const resolution = await resolveDesktopShellPath({
      environment,
      home: '/Users/tester',
      isPackaged: true,
      platform: 'darwin',
      shell: '/bin/zsh',
      capture,
    })

    expect(resolution).toEqual({
      path: '/opt/homebrew/bin:/usr/bin',
      source: 'login-shell',
    })
    const applied = { ...environment }
    if (resolution.source === 'login-shell' && resolution.path !== undefined && resolution.path !== '') {
      applied.PATH = resolution.path
    }
    expect(applied).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      DEEPSEEK_API_KEY: 'explicit-key',
      EXPLICIT_ONLY: 'available',
    })
    expect(JSON.stringify(applied)).not.toContain('shell-secret')
    expect(JSON.stringify(applied)).not.toContain('aws-secret')
    expect(JSON.stringify(applied)).not.toContain('do-not-import')
  })
})
