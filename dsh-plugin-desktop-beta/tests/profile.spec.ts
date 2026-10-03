import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  composeEntries,
  initProfile,
  PROFILE_TEMPLATES,
} from '@deepseek-ai/dsh-app-boot'
import {
  DESKTOP_PACKAGE_NAME,
  desktopShellModeFromSettings,
  desktopStartupSettingsFromSettings,
  desktopBundleList,
  ensureDesktopProfile,
  prepareDesktopProfile,
  migrateDesktopSettingsDocumentSections,
  readDesktopShellMode,
  resolveDesktopSettingsDocument,
  shippedSkillRoot,
  UPSTREAM_PRODUCT_ANALYTICS_ROW_IDS,
  validateDshMarketBundlePatches,
} from '../src/profile.ts'
import { setDesktopProfileBundleSelected } from '../src/desktop-plugins.ts'
import { migrateLegacyAgentPresetSettings } from '../src/setup-wizard-settings.ts'
import { DESKTOP_MARKET_IDENTITIES } from '../src/desktop-market.ts'

const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
  homes.push(home)
  return home
}

function installWebClient(
  home: string,
  packageName: string,
  manifest: Record<string, unknown> = {},
): string {
  const webDir = join(home, 'profiles', 'web')
  const template = PROFILE_TEMPLATES.web
  if (template === undefined) throw new Error('test requires the shipped Web template')
  initProfile(webDir, template.bundles)
  const packageDir = join(webDir, 'node_modules', ...packageName.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: packageName,
    version: '1.0.0',
    type: 'module',
    dsh: { client: { platform: 'web' } },
    ...manifest,
  }) + '\n')
  writeFileSync(join(packageDir, 'index.js'), 'export default {}\n')
  return webDir
}

function installBundle(home: string, packageName: string, patch: string, version = '1.0.0'): string {
  const bundleDir = join(home, 'profiles', 'desktop', 'node_modules', packageName)
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: packageName,
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }) + '\n')
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), patch)
  return bundleDir
}

/**
 * Persist Desktop startup preferences where dsh 0.1.7-alpha.1 keeps them.
 *
 * Through 0.1.6 these lived in the global `$DSH_HOME/settings.yaml` document. 0.1.7
 * made persisted form values profile-specific, so the Host now reads them off the
 * composed `desktop-shell` row: the bundle default overridden by the profile's own
 * patch layer, which is what the config editor writes.
 */
