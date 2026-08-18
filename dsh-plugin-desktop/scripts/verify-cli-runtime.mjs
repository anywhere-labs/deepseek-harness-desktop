/** Headless artifact smoke for the Electron-backed dsh and pnpm command entries. */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { installDesktopPnpmRuntime } from '../lib/desktop-runtime-environment.js'

const packageRoot = new URL('../', import.meta.url)
const desktopCli = fileURLToPath(new URL('lib/desktop-cli.js', packageRoot))
const dshAppBootPackage = fileURLToPath(new URL('node_modules/@deepseek-ai/dsh-app-boot/', packageRoot))
const dshAtomicWritePackage = fileURLToPath(new URL('node_modules/@deepseek-ai/dsh-atomic-write/', packageRoot))
const dshPackage = fileURLToPath(new URL('node_modules/@deepseek-ai/dsh/', packageRoot))
const pnpmCli = fileURLToPath(new URL('node_modules/pnpm/bin/pnpm.mjs', packageRoot))
const dshVersion = JSON.parse(readFileSync(new URL('node_modules/@deepseek-ai/dsh/package.json', packageRoot), 'utf8')).version
const pnpmVersion = JSON.parse(readFileSync(new URL('node_modules/pnpm/package.json', packageRoot), 'utf8')).version
const electronVersion = JSON.parse(readFileSync(new URL('node_modules/electron/package.json', packageRoot), 'utf8')).version
const RUNNER_ENVIRONMENT_NAMES = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NPM_CONFIG_RUNTIME',
  'NPM_CONFIG_TARGET',
  'NPM_CONFIG_DISTURL',
])

function cleanEnvironment() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase()
    if (!RUNNER_ENVIRONMENT_NAMES.has(normalized)) env[key] = value
  }
  return env
}

function assertNoRunnerEnvironment(label, env) {
  const leaked = Object.keys(env).filter((key) => {
    return RUNNER_ENVIRONMENT_NAMES.has(key.toUpperCase())
  })
  if (leaked.length > 0) {
    throw new Error(`${label} leaked runner-only environment variables: ${leaked.join(', ')}`)
  }
}

function verifyResult(label, result, expectedOutput) {
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} artifact smoke exited ${String(result.status)}: ${result.stderr.trim()}`)
  }
  if (expectedOutput === undefined) return
  const output = result.stdout.trim()
  const matches = expectedOutput instanceof RegExp
    ? expectedOutput.test(output)
    : output === expectedOutput
  if (!matches) {
    throw new Error(`${label} artifact smoke returned ${JSON.stringify(output)} instead of matching ${String(expectedOutput)}`)
  }
}

function runElectronEntry(label, nodeArgs, entry, args, expectedOutput, extraEnvironment = {}) {
  const env = cleanEnvironment()
  Object.assign(env, extraEnvironment)
  env.ELECTRON_RUN_AS_NODE = '1'
  const result = spawnSync(electronPath, [...nodeArgs, entry, ...args], {
    encoding: 'utf8',
    env,
    shell: false,
  })
  verifyResult(label, result, expectedOutput)
}

function environmentValue(env, name) {
  const normalized = name.toUpperCase()
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalized)?.[1]
}

function runPnpm(env, args, cwd) {
  return process.platform === 'win32'
    ? spawnSync(environmentValue(env, 'ComSpec') ?? 'cmd.exe', ['/d', '/s', '/c', `pnpm ${args.join(' ')}`], {
        cwd,
        encoding: 'utf8',
        env,
        shell: false,
      })
    : spawnSync('pnpm', args, {
        cwd,
        encoding: 'utf8',
        env,
        shell: false,
      })
}

function verifyLifecycleEnvironment(stateRoot, installation, env) {
  const project = join(stateRoot, 'lifecycle-project')
  const resultPath = join(project, 'result.json')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'dsh-desktop-pnpm-lifecycle-smoke',
    version: '0.0.0',
    private: true,
    scripts: { install: 'node lifecycle.mjs' },
  }) + '\n')
  writeFileSync(join(project, 'lifecycle.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    "writeFileSync(new URL('result.json', import.meta.url), JSON.stringify({",
    "  runAsNode: Object.keys(process.env).filter(name => name.toUpperCase() === 'ELECTRON_RUN_AS_NODE'),",
    '  node: process.env.NODE,',
    '  npmNodeExecPath: process.env.npm_node_execpath,',
    '  runtime: process.env.npm_config_runtime,',
    '  target: process.env.npm_config_target,',
    '  disturl: process.env.npm_config_disturl,',
    '}))',
    '',
  ].join('\n'))

  const result = runPnpm(env, ['install', '--offline', '--reporter=silent'], project)
  verifyResult('pnpm lifecycle smoke', result, '')
  const actual = JSON.parse(readFileSync(resultPath, 'utf8'))
  const expected = {
    runAsNode: [],
    node: installation.nodeShimPath,
    npmNodeExecPath: installation.nodeShimPath,
    runtime: 'electron',
    target: electronVersion,
    disturl: 'https://electronjs.org/headers',
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`pnpm lifecycle smoke returned ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`)
  }
}

function runPackagedPnpmShim() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-smoke-'))
  const env = cleanEnvironment()
  let installation
  try {
    installation = installDesktopPnpmRuntime({
      platform: process.platform,
      appExecutable: electronPath,
      pnpmBinPath: pnpmCli,
      electronVersion,
      stateDir: join(stateRoot, 'runtime'),
      environment: env,
    })
    assertNoRunnerEnvironment('pnpm Host PATH installation', env)
    const result = runPnpm(env, ['--version'])
    verifyResult('pnpm PATH shim', result, pnpmVersion)
    verifyLifecycleEnvironment(stateRoot, installation, env)
    assertNoRunnerEnvironment('pnpm Host PATH after child exit', env)
  } finally {
    try {
      installation?.dispose()
      assertNoRunnerEnvironment('pnpm Host PATH disposal', env)
    } finally {
      rmSync(stateRoot, { recursive: true, force: true })
    }
  }
}

function runFlatProfileDshEntry() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-flat-cli-smoke-'))
  const desktopPackage = join(root, 'node_modules', 'dsh-plugin-desktop')
  const linkedAppBootPackage = join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  const linkedAtomicWritePackage = join(root, 'node_modules', '@deepseek-ai', 'dsh-atomic-write')
  const linkedDshPackage = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  try {
    mkdirSync(join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
    cpSync(fileURLToPath(new URL('lib/', packageRoot)), join(desktopPackage, 'lib'), { recursive: true })
    cpSync(fileURLToPath(new URL('package.json', packageRoot)), join(desktopPackage, 'package.json'))
    symlinkSync(dshAppBootPackage, linkedAppBootPackage, process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(dshAtomicWritePackage, linkedAtomicWritePackage, process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(dshPackage, linkedDshPackage, process.platform === 'win32' ? 'junction' : 'dir')
    runElectronEntry(
      'flat profile dsh plugin help',
      ['--expose-internals'],
      join(desktopPackage, 'lib', 'desktop-cli.js'),
      ['plugin', '--help'],
      undefined,
      { DSH_DESKTOP_DEFAULT_PROFILE: 'desktop' },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

runElectronEntry('dsh', ['--expose-internals'], desktopCli, ['--version'], dshVersion)
runFlatProfileDshEntry()
runPackagedPnpmShim()
