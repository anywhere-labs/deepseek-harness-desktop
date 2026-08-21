/** Compatibility profile composition over the official Web bundle and user plugins. */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluate, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  loadOptionalPatches,
  loadOverlayPatches,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
  type Profile,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import FileSettingsProvider, {
  resolveSpec as resolveSettingsFileSpec,
  type Config as SettingsFileConfig,
} from '@deepseek-ai/dsh-settings-file'
import { parseDocument } from 'yaml'
import { unpackedAsarPath } from './packaged-runtime-path.ts'
import { findOverlayPackage, resolveOverlayPackage } from './package-overlay.ts'
import { DESKTOP_DEFAULT_WEB_PORT } from './desktop-port.ts'
import type { DesktopShellMode } from './runtime.ts'
import {
  activeDesktopProfileLayers,
  desktopPluginBundleMutable,
  readDesktopDisabledBundles,
} from './desktop-plugins.ts'
import {
  DESKTOP_MARKET_IDENTITIES,
  desktopMarketSnapshotWithEffective,
  type DesktopMarketProvider,
  type DesktopMarketSnapshot,
} from './desktop-market.ts'

/** Persistent profile managed by the desktop launcher and the ordinary dsh plugin command. */
export const DESKTOP_PROFILE_NAME = 'desktop'

/** Standalone package name inserted through the launcher-owned desktop layer. */
export const DESKTOP_PACKAGE_NAME = 'dsh-plugin-desktop'

/** Empty include root rewritten before every profile boot. */
export const DESKTOP_PROFILE_ROOT = 'cordis.yml'

const BIN_NAME = DESKTOP_PACKAGE_NAME
const REQUIRED_BUNDLES = requiredWebBundles()
const REQUIRED_BUNDLE_SET = new Set(REQUIRED_BUNDLES)
const OBSOLETE_DESKTOP_BUNDLE_SET = new Set(['@deepseek-ai/dsh-desktop-app'])
const INSTALL_ANCHOR = unpackedAsarPath(fileURLToPath(new URL('../package.json', import.meta.url)))
const DESKTOP_PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const DIRECTORY_PICKER_ROW_ID = 'directory-picker'
const AUTO_PICKER_PACKAGE = '@deepseek-ai/dsh-host-directory-picker-auto'
const BROWSE_PICKER_BACKEND = '@deepseek-ai/dsh-host-directory-picker-browse'
const BROWSE_PICKER_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-browse'
const PWSH_SANDBOX_ROW_ID = 'pwsh-sandbox'
const UPSTREAM_PWSH_SANDBOX_PACKAGE = '@deepseek-ai/dsh-pwsh-sandbox'
const DESKTOP_WINDOWS_PWSH_SANDBOX_ROW_ID = 'desktop-windows-pwsh-sandbox'
const DESKTOP_WINDOWS_PWSH_SANDBOX_PACKAGE = 'dsh-plugin-desktop/windows-pwsh-sandbox'
const AGENT_PRESETS_ROW_ID = 'agent-presets'
const UPSTREAM_AGENT_PRESETS_PACKAGE = '@deepseek-ai/dsh-agent-presets'
const DESKTOP_WINDOWS_AGENT_PRESETS_ROW_ID = 'desktop-windows-agent-presets'
const DESKTOP_WINDOWS_AGENT_PRESETS_PACKAGE = 'dsh-plugin-desktop/windows-agent-presets'
const DEFAULT_DESKTOP_SHELL_MODE: DesktopShellMode = 'compatibility'
const DEFAULT_DESKTOP_PORT = DESKTOP_DEFAULT_WEB_PORT
const DESKTOP_WEB_SERVER_ROW_ID = 'desktop-webserver'
const DESKTOP_WEB_SERVER_PACKAGE = 'dsh-plugin-desktop/webserver'
const SETTINGS_FILE_PACKAGE = '@deepseek-ai/dsh-settings-file'
const DESKTOP_SETTINGS_NAMESPACE = 'dsh-desktop'
const UI_LAYOUT_PACKAGE = '@deepseek-ai/dsh-client-ui-layout'
const UI_SIDEBAR_PACKAGE = '@deepseek-ai/dsh-client-ui-sidebar'
const UI_CONVERSATION_PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'
const DEFAULT_DESKTOP_MARKET_SNAPSHOT: DesktopMarketSnapshot = Object.freeze({
  requested: 'disabled',
  effective: 'disabled',
  legacyDefaulted: true,
})
const MARKET_ROW_IDS: ReadonlySet<string> = new Set([
  DESKTOP_MARKET_IDENTITIES.community.rowId,
  DESKTOP_MARKET_IDENTITIES.dshMarket.rowId,
])
const MARKET_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  DESKTOP_MARKET_IDENTITIES.community.packageName,
  DESKTOP_MARKET_IDENTITIES.dshMarket.packageName,
])

