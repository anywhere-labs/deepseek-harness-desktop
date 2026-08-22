/** Windows-side binding from WSL control methods to the real Electron runtime. */

import { fileURLToPath } from 'node:url'
import { DesktopControlPeer } from './control-protocol.ts'
import type { RendererBootReport } from './renderer-boot-contract.ts'
import type {
  RemoteShellRegistration,
  RemoteTrayRegistration,
} from './remote-runtime.ts'
import type {
  DesktopLocale,
  DesktopRuntime,
  DesktopShellMode,
  DesktopThemeSource,
  DesktopTrayItemRegistration,
} from './runtime.ts'
import type { UpdateCheckResult } from './update-checker.ts'
import { parseDesktopHostTargetSelection } from './host-target.ts'

const BIN_NAME = 'dsh-plugin-desktop'

export interface NativeDesktopControlBridgeOptions {
  readonly runtime: DesktopRuntime
  pickDirectory(): Promise<string | null>
  validateDirectory(path: string): Promise<boolean>
  openTerminal(): void
  exportRecoveryDiagnostics?(): Promise<void>
  showProfileRestoreNotice?(profileName: string): Promise<void>
  showRecoveryFailure?(message: string): Promise<'local' | 'quit'>
  reportError?(operation: string, cause: unknown): void
}

function object(value: unknown, operation: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${BIN_NAME}: invalid ${operation} request`)
  }
  return value as Record<string, unknown>
}

function stringField(record: Record<string, unknown>, name: string, operation: string): string {
  const value = record[name]
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) {
    throw new Error(`${BIN_NAME}: invalid ${operation} request`)
  }
  return value
}

function rendererUrl(record: Record<string, unknown>): string {
  const value = stringField(record, 'url', 'shell registration')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${BIN_NAME}: invalid shell registration request`)
  }
  const port = Number(url.port)
  if (url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.username.length > 0
    || url.password.length > 0
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535) {
    throw new Error(`${BIN_NAME}: remote shell requires an explicit loopback HTTP origin`)
  }
  return value
}

function shellRegistration(value: unknown): RemoteShellRegistration {
  const record = object(value, 'shell registration')
  const mode = record.mode
  const theme = record.theme
  const locale = record.locale
  if ((mode !== 'compatibility' && mode !== 'advanced')
    || (theme !== 'system' && theme !== 'light' && theme !== 'dark')
    || (locale !== undefined && locale !== 'en' && locale !== 'zh')) {
    throw new Error(`${BIN_NAME}: invalid shell registration request`)
  }
  const dimensions = ['width', 'height', 'minWidth', 'minHeight'] as const
  for (const name of dimensions) {
    if (!Number.isSafeInteger(record[name]) || (record[name] as number) < 1) {
      throw new Error(`${BIN_NAME}: invalid shell registration request`)
    }
  }
  return {
    id: stringField(record, 'id', 'shell registration'),
    url: rendererUrl(record),
    productName: stringField(record, 'productName', 'shell registration'),
    windowTitle: stringField(record, 'windowTitle', 'shell registration'),
    mode,
    theme,
    ...(locale === undefined ? {} : { locale }),
    width: record.width as number,
    height: record.height as number,
    minWidth: record.minWidth as number,
    minHeight: record.minHeight as number,
  }
}

function trayRegistration(value: unknown): RemoteTrayRegistration {
  const record = object(value, 'tray registration')
  const group = record.group
  if (group !== 'tools' && group !== 'profiles' && group !== 'status') {
    throw new Error(`${BIN_NAME}: invalid tray registration request`)
  }
  if (!Number.isSafeInteger(record.order) || typeof record.enabled !== 'boolean') {
    throw new Error(`${BIN_NAME}: invalid tray registration request`)
  }
  const submenu = record.submenu
  if (submenu !== undefined && !Array.isArray(submenu)) {
    throw new Error(`${BIN_NAME}: invalid tray submenu registration`)
  }
  return {
    id: stringField(record, 'id', 'tray registration'),
    group,
    order: record.order as number,
    label: stringField(record, 'label', 'tray registration'),
    enabled: record.enabled,
    ...(submenu === undefined ? {} : {
      submenu: submenu.map((entry, expectedIndex) => {
        const item = object(entry, 'tray submenu registration')
        if (item.index !== expectedIndex || typeof item.enabled !== 'boolean'
          || (item.type !== undefined && item.type !== 'normal' && item.type !== 'checkbox' && item.type !== 'radio')
          || (item.checked !== undefined && typeof item.checked !== 'boolean')) {
          throw new Error(`${BIN_NAME}: invalid tray submenu registration`)
        }
        return {
          index: expectedIndex,
          label: stringField(item, 'label', 'tray submenu registration'),
          enabled: item.enabled,
          ...(item.type === undefined ? {} : { type: item.type }),
          ...(item.checked === undefined ? {} : { checked: item.checked }),
        }
      }),
    }),
  }
}

