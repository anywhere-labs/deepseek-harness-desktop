/** Pre-Host reader and atomic writer for Desktop Setup Wizard preferences. */

import {
  desktopBrowserAccessAvailable,
  desktopBrowserAccessEnabled,
  desktopNetworkExposureForBrowserAccess,
} from './desktop-network.ts'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
} from 'node:fs'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { parseDocument } from 'yaml'
import {
  DEFAULT_MACOS_WINDOW_MATERIAL,
  DEFAULT_WINDOWS_WINDOW_MATERIAL,
  parseMacosWindowMaterial,
  parseWindowsWindowMaterial,
} from './window-material.ts'
import type {
  DesktopSetupWizardMacosMaterial,
  DesktopSetupWizardMode,
  DesktopSetupWizardNetworkExposure,
  DesktopSetupWizardNotifications,
  DesktopSetupWizardWindowsMaterial,
} from './setup-wizard-contract.ts'

const BIN_NAME = 'dsh-plugin-desktop'
/**
 * Section keys of the two Wizard-owned groups, `[current, legacy]`.
 *
 * 0.1.7's settings service imports `settings.yaml` exactly once, keyed by Loader
 * entry id, and the launcher renames 0.1.6's `dsh-desktop` sections to those ids
 * (`migrateDesktopSettingsDocumentSections`) before any helper here runs. A
 * helper that only knew the legacy key would read that document as empty and
 * write Setup defaults back under a key the import can no longer place, so each
 * group is read from whichever key the document carries — the current one when
 * both are present, matching the launcher — and a new group is written under the
 * current key.
 */
const DESKTOP_NAMESPACES = Object.freeze(['desktop-shell', 'dsh-desktop'] as const)
const NOTIFICATIONS_NAMESPACES = Object.freeze(['desktop-notifications', 'dsh-desktop-notifications'] as const)
const AGENT_PRESETS_NAMESPACE = 'agent-presets'
/**
 * Where a persisted global preset default can live. 0.1.6 and earlier wrote the
 * user's choice to `agent-presets.default`; 0.1.7 moved it to
 * `agent-preset-registry.selectedDefault`, and beta's launcher renames the former
 * into the latter before this migration runs, so both locations must be checked.
 */
const AGENT_PRESET_DEFAULT_LOCATIONS: readonly (readonly [namespace: string, field: string])[] = Object.freeze([
  Object.freeze([AGENT_PRESETS_NAMESPACE, 'default'] as const),
  Object.freeze(['agent-preset-registry', 'selectedDefault'] as const),
])
const LEGACY_AGENT_PRESET = 'code'
const CURRENT_AGENT_PRESET = 'ptc'
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
const DOCUMENT_FILE_MODE = 0o600
const DOCUMENT_DIRECTORY_MODE = 0o700

type SettingsFormat = 'yaml' | 'json'

/** Complete notification choice committed by the Setup Wizard. */
export type DesktopSetupWizardNotificationSettings = DesktopSetupWizardNotifications

/** Preferences shown and saved before the Desktop Host boots. */
export interface DesktopSetupWizardSettings {
  readonly mode: DesktopSetupWizardMode
  /** Preserve both platform preferences when Setup runs on either platform. */
  readonly macosMaterial: DesktopSetupWizardMacosMaterial
  /** Preserve both platform preferences when Setup runs on either platform. */
  readonly windowsMaterial: DesktopSetupWizardWindowsMaterial
  /** Persisted compatibility key for ordinary-browser access permission. */
  readonly openBrowser: boolean
  /** Native Web listener exposure; LAN requires browser access permission. */
  readonly networkExposure: DesktopSetupWizardNetworkExposure
  readonly notifications: DesktopSetupWizardNotificationSettings
}

interface LoadedSettingsDocument {
  readonly format: SettingsFormat
  readonly root: Record<string, unknown>
  readonly yaml?: ReturnType<typeof parseDocument>
}

function invalid(message: string): Error {
  return new Error(`${BIN_NAME}: invalid Setup Wizard settings document: ${message}`)
}

