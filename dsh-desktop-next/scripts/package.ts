/** Next entry points reuse Stable/Beta's native packaging and credential boundaries. */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageDirectory } from '../../dsh-plugin-desktop-beta/scripts/package-dir.mjs'
import { releaseMac } from '../../dsh-plugin-desktop-beta/scripts/release-mac.ts'
import { packageMacSmoke } from '../../dsh-plugin-desktop-beta/scripts/package-mac.ts'
import { createWindowsPackageOptions, packageWindowsInstaller } from '../../dsh-plugin-desktop-beta/scripts/package-win.ts'
import { prepareNextMacRuntime } from './mac-runtime.ts'
import { runNextPackagingCommand } from './packaging-command.ts'

const desktopRoot = fileURLToPath(new URL('..', import.meta.url))
const workspaceRoot = resolve(desktopRoot, '..')
const require = createRequire(import.meta.url)

/**
 * Optional test-only build version for update drills.
 *
 * electron-builder merges `extraMetadata` before signing, so one value reaches
 * the packaged `package.json` (which the runtime and the updater's bundle check
 * read), `Info.plist` `CFBundleShortVersionString`/`CFBundleVersion`, and the
 * `${version}` artifact name. That produces an installable, correctly signed
 * release whose version differs from the source tree, without editing any
 * version declaration. Only the two shapes the Next channel accepts are allowed.
 */
const TEST_BUILD_VERSION = process.env.DSH_NEXT_BUILD_VERSION
if (TEST_BUILD_VERSION !== undefined && !/^[0-9]+\.[0-9]+\.[0-9]+-next(?:\.[0-9]+)?$/u.test(TEST_BUILD_VERSION)) {
  throw new Error(`DSH_NEXT_BUILD_VERSION must be x.y.z-next or x.y.z-next.N; received ${TEST_BUILD_VERSION}`)
}
const run = (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void => {
  const isBuilder = args.includes('electron-builder') || args.some(arg => arg.endsWith('electron-builder/cli.js'))
  const forwarded = TEST_BUILD_VERSION !== undefined && isBuilder
    ? [...args, `--config.extraMetadata.version=${TEST_BUILD_VERSION}`, `--config.buildVersion=${TEST_BUILD_VERSION}`]
    : args
  if (forwarded !== args) console.log(`Packaging with test build version ${TEST_BUILD_VERSION}; source manifests are unchanged.`)
  runNextPackagingCommand(command, forwarded, cwd, env, workspaceRoot)
}
const prepareRuntime = (): void => {
  prepareNextMacRuntime(desktopRoot)
}
const mode = process.argv[2]
const outputDir = join(desktopRoot, 'dist', mode === 'mac' ? 'mac-release' : 'mac-smoke')
const shared = { env: process.env, platform: process.platform, desktopRoot, outputDir,
  resetOutput: () => rmSync(outputDir, { force: true, recursive: true }), run, log: console.log, prepareRuntime }
if (mode === 'dir') {
  if (process.platform === 'darwin') prepareRuntime()
  packageDirectory({ cwd: desktopRoot, electronBuilderCli: require.resolve('electron-builder/cli.js'), electronDistPath: join(dirname(require.resolve('electron/package.json')), 'dist') })
} else if (mode === 'mac') {
  releaseMac({ ...shared, listCodeSigningIdentities: env => {
    const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { env, encoding: 'utf8' })
    if (result.error || result.status !== 0) throw result.error ?? new Error('Signing identity discovery failed')
    return result.stdout
  } })
} else if (mode === 'mac-smoke') {
  packageMacSmoke({ ...shared, workspaceRoot, arch: process.arch, nodeVersion: process.versions.node,
    builderCli: require.resolve('electron-builder/cli.js'), verifier: join(desktopRoot, 'scripts/verify-mac-smoke.ts'), nodeExecutable: process.execPath })
} else if (mode === 'win') {
  packageWindowsInstaller({ ...createWindowsPackageOptions(), desktopRoot, workspaceRoot, run,
    prepareRuntime: () => {},
    verifier: join(desktopRoot, 'scripts/verify-win-installer.ts') })
} else throw new Error('Expected dir, mac, mac-smoke or win')
