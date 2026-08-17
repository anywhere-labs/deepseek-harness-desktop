import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  verifyMacRelease,
  type MacReleaseVerificationOptions,
} from '../scripts/verify-mac-release.ts'
import { MACOS_UNIVERSAL_NATIVE_ENTRIES } from '../scripts/mac-universal.ts'

function options(overrides: Partial<MacReleaseVerificationOptions> = {}) {
  const calls: Array<{ command: string; args: readonly string[] }> = []
  const removeMountPoint = vi.fn()
  const value: MacReleaseVerificationOptions = {
    distDir: '/release/dist',
    productName: 'DSH Desktop',
    listDmgs: () => ['/release/dist/DSH Desktop-2.0.0-universal.dmg'],
    makeMountPoint: () => '/private/tmp/dsh-desktop-dmg-test',
    run: (command, args) => { calls.push({ command, args: [...args] }) },
    removeMountPoint,
    ...overrides,
  }
  return { calls, removeMountPoint, value }
}

describe('macOS release artifact verification', () => {
  it('mounts one DMG and verifies signature, Gatekeeper, and the stapled ticket', () => {
    const harness = options()
    const appPath = join('/private/tmp/dsh-desktop-dmg-test', 'DSH Desktop.app')

    expect(verifyMacRelease(harness.value)).toEqual({
      appPath,
      dmgPath: '/release/dist/DSH Desktop-2.0.0-universal.dmg',
    })

    expect(harness.calls).toEqual([
      {
        command: 'hdiutil',
        args: [
          'attach', '/release/dist/DSH Desktop-2.0.0-universal.dmg',
          '-mountpoint', '/private/tmp/dsh-desktop-dmg-test', '-nobrowse', '-readonly',
        ],
      },
      {
        command: 'lipo',
        args: [join(appPath, 'Contents', 'MacOS', 'DSH Desktop'), '-verify_arch', 'x86_64'],
      },
      {
        command: 'lipo',
        args: [join(appPath, 'Contents', 'MacOS', 'DSH Desktop'), '-verify_arch', 'arm64'],
      },
      ...MACOS_UNIVERSAL_NATIVE_ENTRIES.map(entry => ({
        command: 'lipo',
        args: [
          join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', entry.path),
          '-verify_arch', entry.arch,
        ],
      })),
      {
        command: 'codesign',
        args: ['--verify', '--deep', '--strict', '--verbose=2', appPath],
      },
      {
        command: 'spctl',
        args: ['--assess', '--type', 'execute', '--verbose=4', appPath],
      },
      {
        command: 'xcrun',
        args: ['stapler', 'validate', appPath],
      },
      {
        command: 'hdiutil',
        args: ['detach', '/private/tmp/dsh-desktop-dmg-test'],
      },
    ])
    expect(harness.removeMountPoint).toHaveBeenCalledWith('/private/tmp/dsh-desktop-dmg-test')
  })

  it('rejects absent or ambiguous release images before mounting', () => {
    for (const dmgs of [[], ['/one.dmg', '/two.dmg']]) {
      const harness = options({ listDmgs: () => dmgs })
      expect(() => verifyMacRelease(harness.value)).toThrow(`found ${String(dmgs.length)}`)
      expect(harness.calls).toEqual([])
    }
  })

  it('detaches the image and preserves verification and cleanup failures', () => {
    const verifyFailure = new Error('Gatekeeper rejected the app')
    const detachFailure = new Error('detach failed')
    const harness = options({
      run: (command, args) => {
        harness.calls.push({ command, args: [...args] })
        if (command === 'spctl') throw verifyFailure
        if (command === 'hdiutil' && args[0] === 'detach') throw detachFailure
      },
    })

    let caught: unknown
    try {
      verifyMacRelease(harness.value)
    } catch (cause) {
      caught = cause
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([verifyFailure, detachFailure])
    expect(harness.removeMountPoint).toHaveBeenCalledOnce()
  })
})
