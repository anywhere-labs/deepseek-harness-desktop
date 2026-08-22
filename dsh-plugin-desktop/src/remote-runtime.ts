/** WSL-side DesktopRuntime proxy backed by the owned control channel. */

import { randomUUID } from 'node:crypto'
import type { UpdateCheckResult, UpdateRequest } from './update-checker.ts'
import { DesktopControlPeer } from './control-protocol.ts'
import {
  parseDesktopHostTargetSelection,
  type DesktopHostTargetSelection,
  type DesktopHostTargetView,
} from './host-target.ts'
import { parseRemoteHostTargetView } from './remote-host-target.ts'
import type {
  DesktopLocale,
  DesktopNotification,
  DesktopPlatform,
  DesktopRuntime,
  DesktopShellMode,
  DesktopShellSpec,
  DesktopThemeSource,
  DesktopTrayItem,
  DesktopTrayItemRegistration,
  DesktopUpdateAdapter,
} from './runtime.ts'

const BIN_NAME = 'dsh-plugin-desktop'

/** Native facts returned before the WSL Host composes its profile. */
export interface RemoteNativeDescription {
  readonly platform: DesktopPlatform
  readonly locale: DesktopLocale
  readonly updates: {
    readonly isPackaged: boolean
    readonly canDownload: boolean
    readonly currentVersion: string
  }
  readonly hostTarget: DesktopHostTargetView
}

/** Serializable window registration. Native assets stay owned by Windows. */
export interface RemoteShellRegistration {
  readonly id: string
  readonly url: string
  readonly productName: string
  readonly windowTitle: string
  readonly mode: DesktopShellMode
  readonly width: number
  readonly height: number
  readonly minWidth: number
  readonly minHeight: number
  readonly locale?: DesktopLocale
  readonly theme: DesktopThemeSource
}

export interface RemoteTraySubmenuItem {
  readonly index: number
  readonly label: string
  readonly enabled: boolean
  readonly type?: 'normal' | 'checkbox' | 'radio'
  readonly checked?: boolean
}

export interface RemoteTrayRegistration {
  readonly id: string
  readonly group: DesktopTrayItem['group']
  readonly order: number
  readonly label: string
  readonly enabled: boolean
  readonly submenu?: readonly RemoteTraySubmenuItem[]
}

export interface RemoteDesktopRuntimeOptions {
  readonly description: RemoteNativeDescription
  readonly updateStatePath: string
  readonly request?: UpdateRequest
}

function isDesktopPlatform(value: unknown): value is DesktopPlatform {
  return value === 'darwin' || value === 'win32' || value === 'linux'
}

function isDesktopLocale(value: unknown): value is DesktopLocale {
  return value === 'en' || value === 'zh'
}

/** Validate the native handshake before publishing it into a trusted Host. */
export function parseRemoteNativeDescription(value: unknown): RemoteNativeDescription {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${BIN_NAME}: invalid native runtime description`)
  }
  const record = value as { platform?: unknown, locale?: unknown, updates?: unknown }
  if (!isDesktopPlatform(record.platform) || !isDesktopLocale(record.locale)
    || record.updates === null || typeof record.updates !== 'object') {
    throw new Error(`${BIN_NAME}: invalid native runtime description`)
  }
  const updates = record.updates as { isPackaged?: unknown, canDownload?: unknown, currentVersion?: unknown }
  if (typeof updates.isPackaged !== 'boolean'
    || typeof updates.canDownload !== 'boolean'
    || typeof updates.currentVersion !== 'string'
    || updates.currentVersion.length === 0
    || updates.currentVersion.length > 128) {
    throw new Error(`${BIN_NAME}: invalid native update description`)
  }
  const hostTarget = (value as { hostTarget?: unknown }).hostTarget === undefined
    ? Object.freeze({ current: { mode: 'local' as const }, distributions: [], wslSupported: false })
    : parseRemoteHostTargetView((value as { hostTarget: unknown }).hostTarget)
  return Object.freeze({
    platform: record.platform,
    locale: record.locale,
    updates: Object.freeze({
      isPackaged: updates.isPackaged,
      canDownload: updates.canDownload,
      currentVersion: updates.currentVersion,
    }),
    hostTarget,
  })
}

function responseBoolean(value: unknown, operation: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${BIN_NAME}: invalid ${operation} response`)
  return value
}

function responseNullableString(value: unknown, operation: string): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`${BIN_NAME}: invalid ${operation} response`)
  }
  return value
}

function traySnapshot(id: string, item: DesktopTrayItem): RemoteTrayRegistration {
  const submenu = item.submenu?.().map((command, index): RemoteTraySubmenuItem => ({
    index,
    label: command.label(),
    enabled: command.enabled?.() ?? true,
    ...(command.type === undefined ? {} : { type: command.type }),
    ...(command.checked === undefined ? {} : { checked: command.checked() }),
  }))
  return Object.freeze({
    id,
    group: item.group,
    order: item.order,
    label: item.label(),
    enabled: item.enabled?.() ?? true,
    ...(submenu === undefined ? {} : { submenu: Object.freeze(submenu) }),
  })
}