function settingsPath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new TypeError(`${BIN_NAME}: Setup Wizard settings document must be an absolute path without NUL`)
  }
  const path = resolve(value)
  const extension = extname(path).toLowerCase()
  if (extension !== '.yaml' && extension !== '.yml' && extension !== '.json') {
    throw new TypeError(`${BIN_NAME}: Setup Wizard settings document must use .yaml, .yml, or .json`)
  }
  return path
}

function formatOf(path: string): SettingsFormat {
  return extname(path).toLowerCase() === '.json' ? 'json' : 'yaml'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readDocumentText(path: string): string | undefined {
  let pathInfo
  try {
    pathInfo = lstatSync(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw invalid('document must be a regular file')
  if (pathInfo.size > MAX_DOCUMENT_BYTES) {
    throw invalid(`document exceeds ${String(MAX_DOCUMENT_BYTES)} bytes`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) {
      throw invalid(`document must be a regular file within ${String(MAX_DOCUMENT_BYTES)} bytes`)
    }
    if (info.dev !== pathInfo.dev || info.ino !== pathInfo.ino) {
      throw invalid('document changed while it was being opened')
    }
    const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.byteLength) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.byteLength - bytesRead, null)
      if (count === 0) break
      bytesRead += count
    }
    if (bytesRead > MAX_DOCUMENT_BYTES) {
      throw invalid(`document exceeds ${String(MAX_DOCUMENT_BYTES)} bytes`)
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    } catch {
      throw invalid('document must contain valid UTF-8')
    }
  } finally {
    closeSync(descriptor)
  }
}

function loadSettingsDocument(path: string): LoadedSettingsDocument {
  const format = formatOf(path)
  const text = readDocumentText(path)
  if (format === 'json') {
    let value: unknown = {}
    if (text !== undefined) {
      try {
        value = JSON.parse(text) as unknown
      } catch {
        throw invalid('JSON could not be parsed')
      }
    }
    if (!isRecord(value)) throw invalid('root must be a map of namespace sections')
    return { format, root: value }
  }

  const yaml = parseDocument(text ?? '', { prettyErrors: true })
  if (yaml.errors.length > 0) {
    throw invalid(`YAML could not be parsed: ${yaml.errors.map(error => error.message).join('; ')}`)
  }
  const value: unknown = yaml.toJS() ?? {}
  if (!isRecord(value)) throw invalid('root must be a map of namespace sections')
  return { format, root: value, yaml }
}

function section(root: Record<string, unknown>, namespace: string): Record<string, unknown> {
  const value = root[namespace]
  if (value === undefined) return {}
  if (!isRecord(value)) throw invalid(`${namespace} must be a map`)
  return value
}

/** Key a Wizard-owned group is read from and written to in this document. */
function namespaceOf(
  root: Record<string, unknown>,
  [current, legacy]: readonly [current: string, legacy: string],
): string {
  return root[current] === undefined && root[legacy] !== undefined ? legacy : current
}

function desktopNamespace(root: Record<string, unknown>): string {
  return namespaceOf(root, DESKTOP_NAMESPACES)
}

function notificationsNamespace(root: Record<string, unknown>): string {
  return namespaceOf(root, NOTIFICATIONS_NAMESPACES)
}

