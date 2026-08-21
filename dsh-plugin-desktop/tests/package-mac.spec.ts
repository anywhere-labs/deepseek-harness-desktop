import { describe, expect, it } from 'vitest'
import {
  packageMacSmoke,
  type MacSmokePackageOptions,
} from '../scripts/package-mac.ts'

interface CommandCall {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

function options(calls: CommandCall[], logs: string[] = []): MacSmokePackageOptions {
  return {
    env: {
      PATH: '/usr/bin:/bin',
      SAFE_VALUE: 'kept',
      APPLE_ID: 'developer@example.test',
      APPLE_APP_SPECIFIC_PASSWORD: 'notary-password-that-must-not-be-logged',
      APPLE_TEAM_ID: 'TEAM123456',
      CSC_FOR_PULL_REQUEST: 'true',
      CSC_INSTALLER_KEY_PASSWORD: 'private-installer-password',
      CSC_INSTALLER_LINK: '/private/installer.p12',
      CSC_KEYCHAIN: '/private/signing.keychain-db',
      MAC_CERT_P12_BASE64: 'private-p12-data',
      MACOS_SIGN_IDENTITY: 'Developer ID Application: Release Signer (TEAM123456)',
      CSC_LINK: 'data:application/x-pkcs12;base64,private-generic-certificate',
      CSC_KEY_PASSWORD: 'private-generic-password',
    },
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: '22.23.2',
    workspaceRoot: '/repo',
    desktopRoot: '/repo/dsh-plugin-desktop',
    outputDir: '/repo/dsh-plugin-desktop/dist/mac-smoke',
    resetOutput: () => undefined,
    prepareRuntime: () => undefined,
    builderCli: '/repo/node_modules/electron-builder/cli.js',
    verifier: '/repo/dsh-plugin-desktop/scripts/verify-mac-smoke.ts',
    nodeExecutable: '/usr/local/bin/node',
    run: (command, args, cwd, env) => {
      calls.push({ command, args: [...args], cwd, env: { ...env } })
    },
    log: message => logs.push(message),
  }
}

describe('macOS DMG smoke packaging', () => {
  it('checks without credentials, builds an unsigned DMG, then verifies it', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []

    packageMacSmoke(options(calls, logs))

    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({
      command: 'corepack',
      args: ['yarn', 'workspace', 'dsh-plugin-desktop', 'check:mac-package'],
      cwd: '/repo',
      env: { PATH: '/usr/bin:/bin', SAFE_VALUE: 'kept' },
    })
    expect(calls[1]).toEqual({
      command: '/usr/local/bin/node',
      args: [
        '/repo/node_modules/electron-builder/cli.js',
        '--mac',
        'dmg',
        '--universal',
        '--publish',
        'never',
        '--config.mac.notarize=false',
        '--config.npmRebuild=false',
        '--config.directories.output=/repo/dsh-plugin-desktop/dist/mac-smoke',
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
        '/repo/dsh-plugin-desktop/scripts/verify-mac-smoke.ts',
        '/repo/dsh-plugin-desktop/dist/mac-smoke',
      ],
      cwd: '/repo/dsh-plugin-desktop',
      env: { PATH: '/usr/bin:/bin', SAFE_VALUE: 'kept' },
    })
    expect(logs).toEqual([
      'Building an unsigned macOS DMG smoke; signing and notarization are release-only steps.',
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

    packageMacSmoke(value)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.args).toEqual([
      '/repo/node_modules/electron-builder/cli.js',
      '--mac',
      'dmg',
      '--universal',
      '--publish',
      'never',
      '--config.mac.notarize=false',
      '--config.npmRebuild=false',
      '--config.directories.output=/repo/dsh-plugin-desktop/dist/mac-smoke',
    ])
    expect(logs).toEqual([
      'Building an unsigned macOS DMG smoke; signing and notarization are release-only steps.',
      'Skipping the macOS package preflight; the package gate already passed.',
    ])
  })

  it.each([
    ['win32', 'arm64', '22.23.2', 'native macOS host'],
    ['darwin', 'ia32', '22.23.2', 'requires x64 or arm64 Node'],
    ['darwin', 'arm64', '25.0.0', 'Node 22.19+ or Node 24.x'],
  ] as const)(
    'rejects unsupported host %s/%s with Node %s before running commands',
    (platform, arch, nodeVersion, message) => {
      const calls: CommandCall[] = []
      const value = { ...options(calls), platform, arch, nodeVersion }

      expect(() => packageMacSmoke(value)).toThrow(message)
      expect(calls).toEqual([])
    },
  )

  it('stops before packaging when the headless check fails', () => {
    const calls: CommandCall[] = []
    const value: MacSmokePackageOptions = {
      ...options(calls),
      run: (command, args, cwd, env) => {
        calls.push({ command, args: [...args], cwd, env: { ...env } })
        throw new Error('headless check failed')
      },
    }

    expect(() => packageMacSmoke(value)).toThrow('headless check failed')
    expect(calls).toHaveLength(1)
  })
})