/**
 * Parse desktop presentation state and reject corrupted values.
 * @param value - untrusted settings value.
 * @returns a supported desktop shell mode.
 */
export function parseDesktopShellMode(value: unknown): DesktopShellMode {
  if (value === undefined) return DEFAULT_DESKTOP_SHELL_MODE
  if (value === 'compatibility' || value === 'advanced') return value
  throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE}.mode must be "compatibility" or "advanced"`)
}

/** Parse the requested loopback Web port and reject values Node cannot listen on. */
export function parseDesktopPort(value: unknown): number {
  if (value === undefined) return DEFAULT_DESKTOP_PORT
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65_535) return value
  throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE}.port must be an integer from 0 through 65535`)
}

/** Startup settings projected into the Loader graph before the settings plugin boots. */
export interface DesktopStartupSettings {
  mode: DesktopShellMode
  port: number
}

/**
 * Read Desktop startup settings from one parsed settings document.
 * @param document - untrusted settings document root.
 * @returns validated mode and port defaults for the next generation.
 */
export function desktopStartupSettingsFromSettings(document: unknown): DesktopStartupSettings {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error(`${BIN_NAME}: settings document must be a map of namespace sections`)
  }
  const section = (document as Record<string, unknown>)[DESKTOP_SETTINGS_NAMESPACE]
  if (section === undefined) {
    return { mode: DEFAULT_DESKTOP_SHELL_MODE, port: DEFAULT_DESKTOP_PORT }
  }
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE} settings must be a map`)
  }
  const values = section as Record<string, unknown>
  return {
    mode: parseDesktopShellMode(values.mode),
    port: parseDesktopPort(values.port),
  }
}

/** Read only the shell mode from one parsed settings document. */
export function desktopShellModeFromSettings(document: unknown): DesktopShellMode {
  return desktopStartupSettingsFromSettings(document).mode
}

/**
 * Read startup settings from the same file resolved by the settings provider.
 * @param config - validated settings-file row config.
 * @returns the values projected into the startup Loader graph.
 */
export function readDesktopStartupSettings(config: SettingsFileConfig): DesktopStartupSettings {
  const spec = resolveSettingsFileSpec(config)
  let text: string
  try {
    text = readFileSync(spec.filename, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { mode: DEFAULT_DESKTOP_SHELL_MODE, port: DEFAULT_DESKTOP_PORT }
    }
    throw cause
  }
  let document: unknown
  if (spec.format === 'yaml') {
    const parsed = parseDocument(text, { prettyErrors: true })
    if (parsed.errors.length > 0) {
      throw new Error(`${BIN_NAME}: invalid settings document at ${spec.filename}: ${parsed.errors.map(error => error.message).join('; ')}`)
    }
    document = parsed.toJS() ?? {}
  } else {
    document = text.trim().length === 0 ? {} : JSON.parse(text)
  }
  return desktopStartupSettingsFromSettings(document)
}

/** Read only the shell mode from the settings provider's resolved file. */
export function readDesktopShellMode(config: SettingsFileConfig): DesktopShellMode {
  return readDesktopStartupSettings(config).mode
}

/** Resolve the public Web template once and reject an incompatible DSH release. */
function requiredWebBundles(): string[] {
  const bundles = PROFILE_TEMPLATES.web
  if (bundles === undefined) {
    throw new Error(`${BIN_NAME}: installed dsh-app-boot has no web profile template`)
  }
  return [...bundles]
}

/** Prepared profile inputs consumed by app-boot. */
export interface PreparedDesktopProfile {
  /** Harness home shared by the launcher and generated command environment. */
  homeDir: string
  /** Resolved profile and its persistent user layer. */
  profile: Profile
  /** Absolute empty root config included by the Cordis Loader. */
  rootConfig: string
  /** Profile-owned parent URL used to resolve bare Cordis plugin packages. */
  bareModuleBaseUrl: string
  /** Complete ordered patch list for this desktop generation. */
  patches: PatchOptions[]
  /** Optional Client UI entries skipped because this profile cannot resolve them. */
  skippedOptionalEntries: SkippedOptionalEntry[]
  /** Persisted shell mode applied after every user-owned patch. */
  mode: DesktopShellMode
  /** Persisted loopback Web port applied to every startup consumer. */
  port: number
  /** Resolved file-backed settings document used by this generation. */
  settingsDocument: string
  /** Requested provider and the fail-closed provider effective for this generation. */
  market: DesktopMarketSnapshot
  /** Internal boot diagnostic when the requested provider was disabled. */
  marketFailure?: string
}

/** Optional observations emitted before profile preparation can fail. */
export interface DesktopProfilePreparationHooks {
  /** Receive the trusted settings path before its contents are parsed. */
  onSettingsDocumentResolved?: (path: string) => void
}

/** User patch entry skipped to keep a profile bootable. */
export interface SkippedOptionalEntry {
  /** Loader row id from the skipped entry. */
  id?: string
  /** Package name from the skipped entry. */
  name: string
}

/**
 * Normalize the installation-owned prefix while preserving third-party order.
 * @param current - current persistent bundle list.
 * @returns base, Web carrier, then every third-party bundle in prior order.
 */
export function desktopBundleList(current: readonly string[]): string[] {
  const thirdParty = current.filter(name => !REQUIRED_BUNDLE_SET.has(name)
    && name !== DESKTOP_PACKAGE_NAME
    && !OBSOLETE_DESKTOP_BUNDLE_SET.has(name))
  return [...REQUIRED_BUNDLES, ...thirdParty]
}

/** Return whether two ordered string lists are identical. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Initialize or repair the persistent desktop profile.
 * @param home - Harness home containing the profiles directory.
 * @returns the absolute profile directory.
 */
export function ensureDesktopProfile(home: string = resolveDshHome()): string {
  const dir = resolveProfileDir(DESKTOP_PROFILE_NAME, home)
  if (!existsSync(join(dir, 'package.json'))) initProfile(dir, REQUIRED_BUNDLES)
  const manifest = readProfileManifest(BIN_NAME, dir)
  const rawBundles = (manifest.dsh?.profile as { bundles?: unknown } | undefined)?.bundles
  if (rawBundles !== undefined
    && (!Array.isArray(rawBundles) || rawBundles.some(value => typeof value !== 'string'))) {
    throw new Error(`${BIN_NAME}: dsh.profile.bundles must be an array of package names`)
  }
  const current = rawBundles === undefined ? [] : rawBundles as string[]
  const bundles = desktopBundleList(current)
  if (!sameList(current, bundles)) {
    writeProfileManifest(dir, {
      ...manifest,
      dsh: {
        ...manifest.dsh,
        profile: {
          ...manifest.dsh?.profile,
          bundles,
        },
      },
    })
  }
  return dir
}

interface RecoveryFilteredProfile {
  readonly profile: Profile
  readonly dshMarketFailure?: string
}

/** Render one provider failure without leaking an arbitrary thrown object into public state. */
function marketFailureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Load a profile while resolving disabled third-party bundles only after they have been filtered.
 * Every direct bundle uses the same Desktop/Profile SemVer overlay that Loader imports use.
 * The `dshmarket` bundle is filtered before resolution unless explicitly selected.
 */
function loadRecoveryFilteredProfile(
  profileName: string,
  profileDir: string,
  disabledBundles: ReadonlySet<string>,
  marketProvider: DesktopMarketProvider,
): RecoveryFilteredProfile {
  if (!existsSync(join(profileDir, 'package.json'))) {
    const template = PROFILE_TEMPLATES[profileName]
    if (template === undefined) {
      throw new Error(`${BIN_NAME}: profile ${JSON.stringify(profileName)} does not exist`)
    }
    initProfile(profileDir, template)
  }
  const manifest = readProfileManifest(BIN_NAME, profileDir)
  const rawBundles = (manifest.dsh?.profile as { bundles?: unknown } | undefined)?.bundles
  if (rawBundles !== undefined
    && (!Array.isArray(rawBundles) || rawBundles.some(value => typeof value !== 'string'))) {
    throw new Error(`${BIN_NAME}: dsh.profile.bundles must be an array of package names`)
  }
  const bundles = (rawBundles ?? []) as string[]
  const selectedBundles = bundles.filter(packageName =>
    packageName !== DESKTOP_MARKET_IDENTITIES.community.packageName
    && (marketProvider === DESKTOP_MARKET_IDENTITIES.dshMarket.provider
      || packageName !== DESKTOP_MARKET_IDENTITIES.dshMarket.packageName),
  )
  if (marketProvider === DESKTOP_MARKET_IDENTITIES.dshMarket.provider
    && !selectedBundles.includes(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)) {
    selectedBundles.push(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
  }
  const layers: Profile['layers'] = []
  let dshMarketFailure: string | undefined
  const installPackageUrl = pathToFileURL(INSTALL_ANCHOR).href
  const profilePackageUrl = pathToFileURL(join(profileDir, 'package.json')).href
  for (const packageName of selectedBundles) {
    const isDshMarket = packageName === DESKTOP_MARKET_IDENTITIES.dshMarket.packageName
    if (!isDshMarket && desktopPluginBundleMutable(packageName) && disabledBundles.has(packageName)) continue
    try {
      const packageDir = resolveOverlayPackage(packageName, {
        installPackageUrl,
        profilePackageUrl,
      }).selected.packageDir
      const bundleManifest: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
      if (isDshMarket && (bundleManifest === null || typeof bundleManifest !== 'object'
        || Array.isArray(bundleManifest)
        || (bundleManifest as { name?: unknown }).name !== DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)) {
        throw new Error(`${BIN_NAME}: selected dshmarket bundle has an invalid package identity`)
      }
      const declared = bundleManifest !== null && typeof bundleManifest === 'object'
        ? (bundleManifest as { dsh?: { bundle?: { patch?: unknown } } }).dsh?.bundle?.patch
        : undefined
      if (typeof declared !== 'string' || declared.length === 0) {
        throw new Error(`${BIN_NAME}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
      }
      const patchPath = join(packageDir, declared)
      layers.push({
        packageName,
        packageDir,
        patchPath,
        patches: loadOverlayPatches(BIN_NAME, patchPath),
      })
    } catch (cause) {
      if (!isDshMarket) throw cause
      dshMarketFailure = marketFailureMessage(cause)
    }
  }
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME)
  return {
    profile: {
      name: profileName,
      dir: profileDir,
      layers,
      patchPath,
      patches: existsSync(patchPath) ? loadOverlayPatches(BIN_NAME, patchPath) : [],
    },
    ...(dshMarketFailure === undefined ? {} : { dshMarketFailure }),
  }
}