function optionalBoolean(values: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = values[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw invalid(`${key} must be a boolean`)
  return value
}

function parseMode(value: unknown): DesktopSetupWizardMode {
  if (value === undefined) return 'compatibility'
  if (value === 'compatibility' || value === 'extended' || value === 'advanced') return value
  throw invalid('dsh-desktop.mode must be compatibility, extended, or advanced')
}

function parseExposure(value: unknown): DesktopSetupWizardNetworkExposure {
  if (value === undefined) return 'loopback'
  if (value === 'loopback' || value === 'lan') return value
  throw invalid('dsh-desktop.networkExposure must be loopback or lan')
}

function notificationSettings(values: Record<string, unknown>): DesktopSetupWizardNotificationSettings {
  return Object.freeze({
    enabled: optionalBoolean(values, 'enabled', true),
    notifyOnTurnCompletion: optionalBoolean(values, 'notifyOnTurnCompletion', true),
    notifyOnTurnFailure: optionalBoolean(values, 'notifyOnTurnFailure', true),
    notifyOnJobCompletion: optionalBoolean(values, 'notifyOnJobCompletion', true),
    notifyOnJobFailure: optionalBoolean(values, 'notifyOnJobFailure', true),
    notifyOnScheduleCompletion: optionalBoolean(values, 'notifyOnScheduleCompletion', true),
    notifyOnScheduleFailure: optionalBoolean(values, 'notifyOnScheduleFailure', true),
  })
}

function projectSettings(
  root: Record<string, unknown>,
): DesktopSetupWizardSettings {
  const desktop = section(root, desktopNamespace(root))
  const notifications = section(root, notificationsNamespace(root))
  const mode = parseMode(desktop.mode)
  const networkExposure = parseExposure(desktop.networkExposure)
  const openBrowser = desktopBrowserAccessEnabled(
    mode,
    optionalBoolean(desktop, 'openBrowser', false),
    networkExposure,
  )
  return Object.freeze({
    mode,
    macosMaterial: parseMacosWindowMaterial(desktop.macosMaterial),
    windowsMaterial: parseWindowsWindowMaterial(desktop.windowsMaterial),
    openBrowser,
    networkExposure: desktopNetworkExposureForBrowserAccess(openBrowser, networkExposure),
    notifications: notificationSettings(notifications),
  })
}

/** Normalize one complete Setup choice exactly as the settings writer would store it. */
export function normalizeDesktopSetupWizardSettings(
  value: DesktopSetupWizardSettings,
): DesktopSetupWizardSettings {
  return normalizedUpdate(value)
}

function normalizedUpdate(
  value: DesktopSetupWizardSettings,
): DesktopSetupWizardSettings {
  if (!isRecord(value)) throw new TypeError(`${BIN_NAME}: invalid Setup Wizard settings update`)
  const requestedMode = parseMode(value.mode)
  if (value.macosMaterial !== 'off' && value.macosMaterial !== 'transparent') {
    throw new TypeError(`${BIN_NAME}: macOS Setup Wizard material must be off or transparent`)
  }
  if (value.windowsMaterial !== 'off') {
    throw new TypeError(`${BIN_NAME}: Windows Setup Wizard material must be off`)
  }
  if (typeof value.openBrowser !== 'boolean') {
    throw new TypeError(`${BIN_NAME}: Setup Wizard openBrowser must be a boolean`)
  }
  const openBrowser = desktopBrowserAccessAvailable(requestedMode) && value.openBrowser
  const networkExposure = desktopNetworkExposureForBrowserAccess(
    openBrowser,
    parseExposure(value.networkExposure),
  )
  if (!isRecord(value.notifications)) {
    throw new TypeError(`${BIN_NAME}: Setup Wizard notifications must be a map`)
  }
  const notificationKeys: readonly (keyof DesktopSetupWizardNotificationSettings)[] = [
    'enabled',
    'notifyOnTurnCompletion',
    'notifyOnTurnFailure',
    'notifyOnJobCompletion',
    'notifyOnJobFailure',
    'notifyOnScheduleCompletion',
    'notifyOnScheduleFailure',
  ]
  if (Object.keys(value.notifications).length !== notificationKeys.length
    || notificationKeys.some(key => typeof value.notifications[key] !== 'boolean')) {
    throw new TypeError(`${BIN_NAME}: Setup Wizard update must contain all seven notification booleans`)
  }
  return Object.freeze({
    mode: requestedMode,
    macosMaterial: value.macosMaterial,
    windowsMaterial: value.windowsMaterial,
    openBrowser,
    networkExposure,
    notifications: Object.freeze({
      enabled: value.notifications.enabled,
      notifyOnTurnCompletion: value.notifications.notifyOnTurnCompletion,
      notifyOnTurnFailure: value.notifications.notifyOnTurnFailure,
      notifyOnJobCompletion: value.notifications.notifyOnJobCompletion,
      notifyOnJobFailure: value.notifications.notifyOnJobFailure,
      notifyOnScheduleCompletion: value.notifications.notifyOnScheduleCompletion,
      notifyOnScheduleFailure: value.notifications.notifyOnScheduleFailure,
    }),
  })
}

/** Return whether two normalized Setup views have identical persisted leaves. */
export function sameDesktopSetupWizardSettings(
  current: DesktopSetupWizardSettings,
  next: DesktopSetupWizardSettings,
): boolean {
  return current.mode === next.mode
    && current.macosMaterial === next.macosMaterial
    && current.windowsMaterial === next.windowsMaterial
    && current.openBrowser === next.openBrowser
    && current.networkExposure === next.networkExposure
    && current.notifications.enabled === next.notifications.enabled
    && current.notifications.notifyOnTurnCompletion === next.notifications.notifyOnTurnCompletion
    && current.notifications.notifyOnTurnFailure === next.notifications.notifyOnTurnFailure
    && current.notifications.notifyOnJobCompletion === next.notifications.notifyOnJobCompletion
    && current.notifications.notifyOnJobFailure === next.notifications.notifyOnJobFailure
    && current.notifications.notifyOnScheduleCompletion === next.notifications.notifyOnScheduleCompletion
    && current.notifications.notifyOnScheduleFailure === next.notifications.notifyOnScheduleFailure
}

function applyYamlUpdate(
  loaded: LoadedSettingsDocument,
  next: DesktopSetupWizardSettings,
): string {
  const document = loaded.yaml!
  const desktop = desktopNamespace(loaded.root)
  const notifications = notificationsNamespace(loaded.root)
  document.setIn([desktop, 'mode'], next.mode)
  document.setIn([desktop, 'macosMaterial'], next.macosMaterial)
  document.setIn([desktop, 'windowsMaterial'], next.windowsMaterial)
  document.setIn([desktop, 'openBrowser'], next.openBrowser)
  document.setIn([desktop, 'networkExposure'], next.networkExposure)
  for (const [key, value] of Object.entries(next.notifications)) {
    document.setIn([notifications, key], value)
  }
  return document.toString()
}

function applyJsonUpdate(
  root: Record<string, unknown>,
  next: DesktopSetupWizardSettings,
): string {
  const output = structuredClone(root)
  const desktopKey = desktopNamespace(output)
  const notificationsKey = notificationsNamespace(output)
  const desktop = { ...section(output, desktopKey) }
  desktop.mode = next.mode
  desktop.macosMaterial = next.macosMaterial
  desktop.windowsMaterial = next.windowsMaterial
  desktop.openBrowser = next.openBrowser
  desktop.networkExposure = next.networkExposure
  output[desktopKey] = desktop
  output[notificationsKey] = {
    ...section(output, notificationsKey),
    ...next.notifications,
  }
  return `${JSON.stringify(output, undefined, 2)}\n`
}

function ensureDocumentDirectory(path: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: DOCUMENT_DIRECTORY_MODE })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw invalid('document parent must be a real directory')
  }
}

