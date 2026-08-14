import type { BrowserWindowConstructorOptions } from 'electron'

/** Shared desktop window geometry and renderer hardening. */
const SHARED_OPTIONS = {
  width: 1440,
  height: 920,
  minWidth: 960,
  minHeight: 640,
  show: false,
  autoHideMenuBar: true,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  },
} as const satisfies Partial<BrowserWindowConstructorOptions>

/**
 * Resolve BrowserWindow options for the current platform. Windows keeps the
 * native frame with the Window Controls Overlay so the system caption buttons
 * stay visible; macOS uses hidden-inset traffic lights over a frameless,
 * transparent surface; every other platform (Linux) gets the standard system
 * title bar and caption buttons.
 * @param platform - process.platform at window creation.
 * @param title - window title shown in the native title bar.
 * @returns BrowserWindow options for that platform.
 */
export function createWindowOptions(platform: NodeJS.Platform, title: string): BrowserWindowConstructorOptions {
  if (platform === 'darwin') {
    return {
      ...SHARED_OPTIONS,
      title,
      frame: false,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      transparent: true,
      backgroundColor: '#00000000',
    }
  }
  if (platform === 'win32') {
    return {
      ...SHARED_OPTIONS,
      title,
      frame: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#7f858f',
        height: 44,
      },
      backgroundMaterial: 'acrylic',
      hasShadow: true,
      roundedCorners: true,
      thickFrame: true,
    }
  }
  return {
    ...SHARED_OPTIONS,
    title,
    frame: true,
  }
}
