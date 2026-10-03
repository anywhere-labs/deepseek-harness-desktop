import {
  lstatSync,
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
import { parseDocument } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultDesktopSetupWizardSettings,
  migrateDesktopBrowserAccessSettings,
  migrateDesktopWindowMaterialSettings,
  migrateLegacyAgentPresetSettings,
  mirrorDesktopSetupWizardProfileSettings,
  readDesktopSetupWizardSettings,
  updateDesktopSetupWizardSettings,
  type DesktopSetupWizardSettings,
} from '../src/setup-wizard-settings.ts'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-setup-settings-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function values(overrides: Partial<DesktopSetupWizardSettings> = {}): DesktopSetupWizardSettings {
  return {
    mode: 'compatibility',
    macosMaterial: 'transparent',
    windowsMaterial: 'off',
    openBrowser: true,
    networkExposure: 'lan',
    notifications: {
      enabled: true,
      notifyOnTurnCompletion: false,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: false,
      notifyOnJobFailure: true,
      notifyOnScheduleCompletion: true,
      notifyOnScheduleFailure: true,
    },
    ...overrides,
  }
}

describe('Desktop Setup Wizard settings document', () => {
  it('returns platform defaults for an absent exact settings document', () => {
    const root = temporaryDirectory()
    expect(readDesktopSetupWizardSettings(join(root, 'settings.yaml')))
      .toEqual(defaultDesktopSetupWizardSettings())
    expect(readDesktopSetupWizardSettings(join(root, 'settings.json')))
      .toEqual(defaultDesktopSetupWizardSettings())
    expect(defaultDesktopSetupWizardSettings()).toMatchObject({
      mode: 'compatibility',
      macosMaterial: 'transparent',
      windowsMaterial: 'off',
      openBrowser: false,
      networkExposure: 'loopback',
    })
  })

  it('updates YAML leaves while preserving comments, unknown fields, and inactive-platform material', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'settings.yaml')
    writeFileSync(path, [
      '# settings owner comment',
      'other-plugin:',
      '  token: keep-me',
      'dsh-desktop:',
      '  # presentation comment',
      '  mode: compatibility',
      '  macosMaterial: transparent',
      '  windowsMaterial: acrylic',
      '  port: 61201',
      '  logLevel: warn',
      '  futureField: preserved',
      'dsh-desktop-notifications:',
      '  enabled: false',
      '  notifyOnTurnCompletion: true',
      '  futureNotification: keep',
      '',
    ].join('\n'), { mode: 0o600 })

    const next = values()
    await expect(updateDesktopSetupWizardSettings(path, next)).resolves.toEqual(next)

    const text = readFileSync(path, 'utf8')
    expect(text).toContain('# settings owner comment')
    expect(text).toContain('# presentation comment')
    const document = parseDocument(text).toJS() as Record<string, Record<string, unknown>>
    expect(document['other-plugin']).toEqual({ token: 'keep-me' })
    expect(document['dsh-desktop']).toMatchObject({
      mode: 'compatibility',
      macosMaterial: 'transparent',
      windowsMaterial: 'off',
      port: 61201,
      logLevel: 'warn',
      futureField: 'preserved',
      openBrowser: true,
      networkExposure: 'lan',
    })
    expect(document['dsh-desktop-notifications']).toEqual({
      enabled: true,
      notifyOnTurnCompletion: false,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: false,
      notifyOnJobFailure: true,
      notifyOnScheduleCompletion: true,
      notifyOnScheduleFailure: true,
      futureNotification: 'keep',
    })
    expect(readDesktopSetupWizardSettings(path)).toEqual(next)
    expect(readdirSync(root)).toEqual(['settings.yaml'])
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('creates and updates JSON without dropping unrelated namespaces or unknown leaves', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'custom-settings.json')
    writeFileSync(path, `${JSON.stringify({
      custom: { retained: ['a', 'b'] },
      'dsh-desktop': {
        mode: 'extended',
        macosMaterial: 'off',
        windowsMaterial: 'acrylic',
        future: 42,
      },
      'dsh-desktop-notifications': { future: 'yes' },
    }, undefined, 2)}\n`, { mode: 0o600 })
    const next = values({
      mode: 'compatibility',
      macosMaterial: 'transparent',
      windowsMaterial: 'off',
    })

    await updateDesktopSetupWizardSettings(path, next)

    const output = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>
    expect(output.custom).toEqual({ retained: ['a', 'b'] })
    expect(output['dsh-desktop']).toMatchObject({
      mode: 'compatibility',
      macosMaterial: 'transparent',
      windowsMaterial: 'off',
      future: 42,
      openBrowser: true,
      networkExposure: 'lan',
    })
    expect(output['dsh-desktop-notifications']).toMatchObject({ future: 'yes' })
    expect(readDesktopSetupWizardSettings(path)).toEqual(next)
  })

  it('creates an absent YAML document with every supported field', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'nested', 'settings.yml')
    const next = values({
      mode: 'extended',
      macosMaterial: 'transparent',
      openBrowser: false,
      networkExposure: 'loopback',
    })

    await updateDesktopSetupWizardSettings(path, next)

    expect(lstatSync(path).isFile()).toBe(true)
    expect(readDesktopSetupWizardSettings(path)).toEqual(next)
  })

  it('does not overwrite malformed syntax, invalid roots, or invalid known values', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'settings.yaml')
    for (const text of [
      'dsh-desktop: [unterminated\n',
      '- not\n- a namespace map\n',
      'dsh-desktop:\n  mode: impossible\n',
      'dsh-desktop-notifications:\n  enabled: sometimes\n',
    ]) {
      writeFileSync(path, text, { mode: 0o600 })
      await expect(updateDesktopSetupWizardSettings(path, values())).rejects.toThrow()
      expect(readFileSync(path, 'utf8')).toBe(text)
      expect(readdirSync(root)).toEqual(['settings.yaml'])
    }
  })

  it('does not overwrite empty, malformed, or non-UTF-8 JSON', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'settings.json')
    const invalidDocuments = [
      Buffer.from(''),
      Buffer.from('{not-json}\n'),
      Buffer.from([0xff]),
    ]
    for (const contents of invalidDocuments) {
      writeFileSync(path, contents, { mode: 0o600 })
      await expect(updateDesktopSetupWizardSettings(path, values())).rejects.toThrow()
      expect(readFileSync(path)).toEqual(contents)
    }
  })

  it('requires a complete update and withdraws LAN exposure with browser access', async () => {
    const path = join(temporaryDirectory(), 'settings.json')
    const incomplete = values({
      openBrowser: false,
      networkExposure: 'lan',
      notifications: { enabled: true } as DesktopSetupWizardSettings['notifications'],
    })
    await expect(updateDesktopSetupWizardSettings(path, incomplete))
      .rejects.toThrow('all seven notification booleans')

    const next = values({ openBrowser: false, networkExposure: 'lan' })
    await expect(updateDesktopSetupWizardSettings(path, next)).resolves.toMatchObject({
      openBrowser: false,
      networkExposure: 'loopback',
    })
    expect(readDesktopSetupWizardSettings(path)).toMatchObject({
      openBrowser: false,
      networkExposure: 'loopback',
    })

    const incompatible = values({ mode: 'advanced', openBrowser: true, networkExposure: 'lan' })
    await expect(updateDesktopSetupWizardSettings(path, incompatible)).resolves.toMatchObject({
      mode: 'advanced',
      openBrowser: false,
      networkExposure: 'loopback',
    })
    expect(readDesktopSetupWizardSettings(path)).toMatchObject({
      mode: 'advanced',
      openBrowser: false,
      networkExposure: 'loopback',
    })
  })

  it('projects legacy LAN exposure as explicit compatibility browser access', () => {
    const path = join(temporaryDirectory(), 'settings.yaml')
    writeFileSync(path, [
      'dsh-desktop:',
      '  openBrowser: false',
      '  networkExposure: lan',
      '',
    ].join('\n'))

    expect(readDesktopSetupWizardSettings(path)).toMatchObject({
      mode: 'compatibility',
      openBrowser: true,
      networkExposure: 'lan',
    })
  })

  it('atomically withdraws legacy browser handoff and LAN from custom modes', async () => {
    const root = temporaryDirectory()
    const yamlPath = join(root, 'legacy.yaml')
    writeFileSync(yamlPath, [
      '# preserve browser migration comments',
      'dsh-desktop:',
      '  mode: advanced',
      '  openBrowser: false',
      '  networkExposure: lan',
      '  future: keep',
      '',
    ].join('\n'))

    await expect(migrateDesktopBrowserAccessSettings(yamlPath)).resolves.toBe(true)
    await expect(migrateDesktopBrowserAccessSettings(yamlPath)).resolves.toBe(false)
    const migrated = readFileSync(yamlPath, 'utf8')
    expect(migrated).toContain('# preserve browser migration comments')
    expect(parseDocument(migrated).toJS()).toMatchObject({
      'dsh-desktop': {
        mode: 'advanced',
        openBrowser: false,
        networkExposure: 'loopback',
        future: 'keep',
      },
    })

    const jsonPath = join(root, 'legacy.json')
    writeFileSync(jsonPath, `${JSON.stringify({
      'dsh-desktop': {
        mode: 'extended',
        openBrowser: true,
        networkExposure: 'loopback',
      },
      untouched: { value: 1 },
    })}\n`)
    await expect(migrateDesktopBrowserAccessSettings(jsonPath)).resolves.toBe(true)
    expect(JSON.parse(readFileSync(jsonPath, 'utf8'))).toMatchObject({
      'dsh-desktop': {
        mode: 'extended',
        openBrowser: false,
        networkExposure: 'loopback',
      },
      untouched: { value: 1 },
    })
  })

  it('preserves legacy LAN intent by materializing compatibility browser access', async () => {
    const path = join(temporaryDirectory(), 'legacy.yaml')
    writeFileSync(path, [
      'dsh-desktop:',
      '  mode: compatibility',
      '  openBrowser: false',
      '  networkExposure: lan',
      '',
    ].join('\n'))

    await expect(migrateDesktopBrowserAccessSettings(path)).resolves.toBe(true)
    await expect(migrateDesktopBrowserAccessSettings(path)).resolves.toBe(false)
    expect(parseDocument(readFileSync(path, 'utf8')).toJS()).toMatchObject({
      'dsh-desktop': {
        mode: 'compatibility',
        openBrowser: true,
        networkExposure: 'lan',
      },
    })
  })

  it('does not acquire a writer lock when browser access settings are already normalized', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'settings.yaml')
    const lockPath = `${path}.lock`
    const contents = 'dsh-desktop:\n  mode: compatibility\n  macosMaterial: transparent\n'
    writeFileSync(path, contents)
    writeFileSync(lockPath, 'owner\n')

    await expect(migrateDesktopBrowserAccessSettings(path)).resolves.toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(contents)
    expect(readFileSync(lockPath, 'utf8')).toBe('owner\n')
  })

  it('does not acquire a writer lock for an unchanged Setup selection', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'settings.yaml')
    const lockPath = `${path}.lock`
    const contents = 'dsh-desktop:\n  mode: compatibility\n  macosMaterial: transparent\n'
    writeFileSync(path, contents)
    writeFileSync(lockPath, 'owner\n')

    await expect(updateDesktopSetupWizardSettings(path, defaultDesktopSetupWizardSettings()))
      .resolves.toEqual(defaultDesktopSetupWizardSettings())
    expect(readFileSync(path, 'utf8')).toBe(contents)
    expect(readFileSync(lockPath, 'utf8')).toBe('owner\n')
  })

  it('writes a changed Setup selection without waiting for a settings lock', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'settings.yaml')
    const lockPath = `${path}.lock`
    writeFileSync(path, 'dsh-desktop:\n  mode: compatibility\n')
    writeFileSync(lockPath, 'owner\n')
    const next = values({
      mode: 'advanced',
      openBrowser: false,
      networkExposure: 'loopback',
    })

    await expect(updateDesktopSetupWizardSettings(path, next)).resolves.toEqual(next)
    expect(readDesktopSetupWizardSettings(path)).toEqual(next)
    expect(readFileSync(lockPath, 'utf8')).toBe('owner\n')
  })

  it('does not wait for a settings lock when a browser migration is needed', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'settings.yaml')
    const lockPath = `${path}.lock`
    const contents = 'dsh-desktop:\n  mode: advanced\n  openBrowser: true\n'
    writeFileSync(path, contents)
    writeFileSync(lockPath, 'owner\n')

    await expect(migrateDesktopBrowserAccessSettings(path)).resolves.toBe(true)
    expect(readFileSync(path, 'utf8')).not.toBe(contents)
    expect(readFileSync(lockPath, 'utf8')).toBe('owner\n')
    expect(readDesktopSetupWizardSettings(path)).toMatchObject({
      mode: 'advanced',
      openBrowser: false,
      networkExposure: 'loopback',
    })
  })

  it('never follows an existing settings-document symlink', async () => {
    const root = temporaryDirectory()
    const outside = join(temporaryDirectory(), 'outside.yaml')
    const path = join(root, 'settings.yaml')
    writeFileSync(outside, 'outside: true\n', { mode: 0o600 })
    symlinkSync(outside, path)

    expect(() => readDesktopSetupWizardSettings(path)).toThrow('regular file')
    await expect(updateDesktopSetupWizardSettings(path, values())).rejects.toThrow('regular file')
    expect(readFileSync(outside, 'utf8')).toBe('outside: true\n')
  })

  it('atomically migrates the removed Acrylic preference to off', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'settings.yaml')
    writeFileSync(path, [
      '# preserve material migration comments',
      'unrelated:',
      '  keep: true',
      'dsh-desktop:',
      '  mode: extended',
      '  windowsMaterial: acrylic',
      '  future: retained',
      '',
    ].join('\n'), { mode: 0o600 })

    expect(readDesktopSetupWizardSettings(path).windowsMaterial).toBe('off')
    await expect(migrateDesktopWindowMaterialSettings(path)).resolves.toBe(true)
    await expect(migrateDesktopWindowMaterialSettings(path)).resolves.toBe(false)

    const migrated = readFileSync(path, 'utf8')
    expect(migrated).toContain('# preserve material migration comments')
    expect(parseDocument(migrated).toJS()).toMatchObject({
      unrelated: { keep: true },
      'dsh-desktop': {
        mode: 'extended',
        windowsMaterial: 'off',
        future: 'retained',
      },
    })
  })

  it('reads a removed Mica preference as off without rewriting it', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'settings.yaml')
    const contents = [
      'dsh-desktop:',
      '  mode: advanced',
      '  windowsMaterial: mica',
      '',
    ].join('\n')
    writeFileSync(path, contents, { mode: 0o600 })

    expect(readDesktopSetupWizardSettings(path)).toMatchObject({ mode: 'advanced', windowsMaterial: 'off' })
    await expect(migrateDesktopWindowMaterialSettings(path)).resolves.toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(contents)
  })

  it('atomically migrates the released code preset default to ptc', async () => {
    const root = temporaryDirectory()
    const yamlPath = join(root, 'legacy-preset.yaml')
    writeFileSync(yamlPath, [
      '# preserve preset migration comments',
      'agent-presets:',
      '  default: code',
      '  future: retained',
      'unrelated:',
      '  keep: true',
      '',
    ].join('\n'), { mode: 0o600 })

    await expect(migrateLegacyAgentPresetSettings(yamlPath)).resolves.toBe(true)
    await expect(migrateLegacyAgentPresetSettings(yamlPath)).resolves.toBe(false)
    const migrated = readFileSync(yamlPath, 'utf8')
    expect(migrated).toContain('# preserve preset migration comments')
    expect(parseDocument(migrated).toJS()).toEqual({
      'agent-presets': { default: 'ptc', future: 'retained' },
      unrelated: { keep: true },
    })

    const jsonPath = join(root, 'legacy-preset.json')
    writeFileSync(jsonPath, `${JSON.stringify({
      'agent-presets': { default: 'code', future: 'retained' },
      unrelated: { keep: true },
    })}\n`)
    await expect(migrateLegacyAgentPresetSettings(jsonPath)).resolves.toBe(true)
    expect(JSON.parse(readFileSync(jsonPath, 'utf8'))).toEqual({
      'agent-presets': { default: 'ptc', future: 'retained' },
      unrelated: { keep: true },
    })
  })

  it('migrates the code preset default under its 0.1.7 registry key too', async () => {
    // Beta's launcher renames `agent-presets.default` to
    // `agent-preset-registry.selectedDefault` before this migration runs.
    const path = join(temporaryDirectory(), 'registry-preset.yaml')
    writeFileSync(path, [
      'agent-preset-registry:',
      '  selectedDefault: code',
      '  default: standard',
      '',
    ].join('\n'))

    await expect(migrateLegacyAgentPresetSettings(path)).resolves.toBe(true)
    await expect(migrateLegacyAgentPresetSettings(path)).resolves.toBe(false)
    expect(parseDocument(readFileSync(path, 'utf8')).toJS()).toEqual({
      'agent-preset-registry': { selectedDefault: 'ptc', default: 'standard' },
    })
  })

  it('leaves current and user-authored preset defaults untouched', async () => {
    for (const preset of ['ptc', 'my-local-preset']) {
      const path = join(temporaryDirectory(), `${preset}.yaml`)
      const contents = `agent-presets:\n  default: ${preset}\n`
      writeFileSync(path, contents)
      await expect(migrateLegacyAgentPresetSettings(path)).resolves.toBe(false)
      expect(readFileSync(path, 'utf8')).toBe(contents)
    }
  })

  it('serializes concurrent complete updates without producing a torn document', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'settings.yaml')
    writeFileSync(path, 'unrelated:\n  keep: true\n', { mode: 0o600 })
    const first = values({ mode: 'extended', windowsMaterial: 'off', openBrowser: false, networkExposure: 'loopback' })
    const second = values({ mode: 'compatibility', networkExposure: 'loopback' })

    await Promise.all([
      updateDesktopSetupWizardSettings(path, first),
      updateDesktopSetupWizardSettings(path, second),
    ])

    const result = readDesktopSetupWizardSettings(path)
    expect([first, second]).toContainEqual(result)
    expect(parseDocument(readFileSync(path, 'utf8')).toJS()).toMatchObject({
      unrelated: { keep: true },
    })
    expect(readdirSync(root)).toEqual(['settings.yaml'])
  })
})

