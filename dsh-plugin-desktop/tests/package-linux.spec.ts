import { describe, expect, it } from 'vitest'
import {
  packageLinuxInstallers,
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
      PATH: '/usr/bin',
      SAFE_VALUE: 'kept',
    },
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '22.23.2',
    workspaceRoot: '/repo',
    desktopRoot: '/repo/dsh-plugin-desktop',
    corepackExecutable: 'corepack',
    builderCli: '/repo/node_modules/electron-builder/cli.js',
    verifier: '/repo/dsh-plugin-desktop/scripts/verify-linux-installer.ts',
    nodeExecutable: '/usr/local/bin/node',
    run: (command, args, cwd, env) => {
      calls.push({ command, args: [...args], cwd, env: { ...env } })
    },
    log: message => logs.push(message),
  }
}

describe('Linux x64 package build', () => {
  it('checks headlessly, builds all three targets, then verifies them', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []

    packageLinuxInstallers(options(calls, logs))

    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({
      command: 'corepack',
      args: ['yarn', 'workspace', 'dsh-plugin-desktop', 'check:linux-package'],
      cwd: '/repo',
      env: { PATH: '/usr/bin', SAFE_VALUE: 'kept' },
    })
    expect(calls[1]).toEqual({
      command: '/usr/local/bin/node',
      args: [
        '/repo/node_modules/electron-builder/cli.js',
        '--linux',
        'deb',
        'rpm',
        'AppImage',
        '--x64',
        '--publish',
        'never',
        '--config.npmRebuild=false',
        '--config.electronVersion=42.9.3',
      ],
      cwd: '/repo/dsh-plugin-desktop',
      env: { PATH: '/usr/bin', SAFE_VALUE: 'kept' },
    })
    expect(calls[2]).toEqual({
      command: '/usr/local/bin/node',
      args: ['/repo/dsh-plugin-desktop/scripts/verify-linux-installer.ts'],
      cwd: '/repo/dsh-plugin-desktop',
      env: { PATH: '/usr/bin', SAFE_VALUE: 'kept' },
    })
    expect(logs).toEqual([
      'Building unsigned Linux x64 deb, rpm, and AppImage artifacts; the rpm target requires host rpmbuild.',
      'Bundling Electron 42.9.3 for Linux; Electron 43.x tray icons are dropped by the stock GNOME AppIndicator extension v58.',
    ])
  })

  it('reuses a completed CI package gate when explicitly requested', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []
    const value = {
      ...options(calls, logs),
      env: {
        ...options(calls).env,
        DSH_PACKAGE_CHECK_ALREADY_RAN: '1',
      },
    }

    packageLinuxInstallers(value)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      command: '/usr/local/bin/node',
      args: [
        '/repo/node_modules/electron-builder/cli.js',
        '--linux',
        'deb',
        'rpm',
        'AppImage',
        '--x64',
        '--publish',
        'never',
        '--config.npmRebuild=false',
        '--config.electronVersion=42.9.3',
      ],
      cwd: '/repo/dsh-plugin-desktop',
      env: { PATH: '/usr/bin', SAFE_VALUE: 'kept', DSH_PACKAGE_CHECK_ALREADY_RAN: '1' },
    })
    expect(calls[1]).toEqual({
      command: '/usr/local/bin/node',
      args: ['/repo/dsh-plugin-desktop/scripts/verify-linux-installer.ts'],
      cwd: '/repo/dsh-plugin-desktop',
      env: { PATH: '/usr/bin', SAFE_VALUE: 'kept', DSH_PACKAGE_CHECK_ALREADY_RAN: '1' },
    })
    expect(logs).toEqual([
      'Building unsigned Linux x64 deb, rpm, and AppImage artifacts; the rpm target requires host rpmbuild.',
      'Bundling Electron 42.9.3 for Linux; Electron 43.x tray icons are dropped by the stock GNOME AppIndicator extension v58.',
      'Skipping the Linux package preflight; the CI shared gate already passed.',
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

      expect(() => packageLinuxInstallers(value)).toThrow(message)
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

    expect(() => packageLinuxInstallers(value)).toThrow('headless check failed')
    expect(calls).toHaveLength(1)
  })
})
