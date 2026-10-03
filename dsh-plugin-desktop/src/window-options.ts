/** BrowserWindow construction for compatibility and advanced shells. */

import type { BrowserWindowConstructorOptions, NativeImage } from 'electron'
import type { DesktopPlatform, DesktopShellSpec } from './runtime.ts'
import {
  ADVANCED_MACOS_TRAFFIC_LIGHT_TOP,
  ADVANCED_WINDOWS_TITLEBAR_HEIGHT,
  DESKTOP_FRAME_HEIGHT,
  DESKTOP_FRAME_MACOS_TRAFFIC_LIGHT_TOP,
} from './window-chrome.ts'

/** Stable persistent storage isolated from every auxiliary/default session. */
export const DESKTOP_RENDERER_SESSION_PARTITION = 'persist:dsh-desktop-renderer'

function baseWindowOptions(
  spec: DesktopShellSpec,
  icon: NativeImage,
  platform: DesktopPlatform,
  preload: string,
): BrowserWindowConstructorOptions {
  return {
    title: platform === 'win32' ? spec.windowTitle : '',
    width: spec.width,
    height: spec.height,
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    show: false,
    backgroundColor: '#202124',
    icon,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: DESKTOP_RENDERER_SESSION_PARTITION,
    },
  }
}

/**
 * Build the independent Desktop frame around the official compatibility client.
 * @param spec - shell values resolved from the active Cordis row.
 * @param icon - validated application icon.
 * @param platform - current Electron platform.
 * @returns custom frame options on macOS/Windows and a native Linux fallback.
 */
export function compatibilityWindowOptions(
  spec: DesktopShellSpec,
  icon: NativeImage,
  platform: DesktopPlatform,
  preload: string,
): BrowserWindowConstructorOptions {
  if (spec.mode !== 'compatibility') {
    throw new Error(`dsh-plugin-desktop: unsupported compatibility window mode ${spec.mode}`)
  }
  if (platform === 'darwin' || platform === 'win32') {
    return customChromeWindowOptions(spec, icon, platform, preload, {
      titlebarHeight: DESKTOP_FRAME_HEIGHT,
      macosTrafficLightTop: DESKTOP_FRAME_MACOS_TRAFFIC_LIGHT_TOP,
    })
  }
  const options = baseWindowOptions(spec, icon, platform, preload)
  if (platform === 'linux') return options
  throw new Error('dsh-plugin-desktop: compatibility mode is unsupported on this platform')
}

/**
 * Build the native material window used by the desktop-owned advanced shell.
 * @param spec - shell values resolved from the active Cordis row.
 * @param icon - validated application icon.
 * @param platform - current Electron platform.
 * @returns platform-native glass and window-control options.
 */
export function advancedWindowOptions(
  spec: DesktopShellSpec,
  icon: NativeImage,
  platform: DesktopPlatform,
  preload: string,
): BrowserWindowConstructorOptions {
  if (spec.mode !== 'advanced') {
    throw new Error(`dsh-plugin-desktop: unsupported enhanced window mode ${spec.mode}`)
  }
  return customChromeWindowOptions(spec, icon, platform, preload, {
    titlebarHeight: ADVANCED_WINDOWS_TITLEBAR_HEIGHT,
    macosTrafficLightTop: ADVANCED_MACOS_TRAFFIC_LIGHT_TOP,
  })
}

/** Build the visible command-bar window used by extended mode. */
export function extendedWindowOptions(
  spec: DesktopShellSpec,
  icon: NativeImage,
  platform: DesktopPlatform,
  preload: string,
): BrowserWindowConstructorOptions {
  if (spec.mode !== 'extended') {
    throw new Error(`dsh-plugin-desktop: unsupported extended window mode ${spec.mode}`)
  }
  return customChromeWindowOptions(spec, icon, platform, preload, {
    titlebarHeight: DESKTOP_FRAME_HEIGHT,
    macosTrafficLightTop: DESKTOP_FRAME_MACOS_TRAFFIC_LIGHT_TOP,
  })
}

interface CustomChromeGeometry {
  readonly titlebarHeight: number
  readonly macosTrafficLightTop: number
}

function customChromeWindowOptions(
  spec: DesktopShellSpec,
  icon: NativeImage,
  platform: DesktopPlatform,
  preload: string,
  geometry: CustomChromeGeometry,
): BrowserWindowConstructorOptions {
  const options = baseWindowOptions(spec, icon, platform, preload)
  if (platform === 'darwin') {
    const custom: BrowserWindowConstructorOptions = {
      ...options,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: geometry.macosTrafficLightTop },
    }
    return spec.material === 'transparent'
      ? {
          ...custom,
          transparent: true,
          backgroundColor: '#00000000',
          vibrancy: 'sidebar',
          visualEffectState: 'followWindow',
        }
      : custom
  }
  if (platform === 'win32') {
    return {
      ...options,
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#7f858f',
        height: geometry.titlebarHeight,
      },
      hasShadow: true,
      roundedCorners: true,
      thickFrame: true,
    }
  }
  throw new Error('dsh-plugin-desktop: custom desktop shell modes are supported on macOS and Windows')
}

/**
 * Select the BrowserWindow options for the active presentation mode.
 * @param spec - active shell generation.
 * @param icon - validated application icon.
 * @param platform - current Electron platform.
 * @returns mode-specific BrowserWindow options.
 */
export function desktopWindowOptions(
  spec: DesktopShellSpec,
  icon: NativeImage,
  platform: DesktopPlatform,
  preload: string,
): BrowserWindowConstructorOptions {
  if (spec.mode === 'compatibility') return compatibilityWindowOptions(spec, icon, platform, preload)
  if (spec.mode === 'extended') return extendedWindowOptions(spec, icon, platform, preload)
  return advancedWindowOptions(spec, icon, platform, preload)
}
