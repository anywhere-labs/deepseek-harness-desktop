/**
 * Edition-local adapter between the shared Desktop sources and the core
 * settings surface.
 *
 * Both Desktop editions ride dsh 0.1.7, which replaced the `SettingsProvider` service
 * with `SettingsForms`: a plugin no longer *registers* a namespace and schema,
 * it *declares* the editable subset of its own `Config` with `.volatile()` and
 * the Loader entry id becomes the settings namespace. Reads come from the live
 * volatile references, this fiber's changes arrive on `loader/volatile-update`,
 * and cross-plugin reads go through `SettingsForms#describe()`.
 *
 * Every shared source file calls only the edition-neutral names exported here,
 * so `scripts/verify-desktop-variants.mjs` keeps byte-comparing them against
 * the stable edition while the two implementations stay free to diverge.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  LOCALE_SETTINGS_NAMESPACE,
  type LocaleSettings,
} from '@deepseek-ai/dsh-client-locale'
import {
  THEME_SETTINGS_NAMESPACE,
  type ThemeSettings,
} from '@deepseek-ai/dsh-client-ui-theme'
import { DESKTOP_DEFAULT_WEB_PORT } from './desktop-port.ts'
import {
  desktopBrowserAccessAvailable,
  desktopBrowserAccessEnabled,
  desktopNetworkExposureForBrowserAccess,
  type DesktopNetworkExposure,
} from './desktop-network.ts'
import { DESKTOP_PACKAGE_NAME } from './product-identity.ts'
import type { DesktopProfilePreferences } from './profile-preferences.ts'
import { desktopProfilePreferencesFromSettings } from './profile-preferences.ts'
import type { DesktopShellMode } from './runtime.ts'
import {
  DEFAULT_LINUX_WINDOW_MATERIAL,
  DEFAULT_MACOS_WINDOW_MATERIAL,
  DEFAULT_WINDOWS_WINDOW_MATERIAL,
  type LinuxWindowMaterial,
  type MacosWindowMaterial,
  type PersistedWindowsWindowMaterial,
} from './window-material.ts'

/**
 * Legacy settings-document section key. The removed `settings.yaml` and the
 * pre-Host startup parser in `profile.ts` both address Desktop preferences
 * under this key, so it survives as the on-disk name even though 0.1.7 keys
 * live configuration by Loader entry id instead.
 */
export const DESKTOP_SETTINGS_NAMESPACE = 'dsh-desktop'

/**
 * Loader entry id of the Desktop shell plugin, which 0.1.7 uses as the
 * settings namespace. It matches the `desktop-shell` row this edition already
 * writes its startup configuration into (`src/profile.ts`), so the settings
 * form and the pre-Host startup read now address one document.
 */
export const DESKTOP_SETTINGS_ENTRY_ID = 'desktop-shell'

/** Loader entry id of the Desktop notification plugin (`cordis.patch.yml`). */
export const DESKTOP_NOTIFICATIONS_SETTINGS_ENTRY_ID = 'desktop-notifications'

/** Loader entry id whose configuration carries the shared locale preference. */
const UI_LOCALE_SETTINGS_ENTRY_ID: string = LOCALE_SETTINGS_NAMESPACE

/** Loader entry id whose configuration carries the shared theme preference. */
const UI_THEME_SETTINGS_ENTRY_ID: string = THEME_SETTINGS_NAMESPACE