describe('Desktop Setup Wizard settings under the 0.1.7 section keys', () => {
  // 0.1.7's launcher renames `dsh-desktop` / `dsh-desktop-notifications` to the
  // Loader entry ids before any Setup helper reads the document, and the settings
  // service imports and renames the document away on the first Host boot.
  const renamed = [
    '# user comment',
    'desktop-shell:',
    '  mode: extended',
    '  windowsMaterial: "off"',
    '  macosMaterial: "off"',
    '  logLevel: debug',
    'desktop-notifications:',
    '  notifyOnJobCompletion: false',
    '',
  ].join('\n')

  it('reads the renamed sections instead of falling back to defaults', () => {
    const path = join(temporaryDirectory(), 'settings.yaml')
    writeFileSync(path, renamed)

    expect(readDesktopSetupWizardSettings(path)).toMatchObject({
      mode: 'extended',
      windowsMaterial: 'off',
      macosMaterial: 'off',
      notifications: { notifyOnJobCompletion: false, enabled: true },
    })
  })

  it('updates the renamed sections in place and never recreates the legacy keys', async () => {
    const path = join(temporaryDirectory(), 'settings.yaml')
    writeFileSync(path, renamed)

    await updateDesktopSetupWizardSettings(path, values({ mode: 'advanced', openBrowser: false, networkExposure: 'loopback' }))

    const text = readFileSync(path, 'utf8')
    expect(text).toContain('# user comment')
    const document = parseDocument(text).toJS() as Record<string, Record<string, unknown>>
    expect(Object.keys(document)).toEqual(['desktop-shell', 'desktop-notifications'])
    expect(document['desktop-shell']).toMatchObject({ mode: 'advanced', windowsMaterial: 'off', logLevel: 'debug' })
    expect(document['desktop-notifications']).toMatchObject({ notifyOnTurnCompletion: false })
  })

  it('writes a new document under the entry ids the settings import keys by', async () => {
    const path = join(temporaryDirectory(), 'settings.yaml')

    await updateDesktopSetupWizardSettings(path, values())

    expect(Object.keys(parseDocument(readFileSync(path, 'utf8')).toJS() as object))
      .toEqual(['desktop-shell', 'desktop-notifications'])
  })

  it('migrates removed Acrylic and legacy LAN intent inside the renamed section', async () => {
    const path = join(temporaryDirectory(), 'settings.yaml')
    writeFileSync(path, 'desktop-shell:\n  windowsMaterial: acrylic\n  openBrowser: false\n  networkExposure: lan\n')

    await expect(migrateDesktopWindowMaterialSettings(path)).resolves.toBe(true)
    await expect(migrateDesktopBrowserAccessSettings(path)).resolves.toBe(true)

    expect(parseDocument(readFileSync(path, 'utf8')).toJS()).toEqual({
      'desktop-shell': { windowsMaterial: 'off', openBrowser: true, networkExposure: 'lan' },
    })
  })

  it('mirrors Profile leaves into a pending document without touching its materials', async () => {
    const path = join(temporaryDirectory(), 'settings.yaml')
    writeFileSync(path, renamed)
    const profile = {
      mode: 'compatibility',
      openBrowser: true,
      networkExposure: 'lan',
      notifications: values().notifications,
    } as const

    await expect(mirrorDesktopSetupWizardProfileSettings(path, profile)).resolves.toBe(true)
    await expect(mirrorDesktopSetupWizardProfileSettings(path, profile)).resolves.toBe(false)

    expect(readDesktopSetupWizardSettings(path)).toEqual({
      ...profile,
      windowsMaterial: 'off',
      macosMaterial: 'off',
    })
  })

  it('does not recreate a document the settings import already consumed', async () => {
    const root = temporaryDirectory()
    const path = join(root, 'settings.yaml')
    writeFileSync(`${path}.imported`, renamed)

    await expect(mirrorDesktopSetupWizardProfileSettings(path, {
      mode: 'advanced',
      openBrowser: false,
      networkExposure: 'loopback',
      notifications: values().notifications,
    })).resolves.toBe(false)

    expect(readdirSync(root)).toEqual(['settings.yaml.imported'])
    expect(readFileSync(`${path}.imported`, 'utf8')).toBe(renamed)
  })
})