function updateResult(value: unknown): UpdateCheckResult | null {
  if (value === null) return null
  const record = object(value, 'manual update result')
  if (record.status === 'up-to-date'
    && typeof record.currentVersion === 'string'
    && typeof record.latestVersion === 'string') return record as unknown as UpdateCheckResult
  if (record.status === 'update-available'
    && typeof record.currentVersion === 'string'
    && typeof record.latestVersion === 'string') return record as unknown as UpdateCheckResult
  throw new Error(`${BIN_NAME}: invalid manual update result`)
}

/** Own every native registration created for one WSL Host child. */
export class NativeDesktopControlBridge {
  private readonly releases: Array<() => void> = []
  private readonly tray = new Map<string, { value: RemoteTrayRegistration, registration: DesktopTrayItemRegistration }>()
  private shell: { id: string, release: () => Promise<void> } | undefined
  private profileCreateSessionId: string | undefined

  constructor(
    private readonly peer: DesktopControlPeer,
    private readonly options: NativeDesktopControlBridgeOptions,
  ) {
    const runtime = options.runtime
    this.releases.push(
      peer.register('native/runtime.describe', () => ({
        platform: runtime.platform,
        locale: runtime.locale,
        updates: {
          isPackaged: runtime.updates.isPackaged,
          canDownload: runtime.updates.canDownload,
          currentVersion: runtime.updates.currentVersion,
        },
        hostTarget: runtime.hostTarget ?? {
          current: { mode: 'local' }, distributions: [], wslSupported: false,
        },
      })),
      peer.register('native/host-target.select', async params => {
        if (runtime.selectHostTarget === undefined) throw new Error(`${BIN_NAME}: Host target switching is unavailable`)
        await runtime.selectHostTarget(parseDesktopHostTargetSelection(params))
        return null
      }),
      peer.register('native/shell.schedule', params => { this.scheduleShell(shellRegistration(params)); return null }),
      peer.register('native/shell.mount', async params => {
        this.assertShellId(params)
        await runtime.mountScheduled()
        return null
      }),
      peer.register('native/shell.release', async params => {
        this.assertShellId(params)
        const shell = this.shell
        this.shell = undefined
        await shell?.release()
        return null
      }),
      peer.register('native/window.show', () => { runtime.show(); return null }),
      peer.register('native/window.notify-attention', params => {
        const record = object(params, 'attention notification')
        runtime.notifyAttention({
          title: stringField(record, 'title', 'attention notification'),
          body: stringField(record, 'body', 'attention notification'),
        })
        return null
      }),
      peer.register('native/tray.register', params => { this.registerTray(trayRegistration(params)); return null }),
      peer.register('native/tray.refresh', params => { this.refreshTray(trayRegistration(params)); return null }),
      peer.register('native/tray.dispose', params => { this.disposeTray(params); return null }),
      peer.register('native/terminal.open', () => { options.openTerminal(); return null }),
      peer.register('native/diagnostics.export', async () => { await runtime.exportDiagnostics(); return null }),
      peer.register('native/recovery.export-diagnostics', async () => {
        if (options.exportRecoveryDiagnostics === undefined) {
          throw new Error(`${BIN_NAME}: automatic recovery diagnostics are unavailable`)
        }
        await options.exportRecoveryDiagnostics()
        return null
      }),
      peer.register('native/recovery.profile-restored', async params => {
        if (options.showProfileRestoreNotice === undefined) {
          throw new Error(`${BIN_NAME}: Profile restore notice is unavailable`)
        }
        await options.showProfileRestoreNotice(stringField(
          object(params, 'Profile restore notice'),
          'profileName',
          'Profile restore notice',
        ))
        return null
      }),
      peer.register('native/recovery.failed', async params => {
        if (options.showRecoveryFailure === undefined) {
          throw new Error(`${BIN_NAME}: WSL recovery failure dialog is unavailable`)
        }
        return await options.showRecoveryFailure(stringField(
          object(params, 'WSL recovery failure'),
          'message',
          'WSL recovery failure',
        ))
      }),
      peer.register('native/directory.pick', async () => await options.pickDirectory()),
      peer.register('native/directory.validate', async params => {
        const record = object(params, 'directory validation')
        return await options.validateDirectory(stringField(record, 'path', 'directory validation'))
      }),
      peer.register('native/profile-create.open', params => {
        this.profileCreateSessionId = stringField(
          object(params, 'Profile creator'),
          'id',
          'Profile creator',
        )
        runtime.openProfileCreateWindow({
          onSubmit: async name => {
            const id = this.profileCreateSessionId
            if (id === undefined) throw new Error(`${BIN_NAME}: Profile creator session is unavailable`)
            await peer.call('host/profile-create.submit', { id, name })
          },
        })
        return null
      }),
      peer.register('native/renderer.report', params => { runtime.reportRendererBoot(params as RendererBootReport); return null }),
      peer.register('native/locale.set', params => {
        const preference = object(params, 'locale preference').preference
        if (preference !== null && preference !== 'en' && preference !== 'zh') {
          throw new Error(`${BIN_NAME}: invalid locale preference`)
        }
        runtime.setLocalePreference(preference as DesktopLocale | undefined)
        return null
      }),
      peer.register('native/theme.set', params => {
        const source = object(params, 'theme source').source
        if (source !== 'system' && source !== 'light' && source !== 'dark') {
          throw new Error(`${BIN_NAME}: invalid theme source`)
        }
        runtime.setThemeSource(source as DesktopThemeSource)
        return null
      }),
      peer.register('native/runtime.restart', () => {
        // Acknowledge before shutdown starts. The Windows shutdown owns this
        // WSL child and waits for it to exit, so awaiting it here would create
        // a transport-level shutdown cycle.
        setImmediate(() => {
          void runtime.requestRestart().catch(cause => {
            options.reportError?.('WSL Host restart', cause)
          })
        })
        return null
      }),
      peer.register('native/runtime.prepare-to-quit', () => { runtime.prepareToQuit(); return null }),
      peer.register('native/notification.show', params => {
        const record = object(params, 'notification')
        runtime.updates.notify({
          title: stringField(record, 'title', 'notification'),
          body: stringField(record, 'body', 'notification'),
        })
        return null
      }),
      peer.register('native/update.confirm-download', async params => {
        return await runtime.updates.confirmDownload(stringField(object(params, 'update confirmation'), 'version', 'update confirmation'))
      }),
      peer.register('native/update.show-manual-result', async params => {
        await runtime.updates.showManualCheckResult(updateResult(object(params, 'manual update result').result))
        return null
      }),
      peer.register('native/update.download-and-open', async (params, signal) => {
        await runtime.updates.downloadAndOpen(
          stringField(object(params, 'update download'), 'version', 'update download'),
          signal,
        )
        return null
      }),
    )
  }

