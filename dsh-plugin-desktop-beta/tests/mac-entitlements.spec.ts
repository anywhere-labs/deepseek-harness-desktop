import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MAC_REQUIRED_ENTITLEMENTS, verifyMacEntitlements } from '../scripts/verify-mac-entitlements.ts'

const granted = Object.fromEntries(MAC_REQUIRED_ENTITLEMENTS.map(key => [key, true]))

it('inherits the pinned upstream entitlement file for the main app and all Helpers', () => {
  const { build } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(build.mac.hardenedRuntime).toBe(true)
  expect(build.mac.extendInfo.NSMicrophoneUsageDescription).toBeTruthy()
  expect(build.mac.entitlements).toBe('../deepseek-harness/apps/desktop/scripts/macos-entitlements.plist')
  expect(build.mac.entitlementsInherit).toBe(build.mac.entitlements)
  const plist = readFileSync(new URL(`../${build.mac.entitlements}`, import.meta.url), 'utf8')
  for (const key of MAC_REQUIRED_ENTITLEMENTS) {
    expect(plist).toContain(`<key>${key}</key>\n    <true/>`)
  }
})

it('checks both architectures in the main app and all four Helpers', () => {
  const read = vi.fn(() => granted)
  verifyMacEntitlements('/mounted/DSH Desktop Beta.app', 'DSH Desktop Beta', read)
  expect(read).toHaveBeenCalledTimes(10)
  for (const suffix of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
    for (const arch of ['arm64', 'x86_64']) {
      expect(read).toHaveBeenCalledWith(join('/mounted/DSH Desktop Beta.app', 'Contents', 'Frameworks', `DSH Desktop Beta Helper${suffix}.app`), arch)
    }
  }
})

it.each([undefined, false, 'true'])('rejects missing or non-boolean audio input grants: %s', value => {
  expect(() => verifyMacEntitlements('/mounted/DSH Desktop Beta.app', 'DSH Desktop Beta', (path, arch) =>
    path.endsWith('Helper.app') && arch === 'x86_64'
      ? { ...granted, 'com.apple.security.device.audio-input': value } : granted,
  )).toThrow(/audio-input.*Helper.app.*x86_64/)
})

it('propagates a signature inspection failure instead of accepting an unchecked artifact', () => {
  expect(() => verifyMacEntitlements('/mounted/DSH Desktop Beta.app', 'DSH Desktop Beta', () => { throw new Error('codesign failed') })).toThrow('codesign failed')
})