/** Desktop capability consumed by Host plugins while Electron stays on Windows. */
export class RemoteDesktopRuntime implements DesktopRuntime {
  readonly platform: DesktopPlatform
  readonly updates: DesktopUpdateAdapter
  private currentLocale: DesktopLocale
  private shell: { id: string, spec: DesktopShellSpec, scheduled: Promise<unknown> } | undefined
  private currentHostTarget: DesktopHostTargetView
  private readonly trayItems = new Map<string, DesktopTrayItem>()
  private profileCreateSession: {
    readonly id: string
    readonly onSubmit: Parameters<DesktopRuntime['openProfileCreateWindow']>[0]['onSubmit']
  } | undefined
  private readonly releases: Array<() => void> = []

  static async connect(
    peer: DesktopControlPeer,
    updateStatePath: string,
    request?: UpdateRequest,
  ): Promise<RemoteDesktopRuntime> {
    const description = parseRemoteNativeDescription(await peer.call('native/runtime.describe'))
    return new RemoteDesktopRuntime(peer, { description, updateStatePath, ...(request === undefined ? {} : { request }) })
  }

  constructor(
    private readonly peer: DesktopControlPeer,
    options: RemoteDesktopRuntimeOptions,
  ) {
    this.platform = options.description.platform
    this.currentLocale = options.description.locale
    const request = options.request ?? ((url, init) => globalThis.fetch(url, init))
    this.currentHostTarget = options.description.hostTarget
    const nativeUpdates = options.description.updates
    const updates: DesktopUpdateAdapter = {
      isPackaged: nativeUpdates.isPackaged,
      canDownload: nativeUpdates.canDownload,
      currentVersion: nativeUpdates.currentVersion,
      statePath: options.updateStatePath,
      request,
      confirmDownload: async (version: string) => responseBoolean(
        await peer.call('native/update.confirm-download', { version }),
        'update confirmation',
      ),
      showManualCheckResult: async (result: UpdateCheckResult | null) => {
        await peer.call('native/update.show-manual-result', { result })
      },
      downloadAndOpen: async (version: string, signal: AbortSignal) => {
        await peer.call('native/update.download-and-open', { version }, signal)
      },
      notify: (notification: DesktopNotification) => { peer.notify('native/notification.show', notification) },
    }
    this.updates = Object.freeze(updates)
    this.releases.push(
      peer.register('host/shell.quit', params => {
        const code = typeof params === 'object' && params !== null
          ? (params as { code?: unknown }).code
          : undefined
        if (!Number.isSafeInteger(code)) throw new Error(`${BIN_NAME}: invalid native quit request`)
        this.shell?.spec.requestQuit(code as number)
        return null
      }),
      peer.register('host/shell.mode', async params => {
        const mode = typeof params === 'object' && params !== null
          ? (params as { mode?: unknown }).mode
          : undefined
        if (mode !== 'compatibility' && mode !== 'advanced') {
          throw new Error(`${BIN_NAME}: invalid native mode request`)
        }
        await this.shell?.spec.requestModeChange(mode)
        return null
      }),
      peer.register('host/tray.invoke', async params => {
        if (params === null || typeof params !== 'object') throw new Error(`${BIN_NAME}: invalid tray invocation`)
        const { id, index } = params as { id?: unknown, index?: unknown }
        if (typeof id !== 'string') throw new Error(`${BIN_NAME}: invalid tray invocation`)
        const item = this.trayItems.get(id)
        if (item === undefined) return null
        if (index === undefined || index === null) await item.invoke()
        else {
          if (!Number.isSafeInteger(index) || (index as number) < 0) {
            throw new Error(`${BIN_NAME}: invalid tray submenu invocation`)
          }
          const command = item.submenu?.()[index as number]
          if (command === undefined) throw new Error(`${BIN_NAME}: tray submenu command is unavailable`)
          await command.invoke()

        }
        return null
      }),
      peer.register('host/profile-create.submit', async params => {
        if (params === null || typeof params !== 'object' || Array.isArray(params)) {
          throw new Error(`${BIN_NAME}: invalid Profile creation submission`)
        }
        const { id, name } = params as { id?: unknown, name?: unknown }
        const session = this.profileCreateSession
        if (typeof id !== 'string' || id.length === 0 || id.length > 128
          || typeof name !== 'string' || name.length === 0 || Buffer.byteLength(name, 'utf8') > 1024
          || name.includes('\0') || session?.id !== id) {
          throw new Error(`${BIN_NAME}: invalid Profile creation submission`)
        }
        await session.onSubmit(name)
        if (this.profileCreateSession === session) this.profileCreateSession = undefined
        return null
      }),
    )
  }