/** Read defaults or validated current values from the exact prepared settings file. */
export function readDesktopSetupWizardSettings(
  documentPath: string,
): DesktopSetupWizardSettings {
  const path = settingsPath(documentPath)
  return projectSettings(loadSettingsDocument(path).root)
}

/**
 * Atomically update only Wizard-owned leaves, preserving every other setting.
 * Setup runs before the Host and never creates or waits for a settings writer
 * lock; the same-directory rename still keeps readers from seeing torn bytes.
 */
export async function updateDesktopSetupWizardSettings(
  documentPath: string,
  value: DesktopSetupWizardSettings,
): Promise<DesktopSetupWizardSettings> {
  const path = settingsPath(documentPath)
  const next = normalizedUpdate(value)
  // Explicit default leaves do not need to be materialized. Apart from making
  // Setup idempotent, this lets an unchanged first-run choice proceed while an
  // unrelated or orphaned settings writer lock exists.
  if (sameDesktopSetupWizardSettings(projectSettings(loadSettingsDocument(path).root), next)) return next
  ensureDocumentDirectory(path)
  const loaded = loadSettingsDocument(path)
  // Refuse to cover an invalid known value, including the inactive platform's
  // material, before touching the user's document.
  projectSettings(loaded.root)
  const output = loaded.format === 'yaml'
    ? applyYamlUpdate(loaded, next)
    : applyJsonUpdate(loaded.root, next)
  await writeFileAtomic(path, output, {
    mode: DOCUMENT_FILE_MODE,
    dirMode: DOCUMENT_DIRECTORY_MODE,
  })
  return next
}

