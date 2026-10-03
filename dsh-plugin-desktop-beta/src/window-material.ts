/** Cross-platform window-material preferences. */

import type { DesktopPlatform, DesktopShellMode } from './runtime.ts'

export type MacosWindowMaterial = 'off' | 'transparent'
/** Windows no longer offers a selectable material; windows are always opaque. */
export type WindowsWindowMaterial = 'off'
/** Electron-native window transparency used by Linux generations. */
export type LinuxWindowMaterial = 'off' | 'transparent'
/** Persisted compatibility values accepted only so pre-removal settings still boot. */
export type PersistedWindowsWindowMaterial = WindowsWindowMaterial | 'acrylic' | 'mica'
export type DesktopWindowMaterial = MacosWindowMaterial | WindowsWindowMaterial | LinuxWindowMaterial

export const DEFAULT_MACOS_WINDOW_MATERIAL: MacosWindowMaterial = 'transparent'
export const DEFAULT_WINDOWS_WINDOW_MATERIAL: WindowsWindowMaterial = 'off'
export const DEFAULT_LINUX_WINDOW_MATERIAL: LinuxWindowMaterial = 'off'

export function parseMacosWindowMaterial(value: unknown): MacosWindowMaterial {
  if (value === undefined) return DEFAULT_MACOS_WINDOW_MATERIAL
  if (value === 'off' || value === 'transparent') return value
  throw new Error('dsh-desktop.macosMaterial must be "off" or "transparent"')
}

export function parseWindowsWindowMaterial(value: unknown): WindowsWindowMaterial {
  if (value === undefined) return DEFAULT_WINDOWS_WINDOW_MATERIAL
  if (value === 'off') return value
  // Acrylic and Mica were removed because the Windows backdrops can break
  // native window behavior. Keep the legacy values readable and fail closed
  // to an ordinary opaque window.
  if (value === 'acrylic' || value === 'mica') return 'off'
  throw new Error('dsh-desktop.windowsMaterial must be "off"')
}

export function parseLinuxWindowMaterial(value: unknown): LinuxWindowMaterial {
  if (value === undefined) return DEFAULT_LINUX_WINDOW_MATERIAL
  // The upstream compatibility client paints an opaque background, so a
  // transparent window frame stays invisible; fail closed to the solid
  // frame until the client learns to render behind transparency.
  if (value === 'off' || value === 'transparent') return 'off'
  throw new Error('dsh-desktop.linuxMaterial must be "off" or "transparent"')
}

/** Resolve the actual generation material without making settings non-portable. */
export function effectiveDesktopWindowMaterial(
  mode: DesktopShellMode,
  platform: DesktopPlatform,
  macosMaterial: MacosWindowMaterial,
  linuxMaterial: LinuxWindowMaterial = DEFAULT_LINUX_WINDOW_MATERIAL,
): DesktopWindowMaterial {
  // Material now applies to every presentation. Keep mode in the resolver
  // signature so callers cannot accidentally bypass shell context.
  void mode
  if (platform === 'linux') return linuxMaterial
  if (platform === 'darwin') return macosMaterial
  // Windows has no selectable material; any persisted legacy value is opaque.
  return 'off'
}
