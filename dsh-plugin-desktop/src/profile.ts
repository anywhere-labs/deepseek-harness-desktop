/** Compatibility profile composition over the official Web bundle and user plugins. */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isIP } from 'node:net'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluate, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  bundlePatchPaths,
  composeEntries,
  initProfile,
  loadOptionalPatches,
  loadOverlayPatches,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  PROFILES_DIR,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
  type Profile,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isMap, isPair, isScalar, isSeq, parseAllDocuments, parseDocument, type Pair, type YAMLMap } from 'yaml'
import { findOverlayPackage, resolveOverlayPackage } from './package-overlay.ts'
import { removeLinkProjectionsSafely } from './link-projections.ts'
import { DESKTOP_DEFAULT_WEB_PORT } from './desktop-port.ts'
import {
  desktopBrowserAccessAvailable,
  desktopBrowserAccessEnabled,
  desktopNetworkExposureForBrowserAccess,
  desktopWebServerHost,
  parseDesktopNetworkExposure,
  parseDesktopOpenBrowser,
  type DesktopNetworkExposure,
} from './desktop-network.ts'
import type { DesktopShellMode } from './runtime.ts'
import {
  DESKTOP_PACKAGE_NAME,
  DESKTOP_PACKAGE_NAMES,
} from './product-identity.ts'
import {
  DEFAULT_MACOS_WINDOW_MATERIAL,
  DEFAULT_WINDOWS_WINDOW_MATERIAL,
  parseMacosWindowMaterial,
  parseWindowsWindowMaterial,
  type MacosWindowMaterial,
  type WindowsWindowMaterial,

  DEFAULT_LINUX_WINDOW_MATERIAL,
  parseLinuxWindowMaterial,} from './window-material.ts'
import type { LinuxWindowMaterial } from './window-material.ts'
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
import { DesktopShellConfig } from './settings-bridge.ts'

/** Persistent profile managed by the desktop launcher and the ordinary dsh plugin command. */
export const DESKTOP_PROFILE_NAME = 'desktop'

/** Standalone package name inserted through the launcher-owned desktop layer. */
export { DESKTOP_PACKAGE_NAME } from './product-identity.ts'

/** Empty include root rewritten before every profile boot. */
export const DESKTOP_PROFILE_ROOT = 'cordis.yml'

const AA_PACKAGE_NAME = '@agents-anywhere/dsh-bridge-next'
const AA_ROW_ID = 'agents-anywhere-bridge-next'
const BIN_NAME = DESKTOP_PACKAGE_NAME
const REQUIRED_BUNDLES = requiredWebBundles()
const REQUIRED_BUNDLE_SET = new Set(REQUIRED_BUNDLES)
const OBSOLETE_DESKTOP_BUNDLE_SET = new Set(['@deepseek-ai/dsh-desktop-app'])
// Electron's patched fs/module APIs read this logical ASAR path directly. The
// Desktop resolver bridges out-of-tree Profile plugins back into this virtual
// installation without materializing an incomplete ESM-only proxy tree.
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))
const DESKTOP_PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const DIRECTORY_PICKER_ROW_ID = 'directory-picker'
const AUTO_PICKER_PACKAGE = '@deepseek-ai/dsh-host-directory-picker-auto'
const BROWSE_PICKER_BACKEND = '@deepseek-ai/dsh-host-directory-picker-browse'
const BROWSE_PICKER_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-browse'
const PWSH_SANDBOX_ROW_ID = 'pwsh-sandbox'
const UPSTREAM_PWSH_SANDBOX_PACKAGE = '@deepseek-ai/dsh-pwsh-sandbox'
const DESKTOP_WINDOWS_PWSH_SANDBOX_ROW_ID = 'desktop-windows-pwsh-sandbox'
const DESKTOP_WINDOWS_PWSH_SANDBOX_PACKAGE = `${DESKTOP_PACKAGE_NAME}/windows-pwsh-sandbox`
/** Upstream Web rows that exist only to send Desktop product analytics to DeepSeek. */
export const UPSTREAM_PRODUCT_ANALYTICS_ROW_IDS = ['desktop-product-telemetry', 'product-analytics'] as const
const DEFAULT_DESKTOP_SHELL_MODE: DesktopShellMode = 'compatibility'
const DEFAULT_DESKTOP_PORT = DESKTOP_DEFAULT_WEB_PORT
const DESKTOP_WEB_SERVER_ROW_ID = 'desktop-webserver'
const DESKTOP_WEB_SERVER_PACKAGE = `${DESKTOP_PACKAGE_NAME}/webserver`
// dsh 0.1.7-alpha.1 deleted `@deepseek-ai/dsh-settings-file` (upstream 601d6761e4) and
// moved persisted form values into the active profile's own patch layer. The row that
// carries the settings service is now the profile-owned `@deepseek-ai/dsh-settings`.
const SETTINGS_PACKAGE = '@deepseek-ai/dsh-settings'
/** Legacy harness-home document the upstream one-shot import still reads. */
const SETTINGS_DOCUMENT_FILENAME = 'settings.yaml'
const SETTINGS_DOCUMENT_FORMATS: Readonly<Record<string, 'yaml' | 'json'>> = Object.freeze({
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
})
const DESKTOP_SETTINGS_NAMESPACE = 'dsh-desktop'
/** Loader entry id the settings import keys Desktop's shell section by. */
const DESKTOP_SHELL_ENTRY_ID = 'desktop-shell'
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
  if (value === 'compatibility' || value === 'extended' || value === 'advanced') return value
  throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE}.mode must be "compatibility", "extended", or "advanced"`)
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
  macosMaterial: MacosWindowMaterial
  windowsMaterial: WindowsWindowMaterial
  linuxMaterial: LinuxWindowMaterial
  /** Persisted compatibility key for ordinary-browser access permission. */
  openBrowser: boolean
  networkExposure: DesktopNetworkExposure
}

const DEFAULT_DESKTOP_STARTUP_SETTINGS: DesktopStartupSettings = Object.freeze({
  mode: DEFAULT_DESKTOP_SHELL_MODE,
  port: DEFAULT_DESKTOP_PORT,
  macosMaterial: DEFAULT_MACOS_WINDOW_MATERIAL,
  windowsMaterial: DEFAULT_WINDOWS_WINDOW_MATERIAL,
  linuxMaterial: DEFAULT_LINUX_WINDOW_MATERIAL,
  openBrowser: false,
  networkExposure: 'loopback',
})

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
    return { ...DEFAULT_DESKTOP_STARTUP_SETTINGS }
  }
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE} settings must be a map`)
  }
  const values = section as Record<string, unknown>
  const mode = parseDesktopShellMode(values.mode)
  const networkExposure = parseDesktopNetworkExposure(values.networkExposure)
  const openBrowser = desktopBrowserAccessEnabled(
    mode,
    parseDesktopOpenBrowser(values.openBrowser),
    networkExposure,
  )
  return {
    mode,
    port: parseDesktopPort(values.port),
    macosMaterial: parseMacosWindowMaterial(values.macosMaterial),
    windowsMaterial: parseWindowsWindowMaterial(values.windowsMaterial),
    linuxMaterial: parseLinuxWindowMaterial(values.linuxMaterial),
    openBrowser,
    networkExposure: desktopNetworkExposureForBrowserAccess(openBrowser, networkExposure),
  }
}