/** Resolve the agent presets shipped by the matching dsh CLI dependency. */
export function shippedPresetRoot(moduleUrl: string = import.meta.url): string {
  const require = createRequire(moduleUrl)
  return unpackedAsarPath(
    join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'config', 'agent-presets'),
  )
}

/** Read a row's object config without trusting arbitrary YAML values. */
function rowConfig(row: EntryOptions | undefined): Record<string, unknown> {
  const config = row?.config
  return config !== null && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {}
}

/** Resolve a Loader row's platform gate without mutating the host process. */
function rowDisabledOnPlatform(row: EntryOptions, platform: NodeJS.Platform): boolean {
  if (!isJsExpr(row.disabled)) return row.disabled === true
  const scopedProcess = new Proxy(process, {
    get(target, property) {
      if (property === 'platform') return platform
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return Boolean(evaluate({ process: scopedProcess }, row.disabled.__jsExpr))
}

/** Reject duplicate entries before the Loader turns them into a startup crash. */
function assertUniqueEntryIds(rows: readonly EntryOptions[]): void {
  const seen = new Set<string>()
  for (const row of rows) {
    if (typeof row.id === 'string') {
      if (seen.has(row.id)) {
        throw new Error(`${BIN_NAME}: duplicate loader entry id "${row.id}" in the composed profile`)
      }
      seen.add(row.id)
    }
    if (row.group === true && Array.isArray(row.config)) {
      assertUniqueEntryIds(row.config)
    }
  }
}

/** Return whether a Loader specifier names an npm package. */
function isBarePackageSpecifier(name: string): boolean {
  return !name.startsWith('.')
    && !name.startsWith('/')
    && !name.startsWith('#')
    && !URL.canParse(name)
}

/** Return whether a package is a user-facing Client UI extension, not a Host provider. */
function isOptionalClientPackage(name: string): boolean {
  return /^(@[^/]+\/)?dsh-client-ui-/u.test(name)
}

/** Drop unresolved optional Client UI rows from the machine-wide patch only. */
function omitUnresolvedOptionalEntries(
  patches: PatchOptions[],
  profilePackageUrl: string,
): { patches: PatchOptions[], skipped: SkippedOptionalEntry[] } {
  const skipped: SkippedOptionalEntry[] = []
  const installPackageUrl = pathToFileURL(INSTALL_ANCHOR).href

  const filterRows = (rows: EntryOptions[]): EntryOptions[] => {
    const filtered: EntryOptions[] = []
    for (const row of rows) {
      if (typeof row.name === 'string'
        && isBarePackageSpecifier(row.name)
        && isOptionalClientPackage(row.name)
        && findOverlayPackage(row.name, { installPackageUrl, profilePackageUrl }) === undefined) {
        skipped.push({
          ...(typeof row.id === 'string' ? { id: row.id } : {}),
          name: row.name,
        })
        continue
      }
      const config = row.group === true && Array.isArray(row.config) ? filterRows(row.config) : undefined
      filtered.push(config === undefined ? row : { ...row, config })
    }
    return filtered
  }

  return {
    patches: patches.flatMap((patch) => {
      if (!Array.isArray(patch.insert)) return [patch]
      const insert = filterRows(patch.insert)
      return [{ ...patch, insert }]
    }),
    skipped,
  }
}

interface MarketPatchFilter {
  readonly patches: PatchOptions[]
  readonly removedProviderReference: boolean
}

/** Return whether one Loader row claims either Desktop-owned Market identity. */
function isMarketProviderEntry(entry: { readonly id?: unknown, readonly name?: unknown }): boolean {
  return (typeof entry.id === 'string' && MARKET_ROW_IDS.has(entry.id))
    || (typeof entry.name === 'string' && MARKET_PACKAGE_NAMES.has(entry.name))
}

/** Remove provider rows recursively before an untrusted patch can activate either implementation. */
function filterMarketProviderRows(rows: EntryOptions[]): {
  rows: EntryOptions[]
  removedProviderReference: boolean
} {
  const filtered: EntryOptions[] = []
  let removedProviderReference = false
  for (const row of rows) {
    if (isMarketProviderEntry(row)) {
      removedProviderReference = true
      continue
    }
    if (row.group === true && Array.isArray(row.config)) {
      const nested = filterMarketProviderRows(row.config)
      removedProviderReference ||= nested.removedProviderReference
      filtered.push(nested.removedProviderReference ? { ...row, config: nested.rows } : row)
    } else {
      filtered.push(row)
    }
  }
  return { rows: filtered, removedProviderReference }
}

/** Strip provider inserts and overrides from every non-provider layer. */
function filterMarketProviderPatches(patches: PatchOptions[]): MarketPatchFilter {
  const filtered: PatchOptions[] = []
  let removedProviderReference = false
  for (const patch of patches) {
    if (isMarketProviderEntry(patch)) {
      removedProviderReference = true
      continue
    }
    if (Array.isArray(patch.insert)) {
      const insert = filterMarketProviderRows(patch.insert)
      removedProviderReference ||= insert.removedProviderReference
      filtered.push(insert.removedProviderReference ? { ...patch, insert: insert.rows } : patch)
    } else {
      filtered.push(patch)
    }
  }
  return { patches: filtered, removedProviderReference }
}

/** Accept only the audited single-row contract from the selected direct bundle layer. */
export function validateDshMarketBundlePatches(patches: readonly PatchOptions[]): void {
  const rows = composeEntries([[...patches]])
  const row = rows[0]
  if (rows.length !== 1 || row === undefined
    || row.id !== DESKTOP_MARKET_IDENTITIES.dshMarket.rowId
    || row.name !== DESKTOP_MARKET_IDENTITIES.dshMarket.packageName
    || Object.keys(row).some(key => key !== 'id' && key !== 'name')) {
    throw new Error(`${BIN_NAME}: dshmarket bundle patch must insert exactly the canonical dsh-market row`)
  }
}

/** Ensure a Desktop dependency is resolvable through the selected profile fallback. */
function validateMarketPackage(name: string, profilePackageUrl: string): string | undefined {
  try {
    resolveOverlayPackage(name, {
      installPackageUrl: pathToFileURL(INSTALL_ANCHOR).href,
      profilePackageUrl,
    })
  } catch (cause) {
    return `${BIN_NAME}: cannot resolve selected Market package ${name}: ${marketFailureMessage(cause)}`
  }
}

/** Assert the final graph contains only the provider selected by the launcher. */
function assertEffectiveMarketRows(
  rows: readonly EntryOptions[],
  effective: DesktopMarketProvider,
): void {
  const providers = rows.filter(isMarketProviderEntry)
  if (effective === 'disabled') {
    if (providers.length !== 0) throw new Error(`${BIN_NAME}: disabled Market provider leaked into the Loader graph`)
    return
  }
  const identity = effective === DESKTOP_MARKET_IDENTITIES.community.provider
    ? DESKTOP_MARKET_IDENTITIES.community
    : DESKTOP_MARKET_IDENTITIES.dshMarket
  if (providers.length !== 1 || providers[0]?.id !== identity.rowId
    || providers[0]?.name !== identity.packageName) {
    throw new Error(`${BIN_NAME}: selected Market provider did not compose to one canonical Loader row`)
  }
}

/**
 * Load and compose one desktop profile generation.
 * @param telemetryDisabled - inherited DSH telemetry opt-out value.
 * @param home - Harness home containing profiles and the machine-wide patch.
 * @param platform - native platform selecting launcher-owned safety overlays.
 * @param profileName - existing or lazily available Web profile to compose.
 * @param pluginStatePath - optional Desktop-private disabled-bundle state.
 * @param marketSelection - machine-level provider request fixed for this generation.
 * @returns root config, profile metadata, and ordered patches.
 */
export function prepareDesktopProfile(
  telemetryDisabled: string | undefined = process.env.DSH_TELEMETRY_DISABLED,
  home: string = resolveDshHome(),
  platform: NodeJS.Platform = process.platform,
  profileName: string = DESKTOP_PROFILE_NAME,
  pluginStatePath?: string,
  marketSelection: DesktopMarketSnapshot = DEFAULT_DESKTOP_MARKET_SNAPSHOT,
  recoveryStatePath?: string,
  hooks: DesktopProfilePreparationHooks = {},
): PreparedDesktopProfile {
  const profileDir = profileName === DESKTOP_PROFILE_NAME
    ? ensureDesktopProfile(home)
    : resolveProfileDir(profileName, home)
  healProfilesModuleFallback(INSTALL_ANCHOR, home)
  // `plugin-management` is the community market's user-facing scope. Startup
  // recovery has its own state file so switching to another provider cannot
  // reapply a stale community-market disable, while a recovery disable always
  // remains effective regardless of the selected provider. Keep the legacy
  // five-argument call compatible for tests/older embedders.
  const managedDisabledBundles = pluginStatePath === undefined
    ? new Set<string>()
    : readDesktopDisabledBundles(pluginStatePath, profileName)
  const recoveryDisabledBundles = recoveryStatePath === undefined
    ? (marketSelection.requested === DESKTOP_MARKET_IDENTITIES.community.provider
      ? new Set<string>()
      : new Set(managedDisabledBundles))
    : readDesktopDisabledBundles(recoveryStatePath, profileName)
  const disabledBundles = new Set(recoveryDisabledBundles)
  if (recoveryStatePath === undefined
    || marketSelection.requested === DESKTOP_MARKET_IDENTITIES.community.provider) {
    for (const packageName of managedDisabledBundles) disabledBundles.add(packageName)
  }
  const loadedProfile = loadRecoveryFilteredProfile(
    profileName,
    profileDir,
    disabledBundles,
    marketSelection.requested,
  )
  const profile = loadedProfile.profile
  const rootConfig = join(profileDir, DESKTOP_PROFILE_ROOT)
  const bareModuleBaseUrl = pathToFileURL(join(profile.dir, 'package.json')).href
  writeFileSync(rootConfig, '[]\n')

  const desktopPatches = loadOverlayPatches(BIN_NAME, DESKTOP_PATCH_PATH)
  const bundlePatches: PatchOptions[] = []
  let dshMarketPatches: PatchOptions[] | undefined
  let desktopLayerInserted = false
  const providerAwareDisabledBundles = new Set(disabledBundles)
  if (marketSelection.requested === DESKTOP_MARKET_IDENTITIES.dshMarket.provider) {
    providerAwareDisabledBundles.delete(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
  }
  for (const layer of activeDesktopProfileLayers(profile, providerAwareDisabledBundles)) {
    if (layer.packageName === DESKTOP_MARKET_IDENTITIES.dshMarket.packageName) {
      dshMarketPatches = layer.patches
      continue
    }
    bundlePatches.push(...layer.patches)
    if (layer.packageName !== '@deepseek-ai/dsh-web-app') continue
    bundlePatches.push(...desktopPatches)
    desktopLayerInserted = true
  }
  if (!desktopLayerInserted) {
    throw new Error(`${BIN_NAME}: desktop profile is missing @deepseek-ai/dsh-web-app`)
  }

  const loadedHomePatches = loadOptionalPatches(BIN_NAME, join(home, PROFILE_PATCH_FILENAME)) ?? []
  const { patches: homePatches, skipped: skippedOptionalEntries } = omitUnresolvedOptionalEntries(
    loadedHomePatches,
    bareModuleBaseUrl,
  )
  const filteredBundles = filterMarketProviderPatches(bundlePatches)
  const filteredProfile = filterMarketProviderPatches(profile.patches)
  const filteredHome = filterMarketProviderPatches(homePatches)
  const hasProviderConflict = filteredBundles.removedProviderReference
    || filteredProfile.removedProviderReference
    || filteredHome.removedProviderReference
  let effectiveMarket: DesktopMarketProvider = 'disabled'
  let marketFailure: string | undefined
  const providerPatches: PatchOptions[] = []
  if (marketSelection.requested !== 'disabled') {
    if (hasProviderConflict) {
      marketFailure = `${BIN_NAME}: conflicting Market provider Loader identity was removed`
    } else if (marketSelection.requested === DESKTOP_MARKET_IDENTITIES.community.provider) {
      marketFailure = validateMarketPackage(
        DESKTOP_MARKET_IDENTITIES.community.packageName,
        bareModuleBaseUrl,
      )
      if (marketFailure === undefined) {
        providerPatches.push({
          insert: [{
            id: DESKTOP_MARKET_IDENTITIES.community.rowId,
            name: DESKTOP_MARKET_IDENTITIES.community.packageName,
          }],
        })
        effectiveMarket = DESKTOP_MARKET_IDENTITIES.community.provider
      }
    } else if (loadedProfile.dshMarketFailure !== undefined) {
      marketFailure = loadedProfile.dshMarketFailure
    } else if (dshMarketPatches === undefined) {
      marketFailure = `${BIN_NAME}: selected dshmarket bundle layer is unavailable`
    } else {
      try {
        validateDshMarketBundlePatches(dshMarketPatches)
        providerPatches.push(...dshMarketPatches)
        effectiveMarket = DESKTOP_MARKET_IDENTITIES.dshMarket.provider
      } catch (cause) {
        marketFailure = marketFailureMessage(cause)
      }
    }
  }
  const patches: PatchOptions[] = [
    ...filteredBundles.patches,
    ...providerPatches,
    ...filteredProfile.patches,
    ...filteredHome.patches,
  ]
  const composedRows = composeEntries([patches])
  assertUniqueEntryIds(composedRows)
  assertEffectiveMarketRows(composedRows, effectiveMarket)
  const rows = new Map<string, EntryOptions>()
  for (const row of composedRows) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const settings = rows.get('settings')
  if (settings?.name !== SETTINGS_FILE_PACKAGE) {
    throw new Error(`${BIN_NAME}: desktop profile must use ${SETTINGS_FILE_PACKAGE} in the settings row`)
  }
  const settingsConfig = FileSettingsProvider.Config({
    dshHome: home,
    ...rowConfig(settings),
  } as SettingsFileConfig)
  const settingsDocument = resolveSettingsFileSpec(settingsConfig).filename
  hooks.onSettingsDocumentResolved?.(settingsDocument)
  const { mode, port } = readDesktopStartupSettings(settingsConfig)
  patches.push({
    id: 'settings',
    config: settingsConfig,
  })
  if (mode === 'advanced') {
    for (const [id, packageName] of [
      ['ui-layout', UI_LAYOUT_PACKAGE],
      ['ui-sidebar', UI_SIDEBAR_PACKAGE],
      ['ui-conversation', UI_CONVERSATION_PACKAGE],
    ] as const) {
      if (rows.get(id)?.name !== packageName) {
        throw new Error(`${BIN_NAME}: advanced desktop mode must use ${packageName} in the ${id} row`)
      }
    }
    patches.push(
      { id: 'ui-layout', disabled: true },
      { id: 'ui-sidebar', disabled: false },
      { id: 'ui-conversation', disabled: false },
    )
  }
  const presets = rows.get(AGENT_PRESETS_ROW_ID)
  if (presets !== undefined) {
    const config = {
      ...rowConfig(presets),
      roots: [{ path: shippedPresetRoot(), trust: 'system' }],
    }
    if (platform === 'win32'
      && presets.name === UPSTREAM_AGENT_PRESETS_PACKAGE
      && !rowDisabledOnPlatform(presets, platform)) {
      patches.push(
        {
          id: AGENT_PRESETS_ROW_ID,
          name: UPSTREAM_AGENT_PRESETS_PACKAGE,
          disabled: true,
        },
        {
          insert: [{
            id: DESKTOP_WINDOWS_AGENT_PRESETS_ROW_ID,
            name: DESKTOP_WINDOWS_AGENT_PRESETS_PACKAGE,
            config,
          }],
        },
      )
    } else {
      patches.push({ id: AGENT_PRESETS_ROW_ID, config })
    }
  }
  const webserver = rows.get('webserver')
  if (webserver === undefined) {
    throw new Error(`${BIN_NAME}: desktop profile has no webserver row`)
  }
  if (platform === 'win32') {
    if (!rows.has(DIRECTORY_PICKER_ROW_ID)) {
      throw new Error(`${BIN_NAME}: desktop profile has no directory-picker row`)
    }
    patches.push(
      {
        id: DIRECTORY_PICKER_ROW_ID,
        name: AUTO_PICKER_PACKAGE,
        disabled: true,
      },
      {
        insert: [
          {
            id: 'desktop-directory-picker-browse-host',
            name: BROWSE_PICKER_BACKEND,
          },
          {
            id: 'desktop-directory-picker-browse-surface',
            name: BROWSE_PICKER_SURFACE,
          },
        ],
      },
    )
    const pwshSandbox = rows.get(PWSH_SANDBOX_ROW_ID)
    if (pwshSandbox?.name === UPSTREAM_PWSH_SANDBOX_PACKAGE
      && !rowDisabledOnPlatform(pwshSandbox, platform)) {
      patches.push(
        {
          id: PWSH_SANDBOX_ROW_ID,
          name: UPSTREAM_PWSH_SANDBOX_PACKAGE,
          disabled: true,
        },
        {
          insert: [
            {
              id: DESKTOP_WINDOWS_PWSH_SANDBOX_ROW_ID,
              name: DESKTOP_WINDOWS_PWSH_SANDBOX_PACKAGE,
              ...(pwshSandbox.disabled === undefined ? {} : { disabled: pwshSandbox.disabled }),
              config: rowConfig(pwshSandbox),
            },
          ],
        },
      )
    }
  }
  // Loader patches cannot change an existing row's package identity. Disable the
  // profile row by its current identity and insert the Desktop-owned provider.
  // Loopback-only binding is a launcher security invariant, not user config.
  const webserverConfig = { host: '127.0.0.1', port }
  if (webserver.name === DESKTOP_WEB_SERVER_PACKAGE) {
    patches.push({
      id: 'webserver',
      name: DESKTOP_WEB_SERVER_PACKAGE,
      disabled: false,
      config: webserverConfig,
    })
  } else {
    if (typeof webserver.name !== 'string') {
      throw new Error(`${BIN_NAME}: desktop profile webserver row has no package identity`)
    }
    const replacement = rows.get(DESKTOP_WEB_SERVER_ROW_ID)
    if (replacement !== undefined && replacement.name !== DESKTOP_WEB_SERVER_PACKAGE) {
      throw new Error(`${BIN_NAME}: reserved ${DESKTOP_WEB_SERVER_ROW_ID} row has a conflicting package identity`)
    }
    patches.push({
      id: 'webserver',
      name: webserver.name,
      disabled: true,
    })
    if (replacement === undefined) {
      patches.push({
        insert: [{
          id: DESKTOP_WEB_SERVER_ROW_ID,
          name: DESKTOP_WEB_SERVER_PACKAGE,
          config: webserverConfig,
        }],
      })
    } else {
      patches.push({
        id: DESKTOP_WEB_SERVER_ROW_ID,
        name: DESKTOP_WEB_SERVER_PACKAGE,
        disabled: false,
        config: webserverConfig,
      })
    }
  }
  if ((telemetryDisabled ?? '') !== '' && rows.has('session-telemetry-otel')) {
    patches.push({ id: 'session-telemetry-otel', disabled: true })
  }
  const desktopShell = rows.get('desktop-shell')
  if (desktopShell === undefined) {
    throw new Error(`${BIN_NAME}: desktop profile has no desktop-shell row`)
  }
  patches.push({
    id: 'desktop-shell',
    disabled: false,
    config: {
      ...rowConfig(desktopShell),
      mode,
      port,
    },
  })
  return {
    homeDir: home,
    profile,
    rootConfig,
    bareModuleBaseUrl,
    patches: structuredClone(patches),
    skippedOptionalEntries,
    mode,
    port,
    settingsDocument,
    market: desktopMarketSnapshotWithEffective(marketSelection, effectiveMarket),
    ...(marketFailure === undefined ? {} : { marketFailure }),
  }
}

/** Expose the package anchor for focused resolution tests. */
export function desktopInstallAnchor(): string {
  return INSTALL_ANCHOR
}

/** Preserve the public manifest type in the declaration graph used by plugin tooling. */
export type DesktopProfileManifest = ProfileManifest
