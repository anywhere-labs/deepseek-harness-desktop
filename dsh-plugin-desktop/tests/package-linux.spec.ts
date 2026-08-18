import { describe, expect, it } from 'vitest'
import {
  packageLinuxDeb,
  type LinuxPackageOptions,
} from '../scripts/package-linux.ts'

interface CommandCall {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

function options(calls: CommandCall[], logs: string[] = []): LinuxPackageOptions {
  return {
    env: {
      PATH: '/usr/bin:/bin',
      SAFE_VALUE: 'kept',
    },
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '22.23.2',
    workspaceRoot: '/repo',
    desktopRoot: '/repo/dsh-plugin-desktop',
    outputDir: '/repo/dsh-plugin-desktop/dist/linux',
    resetOutput: () => undefined,
    builderCli: '/repo/node_modules/electron-builder/cli.js',
    verifier: '/repo/dsh-plugin-desktop/scripts/verify-linux-package.ts',
    nodeExecutable: '/usr/local/bin/node',
    run: (command, args, cwd, env) => {
      calls.push({ command, args: [...args], cwd, env: { ...env } })
    },
    log: message => logs.push(message),
  }
}

describe('Linux x64 deb packaging', () => {
  it('checks the package gate, builds an unsigned deb target, then verifies it', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []

    packageLinuxDeb(options(calls, logs))

    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({
      command: 'corepack',
      args: ['yarn', 'workspace', 'dsh-plugin-desktop', 'check:linux-package'],
      cwd: '/repo',
      env: { PATH: '/usr/bin:/bin', SAFE_VALUE: 'kept' },
    })
    expect(calls[1]).toEqual({
      command: '/usr/local/bin/node',
      args: [
        '/repo/node_modules/electron-builder/cli.js',
        '--linux',
        'deb',
        '--x64',
        '--publish',
        'never',
        '--config.npmRebuild=false',
        '--config.directories.output=/repo/dsh-plugin-desktop/dist/linux',
      ],
      cwd: '/repo/dsh-plugin-desktop',
      env: {
        PATH: '/usr/bin:/bin',
        SAFE_VALUE: 'kept',
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      },
    })
    expect(calls[2]).toEqual({
      command: '/usr/local/bin/node',
      args: [
        '/repo/dsh-plugin-desktop/scripts/verify-linux-package.ts',
        '/repo/dsh-plugin-desktop/dist/linux',
      ],
      cwd: '/repo/dsh-plugin-desktop',
      env: { PATH: '/usr/bin:/bin', SAFE_VALUE: 'kept' },
    })
    expect(logs).toEqual([
      'Building an unsigned Linux x64 deb package; signing is a separate release step.',
    ])
  })

  it.each([
    ['darwin', 'x64', '22.23.2', 'native Linux host'],
    ['linux', 'arm64', '22.23.2', 'requires x64 Node'],
    ['linux', 'x64', '25.0.0', 'Node 22.19+ or Node 24.x'],
  ] as const)(
    'rejects unsupported host %s/%s with Node %s before running commands',
    (platform, arch, nodeVersion, message) => {
      const calls: CommandCall[] = []
      const value = { ...options(calls), platform, arch, nodeVersion }

      expect(() => packageLinuxDeb(value)).toThrow(message)
      expect(calls).toEqual([])
    },
  )

  it('stops before packaging when the headless check fails', () => {
    const calls: CommandCall[] = []
    const value: LinuxPackageOptions = {
      ...options(calls),
      run: (command, args, cwd, env) => {
        calls.push({ command, args: [...args], cwd, env: { ...env } })
        throw new Error('headless check failed')
      },
    }

    expect(() => packageLinuxDeb(value)).toThrow('headless check failed')
    expect(calls).toHaveLength(1)
  })
})
