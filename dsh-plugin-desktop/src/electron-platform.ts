import { app } from 'electron'
import type { BrowserWindow, NativeImage } from 'electron'
import type { DesktopPlatform } from './runtime.ts'
import type { DesktopDownloadPlatform } from './update-download.ts'

/** Native presentation and capability differences selected once at startup. */
export interface ElectronPlatformStrategy {
  readonly platform: DesktopPlatform
  readonly updateDownloadPlatform: DesktopDownloadPlatform | undefined
  readonly canPickDirectory: boolean
  readonly canToggleShellMode: boolean
  configureApplication(icon: NativeImage): void
  configureWindow(window: BrowserWindow): void
  refreshThemeMaterial(window: BrowserWindow): void
}

class WindowsPlatformStrategy implements ElectronPlatformStrategy {
  readonly platform = 'win32'
  readonly updateDownloadPlatform = 'win32'
  readonly canPickDirectory = true
  readonly canToggleShellMode = true

  configureApplication(_icon: NativeImage): void {}

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

  configureApplication(icon: NativeImage): void {
    app.dock?.setIcon(icon)
  }

  configureWindow(_window: BrowserWindow): void {}

  refreshThemeMaterial(_window: BrowserWindow): void {}
}

class LinuxPlatformStrategy implements ElectronPlatformStrategy {
  readonly platform = 'linux'
  readonly updateDownloadPlatform = undefined
  readonly canPickDirectory = false
  readonly canToggleShellMode = false

  configureApplication(_icon: NativeImage): void {}

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
