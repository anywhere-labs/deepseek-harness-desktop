import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertDesktopProfileName,
  beginDesktopProfileStartup,
  canDeleteDesktopProfile,
  createDesktopWebProfile,
  deleteDesktopProfile,
  listDesktopProfiles,
  markDesktopProfileFailed,
  markDesktopProfileHealthy,
  readDesktopProfileState,
  selectDesktopProfile,
} from '../src/profile-manager.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-manager-'))
  roots.push(root)
  return root
}

function writeProfile(home: string, name: string, bundles: unknown): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dsh: { profile: { bundles } },
  }, undefined, 2) + '\n')
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop profile discovery', () => {
  it('accepts safe human profile names while rejecting path and control characters', () => {
    expect(() => assertDesktopProfileName('团队 profile')).not.toThrow()
    expect(() => assertDesktopProfileName('profile\nname')).toThrow('invalid desktop profile name')
    expect(() => assertDesktopProfileName('../outside')).toThrow()
    expect(() => assertDesktopProfileName('CON.txt')).toThrow('invalid desktop profile name')
    expect(() => assertDesktopProfileName('name.')).toThrow('invalid desktop profile name')
    expect(() => assertDesktopProfileName('name ')).toThrow('invalid desktop profile name')
    expect(() => assertDesktopProfileName('é'.repeat(128))).toThrow('invalid desktop profile name')
  })

  it('creates a Web profile from the shipped template and publishes all files together', () => {
    const home = temporaryRoot()

    expect(createDesktopWebProfile(home, 'work')).toEqual(expect.objectContaining({
      name: 'work',
      dir: join(home, 'profiles', 'work'),
      exists: true,
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      webCapable: true,
    }))
    expect(readFileSync(join(home, 'profiles', 'work', 'package.json'), 'utf8'))
      .toContain('"name": "dsh-profile-work"')
    expect(existsSync(join(home, 'profiles', 'work', 'cordis.patch.yml'))).toBe(true)
    expect(existsSync(join(home, 'profiles', 'work', 'pnpm-workspace.yaml'))).toBe(true)
    expect(readdirSync(join(home, 'profiles')).filter(name => name.includes('.work.creating-'))).toEqual([])
  })

  it('does not overwrite an existing profile or leave a target after failure', () => {
    const home = temporaryRoot()
    const existing = writeProfile(home, 'work', ['@deepseek-ai/dsh-base'])
    const before = readFileSync(join(existing, 'package.json'), 'utf8')

    expect(() => createDesktopWebProfile(home, 'work')).toThrow('already exists')
    expect(readFileSync(join(existing, 'package.json'), 'utf8')).toBe(before)
    expect(readdirSync(join(home, 'profiles')).filter(name => name.includes('.work.creating-'))).toEqual([])

    const blockedHome = join(home, 'blocked-home')
    mkdirSync(blockedHome, { recursive: true })
    writeFileSync(join(blockedHome, 'profiles'), 'not a directory')
    expect(() => createDesktopWebProfile(blockedHome, 'work')).toThrow()
    expect(existsSync(join(blockedHome, 'profiles', 'work'))).toBe(false)
  })

  it('lists lazy defaults and existing profiles without creating or changing manifests', () => {
    const home = temporaryRoot()
    const webDir = writeProfile(home, 'work', [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'third-party-plugin',
    ])
    writeProfile(home, 'headless', ['@deepseek-ai/dsh-base'])
    writeProfile(home, 'wrong-order', ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base'])
    writeProfile(home, 'embedded-desktop', [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'dsh-plugin-desktop',
    ])
    writeProfile(home, 'broken', 'not-an-array')
    mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
    const before = readFileSync(join(webDir, 'package.json'), 'utf8')

    expect(listDesktopProfiles(home)).toEqual([
      expect.objectContaining({ name: 'desktop', exists: false, webCapable: true }),
      expect.objectContaining({ name: 'web', exists: false, webCapable: true }),
      expect.objectContaining({ name: 'broken', exists: true, webCapable: false, problem: expect.any(String) }),
      expect.objectContaining({
        name: 'embedded-desktop',
        exists: true,
        webCapable: false,
        problem: expect.stringContaining('launcher-owned'),
      }),
      expect.objectContaining({ name: 'headless', exists: true, webCapable: false, bundles: ['@deepseek-ai/dsh-base'] }),
      expect.objectContaining({
        name: 'work',
        exists: true,
        webCapable: true,
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'third-party-plugin'],
      }),
      expect.objectContaining({ name: 'wrong-order', exists: true, webCapable: false }),
    ])
    expect(readFileSync(join(webDir, 'package.json'), 'utf8')).toBe(before)
    expect(readdirSync(join(home, 'profiles')).sort()).toEqual([
      'broken',
      'embedded-desktop',
      'headless',
      'node_modules',
      'work',
      'wrong-order',
    ])
  })

  it('treats an existing repairable desktop profile as managed but rejects malformed metadata', () => {
    const home = temporaryRoot()
    writeProfile(home, 'desktop', ['@deepseek-ai/dsh-base'])
    expect(listDesktopProfiles(home)[0]).toEqual(expect.objectContaining({
      name: 'desktop',
      exists: true,
      webCapable: true,
    }))

    writeProfile(home, 'desktop', 'broken')
    expect(listDesktopProfiles(home)[0]).toEqual(expect.objectContaining({
      name: 'desktop',
      webCapable: false,
      problem: expect.any(String),
    }))
  })
})