/** Desktop preferences presented by the standard configuration form. */
export interface DesktopSettings {
  /** Native presentation selected for the next application generation. */
  mode: DesktopShellMode
  /** Native translucency preference used on macOS custom-chrome modes. */
  macosMaterial: MacosWindowMaterial
  /** Legacy Windows backdrop preference; every persisted value resolves to 'off'. */
  windowsMaterial: PersistedWindowsWindowMaterial
  /** Electron-native transparency preference used on Linux generations. */
  linuxMaterial: LinuxWindowMaterial
  /** Loopback Web port selected for the next application generation; zero requests a random port. */
  port: number
  /** Whether Desktop advertises its marker-free compatibility client for browser use. */
  openBrowser: boolean
  /** Whether the next generation listens only on loopback or on every LAN interface. */
  networkExposure: DesktopNetworkExposure
  /** Log verbosity threshold applied to the file logger. */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/** Schema of the editable Desktop preference subset. */
export const DesktopSettingsSchema: z<DesktopSettings> = z.object({
  mode: z.union(['compatibility', 'extended', 'advanced'] as const).default('compatibility'),
  macosMaterial: z.union(['off', 'transparent'] as const).default(DEFAULT_MACOS_WINDOW_MATERIAL),
  // Windows no longer offers a material. The removed Acrylic and Mica values
  // stay schema-valid so older settings still boot; they resolve to 'off'.
  windowsMaterial: z.union(['off', 'acrylic', 'mica'] as const).default(DEFAULT_WINDOWS_WINDOW_MATERIAL),
  linuxMaterial: z.union(['off', 'transparent'] as const).default(DEFAULT_LINUX_WINDOW_MATERIAL),
  port: z.number().step(1).min(0).max(65_535).default(DESKTOP_DEFAULT_WEB_PORT),
  openBrowser: z.boolean().default(false),
  networkExposure: z.union(['loopback', 'lan'] as const).default('loopback'),
  logLevel: z.union(['debug', 'info', 'warn', 'error'] as const).default('info'),
})

/**
 * Native window configuration. The eight fields the configuration form edits
 * are `.volatile()`, which is what publishes them to `SettingsForms`; the four
 * geometry fields are consumed once at window construction and stay plain.
 */
export interface DesktopShellConfig {
  /** Native presentation mode selected before BrowserWindow construction. */
  mode: Volatile<DesktopShellMode>
  /** Native translucency preference used on macOS custom-chrome modes. */
  macosMaterial: Volatile<MacosWindowMaterial>
  /** Legacy Windows backdrop preference; every persisted value resolves to 'off'. */
  windowsMaterial: Volatile<PersistedWindowsWindowMaterial>
  /** Electron-native transparency preference used on Linux generations. */
  linuxMaterial: Volatile<LinuxWindowMaterial>
  /** Configured loopback Web port used to detect restart-applied settings changes. */
  port: Volatile<number>
  /** Whether Desktop advertises its marker-free compatibility client for browser use. */
  openBrowser: Volatile<boolean>
  /** Configured listener exposure used to detect restart-applied settings changes. */
  networkExposure: Volatile<DesktopNetworkExposure>
  /** Log verbosity threshold applied to the file logger. */
  logLevel: Volatile<'debug' | 'info' | 'warn' | 'error'>
  /** Initial window width in CSS pixels. */
  width: number
  /** Initial window height in CSS pixels. */
  height: number
  /** Minimum window width in CSS pixels. */
  minWidth: number
  /** Minimum window height in CSS pixels. */
  minHeight: number
}

/** Validated native window configuration. */
export const DesktopShellConfig = z.object({
  mode: z.union(['compatibility', 'extended', 'advanced'] as const).default('compatibility').volatile(),
  macosMaterial: z.union(['off', 'transparent'] as const).default(DEFAULT_MACOS_WINDOW_MATERIAL).volatile(),
  // Legacy Acrylic and Mica rows stay readable and resolve to 'off'.
  windowsMaterial: z.union(['off', 'acrylic', 'mica'] as const).default(DEFAULT_WINDOWS_WINDOW_MATERIAL).volatile(),
  linuxMaterial: z.union(['off', 'transparent'] as const).default(DEFAULT_LINUX_WINDOW_MATERIAL).volatile(),
  port: z.number().step(1).min(0).max(65_535).default(DESKTOP_DEFAULT_WEB_PORT).volatile(),
  openBrowser: z.boolean().default(false).volatile(),
  networkExposure: z.union(['loopback', 'lan'] as const).default('loopback').volatile(),
  logLevel: z.union(['debug', 'info', 'warn', 'error'] as const).default('info').volatile(),
  width: z.number().step(1).min(800).default(1280),
  height: z.number().step(1).min(600).default(840),
  minWidth: z.number().step(1).min(640).default(900),
  minHeight: z.number().step(1).min(480).default(640),
})

/**
 * Startup-applied window configuration with every volatile reference read.
 * Shaped exactly like the stable edition's plain `Config` so the shared shell
 * sources stay byte-identical across editions.
 */
export interface ResolvedDesktopConfig {
  mode: DesktopShellMode
  macosMaterial: MacosWindowMaterial
  windowsMaterial: PersistedWindowsWindowMaterial
  linuxMaterial: LinuxWindowMaterial
  port: number
  networkExposure: DesktopNetworkExposure
  width: number
  height: number
  minWidth: number
  minHeight: number
}

/**
 * Read the startup-applied configuration once.
 *
 * Every field here is adopted at BrowserWindow construction, so a later live
 * edit is deliberately *not* observed: the shell compares the edited value
 * against this snapshot and asks the launcher for a restart instead.
 * @param config - validated native window configuration.
 * @returns the plain startup configuration.
 */
export function resolveDesktopConfig(config: DesktopShellConfig): ResolvedDesktopConfig {
  const mode = config.mode.get()
  const storedNetworkExposure = config.networkExposure.get()
  // LAN exposure is stored intent; it only takes effect while browser access is
  // actually available. `src/profile.ts` applies the same withdrawal before it
  // hands the launcher's WebServer its host, and `src/index.ts` asserts the two
  // agree -- so this rule has to live wherever the row is read, not in a patch
  // that would shadow the user's own edit to these fields.
  const browserAccess = desktopBrowserAccessEnabled(
    mode,
    config.openBrowser.get(),
    storedNetworkExposure,
  )
  return {
    mode,
    macosMaterial: config.macosMaterial.get(),
    windowsMaterial: config.windowsMaterial.get(),
    linuxMaterial: config.linuxMaterial.get(),
    port: config.port.get(),
    networkExposure: desktopNetworkExposureForBrowserAccess(browserAccess, storedNetworkExposure),
    width: config.width,
    height: config.height,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
  }
}

/** Edition-neutral read, observe, and write face over the Desktop preferences. */
export interface DesktopSettingsPort {
  /** @returns the preferences standing right now. */
  get(): DesktopSettings
  /**
   * Observe accepted preference changes.
   * @param listener - invoked with the preferences after each accepted change.
   * @returns the disposer removing this listener.
   */
  watch(listener: (next: DesktopSettings) => void): () => void
  /**
   * Merge a partial preference edit.
   * @param patch - fields to write.
   */
  update(patch: Partial<DesktopSettings>): Promise<void>
}

/**
 * Bind the Desktop shell preferences and fence invalid combinations.
 *
 * 0.1.7 dropped `applies: 'restart'`; a form write now always lands live, so
 * the caller owns the restart decision. It also dropped the registration-time
 * `validate` hook, so the two combination rules move to the Loader's
 * `internal/config` waterfall, which refuses the update before it commits.
 * @param ctx - the Desktop shell plugin context.
 * @param config - this instance's validated configuration.
 * @param platform - the active Electron platform.
 * @returns the preference port consumed by the shared shell sources.
 */
export function createDesktopSettingsPort(
  ctx: Context,
  config: DesktopShellConfig,
  platform: NodeJS.Platform,
): DesktopSettingsPort {
  const read = (): DesktopSettings => ({
    mode: config.mode.get(),
    macosMaterial: config.macosMaterial.get(),
    windowsMaterial: config.windowsMaterial.get(),
    linuxMaterial: config.linuxMaterial.get(),
    port: config.port.get(),
    openBrowser: config.openBrowser.get(),
    networkExposure: config.networkExposure.get(),
    logLevel: config.logLevel.get(),
  })
  assertDesktopSettings(read(), platform)
  ctx.on('internal/config', function (_raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    assertDesktopSettings(readCandidate(raw), platform)
    return raw
  })
  // Desktop owns a hand-written settings page, so the automatic form is off.
  ctx.inject(['settings'], (child) => {
    child.effect(
      () => child.settings.configure({ auto: false }, ctx.fiber),
      'dsh-plugin-desktop: desktop settings page policy',
    )
  })
  return {
    get: read,
    watch(listener) {
      return ctx.on('loader/volatile-update', () => { listener(read()) })
    },
    async update(patch) {
      await ctx.settings.update(DESKTOP_SETTINGS_ENTRY_ID, patch)
    },
  }
}

/** Project a candidate raw configuration onto the editable preference subset. */
function readCandidate(raw: unknown): DesktopSettings {
  const candidate = DesktopShellConfig(raw as never)
  return {
    mode: candidate.mode.get(),
    macosMaterial: candidate.macosMaterial.get(),
    windowsMaterial: candidate.windowsMaterial.get(),
    linuxMaterial: candidate.linuxMaterial.get(),
    port: candidate.port.get(),
    openBrowser: candidate.openBrowser.get(),
    networkExposure: candidate.networkExposure.get(),
    logLevel: candidate.logLevel.get(),
  }
}

/** Refuse preference combinations the native shell cannot present. */
function assertDesktopSettings(value: DesktopSettings, platform: NodeJS.Platform): void {
  if (!desktopBrowserAccessAvailable(value.mode) && value.openBrowser) {
    throw new Error('dsh-plugin-desktop: browser access requires compatibility mode')
  }
  if (value.mode !== 'compatibility' && platform === 'linux') {
    throw new Error('dsh-plugin-desktop: custom desktop shell modes are supported on macOS and Windows')
  }
}

/** Desktop notification preferences presented by the standard configuration form. */
export interface DesktopNotificationSettings {
  /** Whether any native notification is raised at all. */
  enabled: boolean
  /** Raise attention when a user-initiated turn completes. */
  notifyOnTurnCompletion: boolean
  /** Raise attention when a user-initiated turn fails. */
  notifyOnTurnFailure: boolean
  /** Raise attention when a background job completes. */
  notifyOnJobCompletion: boolean
  /** Raise attention when a background job fails. */
  notifyOnJobFailure: boolean
  /** Raise attention when a scheduled turn completes. */
  notifyOnScheduleCompletion: boolean
  /** Raise attention when a scheduled turn fails. */
  notifyOnScheduleFailure: boolean
}

/** Schema of the editable notification preference subset. */
export const DesktopNotificationSettingsSchema: z<DesktopNotificationSettings> = z.object({
  enabled: z.boolean().default(true),
  notifyOnTurnCompletion: z.boolean().default(true),
  notifyOnTurnFailure: z.boolean().default(true),
  notifyOnJobCompletion: z.boolean().default(true),
  notifyOnJobFailure: z.boolean().default(true),
  notifyOnScheduleCompletion: z.boolean().default(true),
  notifyOnScheduleFailure: z.boolean().default(true),
})

/** Live notification preferences. */
export interface DesktopNotificationConfig {
  /** Whether any native notification is raised at all. */
  enabled: Volatile<boolean>
  /** Raise attention when a user-initiated turn completes. */
  notifyOnTurnCompletion: Volatile<boolean>
  /** Raise attention when a user-initiated turn fails. */
  notifyOnTurnFailure: Volatile<boolean>
  /** Raise attention when a background job completes. */
  notifyOnJobCompletion: Volatile<boolean>
  /** Raise attention when a background job fails. */
  notifyOnJobFailure: Volatile<boolean>
  /** Raise attention when a scheduled turn completes. */
  notifyOnScheduleCompletion: Volatile<boolean>
  /** Raise attention when a scheduled turn fails. */
  notifyOnScheduleFailure: Volatile<boolean>
}

/** Validated live notification preferences. */
export const DesktopNotificationConfig = z.object({
  enabled: z.boolean().default(true).volatile(),
  notifyOnTurnCompletion: z.boolean().default(true).volatile(),
  notifyOnTurnFailure: z.boolean().default(true).volatile(),
  notifyOnJobCompletion: z.boolean().default(true).volatile(),
  notifyOnJobFailure: z.boolean().default(true).volatile(),
  notifyOnScheduleCompletion: z.boolean().default(true).volatile(),
  notifyOnScheduleFailure: z.boolean().default(true).volatile(),
})

/** Notification preferences standing before the first observed value. */
export const DEFAULT_NOTIFICATION_SETTINGS: DesktopNotificationSettings =
  DesktopNotificationSettingsSchema({} as DesktopNotificationSettings)

/**
 * Publish the notification preferences and follow their live edits.
 * @param ctx - the notification plugin context.
 * @param config - this instance's validated configuration.
 * @param listener - invoked with the preferences standing after each change.
 * @returns the disposer restoring the defaults.
 */
export function bindDesktopNotificationSettings(
  ctx: Context,
  config: DesktopNotificationConfig,
  listener: (next: DesktopNotificationSettings) => void,
): () => void {
  const read = (): DesktopNotificationSettings => ({
    enabled: config.enabled.get(),
    notifyOnTurnCompletion: config.notifyOnTurnCompletion.get(),
    notifyOnTurnFailure: config.notifyOnTurnFailure.get(),
    notifyOnJobCompletion: config.notifyOnJobCompletion.get(),
    notifyOnJobFailure: config.notifyOnJobFailure.get(),
    notifyOnScheduleCompletion: config.notifyOnScheduleCompletion.get(),
    notifyOnScheduleFailure: config.notifyOnScheduleFailure.get(),
  })
  // Desktop owns a hand-written notifications page inside its settings section.
  ctx.inject(['settings'], (child) => {
    child.effect(
      () => child.settings.configure({ auto: false }, ctx.fiber),
      'dsh-plugin-desktop: native notification settings page policy',
    )
  })
  listener(read())
  const stopWatching = ctx.on('loader/volatile-update', () => { listener(read()) })
  return () => {
    stopWatching()
    listener(DEFAULT_NOTIFICATION_SETTINGS)
  }
}

/** Read one Loader entry's live configuration through the describe face. */
function readEntryValue<T>(ctx: Context, entryId: string): T | undefined {
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  return settings.describe().find(entry => String(entry.ns) === entryId)?.value as T | undefined
}

/**
 * Read the shared locale preference.
 * @param ctx - any Host context.
 * @returns the configured locale id, or undefined when none is selected.
 */
export function readUiLocalePreference(ctx: Context): string | undefined {
  return readEntryValue<LocaleSettings>(ctx, UI_LOCALE_SETTINGS_ENTRY_ID)?.preference
}

/**
 * Read the shared theme preference.
 * @param ctx - any Host context.
 * @returns the configured built-in theme preference.
 * @throws When the composition does not serve the theme entry.
 */
export function readUiThemeSource(ctx: Context): ThemeSettings['preference'] {
  const theme = readEntryValue<ThemeSettings>(ctx, UI_THEME_SETTINGS_ENTRY_ID)
  if (theme === undefined) {
    throw new Error('dsh-plugin-desktop: custom shell requires the ui-theme settings namespace')
  }
  return theme.preference
}

/**
 * Follow the shared theme preference.
 *
 * `settings/document-updated` carries only the namespace and its revision, so
 * the value is re-read from the describe face on every notification.
 * @param ctx - any Host context.
 * @param listener - invoked with the preference standing after each change.
 */
export function watchUiThemeSource(
  ctx: Context,
  listener: (preference: ThemeSettings['preference']) => void,
): void {
  ctx.on('settings/document-updated', (ns) => {
    if (String(ns) !== UI_THEME_SETTINGS_ENTRY_ID) return
    const theme = readEntryValue<ThemeSettings>(ctx, UI_THEME_SETTINGS_ENTRY_ID)
    if (theme === undefined) return
    listener(theme.preference)
  })
}

/**
 * Follow the shared locale preference.
 * @param ctx - any Host context.
 * @param listener - invoked with the preference standing after each change.
 */
export function watchUiLocalePreference(
  ctx: Context,
  listener: (preference: string | undefined) => void,
): void {
  ctx.on('settings/document-updated', (ns) => {
    if (String(ns) !== UI_LOCALE_SETTINGS_ENTRY_ID) return
    listener(readEntryValue<LocaleSettings>(ctx, UI_LOCALE_SETTINGS_ENTRY_ID)?.preference)
  })
}

/** File log exporter seam owned by the Host bootstrap. */
export interface DesktopLogThresholdSink {
  /** Apply the configured verbosity threshold. */
  setThreshold(level: DesktopSettings['logLevel']): void
}

/** Serialized Profile preference writer owned by the Host bootstrap. */
export type DesktopProfilePreferencesWriter = (
  update: (current: DesktopProfilePreferences) => DesktopProfilePreferences,
) => Promise<unknown>

/**
 * Mirror the Desktop and notification preferences into the active Profile and
 * keep the file logger threshold current.
 *
 * Runs on the Host root context, which owns neither entry, so both values are
 * read through the describe face rather than from a volatile reference.
 * @param ctx - the Host root context.
 * @param fileExporter - the file log exporter, when one is installed.
 * @param enqueueProfilePreferencesWrite - the serialized Profile preference writer.
 */
export function observeDesktopPreferenceSettings(
  ctx: Context,
  fileExporter: DesktopLogThresholdSink | undefined,
  enqueueProfilePreferencesWrite: DesktopProfilePreferencesWriter,
): void {
  const readDesktop = (): DesktopSettings | undefined =>
    readEntryValue<DesktopSettings>(ctx, DESKTOP_SETTINGS_ENTRY_ID)
  const readNotifications = (): DesktopNotificationSettings | undefined =>
    readEntryValue<DesktopNotificationSettings>(ctx, DESKTOP_NOTIFICATIONS_SETTINGS_ENTRY_ID)
  fileExporter?.setThreshold(readDesktop()?.logLevel ?? 'info')
  ctx.on('settings/document-updated', (ns) => {
    const namespace = String(ns)
    if (namespace !== DESKTOP_SETTINGS_ENTRY_ID
      && namespace !== DESKTOP_NOTIFICATIONS_SETTINGS_ENTRY_ID) return
    const desktop = readDesktop()
    const notifications = readNotifications()
    if (desktop === undefined || notifications === undefined) return
    if (namespace === DESKTOP_SETTINGS_ENTRY_ID) fileExporter?.setThreshold(desktop.logLevel)
    const write = enqueueProfilePreferencesWrite(current => desktopProfilePreferencesFromSettings(
      desktop,
      notifications,
      current.market,
      current.aaEnabled === true,
    ))
    void write.catch((cause: unknown) => {
      ctx.logger.error(
        `${DESKTOP_PACKAGE_NAME}: failed to capture active Profile settings: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    })
  })
}
