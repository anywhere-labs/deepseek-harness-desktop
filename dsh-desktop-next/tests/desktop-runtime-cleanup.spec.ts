import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cleanupDisposableTree } from '../../dsh-plugin-desktop-beta/src/disposable-tree.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NextDesktopRuntime } from '../src/desktop-runtime.ts'
import { DEFAULT_PREFERENCES, SAFE_MODE_PREFERENCES } from '../src/desktop-contract.ts'
import { NextProfiles } from '../src/profiles.ts'

vi.mock('../../dsh-plugin-desktop-beta/src/disposable-tree.ts', () => ({
  cleanupDisposableTree: vi.fn(),
}))

const cleanup: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(cleanupDisposableTree).mockReset()
  for (const dispose of cleanup.splice(0)) dispose()
})

async function fixture(prepare?: (home: string) => Partial<ConstructorParameters<typeof NextDesktopRuntime>[0]>) {
  const home = mkdtempSync(join(tmpdir(), 'next-safe-cleanup-'))
  const runtime = new NextDesktopRuntime({ home, root: home, executable: process.execPath, addresses: () => [],
    certificate: async () => { throw new Error('No native certificate access in this test') },
    onFailure: vi.fn(), onChange() {}, onRestart() {}, onTerminal() {}, onNotification() {},
    ...prepare?.(home),
  })
  cleanup.push(() => { runtime.diagnostics.flush(); rmSync(home, { recursive: true, force: true }) })
  // Run real safe-home preparation without spawning a Host or opening Electron.
  vi.spyOn(runtime.backend, 'start').mockImplementation(async prepare => { await prepare() })
  runtime.safeMode = true
  runtime.initialize()
  await runtime.start()
  const safeHome = runtime.terminalTarget().homeDir
  return { runtime, home, safeHome }
}

it('keeps Next safe-home preparation and bypasses broken original settings and Profile selection', async () => {
  const { runtime, home, safeHome } = await fixture(home => {
    writeFileSync(join(home, 'desktop-preferences.json'), '{broken preferences')
    writeFileSync(join(home, 'desktop-next.json'), '{broken selection')
    const profiles = new NextProfiles(home)
    profiles.ensure('desktop')
    writeFileSync(join(profiles.directory('desktop'), 'package.json'), '{broken Profile')
    return { stateHome: join(home, 'electron-user-data', 'safe-mode') }
  })
  expect(runtime.options.onFailure).not.toHaveBeenCalled()
  expect(runtime.preferences).toEqual(SAFE_MODE_PREFERENCES)
  expect(runtime.settings.file).toBe(join(home, 'electron-user-data', 'safe-mode', 'desktop-preferences.json'))
  expect(safeHome).toContain(join(runtime.recovery.directory, 'safe-runtime-'))
  expect(runtime.terminalTarget().profileName).toBe('desktop')
  expect(new NextProfiles(safeHome).features('desktop')).toEqual({ remoteControl: false, market: false })
  expect(runtime.state().features).toEqual({ remoteControl: false, market: false })
  expect(() => runtime.writePreferences(DEFAULT_PREFERENCES)).toThrow('fixed')
  expect(readFileSync(join(home, 'desktop-preferences.json'), 'utf8')).toBe('{broken preferences')
  expect(readFileSync(join(home, 'desktop-next.json'), 'utf8')).toBe('{broken selection')
  expect(readFileSync(join(runtime.profiles.directory('desktop'), 'package.json'), 'utf8')).toBe('{broken Profile')
})

it('restores normal saved preferences when the headless runtime leaves Safe Mode', async () => {
  const saved = { ...DEFAULT_PREFERENCES, port: 43123, logLevel: 'debug' }
  const { runtime } = await fixture(home => {
    writeFileSync(join(home, 'desktop-preferences.json'), JSON.stringify(saved))
    return {}
  })
  expect(runtime.preferences).toEqual(SAFE_MODE_PREFERENCES)
  await runtime.restart(() => { runtime.safeMode = false })
  expect(runtime.preferences).toEqual(saved)
})

it('waits for Host shutdown before removing the safe home and completing close', async () => {
  const { runtime, safeHome } = await fixture()
  let finishStop!: () => void
  vi.spyOn(runtime.backend, 'close').mockImplementation(() => new Promise(resolve => { finishStop = resolve }))
  vi.mocked(cleanupDisposableTree).mockImplementation(path => { rmSync(path, { recursive: true, force: true }); return true })
  const closing = runtime.close()
  expect(cleanupDisposableTree).not.toHaveBeenCalled()
  finishStop()
  await closing
  expect(existsSync(safeHome)).toBe(false)
  expect(cleanupDisposableTree).toHaveBeenCalledWith(safeHome)
})

it.each(['EPERM', 'EBUSY'])('allows relaunch after %s cleaning the safe home and persists a warning', async code => {
  const { runtime, safeHome } = await fixture()
  vi.mocked(cleanupDisposableTree).mockImplementation(() => { throw Object.assign(new Error(`${code}: directory is locked`), { code }) })
  await expect(runtime.close()).resolves.toBeUndefined()
  expect(existsSync(safeHome)).toBe(true)
  expect(readFileSync(runtime.diagnostics.file, 'utf8')).toContain(`${code}: directory is locked`)
  expect(runtime.options.onFailure).not.toHaveBeenCalled()
})

it('returns to the original Profile despite a locked safe home and creates a fresh home next time', async () => {
  const { runtime, home, safeHome } = await fixture()
  vi.mocked(cleanupDisposableTree).mockImplementation(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) })
  await expect(runtime.restart(() => { runtime.safeMode = false })).resolves.toBeUndefined()
  expect(runtime.terminalTarget().homeDir).toBe(home)
  await runtime.restart(() => { runtime.safeMode = true })
  expect(runtime.terminalTarget().homeDir).not.toBe(safeHome)
})

it('still rejects close when the Host cannot stop and leaves its safe home intact', async () => {
  const { runtime, safeHome } = await fixture()
  vi.spyOn(runtime.backend, 'close').mockRejectedValue(new Error('Host did not exit'))
  await expect(runtime.close()).rejects.toThrow('Host did not exit')
  expect(cleanupDisposableTree).not.toHaveBeenCalled()
  expect(existsSync(safeHome)).toBe(true)
})