function writeDesktopShellPreferences(home: string, preferences: readonly string[]): void {
  const dir = ensureDesktopProfile(home)
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- id: desktop-shell',
    '  config:',
    ...preferences.map(line => `    ${line}`),
    '',
  ].join('\n'))
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('desktop profile composition', {
  timeout: process.platform === 'win32' ? 10_000 : 5_000,
}, () => {
  it('ships a PowerShell-backed minimal preset for Windows', () => {
    // dsh 0.1.7-alpha.1 moved shipped preset declarations out of a filesystem preset
    // root and into one patch file per preset, carried by the Web bundle.
    const require = createRequire(import.meta.url)
    const minimalPreset = readFileSync(
      join(dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets', 'minimal.patch.yml'),
      'utf8',
    )

    expect(minimalPreset).toContain("name: '@deepseek-ai/dsh-tool-pwsh-persistent'")
    expect(minimalPreset).toContain("disabled: !!js process.platform !== 'win32'")
  })

  it('reads packaged Cordis skills from the logical ASAR preset root', () => {
    const home = temporaryHome()
    const resources = join(home, 'resources')
    const archivedPreset = join(
      resources,
      'app.asar',
      'node_modules',
      '@deepseek-ai',
      'dsh-agent-preset',
    )
    const archivedSkillRoot = join(archivedPreset, 'skills')
    const skillPath = join(
      archivedSkillRoot,
      'cordis-plugin-development',
      'SKILL.md',
    )
    mkdirSync(join(resources, 'app.asar', 'lib'), { recursive: true })
    mkdirSync(archivedPreset, { recursive: true })
    mkdirSync(dirname(skillPath), { recursive: true })
    writeFileSync(join(archivedPreset, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-agent-preset',
      exports: { './package.json': './package.json' },
    }) + '\n')
    writeFileSync(skillPath, '# Cordis plugin development\n')

    const moduleUrl = pathToFileURL(join(resources, 'app.asar', 'lib', 'profile.js')).href
    const resolvedRoot = shippedSkillRoot(moduleUrl)

    expect(resolvedRoot).toBe(realpathSync(archivedSkillRoot))
    expect(readFileSync(join(
      resolvedRoot,
      'cordis-plugin-development',
      'SKILL.md',
    ), 'utf8')).toBe('# Cordis plugin development\n')
  })

  it('adds the Web surface before third-party bundles and removes the launcher bundle duplicate', () => {
    expect(desktopBundleList([
      '@deepseek-ai/dsh-base',
      'third-party-one',
      'dsh-plugin-desktop',
      DESKTOP_PACKAGE_NAME,
      'third-party-two',
    ])).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'third-party-one',
      'third-party-two',
    ])
  })

  it('repairs a base-only CLI profile without replacing dependencies', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({
      ...manifest,
      dependencies: { 'third-party-plugin': '^1.2.3' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'third-party-plugin'] } },
      custom: { preserved: true },
    }, undefined, 2) + '\n')

    ensureDesktopProfile(home)
    const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
      custom: { preserved: boolean }
    }
    expect(repaired.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'third-party-plugin',
    ])
    expect(repaired.dependencies).toEqual({ 'third-party-plugin': '^1.2.3' })
    expect(repaired.custom.preserved).toBe(true)
  })

  it('migrates the obsolete Desktop bundle before loading a historical profile', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({
      ...manifest,
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@deepseek-ai/dsh-web-app',
            '@deepseek-ai/dsh-desktop-app',
          ],
        },
      },
    }, undefined, 2) + '\n')

    expect(() => prepareDesktopProfile(undefined, home, 'win32')).not.toThrow()
    const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(repaired.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ])
  })

  it('marks legacy isolated Profile dependencies for one-time migration', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const modulesDir = join(dir, 'node_modules')
    mkdirSync(modulesDir, { recursive: true })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), `packages:
  - .

nodeLinker: isolated
autoInstallPeers: true
customSetting: preserved
`)
    writeFileSync(join(modulesDir, '.modules.yaml'), `layoutVersion: 5
nodeLinker: isolated
packageManager: pnpm@9.12.0
`)
    writeFileSync(join(dir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
`)

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')

    expect(prepared.requiresDependencyMigration).toBe(true)
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('autoInstallPeers: false')
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('customSetting: preserved')
  })

  it('leaves an already-hoisted Profile dependency tree untouched', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const modulesDir = join(dir, 'node_modules')
    mkdirSync(modulesDir, { recursive: true })
    writeFileSync(join(modulesDir, '.modules.yaml'), `layoutVersion: 5
nodeLinker: hoisted
packageManager: pnpm@11.7.0
virtualStoreDirMaxLength: 120
`)

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')

    expect(prepared.requiresDependencyMigration).toBe(false)
  })

  it('migrates a hoisted Profile dependency tree created by pnpm 9', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const modulesDir = join(dir, 'node_modules')
    mkdirSync(modulesDir, { recursive: true })
    writeFileSync(join(modulesDir, '.modules.yaml'), `layoutVersion: 5
nodeLinker: hoisted
packageManager: pnpm@9.12.0
virtualStoreDirMaxLength: 120
`)

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')

    expect(prepared.requiresDependencyMigration).toBe(true)
  })

  it('migrates Windows Profile metadata created with the non-Windows virtual store limit', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const modulesDir = join(dir, 'node_modules')
    mkdirSync(modulesDir, { recursive: true })
    writeFileSync(join(modulesDir, '.modules.yaml'), `layoutVersion: 5
nodeLinker: hoisted
packageManager: pnpm@11.7.0
virtualStoreDirMaxLength: 120
`)

    const prepared = prepareDesktopProfile(undefined, home, 'win32')

    expect(prepared.requiresDependencyMigration).toBe(true)
  })

  it('leaves current Windows Profile dependency metadata untouched', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const modulesDir = join(dir, 'node_modules')
    mkdirSync(modulesDir, { recursive: true })
    writeFileSync(join(modulesDir, '.modules.yaml'), `layoutVersion: 5
nodeLinker: hoisted
packageManager: pnpm@11.7.0
virtualStoreDirMaxLength: 60
`)

    const prepared = prepareDesktopProfile(undefined, home, 'win32')

    expect(prepared.requiresDependencyMigration).toBe(false)
  })

  it('rejects malformed persistent bundle metadata', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...manifest, dsh: { profile: { bundles: 'not-an-array' } } }) + '\n')
    expect(() => ensureDesktopProfile(home)).toThrow('dsh.profile.bundles must be an array')
  })

  it('assembles the Host shell without replacing the upstream client shell', () => {
    const home = temporaryHome()
    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const patches = prepared.patches as Array<Record<string, unknown>>
    const inserted = patches.flatMap((patch) => {
      const rows = patch.insert
      return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
    })
    expect(inserted).toContainEqual(expect.objectContaining({
      name: DESKTOP_PACKAGE_NAME,
      config: { mode: 'compatibility' },
    }))
    expect(patches).toContainEqual(expect.objectContaining({
      id: 'webserver',
      name: '@deepseek-ai/dsh-host-webserver',
      disabled: true,
    }))
    expect(inserted).toContainEqual(expect.objectContaining({
      id: 'desktop-webserver',
      name: 'dsh-plugin-desktop-beta/webserver',
      config: { host: '127.0.0.1', port: 43_120 },
    }))
    // dsh 0.1.7-alpha.1 replaced filesystem preset discovery with preset declarations
    // carried by patch files, so Desktop no longer pins preset roots on the registry
    // row: `roots` and `includeUserRoot` are not fields of any 0.1.7 Config.
    expect(patches.map(patch => patch.id)).not.toContain('agent-presets')
    expect(patches.map(patch => patch.id)).not.toContain('agent-preset-registry')
    expect(existsSync(join(
      prepared.profile.dir,
      'agent-preset-compat',
      'code',
      'agent.cordis.yml',
    ))).toBe(false)
    expect(readFileSync(prepared.rootConfig, 'utf8')).toBe('[]\n')
    expect(prepared.homeDir).toBe(home)
    expect(fileURLToPath(prepared.bareModuleBaseUrl)).toBe(join(prepared.profile.dir, 'package.json'))
    expect(prepared.mode).toBe('compatibility')
    expect(prepared.openBrowser).toBe(false)
    expect(prepared.networkExposure).toBe('loopback')
    expect(prepared.lanAddresses).toEqual([])
    expect(Object.isFrozen(prepared.lanAddresses)).toBe(true)

    const rows = composeEntries([prepared.patches])
    for (const [id, name] of [
      ['ui-layout', '@deepseek-ai/dsh-client-ui-layout'],
      ['ui-sidebar', '@deepseek-ai/dsh-client-ui-sidebar'],
      ['ui-conversation', '@deepseek-ai/dsh-client-ui-conversation'],
    ] as const) {
      const matching = rows.filter(row => row.id === id)
      expect(matching).toHaveLength(1)
      expect(matching[0]).toEqual(expect.objectContaining({ name }))
      expect(matching[0]?.disabled).toBeFalsy()
    }
    expect(rows.find(row => row.id === 'directory-picker')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
    }))
    expect(rows.find(row => row.id === 'directory-picker')?.disabled).toBeFalsy()
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-browse-host')
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-browse-surface')
    expect(rows.find(row => row.id === 'subprocess')).toEqual({
      id: 'subprocess',
      name: '@deepseek-ai/dsh-subprocess-local',
    })
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-subprocess')
    expect(rows.find(row => row.id === 'sandbox')).toEqual({
      id: 'sandbox',
      name: '@deepseek-ai/dsh-sandbox-local',
    })
    expect(rows.find(row => row.id === 'agent-preset-registry')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-agent-preset-registry',
    }))
    expect(rows.map(row => row.id)).not.toContain('agent-presets')
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-agent-presets')
    expect(rows.find(row => row.id === 'pwsh-sandbox')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-pwsh-sandbox')
    expect(rows.find(row => row.id === 'desktop-terminal')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop-beta/terminal',
      disabled: { __jsExpr: "process.platform === 'linux'" },
    }))
    expect(rows.find(row => row.id === 'desktop-pnpm')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop-beta/pnpm',
    }))
    expect(rows.find(row => row.id === 'desktop-updates')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop-beta/updates',
    }))
    expect(rows.find(row => row.id === 'desktop-notifications')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop-beta/notifications',
    }))
    expect(rows.find(row => row.id === 'desktop-profiles')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop-beta/profiles',
    }))
  })

  it('merges a frozen LAN IPv4 snapshot into existing Web runtime trust', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: web-runtime',
      '  config:',
      '    trustedHosts:',
      '      - lab.internal',
      '      - 192.168.1.5',
      '      - lab.internal',
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      undefined,
      undefined,
      { lanAddresses: ['192.168.1.5', '10.0.0.7', '10.0.0.7'] },
    )
    const rows = composeEntries([prepared.patches])

    expect(prepared.lanAddresses).toEqual(['192.168.1.5', '10.0.0.7'])
    expect(Object.isFrozen(prepared.lanAddresses)).toBe(true)
    expect(rows.find(row => row.id === 'web-runtime')).toEqual(expect.objectContaining({
      config: expect.objectContaining({
        openBrowser: false,
        trustedHosts: ['lab.internal', '192.168.1.5', '10.0.0.7'],
      }),
    }))
    expect(rows.find(row => row.id === 'desktop-webserver')).toEqual(expect.objectContaining({
      config: { host: '127.0.0.1', port: 43_120 },
    }))
  })

  it('rejects malformed Web trust config and non-IPv4 launcher addresses', () => {
    const malformedHome = temporaryHome()
    writeFileSync(join(malformedHome, 'cordis.patch.yml'), [
      '- id: web-runtime',
      '  config:',
      '    trustedHosts: lab.internal',
      '',
    ].join('\n'))

    expect(() => prepareDesktopProfile(undefined, malformedHome, 'darwin')).toThrow(
      'web-runtime trustedHosts must be an array of strings',
    )

    const invalidAddressHome = temporaryHome()
    expect(() => prepareDesktopProfile(
      undefined,
      invalidAddressHome,
      'darwin',
      'desktop',
      undefined,
      undefined,
      { lanAddresses: ['desktop.internal'] },
    )).toThrow('LAN address "desktop.internal" is not an IPv4 literal')
  })

  it('keeps both Market providers absent until the user explicitly enables one', () => {
    const home = temporaryHome()
    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])

    expect(prepared.market).toEqual({
      requested: 'disabled',
      effective: 'disabled',
      legacyDefaulted: true,
    })
    expect(rows.some(row => row.id === DESKTOP_MARKET_IDENTITIES.community.rowId
      || row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId)).toBe(false)
  })

  it('inserts the community Market as one canonical row only after explicit selection', () => {
    const home = temporaryHome()
    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'desktop', undefined, {
      requested: 'community-market',
      effective: 'community-market',
      legacyDefaulted: false,
    })
    const rows = composeEntries([prepared.patches])

    expect(prepared.market.effective).toBe('community-market')
    expect(rows.filter(row => row.id === DESKTOP_MARKET_IDENTITIES.community.rowId)).toEqual([{
      id: DESKTOP_MARKET_IDENTITIES.community.rowId,
      name: DESKTOP_MARKET_IDENTITIES.community.packageName,
    }])
    expect(rows.some(row => row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId)).toBe(false)
  })

  it('loads the exact dshmarket dependency as a direct bundle only after explicit selection', () => {
    const home = temporaryHome()
    const profileMarketDir = installBundle(home, DESKTOP_MARKET_IDENTITIES.dshMarket.packageName, [
      '- insert:',
      '    - id: dsh-market',
      '      name: dshmarket',
      '',
    ].join('\n'), '99.0.0')
    const profileManifestPath = join(ensureDesktopProfile(home), 'package.json')
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    profileManifest.dsh.profile.bundles.push(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
    writeFileSync(profileManifestPath, JSON.stringify(profileManifest) + '\n')
    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'desktop', undefined, {
      requested: 'dsh-market',
      effective: 'dsh-market',
      legacyDefaulted: false,
    })
    const rows = composeEntries([prepared.patches])

    expect(prepared.market.effective).toBe('dsh-market')
    expect(prepared.profile.layers.find(layer =>
      layer.packageName === DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)?.packageDir,
    ).toBe(profileMarketDir)
    expect(rows.filter(row => row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId)).toEqual([{
      id: DESKTOP_MARKET_IDENTITIES.dshMarket.rowId,
      name: DESKTOP_MARKET_IDENTITIES.dshMarket.packageName,
    }])
    expect(rows.some(row => row.id === DESKTOP_MARKET_IDENTITIES.community.rowId)).toBe(false)
  })

  it('keeps the newer Desktop dshmarket when a Profile copy is older', () => {
    const home = temporaryHome()
    const oldProfileMarketDir = installBundle(home, DESKTOP_MARKET_IDENTITIES.dshMarket.packageName, [
      '- insert:',
      '    - id: dsh-market',
      '      name: dshmarket',
      '',
    ].join('\n'), '0.1.0')
    const profileManifestPath = join(ensureDesktopProfile(home), 'package.json')
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    profileManifest.dsh.profile.bundles.push(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
    writeFileSync(profileManifestPath, `${JSON.stringify(profileManifest)}\n`)

    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'desktop', undefined, {
      requested: 'dsh-market',
      effective: 'dsh-market',
      legacyDefaulted: false,
    })
    const selected = prepared.profile.layers.find(layer =>
      layer.packageName === DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
    expect(selected?.packageDir).not.toBe(oldProfileMarketDir)
    expect(JSON.parse(readFileSync(join(selected!.packageDir, 'package.json'), 'utf8'))).toMatchObject({
      name: 'dshmarket',
      version: JSON.parse(readFileSync(createRequire(import.meta.url).resolve('dshmarket/package.json'), 'utf8')).version,
    })
  })

  it('does not let community-management disables suppress a third-party market', () => {
    const home = temporaryHome()
    const packageName = 'third-party-plugin'
    installBundle(home, packageName, '- insert:\n    - id: third-party-marker\n      name: cordis:example\n')
    const profileManifestPath = join(ensureDesktopProfile(home), 'package.json')
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    profileManifest.dsh.profile.bundles.push(packageName)
    writeFileSync(profileManifestPath, JSON.stringify(profileManifest) + '\n')
    const managementStatePath = join(home, 'user-data', 'plugin-management', 'state.json')
    mkdirSync(dirname(managementStatePath), { recursive: true })
    writeFileSync(managementStatePath, JSON.stringify({
      version: 1,
      profiles: [{ profileName: 'desktop', disabledBundles: [packageName] }],
    }) + '\n')

    const external = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      managementStatePath,
      { requested: 'dsh-market', effective: 'dsh-market', legacyDefaulted: false },
    )
    expect(composeEntries([external.patches])).toContainEqual(expect.objectContaining({
      id: 'third-party-marker',
    }))

    const community = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      managementStatePath,
      { requested: 'community-market', effective: 'community-market', legacyDefaulted: false },
    )
    expect(composeEntries([community.patches])).not.toContainEqual(expect.objectContaining({
      id: 'third-party-marker',
    }))
  })

  it('ignores obsolete startup-recovery disable state for every market provider', () => {
    const home = temporaryHome()
    const packageName = 'third-party-plugin'
    installBundle(home, packageName, '- insert:\n    - id: third-party-marker\n      name: cordis:example\n')
    const profileManifestPath = join(ensureDesktopProfile(home), 'package.json')
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    profileManifest.dsh.profile.bundles.push(packageName)
    writeFileSync(profileManifestPath, JSON.stringify(profileManifest) + '\n')
    const managementStatePath = join(home, 'user-data', 'plugin-management', 'state.json')
    const recoveryStatePath = join(home, 'user-data', 'startup-recovery', 'state.json')
    mkdirSync(dirname(recoveryStatePath), { recursive: true })
    writeFileSync(recoveryStatePath, JSON.stringify({
      version: 1,
      profiles: [{ profileName: 'desktop', disabledBundles: [packageName] }],
    }) + '\n')

    const prepared = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      managementStatePath,
      { requested: 'dsh-market', effective: 'dsh-market', legacyDefaulted: false },
    )
    expect(composeEntries([prepared.patches])).toContainEqual(expect.objectContaining({
      id: 'third-party-marker',
    }))
  })

  it('filters an unselected dshmarket bundle before resolving or parsing its patch', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const manifestPath = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dsh.profile.bundles.push(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
    installBundle(home, DESKTOP_MARKET_IDENTITIES.dshMarket.packageName, 'not: [valid yaml')

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])

    expect(prepared.market.effective).toBe('disabled')
    expect(rows.some(row => row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId)).toBe(false)
  })

  it('fails a conflicting provider identity closed without blocking the core profile', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), `- insert:\n    - id: community-market\n      name: dsh-community-market\n`)

    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'desktop', undefined, {
      requested: 'community-market',
      effective: 'community-market',
      legacyDefaulted: false,
    })
    const rows = composeEntries([prepared.patches])

    expect(prepared.market.effective).toBe('disabled')
    expect(prepared.marketFailure).toContain('conflicting Market provider Loader identity')
    expect(rows.some(row => row.id === DESKTOP_MARKET_IDENTITIES.community.rowId
      || row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId)).toBe(false)
    expect(rows.some(row => row.id === 'webserver')).toBe(true)
  })

  it('rejects a non-canonical dshmarket bundle patch before it reaches the Loader', () => {
    expect(() => validateDshMarketBundlePatches([{
      insert: [{ id: 'dsh-market', name: 'unexpected-market' }],
    }])).toThrow('must insert exactly the canonical dsh-market row')
  })

  it('keeps upstream Desktop product analytics off even when a user patch enables it', () => {
    const home = temporaryHome()
    writeFileSync(join(ensureDesktopProfile(home), 'cordis.patch.yml'), [
      '- id: product-analytics',
      '  disabled: false',
      '',
    ].join('\n'))

    const rows = composeEntries([prepareDesktopProfile(undefined, home, 'darwin').patches])

    for (const id of UPSTREAM_PRODUCT_ANALYTICS_ROW_IDS) {
      expect(rows.find(row => row.id === id)).toEqual(expect.objectContaining({ disabled: true }))
    }
  })

  it('boots a selected Web profile without overriding its compatibility UI rows', () => {
    const home = temporaryHome()
    const webDir = join(home, 'profiles', 'web')
    const template = PROFILE_TEMPLATES.web
    if (template === undefined) throw new Error('test requires the shipped Web template')
    initProfile(webDir, template.bundles)
    writeFileSync(join(webDir, 'cordis.patch.yml'), [
      '- id: ui-layout',
      "  name: '@deepseek-ai/dsh-client-ui-layout'",
      '  disabled: true',
      '- insert:',
      '    - id: third-party-layout',
      "      name: 'third-party-layout'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'web')
    const rows = composeEntries([prepared.patches])

    expect(prepared.profile.name).toBe('web')
    expect(rows.find(row => row.id === 'ui-layout')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-client-ui-layout',
      disabled: true,
    }))
    expect(rows.find(row => row.id === 'third-party-layout')).toEqual({
      id: 'third-party-layout',
      name: 'third-party-layout',
    })
    expect(rows.find(row => row.id === 'desktop-shell')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop-beta',
      config: expect.objectContaining({ mode: 'compatibility' }),
    }))
  })

  it('keeps a custom layout and withdraws incompatible browser and LAN access', () => {
    const home = temporaryHome()
    writeDesktopShellPreferences(home, [
      'mode: advanced',
      'port: 43189',
      'openBrowser: true',
      'networkExposure: lan',
    ])

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])

    expect(prepared.mode).toBe('advanced')
    expect(prepared.port).toBe(43_189)
    expect(prepared.openBrowser).toBe(false)
    expect(prepared.networkExposure).toBe('loopback')
    expect(rows.find(row => row.id === 'desktop-shell')).toEqual(expect.objectContaining({
      disabled: false,
      config: expect.objectContaining({ mode: 'advanced', port: 43_189 }),
    }))
    expect(rows.find(row => row.id === 'webserver')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-webserver',
      disabled: true,
    }))
    expect(rows.find(row => row.id === 'desktop-webserver')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop-beta/webserver',
      config: { host: '127.0.0.1', port: 43_189 },
    }))
    expect(rows.find(row => row.id === 'web-runtime')).toEqual(expect.objectContaining({
      config: expect.objectContaining({ openBrowser: false }),
    }))
    // 0.1.7's settings row is the profile-owned service and takes no document config,
    // so what is asserted is the Host's own resolution of the harness-home document.
    expect(rows.find(row => row.id === 'settings')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-settings',
    }))
    expect(prepared.settingsDocument).toBe(join(home, 'settings.yaml'))
    expect(rows.find(row => row.id === 'ui-layout')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'ui-sidebar')?.disabled).toBe(false)
    expect(rows.find(row => row.id === 'ui-conversation')?.disabled).toBe(false)
  })

  it('leaves every editable startup field to the profile patch the config editor writes', () => {
    const home = temporaryHome()
    // Every `.volatile()` field of `DesktopShellConfig`, each away from its default.
    const edited = {
      mode: 'advanced',
      macosMaterial: 'transparent',
      // A legacy value the schema still accepts; it resolves to 'off' at runtime.
      windowsMaterial: 'mica',
      linuxMaterial: 'transparent',
      port: 43_189,
      openBrowser: true,
      networkExposure: 'lan',
      logLevel: 'debug',
    } as const
    writeDesktopShellPreferences(home, Object.entries(edited).map(([key, value]) => `${key}: ${value}`))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')

    // The launcher composes its own patches *after* the profile's `cordis.patch.yml`,
    // so anything it pins shadows the user's edit to the same field. 0.1.7's config
    // editor fails closed on that -- it recomposes after writing and throws
    // `Configuration for "desktop-shell" is overridden by a home patch or
    // command-line overlay` -- which blocked the mode picker and with it every other
    // Desktop settings write. Startup values are read back out of the composed row
    // instead, and `DesktopShellConfig` carries the same defaults, so no editable
    // field may survive to the composed row with anything but the user's value.
    expect(composeEntries([prepared.patches]).find(row => row.id === 'desktop-shell'))
      .toEqual(expect.objectContaining({ disabled: false, config: expect.objectContaining(edited) }))
    // `networkExposure` is still withdrawn to loopback -- but on the read path, not
    // by overwriting the stored intent the user just edited.
    expect(prepared).toMatchObject({ mode: 'advanced', port: 43_189, networkExposure: 'loopback' })
  })

  it('composes a pending patch document in place of the one on disk', () => {
    const home = temporaryHome()
    writeDesktopShellPreferences(home, ['mode: compatibility'])

    // What the config editor hands `ProfileContext.readPatches` before it persists:
    // the document it is about to write. Composing the on-disk one instead would
    // both reject the write and reconcile the Loader back to the stale config.
    const pending = prepareDesktopProfile(undefined, home, 'darwin', undefined, undefined, undefined, {
      profilePatches: [{ id: 'desktop-shell', config: { mode: 'advanced', port: 43_189 } }],
    })

    expect(pending.mode).toBe('advanced')
    expect(pending.port).toBe(43_189)
    expect(composeEntries([pending.patches]).find(row => row.id === 'desktop-shell'))
      .toEqual(expect.objectContaining({
        disabled: false,
        config: expect.objectContaining({ mode: 'advanced', port: 43_189 }),
      }))

    // Substituting the document must not disturb the layers, and must not persist.
    expect(pending.profile.layers.map(layer => layer.packageName))
      .toEqual(prepareDesktopProfile(undefined, home, 'darwin').profile.layers.map(layer => layer.packageName))
    expect(prepareDesktopProfile(undefined, home, 'darwin').mode).toBe('compatibility')
  })

  it.each([
    ['compatibility', 'extended', false],
    ['extended', 'compatibility', true],
    ['advanced', 'compatibility', true],
  ] as const)('keeps the %s generation\'s layout rows after the Profile switches to %s', (running, stored, disabled) => {
    // First-run Setup and the mode picker both save the mode into the patch layer
    // while the window keeps its renderer, and the save hot-reloads the Profile.
    // Recomposing the layout rows from the stored mode dropped (or restored)
    // `ui-layout` under a page built for the other layout owner, so the client
    // plugins waited on a layout service forever and the window went to recovery.
    const home = temporaryHome()
    writeDesktopShellPreferences(home, [`mode: ${stored}`])

    const reloaded = prepareDesktopProfile(undefined, home, 'win32', undefined, undefined, undefined, {
      generationMode: running,
    })
    const rows = composeEntries([reloaded.patches])

    expect(reloaded.mode).toBe(stored)
    expect(rows.find(row => row.id === 'desktop-shell')?.config).toEqual(expect.objectContaining({ mode: stored }))
    expect(rows.find(row => row.id === 'ui-layout')?.disabled ?? false).toBe(disabled)
    expect(rows.find(row => row.id === 'ui-sidebar')?.disabled ?? false).toBe(false)
    // The next generation composes from what was saved.
    const next = composeEntries([prepareDesktopProfile(undefined, home, 'win32').patches])
    expect(next.find(row => row.id === 'ui-layout')?.disabled ?? false).toBe(stored !== 'compatibility')
  })

  it('renames its own legacy settings sections to the entry ids 0.1.7 imports by', () => {
    const home = temporaryHome()
    // A 0.1.6 harness-home document, comments and all. Upstream's one-shot import
    // keys sections by Loader entry id and only renames the kernel's own sections,
    // so both of Desktop's would be dropped with a warning and then deleted.
    writeFileSync(join(home, 'settings.yaml'), [
      '# kept verbatim',
      'dsh-desktop:',
      '  mode: advanced   # kept too',
      '  windowsMaterial: off',
      'ui-theme:',
      '  preference: dark',
      'dsh-desktop-notifications:',
      '  notifyOnTurnFailure: false',
      '',
    ].join('\n'))
    const spec = resolveDesktopSettingsDocument({ dshHome: home })

    expect(migrateDesktopSettingsDocumentSections(spec)).toEqual(['desktop-shell', 'desktop-notifications'])

    // Only the two keys move. Position, comments, scalar styles and every section
    // this edition does not own survive, because the key node is renamed in place.
    // Re-stringifying does normalize the run of spaces before an inline comment;
    // that is the whole of the incidental damage, and the document is about to be
    // consumed and deleted by upstream's import anyway.
    expect(readFileSync(spec.filename, 'utf8')).toBe([
      '# kept verbatim',
      'desktop-shell:',
      '  mode: advanced # kept too',
      '  windowsMaterial: off',
      'ui-theme:',
      '  preference: dark',
      'desktop-notifications:',
      '  notifyOnTurnFailure: false',
      '',
    ].join('\n'))

    // Idempotent: a document already keyed by entry id has nothing left to rename.
    expect(migrateDesktopSettingsDocumentSections(spec)).toEqual([])
  })

  it('moves the legacy preset choice to the field 0.1.7 can persist', () => {
    const home = temporaryHome()
    // 0.1.6 stored the user's chosen preset in `agent-presets.default`. 0.1.7
    // renamed the row and kept `default` as the bundle-authored fallback, which is
    // not `.volatile()`: importing the old key under its old name throws
    // `Config field "default" is not volatile` and the choice is lost either way.
    writeFileSync(join(home, 'settings.yaml'), [
      'agent-presets:',
      '  default: minimal',
      '',
    ].join('\n'))
    const spec = resolveDesktopSettingsDocument({ dshHome: home })

    expect(migrateDesktopSettingsDocumentSections(spec)).toEqual(['agent-preset-registry'])
    expect(readFileSync(spec.filename, 'utf8'))
      .toBe(['agent-preset-registry:', '  selectedDefault: minimal', ''].join('\n'))
    expect(migrateDesktopSettingsDocumentSections(spec)).toEqual([])

    // The field alone still moves under a section 0.1.7 already keys correctly.
    writeFileSync(spec.filename, ['agent-preset-registry:', '  default: minimal', ''].join('\n'))
    expect(migrateDesktopSettingsDocumentSections(spec)).toEqual(['agent-preset-registry'])
    expect(readFileSync(spec.filename, 'utf8'))
      .toBe(['agent-preset-registry:', '  selectedDefault: minimal', ''].join('\n'))

    // Both fields present: keep the one 0.1.7 writes and leave the fallback alone.
    const both = ['agent-preset-registry:', '  selectedDefault: minimal', '  default: standard', ''].join('\n')
    writeFileSync(spec.filename, both)
    expect(migrateDesktopSettingsDocumentSections(spec)).toEqual([])
    expect(readFileSync(spec.filename, 'utf8')).toBe(both)
  })

  it('still maps the released code preset to ptc after the 0.1.7 section rename', async () => {
    // Launch order in main.ts: prepareDesktopProfile (section + field rename)
    // runs before migrateLegacyAgentPresetSettings, so the latter must find the
    // legacy id under its new key or the user lands on a preset that no longer exists.
    const home = temporaryHome()
    writeFileSync(join(home, 'settings.yaml'), ['agent-presets:', '  default: code', ''].join('\n'))
    const spec = resolveDesktopSettingsDocument({ dshHome: home })

    expect(migrateDesktopSettingsDocumentSections(spec)).toEqual(['agent-preset-registry'])
    await expect(migrateLegacyAgentPresetSettings(spec.filename)).resolves.toBe(true)
    expect(readFileSync(spec.filename, 'utf8'))
      .toBe(['agent-preset-registry:', '  selectedDefault: ptc', ''].join('\n'))
  })

  it('leaves the settings document alone when there is nothing safe to migrate', () => {
    const home = temporaryHome()
    const spec = resolveDesktopSettingsDocument({ dshHome: home })

    // No document at all: the fresh-install path, and the path taken on every
    // launch after upstream's import renamed the file away.
    expect(migrateDesktopSettingsDocumentSections(spec)).toEqual([])
    expect(existsSync(spec.filename)).toBe(false)

    // Both keys present: keep the entry-id section, because that is the one 0.1.7
    // itself would have written. Merging them is not this function's decision.
    const both = ['desktop-shell:', '  mode: extended', 'dsh-desktop:', '  mode: advanced', ''].join('\n')
    writeFileSync(spec.filename, both)
    expect(migrateDesktopSettingsDocumentSections(spec)).toEqual([])
    expect(readFileSync(spec.filename, 'utf8')).toBe(both)

    // Malformed: `readDesktopStartupSettings` reports it with the parser's own
    // message, so rewriting it here would only destroy the evidence.
    const broken = 'dsh-desktop:\n  mode: advanced\n\tport: 43189\n'
    writeFileSync(spec.filename, broken)
    expect(migrateDesktopSettingsDocumentSections(spec)).toEqual([])
    expect(readFileSync(spec.filename, 'utf8')).toBe(broken)
  })

  it('migrates the settings document while preparing the profile', () => {
    const home = temporaryHome()
    ensureDesktopProfile(home)
    writeFileSync(join(home, 'settings.yaml'), [
      'dsh-desktop-notifications:',
      '  enabled: false',
      'agent-presets:',
      '  default: minimal',
      '',
    ].join('\n'))

    prepareDesktopProfile(undefined, home, 'darwin')

    // The Loader has not started yet, so upstream's import still finds the sections.
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe([
      'desktop-notifications:',
      '  enabled: false',
      'agent-preset-registry:',
      '  selectedDefault: minimal',
      '',
    ].join('\n'))
  })

  it('starts in the mode the not-yet-imported settings document is about to apply', () => {
    // The setup wizard (and every 0.1.6 install) leaves the chosen mode in the
    // harness-home document, which 0.1.7 only merges into the profile after the
    // Loader is up. Reading the composed row alone opened the first window in
    // compatibility mode while the reloaded generation dropped `ui-layout`, so
    // nothing provided a layout and the renderer landed in recovery.
    //
    // Supplying the pending values to the first generation alone is not enough:
    // the import renames the document before it writes, and a recomposition in
    // between (profile HMR notices the rename) would see neither and flip the row
    // back underneath the running shell. So the launcher lands the section in the
    // profile itself, before the Loader starts.
    const home = temporaryHome()
    writeDesktopShellPreferences(home, ['mode: compatibility', 'port: 43189'])
    const settingsPath = join(home, 'settings.yaml')
    const patchPath = join(ensureDesktopProfile(home), 'cordis.patch.yml')
    writeFileSync(settingsPath, ['dsh-desktop:', '  mode: extended', 'agent-presets:', '  default: minimal', ''].join('\n'))

    const first = prepareDesktopProfile(undefined, home, 'win32')
    const rows = composeEntries([first.patches])

    // Merged field by field, like the import: the document's mode, the row's port.
    expect(first).toMatchObject({ mode: 'extended', port: 43_189 })
    expect(rows.find(row => row.id === 'ui-layout')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'ui-sidebar')?.disabled).toBe(false)
    expect(rows.find(row => row.id === 'desktop-shell')?.config)
      .toEqual(expect.objectContaining({ mode: 'extended', port: 43_189 }))
    // Persisted in the profile's own row, where the config editor edits it later;
    // the launcher pins nothing, so those edits are never shadowed.
    expect(readFileSync(patchPath, 'utf8'))
      .toBe(['- id: desktop-shell', '  config:', '    mode: extended', '    port: 43189', ''].join('\n'))
    expect(first.patches.findLast(patch => patch.id === 'desktop-shell')).toEqual({ id: 'desktop-shell', disabled: false })
    // Only Desktop's shell section leaves the document; the import still merges the rest.
    expect(readFileSync(settingsPath, 'utf8')).toBe(['agent-preset-registry:', '  selectedDefault: minimal', ''].join('\n'))
    // Every later composition (HMR, the import's own) reads the same row.
    expect(prepareDesktopProfile(undefined, home, 'win32').mode).toBe('extended')

    // A profile without its own desktop-shell row gets one, shaped as the editor writes it.
    const fresh = temporaryHome()
    const freshPatch = join(ensureDesktopProfile(fresh), 'cordis.patch.yml')
    writeFileSync(join(fresh, 'settings.yaml'), ['desktop-shell:', '  mode: advanced', ''].join('\n'))
    expect(prepareDesktopProfile(undefined, fresh, 'win32').mode).toBe('advanced')
    expect(readFileSync(freshPatch, 'utf8')).toContain(
      ['- id: desktop-shell', `  name: ${DESKTOP_PACKAGE_NAME}`, '  config:', '    mode: advanced', ''].join('\n'))

    // A section the import would reject stays for the import to reject, and the
    // row keeps its values.
    const rejected = (platform: NodeJS.Platform, lines: string[]) => {
      const other = temporaryHome()
      writeDesktopShellPreferences(other, ['mode: compatibility'])
      const document = ['desktop-shell:', ...lines.map(line => `  ${line}`), ''].join('\n')
      writeFileSync(join(other, 'settings.yaml'), document)
      expect(prepareDesktopProfile(undefined, other, platform).mode).toBe('compatibility')
      expect(readFileSync(join(other, 'settings.yaml'), 'utf8')).toBe(document)
    }
    rejected('win32', ['mode: fullscreen'])
    // Only volatile fields are importable; one stray key drops the whole section.
    rejected('win32', ['mode: extended', 'width: 1600'])
    rejected('win32', ['mode: extended', 'logLevel: verbose'])
    rejected('win32', ['mode: extended', 'openBrowser: true'])
    rejected('linux', ['mode: extended'])

    // The config editor's validation pass holds the patch file and writes it next.
    const editing = temporaryHome()
    writeDesktopShellPreferences(editing, ['mode: compatibility'])
    writeFileSync(join(editing, 'settings.yaml'), ['desktop-shell:', '  mode: extended', ''].join('\n'))
    prepareDesktopProfile(undefined, editing, 'win32', undefined, undefined, undefined, {
      profilePatches: [{ id: 'desktop-shell', config: { mode: 'compatibility' } }],
    })
    expect(readFileSync(join(editing, 'settings.yaml'), 'utf8')).toBe(['desktop-shell:', '  mode: extended', ''].join('\n'))
  })

  it('keeps legacy browser intent but clamps LAN exposure when compatibility mode is selected', () => {
    const home = temporaryHome()
    writeDesktopShellPreferences(home, [
      'mode: compatibility',
      'port: 43189',
      'openBrowser: true',
      'networkExposure: lan',
    ])

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])

    expect(prepared).toMatchObject({
      mode: 'compatibility',
      openBrowser: true,
      networkExposure: 'lan',
    })
    expect(rows.find(row => row.id === 'desktop-webserver')).toEqual(expect.objectContaining({
      config: { host: '127.0.0.1', port: 43_189 },
    }))
    expect(rows.find(row => row.id === 'web-runtime')).toEqual(expect.objectContaining({
      config: expect.objectContaining({ openBrowser: false }),
    }))
  })

  it('replaces the official root layout for extended window mode while retaining its occupants', () => {
    const home = temporaryHome()
    writeDesktopShellPreferences(home, [
      'mode: extended',
      "macosMaterial: 'off'",
      'windowsMaterial: mica',
    ])

    const prepared = prepareDesktopProfile(undefined, home, 'win32')
    const rows = composeEntries([prepared.patches])

    // A removed Windows Mica preference still boots and renders opaque.
    expect(prepared).toEqual(expect.objectContaining({
      mode: 'extended',
      macosMaterial: 'off',
      windowsMaterial: 'off',
    }))
    expect(rows.find(row => row.id === 'ui-layout')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'ui-sidebar')?.disabled).toBe(false)
    expect(rows.find(row => row.id === 'ui-conversation')?.disabled).toBe(false)
    expect(rows.find(row => row.id === 'desktop-shell')).toEqual(expect.objectContaining({
      config: expect.objectContaining({
        mode: 'extended',
        macosMaterial: 'off',
        // The user's legacy leaf is carried through unchanged, never rewritten.
        windowsMaterial: 'mica',
      }),
    }))
  })

  it('reads JSON settings and defaults an absent desktop namespace to compatibility', () => {
    const home = temporaryHome()
    const path = join(home, 'desktop-settings.json')
    writeFileSync(path, JSON.stringify({ 'dsh-desktop': { mode: 'advanced' } }))

    expect(readDesktopShellMode({ path })).toBe('advanced')
    expect(desktopStartupSettingsFromSettings({ 'dsh-desktop': { mode: 'advanced', port: 43_189 } })).toEqual({
      mode: 'advanced',
      port: 43_189,
      macosMaterial: 'transparent',
      windowsMaterial: 'off',
      linuxMaterial: 'off',
      openBrowser: false,
      networkExposure: 'loopback',
    })
    expect(desktopStartupSettingsFromSettings({ 'dsh-desktop': { mode: 'advanced' } })).toEqual({
      mode: 'advanced',
      port: 43_120,
      macosMaterial: 'transparent',
      windowsMaterial: 'off',
      linuxMaterial: 'off',
      openBrowser: false,
      networkExposure: 'loopback',
    })
    expect(desktopShellModeFromSettings({ unrelated: { enabled: true } })).toBe('compatibility')
  })

  it('treats legacy LAN exposure as browser access only in compatibility mode', () => {
    expect(desktopStartupSettingsFromSettings({
      'dsh-desktop': {
        mode: 'advanced',
        openBrowser: false,
        networkExposure: 'lan',
      },
    })).toMatchObject({
      mode: 'advanced',
      openBrowser: false,
      networkExposure: 'loopback',
    })
    expect(desktopStartupSettingsFromSettings({
      'dsh-desktop': {
        mode: 'compatibility',
        openBrowser: false,
        networkExposure: 'lan',
      },
    })).toMatchObject({
      mode: 'compatibility',
      openBrowser: true,
      networkExposure: 'lan',
    })
  })

  it('rejects invalid settings roots, sections, modes, and YAML', () => {
    expect(() => desktopShellModeFromSettings([])).toThrow('must be a map')
    expect(() => desktopShellModeFromSettings({ 'dsh-desktop': true })).toThrow('settings must be a map')
    expect(() => desktopShellModeFromSettings({ 'dsh-desktop': { mode: 'glass' } })).toThrow(
      'must be "compatibility", "extended", or "advanced"',
    )
    for (const port of [-1, 1.5, 65_536, '43189']) {
      expect(() => desktopStartupSettingsFromSettings({ 'dsh-desktop': { port } })).toThrow(
        'port must be an integer from 0 through 65535',
      )
    }
    expect(() => desktopStartupSettingsFromSettings({ 'dsh-desktop': { openBrowser: 'yes' } }))
      .toThrow('openBrowser must be a boolean')
    expect(() => desktopStartupSettingsFromSettings({ 'dsh-desktop': { networkExposure: 'internet' } }))
      .toThrow('networkExposure must be "loopback" or "lan"')

    const home = temporaryHome()
    const path = join(home, 'invalid.yaml')
    writeFileSync(path, 'dsh-desktop: [\n')
    expect(() => readDesktopShellMode({ path })).toThrow('invalid settings document')
  })

  it('treats only YAML-null machine-wide patch documents as no desktop patches without rewriting them', () => {
    for (const content of [
      '',
      '  \n\t\n',
      '# no machine-wide patches\n',
      'null\n',
      '~\n',
      '---\n',
      '---\n# no machine-wide patches\n...\n',
    ]) {
      const home = temporaryHome()
      const path = join(home, 'cordis.patch.yml')
      writeFileSync(path, content)

      expect(() => prepareDesktopProfile(undefined, home, 'win32')).not.toThrow()
      expect(readFileSync(path, 'utf8')).toBe(content)
    }
  })

  it('keeps non-null and invalid machine-wide patch documents on the strict upstream path', () => {
    for (const [content, diagnostic] of [
      ['not: a patch list\n', 'must be a top-level YAML array of loader patch entries'],
      ['{}\n', 'must be a top-level YAML array of loader patch entries'],
      ['false\n', 'must be a top-level YAML array of loader patch entries'],
      ['"null"\n', 'must be a top-level YAML array of loader patch entries'],
      ['not: [\n', 'failed to parse patches'],
      ['---\nnull\n---\n[]\n', 'failed to parse patches'],
    ] as const) {
      const home = temporaryHome()
      const path = join(home, 'cordis.patch.yml')
      writeFileSync(path, content)

      expect(() => prepareDesktopProfile(undefined, home, 'win32')).toThrow(diagnostic)
      expect(readFileSync(path, 'utf8')).toBe(content)
    }
  })

  it('continues to load machine-wide patch arrays with upstream !!js expressions', () => {
    const home = temporaryHome()
    const path = join(home, 'cordis.patch.yml')
    const content = [
      '- id: web-runtime',
      '  config:',
      '    desktopNullNormalizationProbe: !!js process.platform',
      '',
    ].join('\n')
    writeFileSync(path, content)

    const prepared = prepareDesktopProfile(undefined, home, 'win32')

    expect(prepared.patches).toContainEqual(expect.objectContaining({
      id: 'web-runtime',
      config: expect.objectContaining({
        desktopNullNormalizationProbe: { __jsExpr: 'process.platform' },
      }),
    }))
    expect(readFileSync(path, 'utf8')).toBe(content)
  })

  it('keeps the Windows browse panel, official subprocess and presets, and desktop pwsh provider', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: pwsh-sandbox',
      "  name: '@deepseek-ai/dsh-pwsh-sandbox'",
      '  config:',
      "    cwd: 'C:\\workspace'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'win32')
    const rows = composeEntries([prepared.patches])
    const picker = rows.find(row => row.id === 'directory-picker')

    expect(picker).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-directory-picker-browse-host',
      name: '@deepseek-ai/dsh-host-directory-picker-browse',
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-directory-picker-browse-surface',
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse',
    }))
    expect(rows.map(row => row.name)).not.toContain('@deepseek-ai/dsh-host-directory-picker-native')
    expect(rows.map(row => row.name)).not.toContain('@deepseek-ai/dsh-client-ui-directory-picker-native')
    expect(rows.find(row => row.id === 'subprocess')).toEqual({
      id: 'subprocess',
      name: '@deepseek-ai/dsh-subprocess-local',
    })
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-subprocess')
    expect(rows.find(row => row.id === 'sandbox')).toEqual({
      id: 'sandbox',
      name: '@deepseek-ai/dsh-sandbox-local',
    })
    // The registry row carries no Desktop override: 0.1.7 dropped `roots` and
    // `includeUserRoot` together with filesystem preset discovery.
    expect(rows.find(row => row.id === 'agent-preset-registry')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-agent-preset-registry',
    }))
    expect(rows.find(row => row.id === 'agent-preset-registry')?.disabled).toBeFalsy()
    expect(rows.map(row => row.id)).not.toContain('agent-presets')
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-agent-presets')
    expect(rows.find(row => row.id === 'pwsh-sandbox')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-windows-pwsh-sandbox',
      name: 'dsh-plugin-desktop-beta/windows-pwsh-sandbox',
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { cwd: 'C:\\workspace' },
    }))
  })

  it('rejects a bundle and user patch that register the same loader entry id', () => {
    const home = temporaryHome()
    const packageName = 'dsh-usage-stats'
    const bundlePatch = [
      '- insert:',
      '    - id: usage-stats',
      `      name: '${packageName}'`,
      '',
    ].join('\n')
    installBundle(home, packageName, bundlePatch)
    const profileDir = join(home, 'profiles', 'desktop')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', packageName] } },
    }) + '\n')
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: usage-stats',
      `      name: '${packageName}'`,
      '',
    ].join('\n'))

    expect(() => prepareDesktopProfile(undefined, home, 'win32')).toThrow(
      'duplicate loader entry id "usage-stats" in the composed profile',
    )
  })

  it('keeps a Web Client in its owning profile and omits it from desktop', () => {
    const home = temporaryHome()
    const packageName = '@linxin666/dsh-client-ui-skin-whale-song'
    installWebClient(home, packageName, { exports: { '.': { import: './index.js' } } })
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: missing-skin',
      `      name: '${packageName}'`,
      '    - id: third-party-host',
      "      name: 'third-party-host-plugin'",
      '',
    ].join('\n'))

    const desktop = prepareDesktopProfile(undefined, home, 'darwin')
    const desktopRows = composeEntries([desktop.patches])

    expect(desktopRows.map(row => row.id)).not.toContain('missing-skin')
    expect(desktopRows).toContainEqual({
      id: 'third-party-host',
      name: 'third-party-host-plugin',
    })
    expect(desktop.skippedOptionalEntries).toEqual([{
      id: 'missing-skin',
      name: packageName,
    }])

    const web = prepareDesktopProfile(undefined, home, 'darwin', 'web')
    const webRows = composeEntries([web.patches])
    expect(webRows).toContainEqual({ id: 'missing-skin', name: packageName })
    expect(web.skippedOptionalEntries).toEqual([])
  })

  it('keeps unresolved non-UI package entries fail-loud', () => {
    const home = temporaryHome()
    const packageName = '@example/whale-song-theme'
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: optional-theme',
      `      name: '${packageName}'`,
      '',
    ].join('\n'))

    const desktop = prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([desktop.patches])).toContainEqual({ id: 'optional-theme', name: packageName })
    expect(desktop.skippedOptionalEntries).toEqual([])
  })

  it('does not treat ordinary array config as nested Loader entries', () => {
    const home = temporaryHome()
    const packageName = '@example/whale-song-theme'
    installWebClient(home, packageName)
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: config-holder',
      "      name: 'third-party-host-plugin'",
      '      config:',
      `        - name: '${packageName}'`,
      '          enabled: true',
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([prepared.patches])).toContainEqual({
      id: 'config-holder',
      name: 'third-party-host-plugin',
      config: [{ name: packageName, enabled: true }],
    })
    expect(prepared.skippedOptionalEntries).toEqual([])
  })

  it('leaves non-package Loader specifiers unchanged', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: builtin-plugin',
      "      name: 'cordis:example'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([prepared.patches])).toContainEqual({
      id: 'builtin-plugin',
      name: 'cordis:example',
    })
    expect(prepared.skippedOptionalEntries).toEqual([])
  })

  it('preserves explicitly disabled upstream Windows providers and third-party replacements', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: pwsh-sandbox',
      "  name: '@deepseek-ai/dsh-pwsh-sandbox'",
      '  disabled: true',
      '- insert:',
      '    - id: third-party-pwsh-sandbox',
      "      name: 'third-party-pwsh-sandbox'",
      '- id: subprocess',
      "  name: '@deepseek-ai/dsh-subprocess-local'",
      '  disabled: true',
      '- insert:',
      '    - id: third-party-subprocess',
      "      name: 'third-party-subprocess'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'win32')
    const rows = composeEntries([prepared.patches])

    expect(rows.find(row => row.id === 'pwsh-sandbox')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'third-party-pwsh-sandbox',
      name: 'third-party-pwsh-sandbox',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-pwsh-sandbox')
    expect(rows.find(row => row.id === 'subprocess')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-subprocess-local',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'third-party-subprocess',
      name: 'third-party-subprocess',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-subprocess')
  })
})

