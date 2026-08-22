/** Desktop renderer modes accepted from the Electron-owned page URL. */
export type DesktopClientMode = 'compatibility' | 'advanced'

/** Host platforms whose native chrome has a desktop presentation. */
export type DesktopClientPlatform = 'darwin' | 'win32' | 'linux'

/** Validated renderer environment supplied by the Electron Host. */
export interface DesktopClientEnvironment {
  /** Active shell mode for this BrowserWindow lifetime. */
  mode: DesktopClientMode
  /** Electron Host platform used for native spacing and drag regions. */
  platform: DesktopClientPlatform
  /**
   * Bundles that failed to load and were left degraded; empty in a healthy
   * run. The parser always populates this from the `dsh-degraded` marker, so
   * consumers may read it directly; it stays optional so hand-built
   * environments (tests, fixtures) need not carry it.
   */
  degradedBundles?: readonly string[]
}

const MODES = new Set<DesktopClientMode>(['compatibility', 'advanced'])
const PLATFORMS = new Set<DesktopClientPlatform>(['darwin', 'win32', 'linux'])

/**
 * Parse the comma-separated degraded bundle marker. Package names cannot
 * contain commas, so each non-empty piece is a valid bundle; whitespace and
 * stray separators are dropped rather than failing the whole environment.
 * @param raw - decoded marker value from the Electron-owned page URL.
 * @returns the validated degraded bundles (empty when absent or malformed).
 */
function parseDegradedBundles(raw: string | null): readonly string[] {
  if (raw === null) return []
  return raw.split(',').map(piece => piece.trim()).filter(piece => piece.length > 0)
}

/**
 * Validate the Electron-owned query marker before any desktop client effects run.
 * @param search - URL search string, including or omitting the leading question mark.
 * @returns the validated desktop renderer environment, or undefined outside the desktop shell.
 */
export function parseDesktopClientEnvironment(search: string): DesktopClientEnvironment | undefined {
  const params = new URLSearchParams(search)
  const mode = params.get('dsh-desktop-mode')
  const platform = params.get('dsh-desktop-platform')
  if (mode === null && platform === null) return undefined
  if (!MODES.has(mode as DesktopClientMode)) {
    throw new Error(`dsh-plugin-desktop: invalid or missing dsh-desktop-mode ${JSON.stringify(mode)}`)
  }
  if (!PLATFORMS.has(platform as DesktopClientPlatform)) {
    throw new Error(`dsh-plugin-desktop: invalid or missing dsh-desktop-platform ${JSON.stringify(platform)}`)
  }
  return {
    mode: mode as DesktopClientMode,
    platform: platform as DesktopClientPlatform,
    degradedBundles: parseDegradedBundles(params.get('dsh-degraded')),
  }
}
