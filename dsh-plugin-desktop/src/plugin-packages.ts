/** The official `pluginPackages` service for Hosts whose imports use Desktop's Profile resolver. */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { PluginPackages, type PluginPackage } from '@deepseek-ai/dsh-app-boot'
import { refreshProfilePackageSelections, selectProfilePackage } from './module-resolution.ts'

/**
 * The official member Desktop specializes. Stable's pinned service predates `refresh()`,
 * so one shared source declares that method below instead of overriding it.
 */
interface OfficialPluginPackages {
  packageOf(specifier: string, parentURL: string): PluginPackage | undefined
}
const OfficialPluginPackages: new (ctx: Context) => OfficialPluginPackages = PluginPackages

/**
 * Package lookup for official consumers such as the plugin manager, plugin inventory and typert loader.
 * It installs no official runtime interception: Desktop's Profile resolver remains the only resolver,
 * and the inherited official `metaOf()` reads locale files and icons through it.
 */
export class DesktopPluginPackages extends OfficialPluginPackages {
  /**
   * Answer a Profile-boundary request with the package Desktop's resolver loads, never a stale copy
   * above the Profile; other parents keep the official Node lookup.
   */
  override packageOf(specifier: string, parentURL: string): PluginPackage | undefined {
    const selected = selectProfilePackage(specifier, parentURL)
    if (selected === undefined) return super.packageOf(specifier, parentURL)
    if (selected === null) return undefined
    const manifest = JSON.parse(readFileSync(selected.manifestPath, 'utf8')) as Record<string, unknown>
    return {
      name: selected.packageName,
      version: typeof manifest.version === 'string' ? manifest.version : undefined,
      dir: selected.packageDir,
      manifestPath: selected.manifestPath,
      manifest,
    }
  }

  /** Called by the official plugin manager after package operations, before its HMR reload. */
  async refresh(): Promise<void> {
    refreshProfilePackageSelections()
  }
}
