import type { Context } from '@deepseek-ai/cordis'
import type { RendererBootReport } from './renderer-boot-contract.ts'
import type { UpdateCheckResult, UpdateRequest } from './update-checker.ts'
import type { ProfileCreateWindowOptions } from './profile-create-window.ts'

/** Electron platforms supported by the DSH Desktop native adapter. */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux'

/** Native presentation modes selected by the desktop-shell Cordis row. */
export type DesktopShellMode = 'compatibility' | 'advanced'

/** Electron appearance source used by native frame and material rendering. */
export type DesktopThemeSource = 'system' | 'light' | 'dark'

/** Locale identifiers shared by the Web client and native desktop tray. */
export type DesktopLocale = 'zh' | 'en'

/** Window values resolved from the desktop-shell Cordis row. */
export interface DesktopWindowConfig {
  /** Native presentation mode selected before BrowserWindow construction. */
  mode: DesktopShellMode
  /** Initial window width in CSS pixels. */
  width: number
  /** Initial window height in CSS pixels. */
  height: number
  /** Minimum window width in CSS pixels. */
  minWidth: number
  /** Minimum window height in CSS pixels. */
  minHeight: number
}

/** Generated images consumed by the platform tray adapter. */
export interface DesktopTrayIcons {
  /** Black macOS template image with its Retina representation beside it. */
  templatePath: string
  /** Brand-blue Windows/Linux image with DPI representations beside it. */
  bluePath: string
}

/** Stable placement groups for Host plugins that extend the native tray. */
export type DesktopTrayItemGroup = 'tools' | 'profiles' | 'status'

/** One command rendered below a contributed native tray submenu. */
export interface DesktopTraySubmenuItem {
  /** Resolve the current user-visible label when the menu is rebuilt. */
  label(): string
  /** Native menu selection behavior. */
  type?: 'normal' | 'checkbox' | 'radio'
  /** Resolve whether the command can currently be invoked. */
  enabled?(): boolean
  /** Resolve the selected state for checkbox and radio commands. */
  checked?(): boolean
  /** Run the command without blocking the Electron menu callback. */
  invoke(): void | Promise<void>
}

/** One effect-scoped command or submenu contributed to the native tray menu. */
export interface DesktopTrayItem {
  /** Menu section used for deterministic ordering and separators. */
  group: DesktopTrayItemGroup
  /** Relative position inside the selected group. */
  order: number
  /** Resolve the current user-visible label when the menu is rebuilt. */
  label(): string
  /** Resolve whether the command can currently be invoked. */
  enabled?(): boolean
  /** Run the command without blocking the Electron menu callback. */
  invoke(): void | Promise<void>
  /** Resolve optional child commands whenever the menu is rebuilt. */
  submenu?(): readonly DesktopTraySubmenuItem[]
}

/** Lifecycle handle returned for one tray contribution. */
export interface DesktopTrayItemRegistration {
  /** Rebuild the menu after the contribution's observable state changes. */
  refresh(): void
  /** Remove the contribution. Repeated disposal has no effect. */
  dispose(): void
}

/** Native notification shown by a desktop-owned Host plugin. */
export interface DesktopNotification {
  /** Notification heading. */
  title: string
  /** Concise user-facing status. */
  body: string
}

/** Electron capabilities used by the headless update plugin. */
export interface DesktopUpdateAdapter {
  /** Whether the running executable came from an Electron package. */
  readonly isPackaged: boolean
  /** Whether this platform has a fixed installer download endpoint. */
  readonly canDownload: boolean
  /** Installed desktop product version. */
  readonly currentVersion: string
  /** Private file used for update-prompt history. */
  readonly statePath: string
  /** Request adapter backed by Electron's native network session. */
  readonly request: UpdateRequest
  /** Ask whether one strictly newer version may be downloaded. */
  confirmDownload(version: string): Promise<boolean>
  /** Present the outcome of a user-triggered version check. */
  showManualCheckResult(result: UpdateCheckResult | null): Promise<void>
  /** Download and hand one confirmed update to the platform installer. */
  downloadAndOpen(version: string, signal: AbortSignal): Promise<void>
  /** Present a native status notification without blocking the Host tree. */
  notify(notification: DesktopNotification): void
}