describe('bundled Agents Anywhere', () => {
  it('loads the shipped bundle only after explicit opt-in, through its declared bundle and physical Connector paths', () => {
    const home = temporaryHome()
    const disabled = prepareDesktopProfile('1', home)
    expect(disabled.aaEnabled).toBe(false)
    expect(composeEntries([disabled.patches]).some(row => row.name === '@agents-anywhere/dsh-bridge-next')).toBe(false)
    const enabled = prepareDesktopProfile('1', home, process.platform, undefined, undefined, undefined, { aaEnabled: true })
    const aa = composeEntries([enabled.patches]).filter(row => row.name === '@agents-anywhere/dsh-bridge-next' && !row.disabled)
    expect(aa).toHaveLength(1)
    expect(enabled.profile.layers.some(layer => layer.packageName === '@agents-anywhere/dsh-bridge-next')).toBe(true)
    expect(aa[0]?.config).toMatchObject({ dshHome: home })
    expect(aa[0]?.config).not.toHaveProperty('stateRoot')
    const config = aa[0]?.config as { connectorSourceDir: string }
    expect(readFileSync(join(config.connectorSourceDir, 'pyproject.toml'), 'utf8')).toContain('anywhere-cli')
    expect(prepareDesktopProfile('1', home).aaEnabled).toBe(false)
  })
  it('preserves the selected bundle config instead of rebuilding its plugin row', () => {
    const home = temporaryHome()
    prepareDesktopProfile('1', home)
    const packageDir = installBundle(home, '@agents-anywhere/dsh-bridge-next', [
      '- insert:', '    - id: agents-anywhere-bridge-next', '      name: "@agents-anywhere/dsh-bridge-next"',
      '      config:', '        apiBaseUrl: "https://aa.example.com"', '        uvPath: "/custom-uv"',
      '        stateRoot: "/custom-aa-state"', '',
    ].join('\n'), '99.0.0')
    writeFileSync(join(packageDir, 'native.patch.yml'), readFileSync(join(packageDir, 'cordis.patch.yml')))
    rmSync(join(packageDir, 'cordis.patch.yml'))
    const manifestPath = join(packageDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dsh.bundle.patch = './native.patch.yml'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    mkdirSync(join(packageDir, 'lib', 'bundled-connector'), { recursive: true })
    writeFileSync(join(packageDir, 'lib', 'bundled-connector', 'pyproject.toml'), '[project]')
    const enabled = prepareDesktopProfile('1', home, process.platform, undefined, undefined, undefined, { aaEnabled: true })
    expect(enabled.aaFailure).toBeUndefined()
    expect(enabled.profile.layers.find(layer => layer.packageName === '@agents-anywhere/dsh-bridge-next')?.packageDir).toBe(packageDir)
    const row = composeEntries([enabled.patches]).find(row => row.name === '@agents-anywhere/dsh-bridge-next')!
    expect(row.config).toMatchObject({ apiBaseUrl: 'https://aa.example.com', uvPath: '/custom-uv', stateRoot: '/custom-aa-state', dshHome: home })
  })
  it.each(['missing-patch', 'invalid-yaml', 'invalid-row', 'missing-payload'])('keeps Desktop bootable when the optional AA bundle has %s', failure => {
    const home = temporaryHome()
    prepareDesktopProfile('1', home)
    const packageDir = installBundle(home, '@agents-anywhere/dsh-bridge-next', failure === 'invalid-yaml' ? '['
      : failure === 'invalid-row' ? '- insert: []\n'
      : '- insert:\n    - id: agents-anywhere-bridge-next\n      name: "@agents-anywhere/dsh-bridge-next"\n', '99.0.0')
    if (failure === 'missing-patch') rmSync(join(packageDir, 'cordis.patch.yml'))
    const prepared = prepareDesktopProfile('1', home, process.platform, undefined, undefined, undefined, { aaEnabled: true })
    expect(prepared.aaEnabled).toBe(false)
    expect(prepared.aaFailure).toBeTruthy()
    expect(composeEntries([prepared.patches]).some(row => row.name === '@agents-anywhere/dsh-bridge-next')).toBe(false)
    expect(composeEntries([prepared.patches]).some(row => row.id === 'settings')).toBe(true)
    const disabled = prepareDesktopProfile('1', home)
    expect(disabled.aaFailure).toBeUndefined()
    expect(disabled.profile.layers.some(layer => layer.packageName === '@agents-anywhere/dsh-bridge-next')).toBe(false)
  })
  it('reports conflicting AA user layers and excludes them recursively while disabled', () => {
    const home = temporaryHome()
    prepareDesktopProfile('1', home)
    writeFileSync(join(home, 'cordis.patch.yml'), '- insert:\n    - id: aa-group\n      group: true\n      config:\n        - id: other-aa\n          name: "@agents-anywhere/dsh-bridge-next"\n')
    const enabled = prepareDesktopProfile('1', home, process.platform, undefined, undefined, undefined, { aaEnabled: true })
    expect(enabled.aaEnabled).toBe(false)
    expect(enabled.aaFailure).toContain('conflicting AA')
    expect(JSON.stringify(enabled.patches)).not.toContain('@agents-anywhere/dsh-bridge-next')
  })
  it('does not let a user patch enable AA while Desktop selection is off', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), '- insert:\n    - id: custom-aa\n      name: "@agents-anywhere/dsh-bridge-next"\n')
    const prepared = prepareDesktopProfile('1', home)
    expect(composeEntries([prepared.patches]).filter(row => row.name === '@agents-anywhere/dsh-bridge-next').every(row => row.disabled)).toBe(true)
  })
})

