import * as fileSystem from 'node:fs'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LINK_PROJECTION_DIR, removeLinkProjectionsSafely } from '../src/link-projections.ts'

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
}))

const directoryLink = process.platform === 'win32' ? 'junction' : 'dir'

describe('dsh 0.1.5 link projection cleanup', () => {
  const roots: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
  })

  /** Lay out a profile exactly as the 0.1.5 link backend left it: profile link -> owned link -> installation. */
  async function projectedProfile() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-link-projections-'))
    roots.push(root)
    const profile = join(root, 'profiles', 'desktop')
    const installation = join(root, 'old-desktop', 'resources', 'app', 'node_modules')
    const protectedFiles: string[] = []
    const profileLinks: string[] = []
    for (const packageName of ['@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-persona', 'yaml']) {
      const target = join(installation, packageName)
      mkdirSync(join(target, 'lib'), { recursive: true })
      const file = join(target, 'lib', 'index.js')
      writeFileSync(file, 'installation package must survive')
      writeFileSync(join(target, 'package.json'), '{}')
      protectedFiles.push(file)
      const owned = join(profile, LINK_PROJECTION_DIR, 'node_modules', packageName)
      mkdirSync(dirname(owned), { recursive: true })
      fileSystem.symlinkSync(target, owned, directoryLink)
      const profileLink = join(profile, 'node_modules', packageName)
      mkdirSync(dirname(profileLink), { recursive: true })
      fileSystem.symlinkSync(owned, profileLink, directoryLink)
      profileLinks.push(profileLink)
    }
    return { root, profile, protectedFiles, profileLinks }
  }

  it('unlinks projections and the projection directory without touching installation packages', async () => {
    const { profile, protectedFiles, profileLinks } = await projectedProfile()
    const recursiveRemove = vi.spyOn(fileSystem, 'rmSync')

    expect(removeLinkProjectionsSafely(profile)).toBe(true)

    expect(recursiveRemove).not.toHaveBeenCalled()
    for (const link of profileLinks) expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
    expect(existsSync(join(profile, LINK_PROJECTION_DIR))).toBe(false)
    for (const file of protectedFiles) expect(readFileSync(file, 'utf8')).toBe('installation package must survive')
  })

  it('keeps pnpm-installed packages and links that do not point into the projection directory', async () => {
    const { root, profile } = await projectedProfile()
    const installed = join(profile, 'node_modules', '@community', 'plugin')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), '{"name":"@community/plugin"}')
    const external = join(root, 'workspace-plugin')
    mkdirSync(external)
    const userLink = join(profile, 'node_modules', 'workspace-plugin')
    fileSystem.symlinkSync(external, userLink, directoryLink)

    removeLinkProjectionsSafely(profile)

    expect(readFileSync(join(installed, 'package.json'), 'utf8')).toBe('{"name":"@community/plugin"}')
    expect(lstatSync(userLink).isSymbolicLink()).toBe(true)
  })

  it('does nothing for a profile without a projection directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-link-projections-'))
    roots.push(root)
    const profile = join(root, 'profiles', 'desktop')
    mkdirSync(join(profile, 'node_modules'), { recursive: true })

    expect(removeLinkProjectionsSafely(profile)).toBe(false)
    expect(removeLinkProjectionsSafely(join(root, 'profiles', 'missing'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules'))).toBe(true)
  })

  it('removes projections whose installation target was already deleted', async () => {
    const { root, profile, profileLinks } = await projectedProfile()
    await rm(join(root, 'old-desktop'), { recursive: true, force: true })

    expect(removeLinkProjectionsSafely(profile)).toBe(true)

    for (const link of profileLinks) expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
    expect(existsSync(join(profile, LINK_PROJECTION_DIR))).toBe(false)
  })
})
