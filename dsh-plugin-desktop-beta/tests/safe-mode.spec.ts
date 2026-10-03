import { spawnSync } from 'node:child_process'
import * as fileSystem from 'node:fs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupDesktopSafeModeEnvironment,
  DESKTOP_SAFE_MODE_DEFAULTS,
  DESKTOP_SAFE_MODE_PROFILE_NAME,
  desktopSafeModePaths,
  ensureDesktopSafeModeEnvironment,
  resetDesktopSafeModeEnvironment,
} from '../src/safe-mode.ts'

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
}))

describe('Desktop Safe Mode environment', () => {
  const roots: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
  })

  async function userData(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-safe-mode-'))
    roots.push(root)
    return root
  }

  async function linkedEnvironment() {
    const root = await userData()
    const userDataDir = join(root, 'desktop-user-data')
    const paths = resetDesktopSafeModeEnvironment(userDataDir)
    const protectedFiles: string[] = []
    const links: string[] = []
    for (const packageName of ['@img/colour', 'ajv', 'ajv-formats']) {
      const target = join(root, 'installation', 'node_modules', packageName)
      const link = join(paths.homeDir, 'profiles', 'node_modules', packageName)
      mkdirSync(target, { recursive: true })
      mkdirSync(dirname(link), { recursive: true })
      const file = join(target, 'index.js')
      writeFileSync(file, 'installation dependency must survive')
      fileSystem.symlinkSync(target, link, 'junction')
      protectedFiles.push(file)
      links.push(link)
    }
    return { userDataDir, paths, protectedFiles, links }
  }

  it('uses a visible Safe Mode label for its disposable Profile', () => {
    expect(DESKTOP_SAFE_MODE_PROFILE_NAME).toBe('desktop-safe-mode')
  })

  it('uses fixed non-interactive defaults for the disposable Profile', () => {
    expect(DESKTOP_SAFE_MODE_DEFAULTS).toEqual({
      aaEnabled: false,
      market: 'disabled',
      settings: {
        mode: 'compatibility',
        macosMaterial: 'off',
        windowsMaterial: 'off',
        openBrowser: false,
        networkExposure: 'loopback',
        notifications: {
          enabled: false,
          notifyOnTurnCompletion: false,
          notifyOnTurnFailure: false,
          notifyOnJobCompletion: false,
          notifyOnJobFailure: false,
          notifyOnScheduleCompletion: false,
          notifyOnScheduleFailure: false,
        },
      },
    })
  })

  it('creates an isolated DSH home and Desktop state outside the normal Harness home', async () => {
    const root = await userData()
    const paths = resetDesktopSafeModeEnvironment(root, () => new Date('2026-09-03T00:00:00.000Z'))

    expect(paths).toEqual(desktopSafeModePaths(root))
    expect(paths.homeDir).toBe(join(root, 'safe-mode', 'dsh-home'))
    expect(paths.userDataDir).toBe(join(root, 'safe-mode', 'desktop-state'))
    expect(JSON.parse(readFileSync(join(paths.rootDir, 'environment.json'), 'utf8'))).toEqual({
      version: 1,
      createdAt: '2026-09-03T00:00:00.000Z',
    })
  })

  it('creates a usable environment even when directory renames are denied on Windows', async () => {
    const root = await userData()
    const rename = vi.spyOn(fileSystem, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    })

    const paths = resetDesktopSafeModeEnvironment(root)

    expect(rename).not.toHaveBeenCalled()
    expect(existsSync(join(paths.rootDir, 'environment.json'))).toBe(true)
    expect(ensureDesktopSafeModeEnvironment(root)).toEqual(paths)
  })

  it('publishes the completion marker only after directories and permissions are ready', async () => {
    const root = await userData()
    const paths = desktopSafeModePaths(root)
    const permissions = vi.spyOn(fileSystem, 'chmodSync')

    resetDesktopSafeModeEnvironment(root, () => {
      expect(existsSync(paths.homeDir)).toBe(true)
      expect(existsSync(paths.userDataDir)).toBe(true)
      expect(permissions).toHaveBeenCalledWith(paths.rootDir, 0o700)
      expect(permissions).toHaveBeenCalledWith(paths.homeDir, 0o700)
      expect(permissions).toHaveBeenCalledWith(paths.userDataDir, 0o700)
      expect(existsSync(join(paths.rootDir, 'environment.json'))).toBe(false)
      return new Date('2026-09-03T00:00:00.000Z')
    })

    expect(existsSync(join(paths.rootDir, 'environment.json'))).toBe(true)
  })

  it('cleans an incomplete environment when writing the completion marker fails', async () => {
    const root = await userData()
    const paths = desktopSafeModePaths(root)
    const failure = Object.assign(new Error('ENOSPC: cannot write completion marker'), { code: 'ENOSPC' })
    vi.spyOn(fileSystem, 'writeFileSync').mockImplementationOnce(() => { throw failure })

    expect(() => resetDesktopSafeModeEnvironment(root)).toThrow(failure)
    expect(existsSync(paths.rootDir)).toBe(false)
    expect(ensureDesktopSafeModeEnvironment(root)).toEqual(paths)
    expect(existsSync(join(paths.rootDir, 'environment.json'))).toBe(true)
  })

  it('replaces an interrupted generation that has directories but no completion marker', async () => {
    const root = await userData()
    const paths = desktopSafeModePaths(root)
    mkdirSync(paths.homeDir, { recursive: true })
    mkdirSync(paths.userDataDir, { recursive: true })
    writeFileSync(join(paths.homeDir, 'incomplete-session'), 'discard')

    expect(ensureDesktopSafeModeEnvironment(root)).toEqual(paths)
    expect(existsSync(join(paths.homeDir, 'incomplete-session'))).toBe(false)
    expect(existsSync(join(paths.rootDir, 'environment.json'))).toBe(true)
  })

  it('adopts one prepared Safe Mode generation but resets an invalid environment', async () => {
    const root = await userData()
    const paths = resetDesktopSafeModeEnvironment(root)
    writeFileSync(join(paths.homeDir, 'session-data'), 'keep while active')

    expect(ensureDesktopSafeModeEnvironment(root)).toEqual(paths)
    expect(readFileSync(join(paths.homeDir, 'session-data'), 'utf8')).toBe('keep while active')

    writeFileSync(join(paths.rootDir, 'environment.json'), '{broken')
    const repaired = ensureDesktopSafeModeEnvironment(root)
    expect(repaired).toEqual(paths)
    expect(() => readFileSync(join(paths.homeDir, 'session-data'), 'utf8')).toThrow()
  })

  it('removes all disposable data on the next normal launch', async () => {
    const root = await userData()
    const paths = resetDesktopSafeModeEnvironment(root)
    mkdirSync(join(paths.homeDir, 'profiles', DESKTOP_SAFE_MODE_PROFILE_NAME), { recursive: true })
    writeFileSync(join(paths.homeDir, 'profiles', DESKTOP_SAFE_MODE_PROFILE_NAME, 'session.json'), '{}')
    writeFileSync(join(paths.userDataDir, 'selection.json'), '{}')

    expect(cleanupDesktopSafeModeEnvironment(root)).toBe(true)
    expect(cleanupDesktopSafeModeEnvironment(root)).toBe(false)
    expect(() => readFileSync(join(paths.homeDir, 'profiles', DESKTOP_SAFE_MODE_PROFILE_NAME, 'session.json'))).toThrow()
  })

  it('removes fallback junctions without deleting installation dependencies', async () => {
    const fixture = await linkedEnvironment()
    const recursiveRemove = vi.spyOn(fileSystem, 'rmSync')

    expect(cleanupDesktopSafeModeEnvironment(fixture.userDataDir)).toBe(true)

    expect(existsSync(fixture.paths.rootDir)).toBe(false)
    expect(recursiveRemove).not.toHaveBeenCalled()
    for (const file of fixture.protectedFiles) {
      expect(readFileSync(file, 'utf8')).toBe('installation dependency must survive')
    }
  })

  it('preserves linked installation dependencies when a new Safe Mode generation replaces the old one', async () => {
    const fixture = await linkedEnvironment()

    expect(resetDesktopSafeModeEnvironment(fixture.userDataDir)).toEqual(fixture.paths)

    expect(existsSync(join(fixture.paths.homeDir, 'profiles'))).toBe(false)
    for (const file of fixture.protectedFiles) {
      expect(readFileSync(file, 'utf8')).toBe('installation dependency must survive')
    }
  })

  it('unlinks a Safe Mode root junction without deleting its target', async () => {
    const root = await userData()
    const target = join(root, 'unrelated-data')
    mkdirSync(target)
    writeFileSync(join(target, 'keep'), 'unrelated data')
    const paths = desktopSafeModePaths(root)
    fileSystem.symlinkSync(target, paths.rootDir, 'junction')

    expect(cleanupDesktopSafeModeEnvironment(root)).toBe(true)
    expect(existsSync(paths.rootDir)).toBe(false)
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('unrelated data')
  })

  it('removes dangling junctions and read-only disposable files', async () => {
    const root = await userData()
    const paths = resetDesktopSafeModeEnvironment(root)
    const target = join(root, 'removed-installation')
    mkdirSync(target)
    fileSystem.symlinkSync(target, join(paths.homeDir, 'dangling'), 'junction')
    fileSystem.rmdirSync(target)
    const readOnlyFile = join(paths.userDataDir, 'read-only.json')
    writeFileSync(readOnlyFile, '{}')
    fileSystem.chmodSync(readOnlyFile, 0o400)

    expect(cleanupDesktopSafeModeEnvironment(root)).toBe(true)
    expect(existsSync(paths.rootDir)).toBe(false)
  })

  it('reports a locked junction after bounded retries without falling back to recursive removal', async () => {
    const fixture = await linkedEnvironment()
    const failure = Object.assign(new Error('EBUSY: junction is locked'), { code: 'EBUSY' })
    const unlink = fileSystem.unlinkSync
    const removeLink = vi.spyOn(fileSystem, 'unlinkSync').mockImplementation(path => {
      if (path === fixture.links[0]) throw failure
      unlink(path)
    })
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
    const recursiveRemove = vi.spyOn(fileSystem, 'rmSync')

    expect(() => cleanupDesktopSafeModeEnvironment(fixture.userDataDir)).toThrow(failure)

    expect(removeLink.mock.calls.filter(([path]) => path === fixture.links[0])).toHaveLength(4)
    expect(wait).toHaveBeenCalledTimes(3)
    expect(recursiveRemove).not.toHaveBeenCalled()
    for (const file of fixture.protectedFiles) {
      expect(readFileSync(file, 'utf8')).toBe('installation dependency must survive')
    }
  })

  it.skipIf(process.platform !== 'win32')('preserves installation targets during cleanup in the real Windows Electron runtime', async () => {
    const fixture = await linkedEnvironment()
    const executable: unknown = createRequire(import.meta.url)('electron')
    if (typeof executable !== 'string') throw new TypeError('Electron executable path is unavailable')
    const source = new URL('../src/safe-mode.ts', import.meta.url).href
    const result = spawnSync(executable, ['--experimental-strip-types', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict'
      import { cleanupDesktopSafeModeEnvironment } from ${JSON.stringify(source)}
      assert.ok(process.versions.electron)
      assert.equal(cleanupDesktopSafeModeEnvironment(${JSON.stringify(fixture.userDataDir)}), true)
    `], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })

    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(fixture.paths.rootDir)).toBe(false)
    for (const file of fixture.protectedFiles) {
      expect(readFileSync(file, 'utf8')).toBe('installation dependency must survive')
    }
  }, 40_000)

  it('rejects relative or NUL-bearing userData paths', () => {
    expect(() => desktopSafeModePaths('relative')).toThrow(/absolute path/u)
    expect(() => desktopSafeModePaths('/tmp/bad\0path')).toThrow(/absolute path/u)
  })
})
