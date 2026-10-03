/** Electron-only tray, materials, and user-turn notifications. */
import { join } from 'node:path'
import { Menu, nativeImage, nativeTheme, Notification, Tray, type BrowserWindow } from 'electron'
import { desktopMenu } from './desktop-menu.ts'
import { notificationCopy, notificationEnabled } from './notifications.ts'
import type { DesktopCommand, DesktopPreferences, DesktopState, DesktopNotification } from './desktop-contract.ts'
import { windowMaterial } from './window-material.ts'
import { IPC } from './ipc.ts'
import { updateLabel } from './update-state.ts'

export function applyWindowMaterial(window: BrowserWindow, preferences: DesktopPreferences): void {
  const material = windowMaterial(preferences)
  if (process.platform === 'darwin') window.setVibrancy(material === 'transparent' ? 'sidebar' : null)
  window.setBackgroundColor(material === 'off' ? nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb' : '#00000000')
  window.webContents.send(IPC.material, material)
}

export class NativeDesktop {
  private tray: Tray | undefined
  private readonly notifications = new Set<Notification>()
  constructor(private readonly options: {
    root: string; language(): string; state(): DesktopState; window(): BrowserWindow | undefined
    show(): void; run(command: DesktopCommand): void; warn(error: unknown): void
  }) {}
  get available(): boolean { return !!this.tray && !this.tray.isDestroyed() }
  createTray(): void {
    try {
      const icon = nativeImage.createFromPath(join(this.options.root, 'assets', process.platform === 'darwin' ? 'tray-iconTemplate.png' : 'tray-icon-blue.png'))
      if (icon.isEmpty()) throw new Error('Tray icon is unavailable')
      if (process.platform === 'darwin') icon.setTemplateImage(true)
      this.tray = new Tray(icon)
      this.tray.on('click', this.options.show)
      this.tray.on('double-click', this.options.show)
      this.refresh()
    } catch (error) { this.options.warn(error) }
  }
  items() { return desktopMenu(this.options.state(), this.options.language(), this.options.show, this.options.run) }
  refresh(): void {
    if (process.platform !== 'win32') Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'DSH NEXT', submenu: this.items() }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]))
    if (!this.available) return
    const state = this.options.state()
    this.tray!.setToolTip(`DSH NEXT · ${state.selected} · ${state.phase}${state.updates && state.updates.phase !== 'idle' ? ` · ${updateLabel(state.updates, this.options.language())}` : ''}`)
    if (process.platform === 'darwin') {
      const progress = state.updates
      this.tray!.setTitle(progress?.phase === 'downloading'
        ? progress.total ? `${Math.min(100, Math.floor((progress.received ?? 0) / progress.total * 100))}%` : `${Math.floor((progress.received ?? 0) / 1048576)} MB`
        : progress?.phase === 'ready' ? '✓' : '')
    }
    this.tray!.setContextMenu(Menu.buildFromTemplate(this.items()))
  }
  notify(message: DesktopNotification): void {
    const state = this.options.state()
    const window = this.options.window()
    if (!Notification.isSupported() || !notificationEnabled(state.preferences, message.outcome) || window?.isFocused()) return
    const notification = new Notification(notificationCopy(message, this.options.language()))
    this.notifications.add(notification)
    notification.once('click', this.options.show)
    notification.once('close', () => this.notifications.delete(notification))
    notification.once('failed', (_event, error) => { this.notifications.delete(notification); this.options.warn(error) })
    notification.show()
    if (this.notifications.size > 10) { const oldest = this.notifications.values().next().value!; oldest.close(); this.notifications.delete(oldest) }
  }
  close(): void {
    this.tray?.destroy(); this.tray = undefined
    for (const item of this.notifications) item.close()
    this.notifications.clear()
  }
}
