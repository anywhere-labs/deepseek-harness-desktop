/** Headless artifact smoke for profile-local and launcher-owned Cordis plugins. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { installDesktopPnpmRuntime } from '../lib/desktop-runtime-environment.js'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'

const BIN_NAME = 'dsh-plugin-desktop-loader-smoke'
const THIRD_PARTY_NAME = 'dsh-desktop-loader-smoke-plugin'
const THIRD_PARTY_DEPENDENCY_NAME = 'dsh-desktop-loader-smoke-dependency'
const RUNNER_ENVIRONMENT_NAMES = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NPM_CONFIG_RUNTIME',
  'NPM_CONFIG_TARGET',
  'NPM_CONFIG_DISTURL',
])
const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-loader-'))
let ctx
let mounted
let mountedSpec
let releasePackageResolver
let pnpmRuntime
const runnerEnvironment = Object.entries(process.env)
  .filter(([key]) => RUNNER_ENVIRONMENT_NAMES.has(key.toUpperCase()))

try {
  for (const [key] of runnerEnvironment) delete process.env[key]
  const launchEnvironment = createLaunchEnvironmentSnapshot([{
    source: 'process',
    values: { ...process.env },
  }])
  const launchPath = launchEnvironment.get('PATH')?.value
  const packageRoot = new URL('../', import.meta.url)
  const pnpmBinPath = fileURLToPath(new URL('node_modules/pnpm/bin/pnpm.mjs', packageRoot))
  const electronVersion = JSON.parse(readFileSync(new URL('node_modules/electron/package.json', packageRoot), 'utf8')).version
  pnpmRuntime = installDesktopPnpmRuntime({
    platform: process.platform,
    appExecutable: process.execPath,
    pnpmBinPath,
    electronVersion,
    stateDir: join(home, 'runtime-commands'),
    environment: process.env,
  })
  const prepared = prepareDesktopProfile(undefined, home)
  const thirdPartyLink = join(prepared.profile.dir, 'node_modules', THIRD_PARTY_NAME)
  const thirdPartyDir = join(home, 'linked-plugins', THIRD_PARTY_NAME)
  const thirdPartyDependencyDir = join(home, 'profiles', 'node_modules', THIRD_PARTY_DEPENDENCY_NAME)
  mkdirSync(join(prepared.profile.dir, 'node_modules'), { recursive: true })
  mkdirSync(thirdPartyDir, { recursive: true })
  mkdirSync(thirdPartyDependencyDir, { recursive: true })
  writeFileSync(join(thirdPartyDependencyDir, 'package.json'), JSON.stringify({
    name: THIRD_PARTY_DEPENDENCY_NAME,
    version: '0.0.0',
    type: 'module',
    exports: './index.js',
  }) + '\n')
  writeFileSync(join(thirdPartyDependencyDir, 'index.js'), 'export const marker = "profile dependency"\n')
  writeFileSync(join(thirdPartyDir, 'package.json'), JSON.stringify({
    name: THIRD_PARTY_NAME,
    version: '0.0.0',
    type: 'module',
    exports: './index.js',
    dependencies: { [THIRD_PARTY_DEPENDENCY_NAME]: '0.0.0' },
  }) + '\n')
  writeFileSync(join(thirdPartyDir, 'index.js'), [
    "import { delimiter } from 'node:path'",
    `import { marker } from '${THIRD_PARTY_DEPENDENCY_NAME}'`,
    'export function apply(ctx) {',
    "  if (marker !== 'profile dependency') throw new Error('linked plugin did not resolve its profile dependency')",
    `  const expected = ${JSON.stringify(pnpmRuntime.pathDir)}`,
    '  const actual = (process.env.PATH ?? \'\').split(delimiter)[0]',
    '  if (actual !== expected) throw new Error(`third-party plugin received ${actual} instead of packaged pnpm PATH ${expected}`)',
    "  const launchPath = ctx.launchEnvironment?.get('PATH')?.value",
    `  if (launchPath !== ${JSON.stringify(launchPath)}) throw new Error('third-party plugin received a mutated launch-environment PATH snapshot')`,
    `  const runnerNames = new Set(${JSON.stringify([...RUNNER_ENVIRONMENT_NAMES])})`,
    "  const leaked = Object.keys(process.env).filter(key => runnerNames.has(key.toUpperCase()))",
    "  if (leaked.length > 0) throw new Error(`third-party plugin received runner-only environment: ${leaked.join(', ')}`)",
    '}',
    '',
  ].join('\n'))
  symlinkSync(thirdPartyDir, thirdPartyLink, 'junction')
  releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  const profileRequire = createRequire(prepared.bareModuleBaseUrl)
  const desktopManifest = fileURLToPath(new URL('../package.json', import.meta.url))
  if (profileRequire.resolve('dsh-plugin-desktop/package.json') !== desktopManifest) {
    throw new Error('desktop package manifest did not resolve from the installed launcher')
  }
  const profileDirectoryRequire = createRequire(new URL('.', prepared.bareModuleBaseUrl))
  if (profileDirectoryRequire.resolve('dsh-plugin-desktop/package.json') !== desktopManifest) {
    throw new Error('desktop package manifest did not resolve from the profile directory')
  }

  const runtime = {
    platform: 'darwin',
    schedule(spec) {
      mountedSpec = spec
      return async () => { await mounted }
    },
    mountScheduled() {
      if (mountedSpec === undefined) return Promise.reject(new Error('desktop shell was not registered'))
      mounted ??= Promise.resolve()
      return mounted
    },
    show() {},
    async requestRestart() {},
    prepareToQuit() {},
  }
  ctx = await boot(
    BIN_NAME,
    prepared.rootConfig,
    [{ insert: [
      { id: 'desktop-shell', name: 'dsh-plugin-desktop' },
      { id: 'community-market', name: 'dsh-community-market' },
      { id: 'third-party-smoke', name: THIRD_PARTY_NAME },
    ] }],
    (host) => {
      // Packaged Electron does not expose Node's internal ESM loader.
      host.loader.internal = undefined
      host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, launchEnvironment)
      host.provide('desktopRuntime', runtime)
      host.provide('webServer', {
        host: '127.0.0.1',
        port: 43120,
        register() { return () => {} },
      })
      host.provide('webRuntime', {})
      host.provide('appExit', () => {})
      host.provide('settings', {
        register() {
          return {
            get: () => ({ mode: 'compatibility' }),
            watch: () => () => {},
            update: async () => {},
            replace: async () => {},
          }
        },
      })
    },
    prepared.bareModuleBaseUrl,
  )
  await runtime.mountScheduled()

  const desktopEntry = ctx.loader.resolve('include:desktop-shell')
  const marketEntry = ctx.loader.resolve('include:community-market')
  const thirdPartyEntry = ctx.loader.resolve('include:third-party-smoke')
  if (desktopEntry?.options.name !== 'dsh-plugin-desktop') {
    throw new Error('launcher-owned desktop plugin did not activate through its bare package name')
  }
  if (thirdPartyEntry?.options.name !== THIRD_PARTY_NAME) {
    throw new Error('profile-local third-party plugin did not activate')
  }
  if (marketEntry?.options.name !== 'dsh-community-market') {
    throw new Error('community market Host plugin did not activate through its bare package name')
  }
  if (mountedSpec?.mode !== 'compatibility') {
    throw new Error(`desktop plugin produced an unexpected shell mode: ${String(mountedSpec?.mode)}`)
  }
  if (mountedSpec?.url !== 'http://127.0.0.1:43120/?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin') {
    throw new Error(`desktop plugin produced an unexpected renderer URL: ${String(mountedSpec?.url)}`)
  }
} finally {
  try {
    await ctx?.fiber.dispose()
  } finally {
    try {
      releasePackageResolver?.()
    } finally {
      try {
        pnpmRuntime?.dispose()
      } finally {
        for (const key of Object.keys(process.env)) {
          if (RUNNER_ENVIRONMENT_NAMES.has(key.toUpperCase())) {
            delete process.env[key]
          }
        }
        for (const [key, value] of runnerEnvironment) process.env[key] = value
        rmSync(home, { recursive: true, force: true })
      }
    }
  }
}
