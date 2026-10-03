/** Match the existing Desktop's native materials. Windows always renders an opaque window. */
import type { DesktopPreferences } from './desktop-contract.ts'
export function windowMaterial(preferences: DesktopPreferences, platform = process.platform): 'off' | 'transparent' {
  if (platform === 'darwin') return preferences.macosMaterial
  return 'off'
}
