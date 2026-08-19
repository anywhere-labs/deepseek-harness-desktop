import { describe, expect, it } from 'vitest'
import {
  packageLinuxAppImage,
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
      CSC_LINK: '/private/publisher.p12',
      csc_key_password: 'private-signing-password',
      GH_TOKEN: 'private-release-token',
      github_token: 'private-actions-token',
    },
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '22.23.2',
    workspaceRoot: '/repo',
    desktopRoot: '/repo/dsh-plugin-desktop',
    outputDir: '/repo/dsh-plugin-desktop/dist/linux',
    resetOutput: () => undefined,
    prepareRuntime: () => undefined,
    builderCli: '/repo/node_modules/electron-builder/cli.js',
    verifier: '/repo/dsh-plugin-desktop/scripts/verify-linux-appimage.ts',
    nodeExecutable: '/usr/local/bin/node',
    run: (command, args, cwd, env) => {
      calls.push({ command, args: [...args], cwd, env: { ...env } })
    },
    log: message => logs.push(message),
  }
}

describe('Linux x64 AppImage packaging', () => {
  it('checks without publishing credentials, builds without publishing, then verifies', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []

    let checked = false
    let prepared = false
    const value: LinuxPackageOptions = {
      ...options(calls, logs),
      prepareRuntime: () => {
        expect(checked).toBe(true)
        prepared = true
      },
      run: (command, args, cwd, env) => {
        if (command === 'corepack') checked = true
        if (args.includes('--linux')) expect(prepared).toBe(true)
        calls.push({ command, args: [...args], cwd, env: { ...env } })
      },
    }

    packageLinuxAppImage(value)

    const cleanEnvironment = { PATH: '/usr/bin:/bin', SAFE_VALUE: 'kept' }
    expect(calls).toEqual([
      {
        command: 'corepack',
        args: ['yarn', 'workspace', 'dsh-plugin-desktop', 'check:linux-package'],
        cwd: '/repo',
        env: cleanEnvironment,
      },
      {
        command: '/usr/local/bin/node',
        args: [
          '/repo/node_modules/electron-builder/cli.js',
          '--linux',
          'AppImage',
          '--x64',
          '--publish',
          'never',
          '--config.npmRebuild=false',
          '--config.directories.output=/repo/dsh-plugin-desktop/dist/linux',
        ],
        cwd: '/repo/dsh-plugin-desktop',
        env: cleanEnvironment,
      },
      {
        command: '/usr/local/bin/node',
        args: [
          '/repo/dsh-plugin-desktop/scripts/verify-linux-appimage.ts',
          '/repo/dsh-plugin-desktop/dist/linux',
        ],
        cwd: '/repo/dsh-plugin-desktop',
        env: cleanEnvironment,
      },
    ])
    expect(logs).toEqual([
      'Building an unsigned Linux x64 AppImage; release publication is a separate step.',
    ])
    expect(prepared).toBe(true)
  })

  it.each([
    ['win32', 'x64', '22.23.2', 'native Linux host'],
    ['linux', 'arm64', '22.23.2', 'requires x64 Node'],
    ['linux', 'x64', '22.18.0', 'Node 22.19+ or Node 24.x'],
    ['linux', 'x64', '25.0.0', 'Node 22.19+ or Node 24.x'],
  ] as const)(
    'rejects unsupported host %s/%s with Node %s before running commands',
    (platform, arch, nodeVersion, message) => {
      const calls: CommandCall[] = []
      const value = { ...options(calls), platform, arch, nodeVersion }

      expect(() => packageLinuxAppImage(value)).toThrow(message)
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

    expect(() => packageLinuxAppImage(value)).toThrow('headless check failed')
    expect(calls).toHaveLength(1)
  })
})
