import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertDesktopMarketStatePath,
  desktopMarketStatePath,
  parseDesktopMarketState,
  readDesktopMarketState,
  readDesktopMarketStateForUserData,
  selectDesktopMarketProvider,
  writeDesktopMarketSelection,
} from '../src/desktop-market.ts'

const roots: string[] = []

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-market-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Desktop Market state path and parser', () => {
  it('uses one machine-level state path and rejects ambiguous paths', () => {
    const userData = temporaryUserData()
    const statePath = desktopMarketStatePath(userData)

    expect(statePath).toBe(join(userData, 'desktop-market', 'state.json'))
    expect(() => assertDesktopMarketStatePath(statePath)).not.toThrow()
    expect(() => assertDesktopMarketStatePath(join(userData, 'state.json'))).toThrow()
    expect(() => desktopMarketStatePath('relative-user-data')).toThrow()
    expect(() => desktopMarketStatePath(`${userData}\0`)).toThrow()
  })

  it('accepts exactly the version-one persisted shape and rejects unknown fields', () => {
    expect(parseDesktopMarketState({
      version: 1,
      requested: 'dsh-market',
      legacyDefaulted: false,
    })).toEqual({
      version: 1,
      requested: 'dsh-market',
      legacyDefaulted: false,
    })
    expect(() => parseDesktopMarketState({
      version: 2,
      requested: 'disabled',
      legacyDefaulted: false,
    })).toThrow('unsupported version')
    expect(() => parseDesktopMarketState({
      version: 1,
      requested: 'unknown',
      legacyDefaulted: false,
    })).toThrow('requested provider is invalid')
    expect(() => parseDesktopMarketState({
      version: 1,
      requested: 'disabled',
      legacyDefaulted: true,
    })).toThrow('legacyDefaulted must be false')
    expect(() => parseDesktopMarketState({
      version: 1,
      requested: 'disabled',
      legacyDefaulted: false,
      effective: 'disabled',
    })).toThrow('unexpected fields')
  })
})

describe('Desktop Market fail-safe reads', () => {
  it.each([
    ['missing', () => {}],
    ['malformed JSON', (path: string) => writeFileSync(path, '{broken', 'utf8')],
    ['unknown version', (path: string) => writeFileSync(path, '{"version":2,"requested":"disabled","legacyDefaulted":false}\n', 'utf8')],
    ['invalid provider', (path: string) => writeFileSync(path, '{"version":1,"requested":"other","legacyDefaulted":false}\n', 'utf8')],
  ])('defaults %s to disabled without writing a migration', (_label, prepare) => {
    const userData = temporaryUserData()
    const statePath = desktopMarketStatePath(userData)
    mkdirSync(join(userData, 'desktop-market'), { recursive: true })
    prepare(statePath)
    const before = existsSync(statePath) ? readFileSync(statePath, 'utf8') : undefined

    expect(readDesktopMarketStateForUserData(userData)).toEqual({
      requested: 'disabled',
      effective: 'disabled',
      legacyDefaulted: true,
    })
    expect(existsSync(statePath) ? readFileSync(statePath, 'utf8') : undefined).toBe(before)
  })

  it('treats a symlink state file as unavailable without reading its target', () => {
    const userData = temporaryUserData()
    const stateDir = join(userData, 'desktop-market')
    const target = join(userData, 'outside.json')
    const statePath = join(stateDir, 'state.json')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(target, '{"version":1,"requested":"dsh-market","legacyDefaulted":false}\n', 'utf8')
    try {
      symlinkSync(target, statePath)
    } catch {
      return
    }

    expect(lstatSync(statePath).isSymbolicLink()).toBe(true)
    expect(readDesktopMarketState(statePath)).toEqual({
      requested: 'disabled',
      effective: 'disabled',
      legacyDefaulted: true,
    })
    expect(readFileSync(target, 'utf8')).toContain('dsh-market')
  })
})

describe('Desktop Market explicit selection', () => {
  it.each(['disabled', 'community-market', 'dsh-market'] as const)(
    'persists provider %s with no effective field',
    async provider => {
      const userData = temporaryUserData()
      const selected = await selectDesktopMarketProvider(userData, provider)
      const statePath = desktopMarketStatePath(userData)
      const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>

      expect(selected).toEqual({
        requested: provider,
        effective: provider,
        legacyDefaulted: false,
      })
      expect(persisted).toEqual({ version: 1, requested: provider, legacyDefaulted: false })
      expect(persisted).not.toHaveProperty('effective')
      expect(readDesktopMarketState(statePath)).toEqual(selected)
      if (process.platform !== 'win32') {
        expect(statSync(join(userData, 'desktop-market')).mode & 0o777).toBe(0o700)
        expect(statSync(statePath).mode & 0o777).toBe(0o600)
      }
      expect(readdirSync(join(userData, 'desktop-market'))).toEqual(['state.json'])
    },
  )

  it('replaces a previous valid state atomically and leaves no temporary siblings', async () => {
    const userData = temporaryUserData()
    await selectDesktopMarketProvider(userData, 'community-market')
    const statePath = desktopMarketStatePath(userData)
    const previous = readFileSync(statePath, 'utf8')

    await writeDesktopMarketSelection(statePath, 'dsh-market')

    expect(readFileSync(statePath, 'utf8')).not.toBe(previous)
    expect(readDesktopMarketState(statePath).requested).toBe('dsh-market')
    expect(readdirSync(join(userData, 'desktop-market'))).toEqual(['state.json'])
  })

  it('does not follow a symlinked state directory when selecting', async () => {
    const userData = temporaryUserData()
    const outside = join(userData, 'outside')
    const stateDir = join(userData, 'desktop-market')
    mkdirSync(outside, { recursive: true })
    try {
      symlinkSync(outside, stateDir)
    } catch {
      return
    }

    await expect(selectDesktopMarketProvider(userData, 'community-market')).rejects.toThrow(
      'state directory must be a real directory',
    )
    expect(readdirSync(outside)).toEqual([])
  })
})
