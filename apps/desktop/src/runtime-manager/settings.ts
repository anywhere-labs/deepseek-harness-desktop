/** Desktop-owned settings: runtime selection lives in Desktop data, never in DSH data. */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DesktopSettings {
  /**
   * Globally pinned runtime version (npm version of @deepseek-ai/dsh).
   * Absent = the bundled default.
   */
  pinnedRuntime?: string
  /** Per-workspace pins, keyed by the host cwd passed at spawn time. */
  pinnedByWorkspace?: Record<string, string>
  /** Last workspace directory the shell was launched for. */
  lastWorkspace?: string
}

export function defaultSettings(): DesktopSettings {
  return {}
}

export function loadSettings(userDataDir: string): DesktopSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(userDataDir), 'utf8')) as DesktopSettings
    return { ...defaultSettings(), ...parsed }
  } catch {
    return defaultSettings()
  }
}

export function saveSettings(userDataDir: string, settings: DesktopSettings): void {
  writeFileSync(settingsPath(userDataDir), `${JSON.stringify(settings, null, 2)}\n`)
}

export function settingsPath(userDataDir: string): string {
  return join(userDataDir, 'desktop-settings.json')
}

export function pinRuntime(settings: DesktopSettings, version: string | undefined): DesktopSettings {
  if (version === undefined) {
    const { pinnedRuntime: _dropped, ...rest } = settings
    return rest
  }
  return { ...settings, pinnedRuntime: version }
}

export function pinRuntimeForWorkspace(settings: DesktopSettings, workspace: string, version: string | undefined): DesktopSettings {
  const pinnedByWorkspace = { ...(settings.pinnedByWorkspace ?? {}) }
  if (version === undefined) delete pinnedByWorkspace[workspace]
  else pinnedByWorkspace[workspace] = version
  return { ...settings, pinnedByWorkspace }
}

/** Resolve the effective pin for a workspace: workspace pin wins, then global pin. */
export function resolvePinnedRuntime(settings: DesktopSettings, workspace: string): string | undefined {
  return settings.pinnedByWorkspace?.[workspace] ?? settings.pinnedRuntime
}