describe('desktop profile composition and the recovery deselection ledger', () => {
  function selectionBootstrap(home: string) {
    return {
      profileName: 'desktop',
      homeDir: home,
      statePath: join(home, 'user-data', 'plugin-management', 'state.json'),
    }
  }

  function declareBundle(home: string, packageName: string): string {
    const manifestPath = join(ensureDesktopProfile(home), 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh: { profile: { bundles: string[] }; desktopDeselectedBundles?: string[] }
    }
    manifest.dsh.profile.bundles.push(packageName)
    manifest.dependencies = { ...manifest.dependencies, [packageName]: '1.0.0' }
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
    return manifestPath
  }

  it('never lets the deselection ledger decide what loads, under either market provider', () => {
    const home = temporaryHome()
    const packageName = 'third-party-plugin'
    installBundle(home, packageName, '- insert:\n    - id: third-party-marker\n      name: cordis:example\n')
    const manifestPath = declareBundle(home, packageName)
    // A stale ledger entry for a name that is still selected is a UI artefact,
    // never a policy: composition reads `dsh.profile.bundles` alone.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] }; desktopDeselectedBundles?: string[] }
    }
    manifest.dsh.desktopDeselectedBundles = [packageName]
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')

    for (const provider of ['dsh-market', 'community-market'] as const) {
      const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'desktop', undefined, {
        requested: provider,
        effective: provider,
        legacyDefaulted: false,
      })
      expect(composeEntries([prepared.patches])).toContainEqual(expect.objectContaining({
        id: 'third-party-marker',
      }))
    }
  })

  it('lets a deselected bundle with an unparseable patch stop breaking startup', async () => {
    const home = temporaryHome()
    const packageName = 'broken-plugin'
    installBundle(home, packageName, 'not: [valid yaml')
    declareBundle(home, packageName)
    expect(() => prepareDesktopProfile(undefined, home, 'darwin')).toThrow()

    await setDesktopProfileBundleSelected(selectionBootstrap(home), packageName, false)

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([prepared.patches])).not.toContainEqual(expect.objectContaining({
      name: `${packageName}/host`,
    }))
    expect(prepared.profile.layers.some(layer => layer.packageName === packageName)).toBe(false)
    // Nothing was deleted: the declared dependency and the files both survive.
    const manifest = JSON.parse(readFileSync(join(ensureDesktopProfile(home), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies[packageName]).toBe('1.0.0')
    expect(existsSync(join(home, 'profiles', 'desktop', 'node_modules', packageName, 'package.json'))).toBe(true)
  })

  it('lets a deselected bundle whose package directory has no manifest stop breaking startup', async () => {
    const home = temporaryHome()
    const packageName = 'half-written-plugin'
    mkdirSync(join(home, 'profiles', 'desktop', 'node_modules', packageName), { recursive: true })
    declareBundle(home, packageName)
    expect(() => prepareDesktopProfile(undefined, home, 'darwin')).toThrow()

    await setDesktopProfileBundleSelected(selectionBootstrap(home), packageName, false)
    expect(() => prepareDesktopProfile(undefined, home, 'darwin')).not.toThrow()
  })
})