/** Wizard leaves a Desktop Profile owns; the window materials stay device-shared. */
export type DesktopSetupWizardProfileSettings = Pick<
  DesktopSetupWizardSettings,
  'mode' | 'openBrowser' | 'networkExposure' | 'notifications'
>

/**
 * Merge one Profile's leaves into the settings document while it still awaits
 * 0.1.7's one-shot import, preserving the device-shared window materials.
 *
 * Once the settings service has imported the document into the Profile's patch
 * layer it renames it to `settings.yaml.imported`; from then on the patch layer
 * is the live store and the Host keeps the Profile preferences in step with it.
 * Recreating the document at that point would not be a mirror but a second
 * import on the next Host boot, carrying Setup's default materials over the
 * user's choice and replacing the `.imported` copy of the original document,
 * so a document that no longer exists is left absent.
 *
 * @param documentPath - the exact prepared settings document.
 * @param profile - the active Profile's own preference leaves.
 * @returns whether the document changed.
 */
export async function mirrorDesktopSetupWizardProfileSettings(
  documentPath: string,
  profile: DesktopSetupWizardProfileSettings,
): Promise<boolean> {
  const path = settingsPath(documentPath)
  if (readDocumentText(path) === undefined) return false
  const current = projectSettings(loadSettingsDocument(path).root)
  const next = normalizedUpdate({
    ...current,
    mode: profile.mode,
    openBrowser: profile.openBrowser,
    networkExposure: profile.networkExposure,
    notifications: Object.freeze({ ...profile.notifications }),
  })
  if (sameDesktopSetupWizardSettings(current, next)) return false
  await updateDesktopSetupWizardSettings(path, next)
  return true
}

/**
 * Atomically migrate settings written with the former browser-handoff
 * semantics before the Host reads them. Existing LAN exposure becomes an
 * explicit browser-access grant only for an already-selected compatibility
 * mode. Incompatible modes retain their selection and withdraw browser/LAN
 * access. Returns whether the durable document changed.
 */
export async function migrateDesktopBrowserAccessSettings(
  documentPath: string,
): Promise<boolean> {
  const path = settingsPath(documentPath)

  const migrationValues = (loaded: LoadedSettingsDocument) => {
    // Validate every known Wizard-owned value before migrating any leaf.
    projectSettings(loaded.root)
    const desktop = section(loaded.root, desktopNamespace(loaded.root))
    const storedMode = parseMode(desktop.mode)
    const storedOpenBrowser = optionalBoolean(desktop, 'openBrowser', false)
    const storedExposure = parseExposure(desktop.networkExposure)
    const browserAccess = desktopBrowserAccessEnabled(storedMode, storedOpenBrowser, storedExposure)
    const networkExposure = desktopNetworkExposureForBrowserAccess(browserAccess, storedExposure)
    return {
      browserAccess,
      needed: storedOpenBrowser !== browserAccess || storedExposure !== networkExposure,
      networkExposure,
    }
  }

  // Most Profiles are already normalized. Keep their startup entirely
  // read-only so an unrelated or orphaned settings writer lock cannot block
  // Desktop from opening.
  if (!migrationValues(loadSettingsDocument(path)).needed) return false

  ensureDocumentDirectory(path)
  const loaded = loadSettingsDocument(path)
  const migration = migrationValues(loaded)
  if (!migration.needed) return false

  const desktopKey = desktopNamespace(loaded.root)
  let output: string
  if (loaded.format === 'yaml') {
    loaded.yaml!.setIn([desktopKey, 'openBrowser'], migration.browserAccess)
    loaded.yaml!.setIn([desktopKey, 'networkExposure'], migration.networkExposure)
    output = loaded.yaml!.toString()
  } else {
    const root = structuredClone(loaded.root)
    const nextDesktop = { ...section(root, desktopKey) }
    nextDesktop.openBrowser = migration.browserAccess
    nextDesktop.networkExposure = migration.networkExposure
    root[desktopKey] = nextDesktop
    output = `${JSON.stringify(root, undefined, 2)}\n`
  }
  await writeFileAtomic(path, output, {
    mode: DOCUMENT_FILE_MODE,
    dirMode: DOCUMENT_DIRECTORY_MODE,
  })
  return true
}

/**
 * Replace the removed Acrylic preference without making an old settings file
 * a startup failure. Runtime parsing already treats Acrylic as off, so a
 * read-only document remains safe even when this durable migration cannot run.
 */
