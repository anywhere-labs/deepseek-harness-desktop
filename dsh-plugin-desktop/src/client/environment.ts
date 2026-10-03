/** Desktop renderer modes accepted from the Electron-owned page URL. */
export type DesktopClientMode = 'compatibility' | 'extended' | 'advanced'

/** Host platforms whose native chrome has a desktop presentation. */
export type DesktopClientPlatform = 'darwin' | 'win32' | 'linux'

/** Native material selected for the current renderer generation. */
export type DesktopClientMaterial = 'off' | 'transparent'

/** Validated renderer environment supplied by the Electron Host. */
export interface DesktopClientEnvironment {
  /** Installed Desktop product version supplied by the Electron Host. */
  version: string
  /** Active shell mode for this BrowserWindow lifetime. */
  mode: DesktopClientMode
  /** Electron Host platform used for native spacing and drag regions. */
  platform: DesktopClientPlatform
  /** Capability-gated native material active behind this renderer. */
  material: DesktopClientMaterial
}

const MODES = new Set<DesktopClientMode>(['compatibility', 'extended', 'advanced'])
const PLATFORMS = new Set<DesktopClientPlatform>(['darwin', 'win32', 'linux'])
const MATERIAL_MARKERS = new Set(['off', 'transparent', 'acrylic', 'mica'])
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

/**
 * Validate the Electron-owned query marker before any desktop client effects run.
 * @param search - URL search string, including or omitting the leading question mark.
 * @returns the validated desktop renderer environment, or undefined outside the desktop shell.
 */
export function parseDesktopClientEnvironment(search: string): DesktopClientEnvironment | undefined {
  const params = new URLSearchParams(search)
  const mode = params.get('dsh-desktop-mode')
  const platform = params.get('dsh-desktop-platform')
  const materialMarker = params.get('dsh-desktop-material')
  const version = params.get('dsh-desktop-version')
  if (mode === null && platform === null) return undefined
  if (!MODES.has(mode as DesktopClientMode)) {
    throw new Error(`dsh-plugin-desktop: invalid or missing dsh-desktop-mode ${JSON.stringify(mode)}`)
  }
  if (!PLATFORMS.has(platform as DesktopClientPlatform)) {
    throw new Error(`dsh-plugin-desktop: invalid or missing dsh-desktop-platform ${JSON.stringify(platform)}`)
  }
  if (!MATERIAL_MARKERS.has(materialMarker ?? '')) {
    throw new Error(`dsh-plugin-desktop: invalid or missing dsh-desktop-material ${JSON.stringify(materialMarker)}`)
  }
  // Accept old Host markers without reintroducing Acrylic or Mica as an
  // effective client capability. They are rendered as the safe opaque material,
  // and an old Host's dsh-desktop-mica capability marker is ignored.
  const material: DesktopClientMaterial = materialMarker === 'acrylic' || materialMarker === 'mica'
    ? 'off'
    : materialMarker as DesktopClientMaterial
  if (version === null || version.length > 64 || !VERSION_PATTERN.test(version)) {
    throw new Error(`dsh-plugin-desktop: invalid or missing dsh-desktop-version ${JSON.stringify(version)}`)
  }
  if ((platform === 'darwin' && materialMarker !== 'off' && materialMarker !== 'transparent')
    || (platform === 'win32' && materialMarker === 'transparent')
    // Only Windows Hosts ever emitted Mica, so it stays malformed on Linux.
    || (platform === 'linux' && (material !== 'off' || materialMarker === 'mica'))) {
    throw new Error('dsh-plugin-desktop: renderer material is incompatible with its mode or platform')
  }
  return {
    version,
    mode: mode as DesktopClientMode,
    platform: platform as DesktopClientPlatform,
    material,
  }
}