/** Profile identity needed to open the packaged DSH command environment. */
export interface DesktopTerminalSpec {
  /** DSH profile selected by the desktop launcher. */
  profileName: string
  /** Absolute directory containing the profile manifest and dependencies. */
  profileDir: string
  /** Active DSH home shared with the desktop launcher. */
  homeDir: string
}

/** Values the desktop-shell plugin hands to the Electron adapter. */
export interface DesktopShellSpec extends DesktopWindowConfig {
  /** Unmodified Web root served by the active DSH profile. */
  url: string
  /** Native application and tray label. */
  productName: string
  /** Visible native caption on platforms that retain a title. */
  windowTitle: string
  /** Platform-selected application icon shipped with the package. */
  iconPath: string
  /** Generated tray assets derived from the repository-owned SVG. */
  trayIcons: DesktopTrayIcons
  /** Read the explicit Host-backed locale after all profile plugins settle. */
  readLocalePreference(): DesktopLocale | undefined
  /** Read the authoritative built-in theme preference after Host boot settles. */
  readThemeSource(): DesktopThemeSource
  /** Request Cordis teardown followed by native application exit. */
  requestQuit(code: number): void
  /** Persist another mode through the registered desktop settings scope. */
  requestModeChange(mode: DesktopShellMode): Promise<void>
}

/** Electron bootstrap capability supplied before the profile tree mounts. */
export interface DesktopRuntime {
  /** Current Electron platform. */
  readonly platform: DesktopPlatform

  /** Locale currently used for native tray contributions. */
  readonly locale: DesktopLocale

  /** Native network, update-download, and notification adapter. */
  readonly updates: DesktopUpdateAdapter

  /**
   * Register one shell generation while the Cordis profile is activating.
   * @param spec - native shell inputs resolved from active Host services.
   * @returns an asynchronous disposer for the shell generation.
   */
  schedule(spec: DesktopShellSpec): () => Promise<void>

  /**
   * Mount the registered generation after the launcher has settled the profile.
   * @param beforeInteractive - synchronous launcher commit run after native setup
   * succeeds and before tray commands can be dispatched.
   * @returns a promise that rejects when registration or native setup fails.
   */
  mountScheduled(beforeInteractive?: () => void): Promise<void>

  /** Reveal and focus the current window, if mounted. */
  show(): void

  /** Request native attention for background activity while the window is unfocused. */
  notifyAttention(notification: DesktopNotification): void

  /**
   * Contribute one command to the native tray for the current Cordis lifetime.
   * @param item - dynamic label, state, and invocation owned by the caller.
   * @returns a refreshable, idempotent registration handle.
   */
  registerTrayItem(item: DesktopTrayItem): DesktopTrayItemRegistration

  /** Open a native terminal containing packaged DSH command shims. */
  openTerminal(): void

  /** Export a diagnostics zip and reveal it in the system file manager. */
  exportDiagnostics(): Promise<void>

  /** Open the desktop operating system's native workspace-folder chooser. */
  pickDirectory(): Promise<string | null>

  /** Open the isolated native Profile creator, focusing an existing instance. */
  openProfileCreateWindow(options: Omit<ProfileCreateWindowOptions, 'locale'>): void

  /** Confirm that one renderer-selected workspace is safe to persist. */
  validateDirectory(path: string): Promise<boolean>

  /** Accept the terminal client Loader outcome for the mounted generation. */
  reportRendererBoot(report: RendererBootReport): void

  /** Apply an explicit locale, or fall back to Electron's application locale. */
  setLocalePreference(preference: DesktopLocale | undefined): void

  /** Apply a built-in theme preference to Electron's native appearance. */
  setThemeSource(source: DesktopThemeSource): void

  /** Request orderly Cordis teardown followed by an Electron relaunch. */
  requestRestart(): Promise<void>

  /** Allow the final native quit after the Cordis tree has disposed. */
  prepareToQuit(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Electron adapter provided by the DSH Desktop launcher. */
    desktopRuntime: DesktopRuntime
  }
}

// This type-only use keeps declaration merging reachable from the emitted
// package root without creating a runtime dependency edge.
export type DesktopRuntimeContext = Context