/** Read only the shell mode from one parsed settings document. */
export function desktopShellModeFromSettings(document: unknown): DesktopShellMode {
  return desktopStartupSettingsFromSettings(document).mode
}

/**
 * Where Desktop's legacy harness-home settings document lives.
 *
 * dsh 0.1.5 resolved this through `@deepseek-ai/dsh-settings-file`'s `resolveSpec`.
 * 0.1.7 deleted that package, but Desktop still owns the document: the Host reads
 * startup preferences before any plugin boots, the setup wizard and the recovery
 * window read and write it, and upstream's one-shot import consumes it. The
 * defaulting below reproduces the deleted `resolveSpec` exactly (an explicit
 * `path` wins, otherwise `<dshHome>/settings.yaml`; the extension picks the format).
 */
export interface DesktopSettingsDocumentConfig {
  /** Explicit document path; wins over the harness-home default. */
  path?: string
  /** Harness home override passed through to {@link resolveDshHome}. */
  dshHome?: string
}

/** Resolved location and encoding of the Desktop settings document. */
export interface DesktopSettingsDocumentSpec {
  filename: string
  format: 'yaml' | 'json'
}

/**
 * Resolve the settings document the Host reads before the Loader starts.
 * @param config - explicit path and/or harness-home override.
 * @returns the absolute filename and its parsed format.
 * @throws {Error} when the path carries an unsupported extension.
 */
export function resolveDesktopSettingsDocument(
  config: DesktopSettingsDocumentConfig = {},
): DesktopSettingsDocumentSpec {
  const filename = resolve(config.path ?? join(resolveDshHome(config.dshHome), SETTINGS_DOCUMENT_FILENAME))
  const format = SETTINGS_DOCUMENT_FORMATS[extname(filename).toLowerCase()]
  if (format === undefined) {
    throw new Error(`${BIN_NAME}: settings document extension ${JSON.stringify(extname(filename))} is not supported (use .yaml, .yml, or .json)`)
  }
  return { filename, format }
}

/**
 * Desktop's own legacy-to-entry section renames for the harness-home document.
 *
 * 0.1.7's one-shot import (`SettingsForms#importLegacyDocument`) keys every
 * section of `settings.yaml` by Loader entry id and carries a rename table
 * (`LEGACY_SECTION_ENTRIES`) that only covers the kernel's own renames. Desktop
 * renamed its two sections in this port -- the settings namespace is now the
 * Loader entry id, and those rows are `desktop-shell` and `desktop-notifications`
 * -- so without this table the import raises `No configurable plugin entry
 * "dsh-desktop"`, logs a warning nobody reads, and then renames the document to
 * `settings.yaml.imported` anyway. Every user upgrading from 0.1.6 would lose
 * window mode, all three materials, port, browser intent, network exposure, log
 * level and every notification preference, silently and irreversibly.
 *
 * Desktop's own two sections kept every field name, so for them the section key
 * is the whole migration.
 *
 * `agent-presets` is upstream's row, not Desktop's, but it has the same gap:
 * 0.1.7 renamed the row to `agent-preset-registry`
 * (`packages/bundle/web-app/cordis.patch.yml:541`) without adding the pair to
 * `LEGACY_SECTION_ENTRIES`, so the import logs `No configurable plugin entry
 * "agent-presets"` and drops the section. The user's chosen default preset is
 * discarded and the bundle's own `default: standard` takes over. Desktop is the
 * only edition that owns this document before the Loader starts, so the rename
 * has to happen here or not at all.
 *
 * That row also renamed the field. 0.1.6's `default` was the user's choice;
 * 0.1.7 keeps `default` as the bundle-authored fallback and moves the choice to
 * `selectedDefault`, which is the only one of the two declared `.volatile()`
 * (`@deepseek-ai/dsh-agent-preset-registry/lib/index.js:454`). The distinction is
 * not cosmetic: `SettingsForms#write` throws `Config field "default" is not
 * volatile` before it persists anything, so importing the legacy key under its
 * old name loses the value just as completely as dropping the section. The
 * service reads `enabled ? selectedDefault ?? default : default`, so the
 * imported choice takes effect as soon as it lands under the new name.
 */
const LEGACY_DESKTOP_SETTINGS_SECTIONS: readonly LegacySettingsSection[] = Object.freeze([
  Object.freeze({ legacy: 'dsh-desktop', entryId: 'desktop-shell' }),
  Object.freeze({ legacy: 'dsh-desktop-notifications', entryId: 'desktop-notifications' }),
  Object.freeze({
    legacy: 'agent-presets',
    entryId: 'agent-preset-registry',
    fields: Object.freeze([Object.freeze(['default', 'selectedDefault'] as const)]),
  }),
])

/** One legacy `settings.yaml` section and the 0.1.7 entry that now owns it. */
interface LegacySettingsSection {
  /** Section key written by 0.1.6 and earlier. */
  readonly legacy: string
  /** Loader entry id 0.1.7's import keys the section by. */
  readonly entryId: string
  /** Field renames inside the section, `[legacy, current]`; absent when none. */
  readonly fields?: readonly (readonly [legacy: string, field: string])[]
}

/**
 * Rename Desktop's legacy sections in place so upstream's import can find them.
 *
 * Runs in the launcher, before the Loader starts and therefore before the
 * settings plugin consumes and renames the document. Renaming the key node
 * rather than re-setting the map keeps each section's position, comments and
 * scalar styles intact, so a document this edition does not fully understand
 * survives untouched.
 *
 * Idempotent in both directions, for section keys and for the field renames
 * inside them: a name 0.1.7 already uses has nothing to rename, and a document
 * that somehow carries both names keeps the current one, because that is the one
 * 0.1.7 would have written.
 *
 * @param spec - resolved location and encoding of the settings document.
 * @returns the entry ids whose section was rewritten; empty when nothing changed.
 */
