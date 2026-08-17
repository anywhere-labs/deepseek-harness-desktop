import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureLoginShellEnvironment,
  parseShellEnvironment,
  resolveDesktopShellEnvironment,
  selectDesktopShellEnvironment,
} from '../src/shell-environment.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fakeShell(name: 'bash' | 'fish' | 'zsh', body: string): { home: string; shell: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-shell-environment-'))
  temporaryDirectories.push(home)
  const shell = join(home, name)
  writeFileSync(shell, `#!/bin/sh\n${body}\n`)
  chmodSync(shell, 0o700)
  return { home, shell }
}

function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue searching the inherited PATH.
    }
  }
  return undefined
}

describe('desktop shell environment parser', () => {
  it('reads NUL-delimited values between private markers', () => {
    const payload = Buffer.from('noise\0start\0PATH=/opt/homebrew/bin:/usr/bin\0MULTILINE=first\nsecond\0EQUALS=a=b\0EMPTY=\0end\0trailing')

    expect(parseShellEnvironment(payload, 'start', 'end')).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      MULTILINE: 'first\nsecond',
      EQUALS: 'a=b',
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
  it.each([
    { name: 'zsh' as const, commandPosition: '$2', expectedArgs: '-ilc' },
    { name: 'bash' as const, commandPosition: '$2', expectedArgs: '-ilc' },
    { name: 'fish' as const, commandPosition: '$4', expectedArgs: '--login --interactive --command' },
  ])('uses the supported $name interactive login invocation', async ({ name, commandPosition, expectedArgs }) => {
    const { home, shell } = fakeShell(name, `printf '%s' "$*" > "$ARGUMENT_LOG"; exec /bin/sh -c "${commandPosition}"`)
    const argumentLog = join(home, 'arguments')

    await expect(captureLoginShellEnvironment(shell, home, {
      ARGUMENT_LOG: argumentLog,
      CAPTURED_VALUE: 'available',
    }, 10_000)).resolves.toMatchObject({ CAPTURED_VALUE: 'available' })
    expect(readFileSync(argumentLog, 'utf8')).toContain(expectedArgs)
  }, 15_000)

  it('ignores startup-file output outside the randomly framed environment', async () => {
    const { home, shell } = fakeShell('zsh', 'printf ordinary-output; exec /bin/sh -c "$2"')

    await expect(captureLoginShellEnvironment(shell, home, { CAPTURED_VALUE: 'available' }, 10_000))
      .resolves.toMatchObject({ CAPTURED_VALUE: 'available' })
  }, 15_000)

  it('enforces its deadline when a shell and background child retain the capture stream', async () => {
    const { home, shell } = fakeShell('bash', 'sleep 30 &\nsleep 30')
    const startedAt = Date.now()

    await expect(captureLoginShellEnvironment(shell, home, {}, 25)).rejects.toThrow('timed out after 25ms')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('rejects an oversized capture and terminates the shell tree', async () => {
    const { home, shell } = fakeShell('zsh', 'head -c 1048577 /dev/zero\nsleep 30')

    await expect(captureLoginShellEnvironment(shell, home, {}, 10_000)).rejects.toThrow('exceeded 1048576 bytes')
  }, 15_000)

  for (const shellCase of [
    {
      name: 'zsh',
      files: {
        '.zprofile': 'export PATH="/dsh-zsh-login/bin:$PATH"\n',
        '.zshrc': 'export JAVA_HOME="/dsh-zsh-java"\n',
      },
      pathPrefix: '/dsh-zsh-login/bin:',
      javaHome: '/dsh-zsh-java',
    },
    {
      name: 'bash',
      files: {
        '.bash_profile': 'export PATH="/dsh-bash-login/bin:$PATH"\n. "$HOME/.bashrc"\n',
        '.bashrc': 'export JAVA_HOME="/dsh-bash-java"\n',
      },
      pathPrefix: '/dsh-bash-login/bin:',
      javaHome: '/dsh-bash-java',
    },
    {
      name: 'fish',
      files: {
        '.config/fish/config.fish': 'set -gx PATH /dsh-fish-login/bin $PATH\nset -gx JAVA_HOME /dsh-fish-java\n',
      },
      pathPrefix: '/dsh-fish-login/bin:',
      javaHome: '/dsh-fish-java',
    },
  ] as const) {
    const executable = findExecutable(shellCase.name)
    it.runIf(executable !== undefined)(`loads real ${shellCase.name} startup files headlessly`, async () => {
      const home = mkdtempSync(join(tmpdir(), `dsh-real-${shellCase.name}-`))
      temporaryDirectories.push(home)
      for (const [relativePath, contents] of Object.entries(shellCase.files)) {
        const parent = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : ''
        if (parent !== '') mkdirSync(join(home, parent), { recursive: true })
        writeFileSync(join(home, relativePath), contents)
      }

      const environment = await captureLoginShellEnvironment(executable as string, home, {
        HOME: home,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        SHELL: executable as string,
      }, 10_000)

      expect(environment.PATH?.startsWith(shellCase.pathPrefix)).toBe(true)
      expect(environment.JAVA_HOME).toBe(shellCase.javaHome)
    }, 15_000)
  }
})

describe('desktop shell environment selection', () => {
  it('selects PATH, locale and common toolchain exports', () => {
    expect(selectDesktopShellEnvironment({
      PATH: '/opt/homebrew/bin:/usr/bin',
      LANG: 'zh_CN.UTF-8',
      LC_CTYPE: 'UTF-8',
      JAVA_HOME: '/Library/Java/Home',
      NVM_DIR: '/Users/tester/.nvm',
      PNPM_HOME: '/Users/tester/Library/pnpm',
      SDKROOT: '/Applications/Xcode.app/SDK',
    }, { PATH: '/usr/bin' })).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      LANG: 'zh_CN.UTF-8',
      LC_CTYPE: 'UTF-8',
      JAVA_HOME: '/Library/Java/Home',
      NVM_DIR: '/Users/tester/.nvm',
      PNPM_HOME: '/Users/tester/Library/pnpm',
      SDKROOT: '/Applications/Xcode.app/SDK',
    })
  })

  it('reuses the upstream scrub names and rejects unselected or process-affecting exports', () => {
    const selected = selectDesktopShellEnvironment({
      PATH: '/opt/homebrew/bin:/usr/bin',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      GH_TOKEN: 'github-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      dsh_home: '/wrong-home',
      HTTP_PROXY: 'http://user:password@example.test',
      NODE_OPTIONS: '--require=/tmp/inject.cjs',
      BASH_ENV: '/tmp/inject.sh',
      DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
      XDG_CONFIG_HOME: '/tmp/alternate-config',
      SHELL_ONLY: 'not-selected',
    }, { PATH: '/usr/bin' })

    expect(selected).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin' })
    expect(JSON.stringify(selected)).not.toContain('secret')
    expect(JSON.stringify(selected)).not.toContain('password')
    expect(JSON.stringify(selected)).not.toContain('/tmp/inject')
  })

  it('keeps explicit launch variables while allowing PATH to use the login value', () => {
    expect(selectDesktopShellEnvironment({
      PATH: '/login/bin:/usr/bin',
      JAVA_HOME: '/login/java',
      LANG: 'zh_CN.UTF-8',
    }, {
      PATH: '/launch/bin:/usr/bin',
      JAVA_HOME: '/explicit/java',
    })).toEqual({
      PATH: '/login/bin:/usr/bin',
      LANG: 'zh_CN.UTF-8',
    })
  })

  it('lets the upstream scrub preserve recovered tools while removing ambient credentials and DSH facts', () => {
    const saved = {
      PATH: process.env.PATH,
      JAVA_HOME: process.env.JAVA_HOME,
      DESKTOP_AGENT_API_KEY: process.env.DESKTOP_AGENT_API_KEY,
      dsh_home: process.env.dsh_home,
    }
    const updates = selectDesktopShellEnvironment({
      PATH: '/login/bin:/usr/bin',
      JAVA_HOME: '/login/java',
      RC_API_KEY: 'must-not-be-selected',
      dsh_home: '/must-not-be-selected',
    }, { PATH: process.env.PATH })

    try {
      Object.assign(process.env, updates)
      process.env.DESKTOP_AGENT_API_KEY = 'must-not-reach-agent'
      process.env.dsh_home = '/must-not-reach-agent'
      const childEnvironment = scrubbedParentEnv()

      expect(childEnvironment.PATH).toBe('/login/bin:/usr/bin')
      expect(childEnvironment.JAVA_HOME).toBe('/login/java')
      expect(childEnvironment).not.toHaveProperty('DESKTOP_AGENT_API_KEY')
      expect(childEnvironment).not.toHaveProperty('dsh_home')
      expect(JSON.stringify(childEnvironment)).not.toContain('must-not-be-selected')
      expect(JSON.stringify(childEnvironment)).not.toContain('must-not-reach-agent')
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})

describe('desktop shell environment resolution', () => {
  it.each([
    { isPackaged: false, platform: 'darwin' as const, reason: 'not-packaged' },
    { isPackaged: true, platform: 'win32' as const, reason: 'windows' },
    { isPackaged: true, platform: 'aix' as const, reason: 'unsupported-platform' },
  ])('keeps the inherited environment for $reason', async ({ isPackaged, platform, reason }) => {
    const capture = vi.fn()

    await expect(resolveDesktopShellEnvironment({
      environment: { PATH: '/inherited' },
      home: '/Users/tester',
      isPackaged,
      platform,
      shell: '/bin/zsh',
      capture,
    })).resolves.toEqual({
      updates: {},
      source: 'process',
      fallbackReason: reason,
    })
    expect(capture).not.toHaveBeenCalled()
  })

  it('uses selected captured exports on packaged macOS', async () => {
    const capture = vi.fn(async () => ({
      PATH: '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin',
      LANG: 'zh_CN.UTF-8',
      NVM_DIR: '/Users/tester/.nvm',
      DEEPSEEK_API_KEY: 'shell-secret',
      SHELL_ONLY: 'do-not-import',
    }))
    const scrubParent = vi.fn(() => ({
      PATH: '/usr/bin:/bin',
      SAFE_PARENT: 'available-to-rc',
    }))

    await expect(resolveDesktopShellEnvironment({
      environment: { PATH: '/usr/bin:/bin', DEEPSEEK_API_KEY: 'explicit-key' },
      home: '/Users/tester',
      isPackaged: true,
      platform: 'darwin',
      shell: '/bin/zsh',
      capture,
      scrubParent,
    })).resolves.toEqual({
      updates: {
        PATH: '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin',
        LANG: 'zh_CN.UTF-8',
        NVM_DIR: '/Users/tester/.nvm',
      },
      source: 'login-shell',
    })
    expect(capture).toHaveBeenCalledWith('/bin/zsh', '/Users/tester', {
      PATH: '/usr/bin:/bin',
      SAFE_PARENT: 'available-to-rc',
      HOME: '/Users/tester',
      SHELL: '/bin/zsh',
    }, 2_000)
  })

  it('uses the requested timeout on packaged Linux', async () => {
    const capture = vi.fn(async () => ({ PATH: '/home/tester/.local/bin:/usr/bin:/bin' }))

    await expect(resolveDesktopShellEnvironment({
      environment: { PATH: '/usr/bin:/bin' },
      home: '/home/tester',
      isPackaged: true,
      platform: 'linux',
      shell: '/bin/bash',
      timeoutMs: 75,
      capture,
      scrubParent: () => ({}),
    })).resolves.toEqual({
      updates: { PATH: '/home/tester/.local/bin:/usr/bin:/bin' },
      source: 'login-shell',
    })
    expect(capture).toHaveBeenCalledWith('/bin/bash', '/home/tester', {
      HOME: '/home/tester',
      SHELL: '/bin/bash',
    }, 75)
  })

  it.each([
    { shell: 'zsh', description: 'relative shell' },
    { shell: '/bin/nu', description: 'unsupported shell' },
  ])('does not execute a $description', async ({ shell }) => {
    const capture = vi.fn()

    await expect(resolveDesktopShellEnvironment({
      environment: { PATH: '/usr/bin' },
      home: '/Users/tester',
      isPackaged: true,
      platform: 'darwin',
      shell,
      capture,
    })).resolves.toEqual({
      updates: {},
      source: 'process',
      fallbackReason: 'unsupported-shell',
    })
    expect(capture).not.toHaveBeenCalled()
  })

  it('falls back without exposing a capture failure', async () => {
    const capture = vi.fn(async () => { throw new Error('secret shell output') })

    const resolution = await resolveDesktopShellEnvironment({
      environment: { PATH: '/usr/bin' },
      home: '/Users/tester',
      isPackaged: true,
      platform: 'linux',
      shell: '/bin/bash',
      capture,
    })

    expect(resolution).toEqual({
      updates: {},
      source: 'process',
      fallbackReason: 'capture-failed',
    })
    expect(JSON.stringify(resolution)).not.toContain('secret shell output')
  })

  it.each([
    { captured: { JAVA_HOME: '/java' }, description: 'missing PATH' },
    { captured: { PATH: '', LANG: 'zh_CN.UTF-8' }, description: 'empty PATH' },
  ])('retains the inherited environment when capture reports $description', async ({ captured }) => {
    const capture = vi.fn(async () => captured)

    await expect(resolveDesktopShellEnvironment({
      environment: { PATH: '/usr/bin:/bin' },
      home: '/Users/tester',
      isPackaged: true,
      platform: 'darwin',
      shell: '/bin/zsh',
      capture,
    })).resolves.toEqual({
      updates: {},
      source: 'process',
      fallbackReason: 'missing-path',
    })
  })

  it('uses the upstream parent scrub before executing shell startup files', async () => {
    const originalToken = process.env.DESKTOP_CAPTURE_API_KEY
    const originalSafe = process.env.DSH_DESKTOP_CAPTURE_SAFE
    process.env.DESKTOP_CAPTURE_API_KEY = 'must-not-reach-rc'
    process.env.DSH_DESKTOP_CAPTURE_SAFE = 'must-not-reach-rc'
    const capture = vi.fn(async (
      _shell: string,
      _home: string,
      _environment: NodeJS.ProcessEnv,
      _timeoutMs: number,
    ) => ({ PATH: '/usr/bin' }))

    try {
      await resolveDesktopShellEnvironment({
        environment: process.env,
        home: '/Users/tester',
        isPackaged: true,
        platform: 'darwin',
        shell: '/bin/zsh',
        capture,
      })
      const captureEnvironment = capture.mock.calls[0]?.[2]
      expect(captureEnvironment).not.toHaveProperty('DESKTOP_CAPTURE_API_KEY')
      expect(captureEnvironment).not.toHaveProperty('DSH_DESKTOP_CAPTURE_SAFE')
    } finally {
      if (originalToken === undefined) delete process.env.DESKTOP_CAPTURE_API_KEY
      else process.env.DESKTOP_CAPTURE_API_KEY = originalToken
      if (originalSafe === undefined) delete process.env.DSH_DESKTOP_CAPTURE_SAFE
      else process.env.DSH_DESKTOP_CAPTURE_SAFE = originalSafe
    }
  })
})
