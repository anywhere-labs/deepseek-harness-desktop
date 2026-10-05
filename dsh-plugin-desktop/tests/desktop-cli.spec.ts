import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  clearElectronRunAsNode,
  ensurePackagedPnpmOnPath,
  desktopCliProfileManifestUrl,
  runDesktopDshCli,
  selectedDesktopCliProfile,
  withDefaultDesktopProfile,
} from '../src/desktop-cli.ts'
import { packagedDependencyPath, unpackedAsarPath } from '../src/packaged-runtime-path.ts'

describe('packaged dsh bootstrap', () => {
  it('removes every Windows casing of Electron Node mode', () => {
    const environment = {
      ELECTRON_RUN_AS_NODE: '1',
      electron_run_as_node: 'inherited',
      Path: 'C:\\Windows',
    }

    clearElectronRunAsNode(environment)

    expect(environment).toEqual({ Path: 'C:\\Windows' })
  })

  it('clears Node mode and dispatches the imported CLI exactly once', async () => {
    const environment = {
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP_DEFAULT_PROFILE: 'desktop',
      KEEP: 'value',
    }
    const argv = ['/Applications/DSH Desktop', '/app.asar/lib/desktop-cli.js', '--dump-config']
    const runCli = vi.fn(async () => {})
    const load = vi.fn(async (url: string) => {
      expect(environment).toEqual({ KEEP: 'value' })
      expect(argv).toEqual([
        '/Applications/DSH Desktop',
        '/app.asar/lib/desktop-cli.js',
        '--profile',
        'desktop',
        '--dump-config',
      ])
      expect(url).toMatch(/\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/u)
      return { runCli }
    })

    await runDesktopDshCli(environment, load, argv)

    expect(load).toHaveBeenCalledOnce()
    expect(runCli).toHaveBeenCalledOnce()
    expect(runCli).toHaveBeenCalledWith({ manageDesktopProfile: true })
  })

  it('propagates a rejected upstream CLI invocation', async () => {
    const failure = new Error('CLI startup failed')
    const load = async () => ({ runCli: async () => { throw failure } })
    await expect(runDesktopDshCli({}, load, ['node', 'desktop-cli', '--version'])).rejects.toBe(failure)
  })

  it('reads user files physically before the unpacked CLI starts', async () => {
    const asarProcess: { noAsar?: boolean } = {}
    const load = vi.fn(async () => {
      expect(asarProcess.noAsar).toBe(true)
      return { runCli: async () => {} }
    })
    await runDesktopDshCli({}, load, ['node', 'desktop-cli', '--version'], asarProcess)
    expect(load).toHaveBeenCalledOnce()
  })

  it('leaves the release-age policy to the final pnpm shim exactly once', async () => {
    const load = vi.fn(async () => ({ runCli: async () => {} }))
    const defaulted = [
      '/Applications/DSH Desktop',
      '/app.asar/lib/desktop-cli.js',
      'plugin',
      '--config.minimumReleaseAge=0',
      'remove',
      'example-plugin',
    ]
    await runDesktopDshCli({ DSH_DESKTOP_DEFAULT_PROFILE: 'desktop' }, load, defaulted)
    expect(defaulted.slice(2)).toEqual([
      'plugin',
      '--profile',
      'desktop',
      'remove',
      'example-plugin',
    ])

    const explicit = [
      '/Applications/DSH Desktop',
      '/app.asar/lib/desktop-cli.js',
      'plugin',
      '--profile=work',
      '--config.minimumReleaseAge=0',
      'update',
    ]
    await runDesktopDshCli({}, load, explicit)
    expect(explicit.slice(2)).toEqual(['plugin', '--profile=work', 'update'])
  })

  it('defaults profile and plugin commands without overriding explicit or global modes', () => {
    expect(withDefaultDesktopProfile([], 'desktop')).toEqual(['--profile', 'desktop'])
    expect(withDefaultDesktopProfile(['--dump-config'], 'desktop')).toEqual([
      '--profile',
      'desktop',
      '--dump-config',
    ])
    expect(withDefaultDesktopProfile(['plugin', 'add', 'third-party'], 'desktop')).toEqual([
      'plugin',
      '--profile',
      'desktop',
      'add',
      'third-party',
    ])
    expect(withDefaultDesktopProfile(['--profile', 'web'], 'desktop')).toEqual(['--profile', 'web'])
    expect(withDefaultDesktopProfile(['--profile=web'], 'desktop')).toEqual(['--profile=web'])
    expect(withDefaultDesktopProfile(['web'], 'desktop')).toEqual(['web'])
    expect(withDefaultDesktopProfile(['--help'], 'desktop')).toEqual(['--help'])
    expect(withDefaultDesktopProfile(['--version'], 'desktop')).toEqual(['--version'])
    expect(withDefaultDesktopProfile(['plugin', 'update'], '工作 profile')).toEqual([
      'plugin',
      '--profile',
      '工作 profile',
      'update',
    ])
    expect(() => withDefaultDesktopProfile([], '../desktop')).toThrow('invalid desktop profile name')
  })

  it('finds the Profile selected by every supported CLI spelling', () => {
    expect(selectedDesktopCliProfile(['--profile', 'desktop', '--dump-config'])).toBe('desktop')
    expect(selectedDesktopCliProfile(['plugin', '--profile=work', 'update'])).toBe('work')
    expect(selectedDesktopCliProfile(['web', '--help'])).toBe('web')
    expect(selectedDesktopCliProfile(['--version'])).toBeUndefined()
  })

  it('resolves CLI Profiles through DSH_HOME without allowing path traversal', () => {
    const home = join(tmpdir(), 'dsh cli profile home')
    expect(desktopCliProfileManifestUrl('工作 profile', { DSH_HOME: home })).toBe(
      pathToFileURL(join(home, 'profiles', '工作 profile', 'package.json')).href,
    )
    expect(() => desktopCliProfileManifestUrl('../outside', { DSH_HOME: home }))
      .toThrow('invalid profile name')
    expect(() => desktopCliProfileManifestUrl('nested/profile', { DSH_HOME: home }))
      .toThrow('invalid profile name')
    expect(() => desktopCliProfileManifestUrl('node_modules', { DSH_HOME: home }))
      .toThrow('invalid profile name')
  })

  it('uses the physical unpacked dependency tree only inside an Electron package', () => {
    expect(unpackedAsarPath('/Applications/DSH Desktop.app/Contents/Resources/app.asar/node_modules/pkg'))
      .toBe('/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/pkg')
    expect(unpackedAsarPath('C:\\Program Files\\DSH Desktop\\resources\\app.asar\\node_modules\\pkg'))
      .toBe('C:\\Program Files\\DSH Desktop\\resources\\app.asar.unpacked\\node_modules\\pkg')
    expect(unpackedAsarPath('/Applications/DSH Desktop.app/Contents/Resources/app.asar/package.json'))
      .toBe('/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/package.json')
    expect(unpackedAsarPath('/workspace/node_modules/pkg')).toBe('/workspace/node_modules/pkg')
    expect(() => packagedDependencyPath(import.meta.url, '../outside.js'))
      .toThrow('relative POSIX path')
  })

  it('keeps a resolved JavaScript dependency in the logical ASAR tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-asar-profile-'))
    const desktopLib = join(root, 'app.asar', 'lib')
    const dshPackage = join(root, 'app.asar', 'node_modules', '@deepseek-ai', 'dsh')
    try {
      mkdirSync(desktopLib, { recursive: true })
      mkdirSync(join(dshPackage, 'lib'), { recursive: true })
      writeFileSync(join(dshPackage, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh',
        type: 'module',
      }))
      writeFileSync(join(dshPackage, 'lib', 'bin.js'), '')

      const moduleUrl = pathToFileURL(join(desktopLib, 'desktop-cli.js')).href
      expect(packagedDependencyPath(moduleUrl, '@deepseek-ai/dsh/lib/bin.js')).toBe(join(
        realpathSync(root),
        'app.asar',
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'lib',
        'bin.js',
      ))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves the DSH entry from a pnpm profile with flat package dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-flat-profile-'))
    const desktopLib = join(root, 'node_modules', 'dsh-plugin-desktop', 'lib')
    const dshPackage = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    const dshEntry = join(dshPackage, 'lib', 'bin.js')
    const pnpmPackage = join(root, 'node_modules', 'pnpm')
    const pnpmEntry = join(pnpmPackage, 'bin', 'pnpm.mjs')
    try {
      mkdirSync(desktopLib, { recursive: true })
      mkdirSync(join(dshPackage, 'lib'), { recursive: true })
      mkdirSync(join(pnpmPackage, 'bin'), { recursive: true })
      writeFileSync(join(dshPackage, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh',
        type: 'module',
      }))
      writeFileSync(dshEntry, '')
      writeFileSync(join(pnpmPackage, 'package.json'), JSON.stringify({
        name: 'pnpm',
        exports: { '.': './package.json' },
      }))
      writeFileSync(pnpmEntry, '')

      const moduleUrl = pathToFileURL(join(desktopLib, 'desktop-cli.js')).href
      expect(packagedDependencyPath(moduleUrl, '@deepseek-ai/dsh/lib/bin.js'))
        .toBe(join(realpathSync(root), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      expect(packagedDependencyPath(moduleUrl, 'pnpm/bin/pnpm.mjs'))
        .toBe(join(realpathSync(root), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

const isWin = process.platform === 'win32'
const shimDir = join(tmpdir(), `dsh-desktop-cli-${process.platform}-${process.arch}`)
const shimPath = join(shimDir, isWin ? 'pnpm.cmd' : 'pnpm')

describe('ensurePackagedPnpmOnPath', () => {
  it('leaves PATH untouched outside the Electron runtime', () => {
    // Unit tests run under plain Node: process.versions.electron is undefined.
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    ensurePackagedPnpmOnPath(environment)
    expect(environment.PATH).toBe('/usr/bin')
  })

  // The remaining assertions validate the shim contract the Electron path
  // relies on; they run the filesystem branch directly via a temporary stub.
  it.runIf(process.versions.electron !== undefined)('prepends a private shim dir to PATH', () => {
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    ensurePackagedPnpmOnPath(environment)
    expect(environment.PATH?.startsWith(`${shimDir}${delimiter}`)).toBe(true)
    expect(environment.PATH).toContain('/usr/bin')
  })

  it.runIf(process.versions.electron !== undefined)('writes an executable shim pointing at the packaged pnpm', () => {
    const environment: NodeJS.ProcessEnv = { PATH: '' }
    ensurePackagedPnpmOnPath(environment)
    const content = readFileSync(shimPath, 'utf8')
    expect(content).toContain('pnpm.mjs')
    expect(content).toContain('ELECTRON_RUN_AS_NODE')
    expect(content).toContain('npm_config_runtime=electron')
    expect(content).toContain('--config.minimumReleaseAge=0')
    if (!isWin) {
      expect(statSync(shimPath).mode & 0o111).not.toBe(0)
      expect(content.startsWith('#!/bin/sh\n')).toBe(true)
    }
  })
})