export function migrateDesktopSettingsDocumentSections(
  spec: DesktopSettingsDocumentSpec,
): readonly string[] {
  // Only the harness-home YAML document is ever migrated. Desktop always resolves
  // this document from `dshHome`, so the `.json` form `resolveSpec` also accepted
  // is unreachable here; leaving it alone is safer than rewriting a file that
  // reached this path some other way.
  if (spec.format !== 'yaml') return []
  let text: string
  try {
    text = readFileSync(spec.filename, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
  const document = parseDocument(text, { prettyErrors: true })
  // A malformed document is not this function's to diagnose: `readDesktopStartupSettings`
  // reports it with the parser's own message, and rewriting it would destroy evidence.
  if (document.errors.length > 0) return []
  const contents = document.contents
  if (!isMap(contents)) return []
  const keyed = (map: YAMLMap, name: string): Pair | undefined => map.items
    .find((item): item is Pair => isPair(item) && isScalar(item.key) && item.key.value === name)
  const migrated: string[] = []
  for (const { legacy, entryId, fields } of LEGACY_DESKTOP_SETTINGS_SECTIONS) {
    const current = keyed(contents, entryId)
    const section = current ?? keyed(contents, legacy)
    if (section === undefined || !isScalar(section.key)) continue
    let changed = false
    if (current === undefined) {
      section.key.value = entryId
      changed = true
    }
    const values = section.value
    if (fields !== undefined && isMap(values)) {
      for (const [legacyField, field] of fields) {
        if (keyed(values, field) !== undefined) continue
        const pair = keyed(values, legacyField)
        if (pair === undefined || !isScalar(pair.key)) continue
        pair.key.value = field
        changed = true
      }
    }
    if (changed) migrated.push(entryId)
  }
  if (migrated.length === 0) return []
  writeFileSync(spec.filename, String(document))
  return migrated
}

/**
 * Read startup settings from the same file resolved by the settings provider.
 * @param config - validated settings-document locator.
 * @returns the values projected into the startup Loader graph.
 */
export function readDesktopStartupSettings(config: DesktopSettingsDocumentConfig): DesktopStartupSettings {
  const spec = resolveDesktopSettingsDocument(config)
  let text: string
  try {
    text = readFileSync(spec.filename, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_DESKTOP_STARTUP_SETTINGS }
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
export function readDesktopShellMode(config: DesktopSettingsDocumentConfig): DesktopShellMode {
  return readDesktopStartupSettings(config).mode
}

/**
 * The desktop-shell section of a settings document the settings service has not imported yet.
 *
 * The setup wizard, the recovery window and every 0.1.6 install write startup choices to
 * the harness-home document, but 0.1.7's settings service only merges that document into
 * the profile patch layer after the Loader is up (`SettingsForms#importLegacyDocument`),
 * and renames it to `settings.yaml.imported` as it does. The launcher's layout patches and
 * the shell plugin's own row both resolve before that, so while the document still exists
 * under its own name its section is the value the row is about to have. Reading only the
 * composed row booted the first generation after the wizard in compatibility mode, and the
 * import then switched the row to the chosen mode underneath it: the recomposed profile
 * dropped `ui-layout` while the open renderer never installed Desktop's own layout, so
 * eighteen client plugins waited on a layout service forever and startup went to recovery.
 * @param spec - the resolved harness-home document, after section migration.
 * @returns the pending section, or undefined when there is nothing left to import.
 */
function pendingDesktopShellSection(spec: DesktopSettingsDocumentSpec): Record<string, unknown> | undefined {
  // The import only ever reads `<home>/settings.yaml`.
  if (spec.format !== 'yaml') return undefined
  let text: string
  try {
    text = readFileSync(spec.filename, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
  const parsed = parseDocument(text, { prettyErrors: true })
  // A document the import cannot parse is renamed away without merging anything.
  if (parsed.errors.length > 0) return undefined
  const root: unknown = parsed.toJS()
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return undefined
  const document = root as Record<string, unknown>
  // `migrateDesktopSettingsDocumentSections` has already renamed 0.1.6's key; the
  // import merges only the section keyed by the entry id.
  const section = document[DESKTOP_SHELL_ENTRY_ID]
  return typeof section === 'object' && section !== null && !Array.isArray(section)
    ? section as Record<string, unknown>
    : undefined
}

/** Fields the import may write; it refuses a section carrying any other key. */
const PENDING_DESKTOP_SHELL_FIELDS: ReadonlySet<string> = new Set([
  'mode',
  'macosMaterial',
  'windowsMaterial',
  'linuxMaterial',
  'port',
  'openBrowser',
  'networkExposure',
  'logLevel',
])

/**
 * The desktop-shell config as it will stand once the pending document is imported.
 * @param composed - the composed desktop-shell row config.
 * @param pending - the section {@link pendingDesktopShellSection} found, if any.
 * @param platform - native platform the import validates the section for.
 * @returns the merged config, or undefined when the import would not apply it.
 */
function pendingDesktopShellConfig(
  composed: Record<string, unknown>,
  pending: Record<string, unknown> | undefined,
  platform: NodeJS.Platform,
): Record<string, unknown> | undefined {
  if (pending === undefined) return undefined
  // The import skips the whole section when it is rejected, so the row keeps its
  // composed values; so does this generation. It accepts only volatile fields,
  // validates the merged row against the schema, and applies the shell's own
  // combination checks.
  if (Object.keys(pending).some(key => !PENDING_DESKTOP_SHELL_FIELDS.has(key))) return undefined
  // `SettingsForms#update` merges the section over the current row field by field.
  const merged = { ...composed, ...pending }
  let mode: DesktopShellMode
  let openBrowser: boolean
  try {
    const candidate = DesktopShellConfig(merged as never)
    mode = candidate.mode.get()
    openBrowser = candidate.openBrowser.get()
    desktopStartupSettingsFromSettings({ [DESKTOP_SETTINGS_NAMESPACE]: merged })
  } catch {
    return undefined
  }
  if (!desktopBrowserAccessAvailable(mode) && openBrowser) return undefined
  if (mode !== 'compatibility' && platform === 'linux') return undefined
  return merged
}

/**
 * Merge the pending desktop-shell section into the profile patch layer and drop it
 * from the settings document, the way the import would, but before the Loader starts.
 *
 * The row is written exactly as the config editor writes it (the last plain
 * `desktop-shell` row, else a new one), so later edits find and update it. The
 * profile is written first: if the process dies before the document is rewritten,
 * the next launch merges the same values again, which changes nothing. Each file
 * is replaced in one step, so a crash never leaves a half-written profile, and a
 * symlinked document is left to the import rather than replaced by a copy.
 * @param patchPath - the profile's own patch document.
 * @param rowName - the composed desktop-shell row's package identity.
 * @param spec - the resolved harness-home document.
 * @param section - the validated pending section.
 * @returns whether both documents were rewritten; on false the upstream import
 *   still merges the section later, as it did before.
 */
function importPendingDesktopShellSection(
  patchPath: string,
  rowName: unknown,
  spec: DesktopSettingsDocumentSpec,
  section: Record<string, unknown>,
): boolean {
  try {
    if ([patchPath, spec.filename].some(path => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())) {
      return false
    }
    let before: string
    try {
      before = readFileSync(patchPath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      before = '[]\n'
    }
    // `!!js` expressions stay the scalars they were; only the target row is touched.
    const patchDocument = parseDocument(before, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    })
    if (patchDocument.errors.length > 0 || !isSeq(patchDocument.contents)) return false
    const rows = patchDocument.contents
    rows.flow = false
    const index = rows.items.findLastIndex((item, index) => isMap(item)
      && patchDocument.getIn([index, 'id']) === DESKTOP_SHELL_ENTRY_ID
      && !item.has('insert')
      && (!item.has('name') || patchDocument.getIn([index, 'name']) === rowName))
    if (index < 0) {
      patchDocument.addIn([], {
        id: DESKTOP_SHELL_ENTRY_ID,
        ...(typeof rowName === 'string' ? { name: rowName } : {}),
        config: section,
      })
    } else {
      const config = patchDocument.getIn([index, 'config'], true)
      if (config === undefined) {
        patchDocument.setIn([index, 'config'], patchDocument.createNode(section))
      } else if (isMap(config)) {
        for (const [key, value] of Object.entries(section)) config.set(key, value)
      } else {
        return false
      }
    }

    const settingsDocument = parseDocument(readFileSync(spec.filename, 'utf8'), { prettyErrors: true })
    if (settingsDocument.errors.length > 0 || !isMap(settingsDocument.contents)) return false
    replaceDocument(patchPath, String(patchDocument))
    settingsDocument.delete(DESKTOP_SHELL_ENTRY_ID)
    replaceDocument(spec.filename, String(settingsDocument))
    return true
  } catch {
    return false
  }
}

/** Replace a document in one rename, so a crash leaves either its old or its new bytes. */
function replaceDocument(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, text, { flag: 'wx' })
    renameSync(temporary, path)
  } catch (cause) {
    rmSync(temporary, { force: true })
    throw cause
  }
}

/** Resolve the public Web template once and reject an incompatible DSH release. */
function requiredWebBundles(): string[] {
  const template = PROFILE_TEMPLATES.web
  if (template === undefined) {
    throw new Error(`${BIN_NAME}: installed dsh-app-boot has no web profile template`)
  }
  return [...template.bundles]
}

/** Prepared profile inputs consumed by app-boot. */
export interface PreparedDesktopProfile {
  /** Extra launcher-owned patches, also replayed after Profile HMR. */
  overlays?: PatchOptions[]
  /** Serializable inputs for the Desktop-owned alpha.2 Profile reload path. */
  reloadOptions: {
    telemetryDisabled: string | undefined
    platform: NodeJS.Platform
    profileName: string
    pluginStatePath: string | undefined
    marketSelection: DesktopMarketSnapshot
    aaEnabled: boolean
  }
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
  /** Native translucency preference retained for macOS generations. */
  macosMaterial: MacosWindowMaterial
  /** Native backdrop preference retained for Windows generations. */
  windowsMaterial: WindowsWindowMaterial
  /** Electron-native transparency preference retained for Linux generations. */
  linuxMaterial: LinuxWindowMaterial
  /** Persisted Web port applied to every startup consumer. */
  port: number
  /** Whether Desktop advertises the marker-free compatibility client for browser use. */
  openBrowser: boolean
  /** Listener scope applied to the Desktop-owned WebServer. */
  networkExposure: DesktopNetworkExposure
  /** Frozen LAN IPv4 snapshot trusted by this profile generation and its HTTPS edge. */
  lanAddresses: readonly string[]
  /** Resolved file-backed settings document used by this generation. */
  settingsDocument: string
  /** Requested provider and the fail-closed provider effective for this generation. */
  market: DesktopMarketSnapshot
  aaEnabled: boolean
  aaFailure?: string
  /** Internal boot diagnostic when the requested provider was disabled. */
  marketFailure?: string
  /** Whether packaged pnpm must rebuild a legacy Profile dependency layout. */
  requiresDependencyMigration: boolean
}

/** Optional observations emitted before profile preparation can fail. */
export interface DesktopProfilePreparationHooks {
  /** Explicit Profile choice; false also enforces safe-mode exclusion. */
  aaEnabled?: boolean

  /** Receive the trusted settings path before its contents are parsed. */
  onSettingsDocumentResolved?: (path: string) => void
  /** LAN IPv4 literals sampled once before this profile generation is composed. */
  lanAddresses?: readonly string[]

  /**
   * Compose this profile patch document instead of the one currently on disk.
   *
   * The config editor validates and reconciles an edit *before* it writes the
   * file: it composes the pending document and rejects the write when the
   * effective row does not match what it is about to persist. Desktop owns the
   * composition (`ProfileContext.readPatches`), so the pending document has to
   * reach it here -- otherwise every settings write is judged against the stale
   * on-disk document, which by construction still holds the old value, and the
   * editor fails closed with `Configuration for "<id>" is overridden by a home
   * patch or command-line overlay`. The same composition is what the editor
   * then hands `reconcileProfilePatches`, so a stale one would also reconcile
   * the Loader back to the pre-edit config.
   */
  profilePatches?: readonly PatchOptions[]

  /**
   * Compose the layout rows for this running generation's shell mode instead of
   * the one the Profile now stores.
   *
   * A mode change is saved into the patch layer while the generation keeps its
   * renderer, and that save hot-reloads the Profile. Recomposing the layout rows
   * from the new mode dropped `ui-layout` under a compatibility page that never
   * installs Desktop's own layout, so the client plugins waited on a layout
   * service forever and the window went to recovery. The saved mode takes effect
   * with the restart that starts the next generation.
   */
  generationMode?: DesktopShellMode
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
    && !DESKTOP_PACKAGE_NAMES.has(name)
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
  if (!existsSync(join(dir, 'package.json'))) {
    initProfile(dir, REQUIRED_BUNDLES)
  }
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

interface ParsedProfileYaml {
  readonly document: ReturnType<typeof parseDocument>
  readonly value: Record<string, unknown>
}

/** Parse one Profile-owned pnpm document as a YAML map. */
function parseProfileYaml(path: string): ParsedProfileYaml {
  const document = parseDocument(readFileSync(path, 'utf8'), { prettyErrors: true })
  if (document.errors.length > 0) {
    throw new Error(`${BIN_NAME}: invalid Profile pnpm document at ${path}: ${document.errors.map(error => error.message).join('; ')}`)
  }
  const value = document.toJS()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${BIN_NAME}: Profile pnpm document ${path} must hold a YAML map`)
  }
  return { document, value: value as Record<string, unknown> }
}

/** Apply the current out-of-tree plugin linker contract while preserving other workspace settings. */
function reconcileProfilePnpmWorkspace(profileDir: string): boolean {
  const path = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(path)) {
    writeFileSync(path, `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n`)
    return true
  }
  const { document } = parseProfileYaml(path)
  let changed = false
  if (document.get('packages') === undefined) {
    document.set('packages', ['.'])
    changed = true
  }
  if (document.get('nodeLinker') !== 'hoisted') {
    document.set('nodeLinker', 'hoisted')
    changed = true
  }
  if (document.get('autoInstallPeers') !== false) {
    document.set('autoInstallPeers', false)
    changed = true
  }
  if (changed) writeFileSync(path, document.toString())
  return changed
}

/** Read the virtual-store path limit pnpm applies to this Profile. */
function profileVirtualStoreDirMaxLength(profileDir: string, platform: NodeJS.Platform): number {
  const configured = parseProfileYaml(join(profileDir, 'pnpm-workspace.yaml')).value.virtualStoreDirMaxLength
  if (configured === undefined) return platform === 'win32' ? 60 : 120
  if (typeof configured !== 'number' || !Number.isInteger(configured) || configured < 0) {
    throw new Error(`${BIN_NAME}: pnpm-workspace.yaml virtualStoreDirMaxLength must be a non-negative integer`)
  }
  return configured
}

/** Return whether private module metadata was written by a compatible pnpm generation. */
function compatiblePnpmPackageManager(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const match = /^pnpm@(\d+)(?:\.|$)/.exec(value)
  return match !== null && Number(match[1]) >= 10
}

/** Detect pnpm state that cannot satisfy the current hoisted Profile contract. */
function profileDependencyMigrationRequired(
  profileDir: string,
  workspaceChanged: boolean,
  platform: NodeJS.Platform,
): boolean {
  const manifest = readProfileManifest(BIN_NAME, profileDir)
  const hasDependencies = Object.keys(manifest.dependencies ?? {}).length > 0
  const modulesDir = join(profileDir, 'node_modules')
  const hasModules = existsSync(modulesDir)
  if (!hasDependencies && !hasModules) return false

  let modulesCompatible = false
  const modulesStatePath = join(modulesDir, '.modules.yaml')
  if (existsSync(modulesStatePath)) {
    try {
      const modulesState = parseProfileYaml(modulesStatePath).value
      modulesCompatible = modulesState.nodeLinker === 'hoisted'
        && compatiblePnpmPackageManager(modulesState.packageManager)
        && modulesState.virtualStoreDirMaxLength === profileVirtualStoreDirMaxLength(profileDir, platform)
    } catch {
      // pnpm can replace malformed or obsolete private module metadata.
    }
  }

  const lockfilePath = join(profileDir, 'pnpm-lock.yaml')
  let lockfileCompatible = !existsSync(lockfilePath) && !hasDependencies
  if (existsSync(lockfilePath)) {
    try {
      const settings = parseProfileYaml(lockfilePath).value.settings
      lockfileCompatible = typeof settings === 'object' && settings !== null
        && !Array.isArray(settings)
        && (settings as Record<string, unknown>).autoInstallPeers === false
    } catch {
      // A controlled non-frozen install owns lockfile reconciliation below.
    }
  }
  return workspaceChanged || !modulesCompatible || !lockfileCompatible
}

interface RecoveryFilteredProfile {
  readonly profile: Profile
  readonly dshMarketFailure?: string
  readonly aaFailure?: string
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
  aaEnabled: boolean,
): RecoveryFilteredProfile {
  if (!existsSync(join(profileDir, 'package.json'))) {
    const template = PROFILE_TEMPLATES[profileName]
    if (template === undefined) {
      throw new Error(`${BIN_NAME}: profile ${JSON.stringify(profileName)} does not exist`)
    }
    initProfile(profileDir, template.bundles)
  }
  const manifest = readProfileManifest(BIN_NAME, profileDir)
  const rawBundles = (manifest.dsh?.profile as { bundles?: unknown } | undefined)?.bundles
  if (rawBundles !== undefined
    && (!Array.isArray(rawBundles) || rawBundles.some(value => typeof value !== 'string'))) {
    throw new Error(`${BIN_NAME}: dsh.profile.bundles must be an array of package names`)
  }
  const bundles = (rawBundles ?? []) as string[]
  const selectedBundles = bundles.filter(packageName =>
    (aaEnabled || packageName !== AA_PACKAGE_NAME) &&
    packageName !== DESKTOP_MARKET_IDENTITIES.community.packageName
    && (marketProvider === DESKTOP_MARKET_IDENTITIES.dshMarket.provider
      || packageName !== DESKTOP_MARKET_IDENTITIES.dshMarket.packageName),
  )
  if (marketProvider === DESKTOP_MARKET_IDENTITIES.dshMarket.provider
    && !selectedBundles.includes(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)) {
    selectedBundles.push(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
  }
  if (aaEnabled && !selectedBundles.includes(AA_PACKAGE_NAME)) selectedBundles.push(AA_PACKAGE_NAME)
  const layers: Profile['layers'] = []
  let aaFailure: string | undefined
  let dshMarketFailure: string | undefined
  const installPackageUrl = pathToFileURL(INSTALL_ANCHOR).href
  const profilePackageUrl = pathToFileURL(join(profileDir, 'package.json')).href
  for (const packageName of selectedBundles) {
    const isDshMarket = packageName === DESKTOP_MARKET_IDENTITIES.dshMarket.packageName
    const isAa = packageName === AA_PACKAGE_NAME
    if (!isAa && !isDshMarket && desktopPluginBundleMutable(packageName) && disabledBundles.has(packageName)) continue
    try {
      const packageDir = resolveOverlayPackage(packageName, {
        installPackageUrl,
        profilePackageUrl,
      }).selected.packageDir
      const bundleManifest: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
      if ((isDshMarket || isAa) && (bundleManifest === null || typeof bundleManifest !== 'object'
        || Array.isArray(bundleManifest)
        || (bundleManifest as { name?: unknown }).name !== packageName)) {
        throw new Error(`${BIN_NAME}: selected ${packageName} bundle has an invalid package identity`)
      }
      const declared = bundleManifest !== null && typeof bundleManifest === 'object'
        ? (bundleManifest as { dsh?: { bundle?: { patch?: unknown } } }).dsh?.bundle?.patch
        : undefined
      const declaredList = typeof declared === 'string' ? [declared] : declared
      if (!Array.isArray(declaredList) || declaredList.length === 0
        || declaredList.some(entry => typeof entry !== 'string' || entry.length === 0)) {
        throw new Error(`${BIN_NAME}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
      }
      const patchPaths = bundlePatchPaths(packageDir, { patch: declaredList as string[] })
      layers.push({
        packageName,
        packageDir,
        patchPaths,
        patches: patchPaths.flatMap(path => loadOverlayPatches(BIN_NAME, path)),
      })
    } catch (cause) {
      if (isAa) aaFailure = marketFailureMessage(cause)
      else if (isDshMarket) dshMarketFailure = marketFailureMessage(cause)
      else throw cause
    }
  }
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME)
  return {
    profile: {
      name: profileName,
      dir: profileDir,
      layers,
      skippedBundles: [],
      patchPath,
      patches: existsSync(patchPath) ? loadOverlayPatches(BIN_NAME, patchPath) : [],
    },
    ...(dshMarketFailure === undefined ? {} : { dshMarketFailure }),
    ...(aaFailure === undefined ? {} : { aaFailure }),
  }
}

/**
 * Resolve the Cordis skills shipped by the matching agent-preset dependency.
 *
 * dsh 0.1.7-alpha.1 split `@deepseek-ai/dsh-agent-presets` into
 * `@deepseek-ai/dsh-agent-preset` (the preset model, which ships `skills/`) and
 * `@deepseek-ai/dsh-agent-preset-registry` (the Loader-facing service). The preset
 * *declarations* moved again, into `@deepseek-ai/dsh-web-app/presets/*.patch.yml`,
 * so only the skill tree is still resolved from a package root here.
 */
export function shippedSkillRoot(moduleUrl: string = import.meta.url): string {
  const require = createRequire(moduleUrl)
  return join(dirname(require.resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')
}

/** Read a row's object config without trusting arbitrary YAML values. */
function rowConfig(row: EntryOptions | undefined): Record<string, unknown> {
  const config = row?.config
  return config !== null && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {}
}

/** Snapshot, validate, and deduplicate the LAN allowlist supplied by the launcher. */
function preparedLanAddresses(addresses: readonly string[] | undefined): readonly string[] {
  const unique = new Set<string>()
  for (const address of addresses ?? []) {
    if (isIP(address) !== 4) {
      throw new Error(`${BIN_NAME}: LAN address ${JSON.stringify(address)} is not an IPv4 literal`)
    }
    unique.add(address)
  }
  return Object.freeze([...unique])
}

/** Merge launcher-derived LAN literals with a profile's explicit Web trust entries. */
function webRuntimeTrustedHosts(
  configured: unknown,
  lanAddresses: readonly string[],
): string[] {
  if (configured === undefined) return [...lanAddresses]
  if (!Array.isArray(configured) || configured.some(entry => typeof entry !== 'string')) {
    throw new Error(`${BIN_NAME}: web-runtime trustedHosts must be an array of strings`)
  }
  return [...new Set([...configured, ...lanAddresses])]
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
function filterMarketProviderRows(rows: EntryOptions[], matches = isMarketProviderEntry): {
  rows: EntryOptions[]
  removedProviderReference: boolean
} {
  const filtered: EntryOptions[] = []
  let removedProviderReference = false
  for (const row of rows) {
    if (matches(row)) {
      removedProviderReference = true
      continue
    }
    if (row.group === true && Array.isArray(row.config)) {
      const nested = filterMarketProviderRows(row.config, matches)
      removedProviderReference ||= nested.removedProviderReference
      filtered.push(nested.removedProviderReference ? { ...row, config: nested.rows } : row)
    } else {
      filtered.push(row)
    }
  }
  return { rows: filtered, removedProviderReference }
}

/** Strip provider inserts and overrides from every non-provider layer. */
function filterMarketProviderPatches(patches: PatchOptions[], matches = isMarketProviderEntry): MarketPatchFilter {
  const filtered: PatchOptions[] = []
  let removedProviderReference = false
  for (const patch of patches) {
    if (matches(patch)) {
      removedProviderReference = true
      continue
    }
    if (Array.isArray(patch.insert)) {
      const insert = filterMarketProviderRows(patch.insert, matches)
      removedProviderReference ||= insert.removedProviderReference
      filtered.push(insert.removedProviderReference ? { ...patch, insert: insert.rows } : patch)
    } else {
      filtered.push(patch)
    }
  }
  return { patches: filtered, removedProviderReference }
}

/** AA is an optional bundle; user layers cannot bypass its Desktop selection. */
function isAaEntry(entry: { readonly id?: unknown, readonly name?: unknown }): boolean {
  return entry.id === AA_ROW_ID || entry.name === AA_PACKAGE_NAME
    || (typeof entry.name === 'string' && entry.name.startsWith(`${AA_PACKAGE_NAME}/`))
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
 * Read the Desktop machine-wide patch without relaxing upstream patch parsing.
 *
 * A YAML null document is the natural result of an empty, comment-only, or
 * explicit `null` file. Desktop treats only that machine-wide state as an
 * empty patch layer; every non-null document still goes through app-boot's
 * strict parser, including its `!!js` schema and diagnostics.
 */
function loadDesktopMachinePatches(home: string): PatchOptions[] {
  const path = join(home, PROFILE_PATCH_FILENAME)
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return loadOptionalPatches(BIN_NAME, path) ?? []
  }

  try {
    const documents = parseAllDocuments(content, { prettyErrors: true })
    if (documents.length === 0) return []
    const [document] = documents
    if (documents.length === 1
      && document !== undefined
      && document.errors.length === 0
      && document.warnings.length === 0
      && document.toJS() === null) {
      return []
    }
  } catch {
    // Preserve app-boot's strict parser and user-facing diagnostic below.
  }

  return loadOptionalPatches(BIN_NAME, path) ?? []
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
  hooks: DesktopProfilePreparationHooks = {},
): PreparedDesktopProfile {
  const lanAddresses = preparedLanAddresses(hooks.lanAddresses)
  const profileDir = profileName === DESKTOP_PROFILE_NAME
    ? ensureDesktopProfile(home)
    : resolveProfileDir(profileName, home)
  const workspaceChanged = reconcileProfilePnpmWorkspace(profileDir)
  const requiresDependencyMigration = profileDependencyMigrationRequired(profileDir, workspaceChanged, platform)
  // `plugin-management` remains the community market's user-facing scope.
  // Recovery mode no longer reads or writes an independent disable policy:
  // package removal goes through the provider-neutral `dsh plugin remove`.
  const managedDisabledBundles = pluginStatePath === undefined
    ? new Set<string>()
    : readDesktopDisabledBundles(pluginStatePath, profileName)
  const disabledBundles = marketSelection.requested === DESKTOP_MARKET_IDENTITIES.community.provider
    ? new Set(managedDisabledBundles)
    : new Set<string>()
  const loadedProfile = loadRecoveryFilteredProfile(
    profileName,
    profileDir,
    disabledBundles,
    marketSelection.requested,
    hooks.aaEnabled === true,
  )
  // Only the patch document is substitutable: bundle layers, disabled-bundle
  // filtering and Market/AA admission stay launcher-owned even while an edit is
  // in flight, because the editor's own `loadProfileDirectory` view of them is
  // the unfiltered CLI one and must never replace ours.
  const profile = hooks.profilePatches === undefined
    ? loadedProfile.profile
    : { ...loadedProfile.profile, patches: structuredClone([...hooks.profilePatches]) }
  const rootConfig = join(profileDir, DESKTOP_PROFILE_ROOT)
  const bareModuleBaseUrl = pathToFileURL(join(profile.dir, 'package.json')).href
  // Profile HMR reuses preparation; do not retrigger the root watcher on reads.
  if (!existsSync(rootConfig) || readFileSync(rootConfig, 'utf8') !== '[]\n') {
    writeFileSync(rootConfig, '[]\n')
  }

  const desktopPatches = loadOverlayPatches(BIN_NAME, DESKTOP_PATCH_PATH)
  const bundlePatches: PatchOptions[] = []
  let aaLayer: Profile['layers'][number] | undefined
  let dshMarketPatches: PatchOptions[] | undefined
  let desktopLayerInserted = false
  const providerAwareDisabledBundles = new Set(disabledBundles)
  if (marketSelection.requested === DESKTOP_MARKET_IDENTITIES.dshMarket.provider) {
    providerAwareDisabledBundles.delete(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
  }
  if (hooks.aaEnabled === true) providerAwareDisabledBundles.delete(AA_PACKAGE_NAME)
  for (const layer of activeDesktopProfileLayers(profile, providerAwareDisabledBundles)) {
    if (layer.packageName === AA_PACKAGE_NAME) { aaLayer = layer; continue }
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

  const loadedHomePatches = loadDesktopMachinePatches(home)
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
  const ordinary = filterMarketProviderPatches([
    ...filteredBundles.patches,
    ...providerPatches,
    ...filteredProfile.patches,
    ...filteredHome.patches,
  ], isAaEntry)
  const aaPatches: PatchOptions[] = []
  let aaFailure = loadedProfile.aaFailure
  if (hooks.aaEnabled === true && aaFailure === undefined) {
    try {
      if (ordinary.removedProviderReference) throw new Error('conflicting AA configuration was removed')
      if (!aaLayer) throw new Error('selected AA bundle layer is unavailable')
      const aaRows = composeEntries([aaLayer.patches])
      const aaRow = aaRows.find(row => row.id === AA_ROW_ID && row.name === AA_PACKAGE_NAME)
      if (!aaRow || aaRows.length !== 1 || aaRow.disabled === true) {
        throw new Error('AA bundle must contain one active canonical plugin entry')
      }
      // Preserve the declared bundle. Supply only the actual Harness home and
      // the physical Python payload path required when Electron uses ASAR.
      const connectorSourceDir = join(aaLayer.packageDir, 'lib', 'bundled-connector')
        .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
      if (!existsSync(join(connectorSourceDir, 'pyproject.toml'))) throw new Error('AA Connector payload is unavailable')
      aaPatches.push(...aaLayer.patches, { id: AA_ROW_ID, config: {
        ...rowConfig(aaRow), dshHome: home, connectorSourceDir,
      } })
    } catch (cause) {
      aaFailure = marketFailureMessage(cause)
    }
  }
  const patches: PatchOptions[] = [...ordinary.patches, ...aaPatches]
  const composedRows = composeEntries([patches])
  assertUniqueEntryIds(composedRows)
  assertEffectiveMarketRows(composedRows, effectiveMarket)
  const rows = new Map<string, EntryOptions>()
  for (const row of composedRows) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const settings = rows.get('settings')
  if (settings?.name !== SETTINGS_PACKAGE) {
    throw new Error(`${BIN_NAME}: desktop profile must use ${SETTINGS_PACKAGE} in the settings row`)
  }
  // 0.1.7's settings row is the profile-owned service and takes no document config,
  // so Desktop resolves the harness-home document itself. The Host, the setup wizard,
  // and the recovery window all still address the document by path.
  const settingsSpec = resolveDesktopSettingsDocument({ dshHome: home })
  const settingsDocument = settingsSpec.filename
  // Before the Loader starts, so the settings plugin's one-shot import -- which
  // consumes the document and then renames it away -- sees Desktop's sections
  // under the entry ids it keys by.
  migrateDesktopSettingsDocumentSections(settingsSpec)
  hooks.onSettingsDocumentResolved?.(settingsDocument)
  const desktopShell = rows.get('desktop-shell')
  if (desktopShell === undefined) {
    throw new Error(`${BIN_NAME}: desktop profile has no desktop-shell row`)
  }
  const desktopShellConfig = rowConfig(desktopShell)
  const pendingSection = pendingDesktopShellSection(settingsSpec)
  // Land the section the import would merge before anything boots on this row,
  // then prepare again from the persisted profile. Merely supplying the pending
  // values to this generation is not enough: the import renames the document
  // before it writes, and any recomposition in between (profile HMR notices the
  // rename) would see neither and flip the row back underneath the running shell.
  // The config editor's validation pass (`profilePatches`) holds the patch file's
  // lock and writes it next, so it never imports.
  if (pendingSection !== undefined
    && hooks.profilePatches === undefined
    && pendingDesktopShellConfig(desktopShellConfig, pendingSection, platform) !== undefined
    && importPendingDesktopShellSection(profile.patchPath, desktopShell.name, settingsSpec, pendingSection)) {
    return prepareDesktopProfile(
      telemetryDisabled,
      home,
      platform,
      profileName,
      pluginStatePath,
      marketSelection,
      hooks,
    )
  }
  // Startup preferences used to live in the global settings document. 0.1.7 made
  // persisted form values profile-specific, so the composed desktop-shell row — the
  // bundle default overridden by the profile's own patch layer — is now the source.
  const {
    mode,
    port,
    macosMaterial,
    windowsMaterial,
    linuxMaterial,
    openBrowser,
    networkExposure,
  } = desktopStartupSettingsFromSettings({ [DESKTOP_SETTINGS_NAMESPACE]: desktopShellConfig })
  const webRuntime = rows.get('web-runtime')
  if (webRuntime === undefined) {
    throw new Error(`${BIN_NAME}: desktop profile has no web-runtime row`)
  }
  const webRuntimeConfig = rowConfig(webRuntime)
  patches.push({
    id: 'web-runtime',
    config: {
      ...webRuntimeConfig,
      // Browser access is an advertised Desktop capability, never an
      // instruction to launch the operating system's default browser.
      openBrowser: false,
      trustedHosts: webRuntimeTrustedHosts(webRuntimeConfig.trustedHosts, lanAddresses),
    },
  })
  // The saved mode is what the next generation boots, so the config editor's
  // validation pass must still reject a layout it could not start.
  if (mode === 'advanced' || mode === 'extended') {
    for (const [id, packageName] of [
      ['ui-layout', UI_LAYOUT_PACKAGE],
      ['ui-sidebar', UI_SIDEBAR_PACKAGE],
      ['ui-conversation', UI_CONVERSATION_PACKAGE],
    ] as const) {
      if (rows.get(id)?.name !== packageName) {
        throw new Error(`${BIN_NAME}: ${mode} desktop mode must use ${packageName} in the ${id} row`)
      }
    }
  }
  const layoutMode = hooks.generationMode ?? mode
  if (layoutMode === 'advanced' || layoutMode === 'extended') {
    patches.push(
      { id: 'ui-layout', disabled: true },
      { id: 'ui-sidebar', disabled: false },
      { id: 'ui-conversation', disabled: false },
    )
  }
  // dsh 0.1.7-alpha.1 replaced filesystem preset discovery with preset declarations
  // carried by patch files (`@deepseek-ai/dsh-web-app/presets/*.patch.yml`). The
  // `agent-presets` row is now `agent-preset-registry`, whose Config is only
  // `default`/`selectedDefault`/`modeSelectionEnabled` — the `roots` and
  // `includeUserRoot` override Desktop used to push no longer exists anywhere
  // upstream, so there is nothing left for Desktop to pin here.
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
  const webserverConfig = { host: desktopWebServerHost(networkExposure), port }
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
  // Upstream mounts its Desktop product analytics for every Profile named
  // `desktop` and reports to DeepSeek's collector by default. DSH Desktop does
  // not take part in that collection, so both rows stay off after every bundle
  // and user layer. The exporter also requires the upstream Electron shell's
  // DSH_CLIENT_VERSION, which this launcher never provides.
  for (const id of UPSTREAM_PRODUCT_ANALYTICS_ROW_IDS) {
    if (rows.has(id)) patches.push({ id, disabled: true })
  }
  // Keep the shell row enabled, but pin none of its configuration.
  //
  // These launcher-injected patches compose *after* the profile's own
  // `cordis.patch.yml`, which is exactly the file 0.1.7's config editor writes
  // settings into. Re-asserting the startup fields here therefore shadowed
  // every edit the user made to them, and 0.1.7's editor fails closed on that:
  // it recomposes the patch layers after writing and throws
  // `Configuration for "desktop-shell" is overridden by a home patch or
  // command-line overlay` when the effective value is not what it just wrote.
  // That blocked the mode picker and, with it, every Desktop settings write.
  //
  // Nothing is lost by dropping the config. The startup values above are read
  // back out of this same composed row, and `DesktopShellConfig` declares the
  // identical defaults (`parseDesktopShellMode` <-> `.default('compatibility')`,
  // `DEFAULT_DESKTOP_PORT` <-> `.default(DESKTOP_DEFAULT_WEB_PORT)`, and one
  // `DEFAULT_*_WINDOW_MATERIAL` per platform), so the plugin resolves the same
  // values from the raw row. The one field that was *derived* rather than
  // parsed -- `networkExposure`, withdrawn to loopback when browser access is
  // off -- is now derived by `resolveDesktopConfig` in `settings-bridge.ts`,
  // which is where the plugin already owns that rule on the write path.
  patches.push({ id: 'desktop-shell', disabled: false })
  return {
    homeDir: home,
    reloadOptions: {
      telemetryDisabled,
      platform,
      profileName,
      pluginStatePath,
      marketSelection: structuredClone(marketSelection),
      aaEnabled: hooks.aaEnabled === true,
    },
    profile,
    rootConfig,
    bareModuleBaseUrl,
    patches: structuredClone(patches),
    skippedOptionalEntries,
    mode,
    port,
    macosMaterial,
    windowsMaterial,
    linuxMaterial,
    openBrowser,
    networkExposure,
    lanAddresses,
    settingsDocument,
    aaEnabled: aaPatches.length > 0,
    ...(aaFailure === undefined ? {} : { aaFailure }),
    market: desktopMarketSnapshotWithEffective(marketSelection, effectiveMarket),
    requiresDependencyMigration,
    ...(marketFailure === undefined ? {} : { marketFailure }),
  }
}

/**
 * Retire the upstream module fallback for one fully resolved Desktop profile.
 *
 * dsh 0.1.7-alpha.1 deleted `healProfilesModuleFallback`: profile-local packages are
 * served by the runtime resolution table instead of a materialized link tree, so there
 * is no fallback left to heal. All this can still usefully do is sweep the tree older
 * Desktop releases wrote. Upstream runs that sweep (`removeLinkProjections`) inside
 * `loadProfile`, but Desktop composes profiles through {@link loadRecoveryFilteredProfile}
 * and never calls `loadProfile`, so this is the only place a Desktop install cleans up
 * after an upgrade. It uses {@link removeLinkProjectionsSafely}: the upstream helper's
 * recursive `rmSync` follows the projection junctions under Electron 44 and empties the
 * installation packages they point to.
 *
 * NOTE FOR FUTURE WORK: if Desktop ever needs to re-materialize a link tree of its own,
 * it must NOT reuse the directory name `.dsh-module-fallback`. 0.1.7's `loadProfile`
 * calls `removeLinkProjections` on every load and would delete it out from under us.
 *
 * The name and signature are byte-compared against the stable edition's caller in
 * `main.ts`, so only the body may change.
 * @param home - Harness home whose profile directories are swept.
 * @param profile - the resolved profile, when one is already loaded.
 */
export async function healDesktopProfileModuleFallback(home: string, profile?: Profile): Promise<void> {
  await Promise.resolve()
  if (profile !== undefined) {
    removeLinkProjectionsSafely(profile.dir)
    return
  }
  // Pre-boot callers have no profile yet. The sweep expects one profile
  // directory, so sweep every directory under the profiles root.
  const profilesDir = join(home, PROFILES_DIR)
  let entries: string[]
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(profilesDir, entry.name))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
    throw cause
  }
  for (const dir of entries) removeLinkProjectionsSafely(dir)
}

/** Expose the package anchor for focused resolution tests. */
export function desktopInstallAnchor(): string {
  return INSTALL_ANCHOR
}

/** Preserve the public manifest type in the declaration graph used by plugin tooling. */
export type DesktopProfileManifest = ProfileManifest
