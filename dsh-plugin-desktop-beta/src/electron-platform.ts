import { app, Menu } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions, NativeImage } from 'electron'
import { macApplicationMenuTemplate, nativeMenuLocale } from './native-menu.ts'
import type { DesktopPlatform } from './runtime.ts'
import type { DesktopDownloadPlatform } from './update-download.ts'

/** Native presentation and capability differences selected once at startup. */
export interface ElectronPlatformStrategy {
  readonly platform: DesktopPlatform
  readonly updateDownloadPlatform: DesktopDownloadPlatform | undefined
  readonly canPickDirectory: boolean
  readonly canToggleShellMode: boolean
  /**
   * Whether closing the window may hide it entirely, leaving the tray as the
   * only way back. Windows and macOS both guarantee a reachable tray or dock
   * icon. Linux does not: `new Tray()` succeeds even where the desktop shows
   * no status area, so a hidden window becomes unreachable. Those generations
   * minimize instead, which keeps the Host and its sessions running while
   * leaving the window in every window list, alt-tab ring, and overview.
   */
  readonly hidesWindowOnClose: boolean
  configureApplication(
    icon: NativeImage,
    productName: string,
    applicationMenuItems?: readonly MenuItemConstructorOptions[],
  ): void
  refreshApplicationMenu(applicationMenuItems: readonly MenuItemConstructorOptions[]): void
  configureWindow(window: BrowserWindow): void
}

class WindowsPlatformStrategy implements ElectronPlatformStrategy {
  readonly platform = 'win32'
  readonly updateDownloadPlatform = 'win32'
  readonly canPickDirectory = true
  readonly canToggleShellMode = true
  readonly hidesWindowOnClose = true

  configureApplication(
    _icon: NativeImage,
    _productName: string,
    _applicationMenuItems: readonly MenuItemConstructorOptions[] = [],
  ): void {}

  refreshApplicationMenu(_applicationMenuItems: readonly MenuItemConstructorOptions[]): void {}

  configureWindow(window: BrowserWindow): void {
    window.removeMenu()
  }
}

class MacPlatformStrategy implements ElectronPlatformStrategy {
  readonly platform = 'darwin'
  readonly updateDownloadPlatform = 'darwin'
  readonly canPickDirectory = true
  readonly canToggleShellMode = true
  readonly hidesWindowOnClose = true

  private applicationName: string | undefined

  configureApplication(
    icon: NativeImage,
    productName: string,
    applicationMenuItems: readonly MenuItemConstructorOptions[] = [],
  ): void {
    // Packaged macOS apps use their compiled Icon Composer catalog.
    if (!app.isPackaged) app.dock?.setIcon(icon)
    this.applicationName = productName
    this.refreshApplicationMenu(applicationMenuItems)
  }

  refreshApplicationMenu(applicationMenuItems: readonly MenuItemConstructorOptions[]): void {
    const applicationName = this.applicationName
    if (applicationName === undefined) return
    const locale = nativeMenuLocale(app.getPreferredSystemLanguages())
    Menu.setApplicationMenu(Menu.buildFromTemplate(macApplicationMenuTemplate(
      applicationName,
      locale,
      applicationMenuItems,
    )))
  }

  configureWindow(_window: BrowserWindow): void {}
}

class LinuxPlatformStrategy implements ElectronPlatformStrategy {
  readonly platform = 'linux'
  readonly updateDownloadPlatform = undefined
  readonly canPickDirectory = false
  readonly canToggleShellMode = false
  readonly hidesWindowOnClose = false

  configureApplication(
    _icon: NativeImage,
    _productName: string,
    _applicationMenuItems: readonly MenuItemConstructorOptions[] = [],
  ): void {}

  refreshApplicationMenu(_applicationMenuItems: readonly MenuItemConstructorOptions[]): void {}

  configureWindow(_window: BrowserWindow): void {}
}

/** Select the only platform adapter used by one Electron runtime generation. */
export function electronPlatformStrategy(platform: NodeJS.Platform = process.platform): ElectronPlatformStrategy {
  if (platform === 'win32') return new WindowsPlatformStrategy()
  if (platform === 'darwin') return new MacPlatformStrategy()
  if (platform === 'linux') return new LinuxPlatformStrategy()
  throw new Error(`dsh-plugin-desktop: unsupported Electron platform ${platform}`)
}