  get locale(): DesktopLocale {
    return this.currentLocale
  }

  get hostTarget(): DesktopHostTargetView {
    return this.currentHostTarget
  }

  async selectHostTarget(selection: DesktopHostTargetSelection): Promise<void> {
    const target = parseDesktopHostTargetSelection(selection)
    await this.peer.call('native/host-target.select', target)
    this.currentHostTarget = Object.freeze({ ...this.currentHostTarget, current: target })
  }

  schedule(spec: DesktopShellSpec): () => Promise<void> {
    if (this.shell !== undefined) throw new Error(`${BIN_NAME}: a remote shell generation is already registered`)
    const id = randomUUID()
    let theme: DesktopThemeSource = 'system'
    try {
      theme = spec.readThemeSource()
    } catch {
      if (spec.mode === 'advanced') throw new Error(`${BIN_NAME}: advanced remote shell requires a theme setting`)
    }
    const locale = spec.readLocalePreference()
    const registration: RemoteShellRegistration = {
      id,
      url: spec.url,
      productName: spec.productName,
      windowTitle: spec.windowTitle,
      mode: spec.mode,
      width: spec.width,
      height: spec.height,
      minWidth: spec.minWidth,
      minHeight: spec.minHeight,
      ...(locale === undefined ? {} : { locale }),
      theme,
    }
    const scheduled = this.peer.call('native/shell.schedule', registration)
    this.shell = { id, spec, scheduled }
    let active = true
    return async () => {
      if (!active) return
      active = false
      if (this.shell?.id === id) this.shell = undefined
      try {
        await scheduled
        await this.peer.call('native/shell.release', { id })
      } catch {
        // The child-process channel itself owns teardown after either peer exits.
      }
    }
  }

  async mountScheduled(beforeInteractive?: () => void): Promise<void> {
    const shell = this.shell
    if (shell === undefined) throw new Error(`${BIN_NAME}: no remote shell generation is registered`)
    await shell.scheduled
    await this.peer.call('native/shell.mount', { id: shell.id })
    beforeInteractive?.()
  }

  /** Wait until Windows accepted the shell registration without mounting it. */
  async waitUntilScheduled(): Promise<void> {
    const shell = this.shell
    if (shell === undefined) throw new Error(`${BIN_NAME}: no remote shell generation is registered`)
    await shell.scheduled
  }

  show(): void { this.peer.notify('native/window.show') }

  notifyAttention(notification: DesktopNotification): void {
    this.peer.notify('native/window.notify-attention', notification)
  }

  registerTrayItem(item: DesktopTrayItem): DesktopTrayItemRegistration {
    const id = randomUUID()
    this.trayItems.set(id, item)
    this.peer.notify('native/tray.register', traySnapshot(id, item))
    let active = true
    return {
      refresh: () => {
        if (active) this.peer.notify('native/tray.refresh', traySnapshot(id, item))
      },
      dispose: () => {
        if (!active) return
        active = false
        this.trayItems.delete(id)
        this.peer.notify('native/tray.dispose', { id })
      },
    }
  }

  openTerminal(): void { this.peer.notify('native/terminal.open') }

  async exportDiagnostics(): Promise<void> { await this.peer.call('native/diagnostics.export') }

  async pickDirectory(): Promise<string | null> {
    return responseNullableString(await this.peer.call('native/directory.pick'), 'directory picker')
  }

  openProfileCreateWindow(options: Parameters<DesktopRuntime['openProfileCreateWindow']>[0]): void {
    const id = randomUUID()
    this.profileCreateSession = { id, onSubmit: options.onSubmit }
    this.peer.notify('native/profile-create.open', { id })
  }

  async validateDirectory(path: string): Promise<boolean> {
    return responseBoolean(await this.peer.call('native/directory.validate', { path }), 'directory validation')
  }

  reportRendererBoot(report: Parameters<DesktopRuntime['reportRendererBoot']>[0]): void {
    this.peer.notify('native/renderer.report', report)
  }

  setLocalePreference(preference: DesktopLocale | undefined): void {
    if (preference !== undefined) this.currentLocale = preference
    this.peer.notify('native/locale.set', { preference: preference ?? null })
  }

  setThemeSource(source: DesktopThemeSource): void {
    this.peer.notify('native/theme.set', { source })
  }

  async requestRestart(): Promise<void> { await this.peer.call('native/runtime.restart') }

  prepareToQuit(): void { this.peer.notify('native/runtime.prepare-to-quit') }

  /** Remove peer method registrations owned by this proxy. */
  dispose(): void {
    for (const release of this.releases.splice(0).reverse()) release()
    this.profileCreateSession = undefined
    this.trayItems.clear()
  }
}

/** Retain this import in generated declarations. */
export type RemoteUpdateCheckResult = UpdateCheckResult