describe('desktop profile deletion', () => {
  function writeSelection(home: string, statePath: string, state: Record<string, unknown> = {
    version: 1,
    active: 'desktop',
    lastKnownGood: 'desktop',
  }): void {
    mkdirSync(join(home, 'profiles'), { recursive: true })
    mkdirSync(join(statePath, '..'), { recursive: true })
    writeFileSync(statePath, `${JSON.stringify(state)}\n`)
  }

  it('protects only the current, missing, and unsafe profiles', () => {
    const home = temporaryRoot()
    const statePath = join(home, 'state', 'profiles.json')
    writeSelection(home, statePath)
    writeProfile(home, 'desktop', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    writeProfile(home, 'web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    writeProfile(home, 'work', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const link = join(home, 'profiles', 'link')
    let linked = false
    try {
      symlinkSync(join(home, 'profiles', 'work'), link, 'dir')
      linked = true
    } catch { /* Windows may require an elevated symlink privilege. */ }
    const options = { home, selectionStatePath: statePath, currentProfileName: 'desktop' }

    expect(canDeleteDesktopProfile(options, 'desktop')).toBe(false)
    expect(canDeleteDesktopProfile(options, 'web')).toBe(true)
    expect(canDeleteDesktopProfile(options, 'missing')).toBe(false)
    if (linked) expect(canDeleteDesktopProfile(options, 'link')).toBe(false)
    expect(canDeleteDesktopProfile(options, 'work')).toBe(true)
  })

  it('allows inactive desktop and web profiles to be deleted', async () => {
    const home = temporaryRoot()
    const statePath = join(home, 'state', 'profiles.json')
    writeSelection(home, statePath, {
      version: 1,
      active: 'work',
      lastKnownGood: 'work',
    })
    writeProfile(home, 'desktop', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    writeProfile(home, 'web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    writeProfile(home, 'work', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const options = { home, selectionStatePath: statePath, currentProfileName: 'work' }

    expect(canDeleteDesktopProfile(options, 'work')).toBe(false)
    expect(canDeleteDesktopProfile(options, 'desktop')).toBe(true)
    expect(canDeleteDesktopProfile(options, 'web')).toBe(true)
    await deleteDesktopProfile(options, 'desktop')
    await deleteDesktopProfile(options, 'web')
    expect(existsSync(join(home, 'profiles', 'desktop'))).toBe(false)
    expect(existsSync(join(home, 'profiles', 'web'))).toBe(false)
  })

  it('renames, cleans, and removes an inactive profile', async () => {
    const home = temporaryRoot()
    const statePath = join(home, 'state', 'profiles.json')
    writeSelection(home, statePath)
    writeProfile(home, 'work', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const clearDisabledState = vi.fn(async () => {})
    const clearCheckpoint = vi.fn(() => {})

    await deleteDesktopProfile({
      home,
      selectionStatePath: statePath,
      currentProfileName: 'desktop',
      clearDisabledState,
      clearCheckpoint,
    }, 'work')

    expect(existsSync(join(home, 'profiles', 'work'))).toBe(false)
    expect(readdirSync(join(home, 'profiles')).some(name => name.includes('.work.deleting-'))).toBe(false)
    expect(clearDisabledState).toHaveBeenCalledOnce()
    expect(clearCheckpoint).toHaveBeenCalledOnce()
  })

  it('rejects a recovery transaction and restores the directory after cleanup failure', async () => {
    const home = temporaryRoot()
    const statePath = join(home, 'state', 'profiles.json')
    writeSelection(home, statePath)
    const profileDir = writeProfile(home, 'work', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    await expect(deleteDesktopProfile({
      home,
      selectionStatePath: statePath,
      currentProfileName: 'desktop',
      installRecovery: { read: async () => ({ profileName: 'work' }) },
    }, 'work')).rejects.toThrow('pending install recovery')
    expect(existsSync(profileDir)).toBe(true)

    await expect(deleteDesktopProfile({
      home,
      selectionStatePath: statePath,
      currentProfileName: 'desktop',
      clearDisabledState: () => { throw new Error('state locked') },
    }, 'work')).rejects.toThrow('state locked')
    expect(existsSync(profileDir)).toBe(true)
    expect(readdirSync(join(home, 'profiles')).some(name => name.includes('.work.deleting-'))).toBe(false)
  })
})

describe('desktop profile selection state', () => {
  it('defaults to desktop and queues only a directly Web-capable profile', () => {
    const root = temporaryRoot()
    const home = join(root, 'harness')
    const statePath = join(root, 'desktop-private', 'profile-selection', 'state.json')
    writeProfile(home, 'work', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    writeProfile(home, 'headless', ['@deepseek-ai/dsh-base'])
    writeProfile(home, 'wrong-order', ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base'])
    writeProfile(home, 'embedded-desktop', [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'dsh-plugin-desktop',
    ])

    expect(readDesktopProfileState(statePath)).toEqual({
      version: 1,
      active: 'desktop',
      lastKnownGood: 'desktop',
    })
    expect(selectDesktopProfile(statePath, home, 'work')).toEqual({
      version: 1,
      active: 'desktop',
      pending: 'work',
      lastKnownGood: 'desktop',
    })
    expect(() => selectDesktopProfile(statePath, home, 'headless')).toThrow(
      'must directly include @deepseek-ai/dsh-base before @deepseek-ai/dsh-web-app',
    )
    expect(() => selectDesktopProfile(statePath, home, 'wrong-order')).toThrow(
      'must directly include @deepseek-ai/dsh-base before @deepseek-ai/dsh-web-app',
    )
    expect(() => selectDesktopProfile(statePath, home, 'embedded-desktop')).toThrow('launcher-owned')
    expect(() => selectDesktopProfile(statePath, home, '../outside')).toThrow()
    if (process.platform !== 'win32') {
      expect(statSync(statePath).mode & 0o777).toBe(0o600)
      expect(statSync(join(root, 'desktop-private', 'profile-selection')).mode & 0o777).toBe(0o700)
    }
  })

  it('consumes a pending profile and rolls back an unconfirmed startup on the next launch', () => {
    const root = temporaryRoot()
    const home = join(root, 'harness')
    const statePath = join(root, 'private', 'state.json')
    writeProfile(home, 'work', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    selectDesktopProfile(statePath, home, 'work')

    expect(beginDesktopProfileStartup(statePath, home)).toEqual({
      profileName: 'work',
      state: { version: 1, active: 'work', lastKnownGood: 'desktop' },
      recoveredState: false,
    })
    expect(beginDesktopProfileStartup(statePath, home)).toEqual({
      profileName: 'desktop',
      state: { version: 1, active: 'desktop', lastKnownGood: 'desktop' },
      recoveredState: true,
      rolledBackFrom: 'work',
    })
  })

  it('promotes a healthy profile and explicitly rolls a later failed profile back', () => {
    const root = temporaryRoot()
    const home = join(root, 'harness')
    const statePath = join(root, 'private', 'state.json')
    writeProfile(home, 'work', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

    selectDesktopProfile(statePath, home, 'work')
    beginDesktopProfileStartup(statePath, home)
    expect(markDesktopProfileHealthy(statePath, 'work')).toEqual({
      version: 1,
      active: 'work',
      lastKnownGood: 'work',
    })

    selectDesktopProfile(statePath, home, 'web')
    beginDesktopProfileStartup(statePath, home)
    expect(markDesktopProfileFailed(statePath, 'web')).toEqual({
      version: 1,
      active: 'work',
      lastKnownGood: 'work',
    })
    expect(() => markDesktopProfileHealthy(statePath, 'web')).toThrow('cannot confirm inactive profile')
  })

  it('recovers malformed or symlinked private state without touching profile files', () => {
    const root = temporaryRoot()
    const home = join(root, 'harness')
    const stateDir = join(root, 'private')
    const statePath = join(stateDir, 'state.json')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(statePath, '{broken')

    expect(beginDesktopProfileStartup(statePath, home)).toEqual({
      profileName: 'desktop',
      state: { version: 1, active: 'desktop', lastKnownGood: 'desktop' },
      recoveredState: true,
    })
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      version: 1,
      active: 'desktop',
      lastKnownGood: 'desktop',
    })
    expect(lstatSync(statePath).isSymbolicLink()).toBe(false)
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })

  it('falls back when a queued profile disappears before restart', () => {
    const root = temporaryRoot()
    const home = join(root, 'harness')
    const statePath = join(root, 'private', 'state.json')
    const profileDir = writeProfile(home, 'work', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    selectDesktopProfile(statePath, home, 'work')
    rmSync(profileDir, { recursive: true })

    expect(beginDesktopProfileStartup(statePath, home)).toEqual({
      profileName: 'desktop',
      state: { version: 1, active: 'desktop', lastKnownGood: 'desktop' },
      recoveredState: true,
      rolledBackFrom: 'work',
    })
  })
})