  private scheduleShell(value: RemoteShellRegistration): void {
    if (this.shell !== undefined) throw new Error(`${BIN_NAME}: native shell is already registered`)
    const iconPath = fileURLToPath(new URL('../build/app-icon.png', import.meta.url))
    const trayIcons = {
      templatePath: fileURLToPath(new URL('../build/tray-iconTemplate.png', import.meta.url)),
      bluePath: fileURLToPath(new URL('../build/tray-icon-blue.png', import.meta.url)),
    }
    const release = this.options.runtime.schedule({
      ...value,
      iconPath,
      trayIcons,
      readLocalePreference: () => value.locale,
      readThemeSource: () => value.theme,
      requestQuit: code => { this.peer.notify('host/shell.quit', { code }) },
      requestModeChange: async (mode: DesktopShellMode) => {
        await this.peer.call('host/shell.mode', { mode })
      },
    })
    this.shell = { id: value.id, release }
  }

  private assertShellId(params: unknown): void {
    const id = stringField(object(params, 'shell generation'), 'id', 'shell generation')
    if (this.shell?.id !== id) throw new Error(`${BIN_NAME}: remote shell generation is not active`)
  }

  private registerTray(value: RemoteTrayRegistration): void {
    if (this.tray.has(value.id)) throw new Error(`${BIN_NAME}: tray contribution already exists`)
    const holder = { value }
    const registration = this.options.runtime.registerTrayItem({
      group: value.group,
      order: value.order,
      label: () => holder.value.label,
      enabled: () => holder.value.enabled,
      invoke: async () => { await this.peer.call('host/tray.invoke', { id: value.id }) },
      ...(value.submenu === undefined ? {} : {
        submenu: () => holder.value.submenu?.map(item => ({
          label: () => item.label,
          enabled: () => item.enabled,
          ...(item.type === undefined ? {} : { type: item.type }),
          ...(item.checked === undefined ? {} : { checked: () => item.checked as boolean }),
          invoke: async () => { await this.peer.call('host/tray.invoke', { id: value.id, index: item.index }) },
        })) ?? [],
      }),
    })
    this.tray.set(value.id, { value: holder.value, registration })
  }

  private refreshTray(value: RemoteTrayRegistration): void {
    const current = this.tray.get(value.id)
    if (current === undefined) throw new Error(`${BIN_NAME}: tray contribution is unavailable`)
    current.value = value
    current.registration.refresh()
  }

  private disposeTray(params: unknown): void {
    const id = stringField(object(params, 'tray disposal'), 'id', 'tray disposal')
    const current = this.tray.get(id)
    if (current === undefined) return
    this.tray.delete(id)
    current.registration.dispose()
  }

  /** Release native resources before the control peer or child process exits. */
  async dispose(): Promise<void> {
    this.profileCreateSessionId = undefined
    for (const release of this.releases.splice(0).reverse()) release()
    for (const item of this.tray.values()) item.registration.dispose()
    this.tray.clear()
    const shell = this.shell
    this.shell = undefined
    await shell?.release()
  }
}
