/** Reuse the signed universal DMG verifier with Next's application identity. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { verifyMacRelease } from '../../dsh-plugin-desktop-beta/scripts/verify-mac-release.ts'
import { NEXT_MAC_NATIVE_ENTRIES } from './mac-runtime.ts'
import { verifyNextMacEntitlements } from './verify-mac-entitlements.ts'

export function verifyNextMac(signed: boolean): void {
  verifyMacRelease({ distDir: resolve(process.argv[2] ?? `dist/${signed ? 'mac-release' : 'mac-smoke'}`), productName: 'DSH NEXT', nativeEntries: NEXT_MAC_NATIVE_ENTRIES,
    listDmgs: path => readdirSync(path).filter(name => name.endsWith('.dmg')).map(name => join(path, name)).filter(path => statSync(path).isFile()),
    makeMountPoint: () => mkdtempSync(join(tmpdir(), 'dsh-next-release-')), removeMountPoint: path => rmdirSync(path),
    run: (command, args) => {
      if (!signed && ['codesign', 'spctl', 'xcrun'].includes(command)) return
      const result = spawnSync(command, args, { stdio: 'inherit' })
      if (result.error || result.status !== 0) throw result.error ?? new Error(`Artifact verification failed: ${command}`)
      if (signed && command === 'codesign' && args.includes('--verify')) verifyNextMacEntitlements(args.at(-1)!)
    } })
}
if (process.argv[1]?.endsWith('/verify-mac-release.ts')) verifyNextMac(true)