export async function migrateDesktopWindowMaterialSettings(
  documentPath: string,
): Promise<boolean> {
  const path = settingsPath(documentPath)

  const needsMigration = (loaded: LoadedSettingsDocument): boolean => {
    // Validate every known Wizard-owned value before changing the legacy leaf.
    projectSettings(loaded.root)
    return section(loaded.root, desktopNamespace(loaded.root)).windowsMaterial === 'acrylic'
  }

  if (!needsMigration(loadSettingsDocument(path))) return false

  ensureDocumentDirectory(path)
  const loaded = loadSettingsDocument(path)
  if (!needsMigration(loaded)) return false

  const desktopKey = desktopNamespace(loaded.root)
  let output: string
  if (loaded.format === 'yaml') {
    loaded.yaml!.setIn([desktopKey, 'windowsMaterial'], 'off')
    output = loaded.yaml!.toString()
  } else {
    const root = structuredClone(loaded.root)
    const desktop = { ...section(root, desktopKey), windowsMaterial: 'off' }
    root[desktopKey] = desktop
    output = `${JSON.stringify(root, undefined, 2)}\n`
  }
  await writeFileAtomic(path, output, {
    mode: DOCUMENT_FILE_MODE,
    dirMode: DOCUMENT_DIRECTORY_MODE,
  })
  return true
}

/**
 * Replace the released `code` preset default with its current `ptc` id.
 * Session persistence migrates the same historical id, but the global
 * setting is read before a new Session exists and therefore needs its own
 * pre-Host migration. Both the 0.1.6 `agent-presets.default` key and the
 * 0.1.7 `agent-preset-registry.selectedDefault` key it is renamed to are
 * checked, because beta renames the section before this runs. Unknown values
 * remain untouched so user-authored presets keep failing visibly instead of
 * being silently replaced.
 */
export async function migrateLegacyAgentPresetSettings(
  documentPath: string,
): Promise<boolean> {
  const path = settingsPath(documentPath)
  const legacyLocations = (loaded: LoadedSettingsDocument) => AGENT_PRESET_DEFAULT_LOCATIONS
    .filter(([namespace, field]) => section(loaded.root, namespace)[field] === LEGACY_AGENT_PRESET)

  if (legacyLocations(loadSettingsDocument(path)).length === 0) return false

  ensureDocumentDirectory(path)
  const loaded = loadSettingsDocument(path)
  const locations = legacyLocations(loaded)
  if (locations.length === 0) return false

  let output: string
  if (loaded.format === 'yaml') {
    for (const [namespace, field] of locations) {
      loaded.yaml!.setIn([namespace, field], CURRENT_AGENT_PRESET)
    }
    output = loaded.yaml!.toString()
  } else {
    const root = structuredClone(loaded.root)
    for (const [namespace, field] of locations) {
      root[namespace] = { ...section(root, namespace), [field]: CURRENT_AGENT_PRESET }
    }
    output = `${JSON.stringify(root, undefined, 2)}\n`
  }
  await writeFileAtomic(path, output, {
    mode: DOCUMENT_FILE_MODE,
    dirMode: DOCUMENT_DIRECTORY_MODE,
  })
  return true
}

/** Defaults used when the settings document or both owned sections are absent. */
export function defaultDesktopSetupWizardSettings(
): DesktopSetupWizardSettings {
  return Object.freeze({
    mode: 'compatibility',
    macosMaterial: DEFAULT_MACOS_WINDOW_MATERIAL,
    windowsMaterial: DEFAULT_WINDOWS_WINDOW_MATERIAL,
    openBrowser: false,
    networkExposure: 'loopback',
    notifications: Object.freeze({
      enabled: true,
      notifyOnTurnCompletion: true,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: true,
      notifyOnJobFailure: true,
      notifyOnScheduleCompletion: true,
      notifyOnScheduleFailure: true,
    }),
  })
}

export const desktopSetupWizardSettingsConstants = Object.freeze({
  desktopNamespace: DESKTOP_NAMESPACES[0],
  notificationsNamespace: NOTIFICATIONS_NAMESPACES[0],
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  fileMode: DOCUMENT_FILE_MODE,
})
