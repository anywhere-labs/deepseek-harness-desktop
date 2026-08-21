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
  configureApplication(
    icon: NativeImage,
    productName: string,
    applicationMenuItems?: readonly MenuItemConstructorOptions[],
  ): void
  refreshApplicationMenu(applicationMenuItems: readonly MenuItemConstructorOptions[]): void
  configureWindow(window: BrowserWindow): void
  refreshThemeMaterial(window: BrowserWindow): void
}

class WindowsPlatformStrategy implements ElectronPlatformStrategy {
  readonly platform = 'win32'
  readonly updateDownloadPlatform = 'win32'
  readonly canPickDirectory = true
  readonly canToggleShellMode = true

  configureApplication(
    _icon: NativeImage,
    _productName: string,
    _applicationMenuItems: readonly MenuItemConstructorOptions[] = [],
  ): void {}

  refreshApplicationMenu(_applicationMenuItems: readonly MenuItemConstructorOptions[]): void {}

  configureWindow(window: BrowserWindow): void {
    window.removeMenu()
  }

  refreshThemeMaterial(window: BrowserWindow): void {
    window.setBackgroundMaterial('mica')
  }
}

class MacPlatformStrategy implements ElectronPlatformStrategy {
  readonly platform = 'darwin'
  readonly updateDownloadPlatform = 'darwin'
  readonly canPickDirectory = false
  readonly canToggleShellMode = true

  private applicationName: string | undefined

  configureApplication(
    icon: NativeImage,
    productName: string,
    applicationMenuItems: readonly MenuItemConstructorOptions[] = [],
  ): void {
    app.dock?.setIcon(icon)
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

  refreshThemeMaterial(_window: BrowserWindow): void {}
}

class LinuxPlatformStrategy implements ElectronPlatformStrategy {
  readonly platform = 'linux'
  readonly updateDownloadPlatform = undefined
  readonly canPickDirectory = false
  readonly canToggleShellMode = false

  configureApplication(
    _icon: NativeImage,
    _productName: string,
    _applicationMenuItems: readonly MenuItemConstructorOptions[] = [],
  ): void {}

  refreshApplicationMenu(_applicationMenuItems: readonly MenuItemConstructorOptions[]): void {}

  configureWindow(_window: BrowserWindow): void {}

  refreshThemeMaterial(_window: BrowserWindow): void {}
}

/** Select the only platform adapter used by one Electron runtime generation. */
export function electronPlatformStrategy(platform: NodeJS.Platform = process.platform): ElectronPlatformStrategy {
  if (platform === 'win32') return new WindowsPlatformStrategy()
  if (platform === 'darwin') return new MacPlatformStrategy()
  if (platform === 'linux') return new LinuxPlatformStrategy()
  throw new Error(`dsh-plugin-desktop: unsupported Electron platform ${platform}`)
}
