import { describe, expect, it } from 'vitest'
import {
  packageWindowsArtifact,
  packageWindowsInstaller,
  type WindowsPackageOptions,
} from '../scripts/package-win.ts'

interface CommandCall {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

function options(calls: CommandCall[], logs: string[] = []): WindowsPackageOptions {
  return {
    env: {
      PATH: 'C:\\Windows\\System32',
      SAFE_VALUE: 'kept',
      CSC_LINK: 'private-generic-certificate',
      csc_key_password: 'private-generic-password',
      win_csc_link: 'C:\\private\\publisher.pfx',
      WIN_CSC_KEY_PASSWORD: 'private-windows-password',
    },
    platform: 'win32',
    arch: 'x64',
    nodeVersion: '22.23.2',
    workspaceRoot: 'C:\\repo',
    desktopRoot: 'C:\\repo\\dsh-plugin-desktop',
    commandShell: 'C:\\Windows\\System32\\cmd.exe',
    builderCli: 'C:\\repo\\node_modules\\electron-builder\\cli.js',
    verifier: 'C:\\repo\\dsh-plugin-desktop\\scripts\\verify-win-installer.ts',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    run: (command, args, cwd, env) => {
      calls.push({ command, args: [...args], cwd, env: { ...env } })
    },
    log: message => logs.push(message),
  }
}

describe('Windows x64 installer packaging', () => {
  it('checks without credentials, builds an unsigned NSIS target, then verifies it', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []

    packageWindowsInstaller(options(calls, logs))

    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'corepack yarn workspace dsh-plugin-desktop check:win-package',
      ],
      cwd: 'C:\\repo',
      env: { PATH: 'C:\\Windows\\System32', SAFE_VALUE: 'kept' },
    })
    expect(calls[1]).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\repo\\node_modules\\electron-builder\\cli.js',
        '--win',
        'nsis',
        '--x64',
        '--publish',
        'never',
        '--config.win.signExecutable=false',
        '--config.npmRebuild=false',
      ],
      cwd: 'C:\\repo\\dsh-plugin-desktop',
      env: {
        PATH: 'C:\\Windows\\System32',
        SAFE_VALUE: 'kept',
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      },
    })
    expect(calls[2]).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\repo\\dsh-plugin-desktop\\scripts\\verify-win-installer.ts'],
      cwd: 'C:\\repo\\dsh-plugin-desktop',
      env: { PATH: 'C:\\Windows\\System32', SAFE_VALUE: 'kept' },
    })
    expect(logs).toEqual([
      'Building an unsigned Windows x64 installer; Authenticode is a separate release step.',
    ])
  })

  it('checks without credentials, builds an unsigned portable ZIP target, then verifies it', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []
    const value = {
      ...options(calls, logs),
      verifier: 'C:\\repo\\dsh-plugin-desktop\\scripts\\verify-win-portable.ts',
    }

    packageWindowsArtifact(value, 'zip', 'portable archive')

    expect(calls[1]?.args).toEqual([
      'C:\\repo\\node_modules\\electron-builder\\cli.js',
      '--win',
      'zip',
      '--x64',
      '--publish',
      'never',
      '--config.win.signExecutable=false',
      '--config.npmRebuild=false',
    ])
    expect(calls[2]?.args).toEqual([
      'C:\\repo\\dsh-plugin-desktop\\scripts\\verify-win-portable.ts',
    ])
    expect(logs).toEqual([
      'Building an unsigned Windows x64 portable archive; Authenticode is a separate release step.',
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

    packageWindowsInstaller(value)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.args).toEqual([
      'C:\\repo\\node_modules\\electron-builder\\cli.js',
      '--win',
      'nsis',
      '--x64',
      '--publish',
      'never',
      '--config.win.signExecutable=false',
      '--config.npmRebuild=false',
    ])
    expect(logs).toEqual([
      'Building an unsigned Windows x64 installer; Authenticode is a separate release step.',
      'Skipping the Windows package preflight; the package gate already passed.',
    ])
  })

  it.each([
    ['darwin', 'x64', '22.23.2', 'native Windows host'],
    ['win32', 'arm64', '22.23.2', 'requires x64 Node'],
    ['win32', 'x64', '25.0.0', 'Node 22.19+ or Node 24.x'],
  ] as const)(
    'rejects unsupported host %s/%s with Node %s before running commands',
    (platform, arch, nodeVersion, message) => {
    const calls: CommandCall[] = []
      const value = { ...options(calls), platform, arch, nodeVersion }

      expect(() => packageWindowsInstaller(value)).toThrow(message)
      expect(calls).toEqual([])
    },
  )

  it('stops before packaging when the headless check fails', () => {
    const calls: CommandCall[] = []
    const value: WindowsPackageOptions = {
      ...options(calls),
      run: (command, args, cwd, env) => {
        calls.push({ command, args: [...args], cwd, env: { ...env } })
        throw new Error('headless check failed')
      },
    }

    expect(() => packageWindowsInstaller(value)).toThrow('headless check failed')
    expect(calls).toHaveLength(1)
  })
})
