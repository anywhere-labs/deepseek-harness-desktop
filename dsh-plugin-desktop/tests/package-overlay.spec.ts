import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findOverlayPackage,
  packageNameFromSpecifier,
  resolveOverlayPackage,
} from '../src/package-overlay.ts'

const roots: string[] = []

function fixture(): {
  root: string
  install: string
  profile: string
  options: { installPackageUrl: string; profilePackageUrl: string }
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-overlay-'))
  roots.push(root)
  const install = join(root, 'install')
  const profile = join(root, 'profile')
  mkdirSync(install)
  mkdirSync(profile)
  writeFileSync(join(install, 'package.json'), '{"name":"install-root"}\n')
  writeFileSync(join(profile, 'package.json'), '{"name":"profile-root"}\n')
  return {
    root,
    install,
    profile,
    options: {
      installPackageUrl: pathToFileURL(join(install, 'package.json')).href,
      profilePackageUrl: pathToFileURL(join(profile, 'package.json')).href,
    },
  }
}

function installPackage(root: string, name: string, version: string, actualName = name): string {
  const directory = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name: actualName, version })}\n`)
  return directory
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Desktop package overlay', () => {
  it('uses the only available side', () => {
    const installOnly = fixture()
    installPackage(installOnly.install, 'desktop-only', '1.0.0')
    expect(resolveOverlayPackage('desktop-only', installOnly.options).selected.source).toBe('install')

    const profileOnly = fixture()
    installPackage(profileOnly.profile, 'profile-only', '1.0.0')
    expect(resolveOverlayPackage('profile-only', profileOnly.options).selected.source).toBe('profile')
  })

  it('distinguishes an absent package from an invalid declared candidate', () => {
    const absent = fixture()
    expect(findOverlayPackage('missing-package', absent.options)).toBeUndefined()
    expect(() => resolveOverlayPackage('missing-package', absent.options)).toThrow('cannot resolve package')
    expect(() => resolveOverlayPackage('plugin/subpath', absent.options)).toThrow('exact npm package name')
  })

  it('selects the newer semantic version in either direction', () => {
    const profileNewer = fixture()
    installPackage(profileNewer.install, '@scope/plugin', '1.9.9')
    installPackage(profileNewer.profile, '@scope/plugin', '2.0.0')
    expect(resolveOverlayPackage('@scope/plugin', profileNewer.options).selected).toMatchObject({
      source: 'profile',
      version: '2.0.0',
    })

    const installNewer = fixture()
    installPackage(installNewer.install, 'plugin', '3.0.0')
    installPackage(installNewer.profile, 'plugin', '2.9.9')
    expect(resolveOverlayPackage('plugin', installNewer.options).selected).toMatchObject({
      source: 'install',
      version: '3.0.0',
    })
  })

  it('orders prereleases and keeps Desktop on equal precedence', () => {
    const prerelease = fixture()
    installPackage(prerelease.install, 'plugin', '1.0.0-rc.1')
    installPackage(prerelease.profile, 'plugin', '1.0.0-rc.2')
    expect(resolveOverlayPackage('plugin', prerelease.options).selected.source).toBe('profile')

    const equal = fixture()
    installPackage(equal.install, 'plugin', '1.0.0+desktop')
    installPackage(equal.profile, 'plugin', '1.0.0+profile')
    expect(resolveOverlayPackage('plugin', equal.options).selected.source).toBe('install')
  })

  it('uses the only package even without a comparable version and rejects invalid identities', () => {
    const version = fixture()
    installPackage(version.install, 'plugin', 'not-a-version')
    expect(resolveOverlayPackage('plugin', version.options).selected).toMatchObject({
      source: 'install',
    })
    expect(resolveOverlayPackage('plugin', version.options).selected.version).toBeUndefined()

    const profileVersion = fixture()
    installPackage(profileVersion.profile, 'plugin', 'not-a-version')
    expect(resolveOverlayPackage('plugin', profileVersion.options).selected.source).toBe('profile')

    const identity = fixture()
    installPackage(identity.profile, 'plugin', '1.0.0', 'another-package')
    expect(() => resolveOverlayPackage('plugin', identity.options)).toThrow('package identity is invalid')
  })

  it('keeps a valid Desktop package when Profile metadata cannot be compared', () => {
    const version = fixture()
    installPackage(version.install, 'plugin', '1.0.0')
    installPackage(version.profile, 'plugin', 'not-a-version')
    expect(resolveOverlayPackage('plugin', version.options).selected).toMatchObject({
      source: 'install',
      version: '1.0.0',
    })

    const identity = fixture()
    installPackage(identity.install, 'plugin', '1.0.0')
    installPackage(identity.profile, 'plugin', '2.0.0', 'another-package')
    expect(resolveOverlayPackage('plugin', identity.options).selected.source).toBe('install')

    const installVersion = fixture()
    installPackage(installVersion.install, 'plugin', 'not-a-version')
    installPackage(installVersion.profile, 'plugin', '2.0.0')
    expect(resolveOverlayPackage('plugin', installVersion.options).selected.source).toBe('install')
  })

  it('extracts scoped and unscoped roots without treating URLs as packages', () => {
    expect(packageNameFromSpecifier('@scope/plugin/subpath')).toBe('@scope/plugin')
    expect(packageNameFromSpecifier('plugin/subpath')).toBe('plugin')
    expect(packageNameFromSpecifier('node:fs')).toBeUndefined()
    expect(packageNameFromSpecifier('./relative.js')).toBeUndefined()
  })
})
