/** Curated worker-pack metadata. Catalog listing is not a security review. */

/** Desktop-owned engineering default for new sessions that name no preset. */
export const DESKTOP_DEFAULT_AGENT_PRESET = 'code'

/** Built-in catalog key the worker pack can add when the user asks. */
export const WORKER_PACK_CATALOG_SOURCE_KEY = 'dsh-1024store'

/** One community plugin the worker pack can point the market at. */
export interface WorkerPackRecommendedPlugin {
  readonly packageName: string
  readonly displayName: string
  readonly role: 'workspace-shell' | 'workspace-context' | 'workspace-mobile' | 'office-dingtalk' | 'office-wecom'
  readonly repositoryUrl: string
}

/** Workspace plugins recommended for a Codex-like desktop workbench. */
export const WORKER_PACK_RECOMMENDED_PLUGINS: readonly WorkerPackRecommendedPlugin[] = Object.freeze([
  {
    packageName: 'dsh-better-sidebar',
    displayName: 'DSH-better-sidebar',
    role: 'workspace-shell',
    repositoryUrl: 'https://github.com/omdsh-dev/DSH-better-sidebar',
  },
  {
    packageName: 'dsh-context',
    displayName: 'dsh-context',
    role: 'workspace-context',
    repositoryUrl: 'https://github.com/bowenliang123/dsh-context',
  },
])

/**
 * Later, non-default recommendation for narrow screens.
 * Not part of the default workbench install path and never preinstalled.
 */
export const WORKBENCH_LATER_RECOMMENDED_PLUGINS: readonly WorkerPackRecommendedPlugin[] = Object.freeze([
  {
    packageName: 'dsh-web-mobile',
    displayName: 'dsh-web-mobile',
    role: 'workspace-mobile',
    repositoryUrl: 'https://github.com/mexiaosqwq/dsh-web-mobile',
  },
])

/**
 * Starting office-IM recommendations: official DingTalk Stream and WeCom AI Bot.
 * This is a curated list, not an install allowlist. Community channels stay
 * installable through the market and `dsh plugin add`.
 */
export const OFFICE_IM_RECOMMENDED_PLUGINS: readonly WorkerPackRecommendedPlugin[] = Object.freeze([
  {
    packageName: 'dsh-dingtalk-channel',
    displayName: 'dsh-dingtalk-channel',
    role: 'office-dingtalk',
    repositoryUrl: 'https://github.com/ttmouse/dsh-dingtalk-channel',
  },
  {
    packageName: 'dsh-wecom',
    displayName: 'dsh-wecom',
    role: 'office-wecom',
    repositoryUrl: 'https://github.com/TtTRz/dsh-wecom',
  },
])

/**
 * Overlay the desktop worker default onto an existing agent-presets config.
 * User settings still win at runtime through `agent-presets.default`.
 */
export function desktopAgentPresetConfig(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...existing,
    default: DESKTOP_DEFAULT_AGENT_PRESET,
  }
}

/**
 * Worker-pack recommendations never gate installation.
 * Official defaults stay opt-in; community packages remain installable.
 */
export function workerPackBlocksCommunityPackage(_packageName: string): false {
  return false
}

/** True when the recommended built-in catalog is the selected market source. */
export function workerPackCatalogSelected(
  sources: readonly { readonly enabled: boolean; readonly builtInProviderKey?: string }[],
): boolean {
  return sources.some(source => (
    source.builtInProviderKey === WORKER_PACK_CATALOG_SOURCE_KEY && source.enabled
  ))
}

/** Top-level Plugins tabs registered by the desktop client. */
export const DESKTOP_PLUGIN_SETTINGS_TAB_IDS = ['desktop-worker-pack', 'desktop-mcp'] as const

/** Workbench pages that share the Worker pack tab instead of adding more top tabs. */
export const DESKTOP_WORKBENCH_PAGE_IDS = ['pack', 'models', 'home', 'remote'] as const

/** User-initiated install groups on the Worker pack tab. */
export type WorkerPackInstallKind = 'workspace' | 'office-im' | 'later'

/** One profile inventory row the worker pack can match by npm name. */
export interface WorkerPackInstallationRef {
  readonly packageName?: string
  readonly receipt?: { readonly packageName: string }
}

/** Catalog row used to resolve a recommended npm name to a market item. */
export interface WorkerPackCatalogItemRef {
  readonly id: string
  readonly package?: { readonly name?: string }
}

/** Outcome of one user-initiated recommended install. */
export type WorkerPackInstallStatus = 'installed' | 'already' | 'missing' | 'failed'

export interface WorkerPackInstallResult {
  readonly packageName: string
  readonly status: WorkerPackInstallStatus
  readonly error?: string
}

const ALL_RECOMMENDED_PLUGINS: readonly WorkerPackRecommendedPlugin[] = Object.freeze([
  ...WORKER_PACK_RECOMMENDED_PLUGINS,
  ...WORKBENCH_LATER_RECOMMENDED_PLUGINS,
  ...OFFICE_IM_RECOMMENDED_PLUGINS,
])

/** Recommended plugins for one one-click button. Never a silent boot list. */
export function recommendedPluginsFor(
  kind: WorkerPackInstallKind,
): readonly WorkerPackRecommendedPlugin[] {
  if (kind === 'workspace') return WORKER_PACK_RECOMMENDED_PLUGINS
  if (kind === 'office-im') return OFFICE_IM_RECOMMENDED_PLUGINS
  return WORKBENCH_LATER_RECOMMENDED_PLUGINS
}

/** True only for the curated recommendation lists shown on the Worker pack tab. */
export function isWorkerPackRecommendedPackage(packageName: string): boolean {
  return ALL_RECOMMENDED_PLUGINS.some(plugin => plugin.packageName === packageName)
}

/** True when the active profile already has this recommended package. */
export function recommendedPackageInstalled(
  packageName: string,
  installations: readonly WorkerPackInstallationRef[],
): boolean {
  return installations.some(item => (
    item.packageName === packageName || item.receipt?.packageName === packageName
  ))
}

/** Exact npm-name match from a catalog page. Fuzzy hits are ignored. */
export function findCatalogItemForPackage(
  items: readonly WorkerPackCatalogItemRef[],
  packageName: string,
): WorkerPackCatalogItemRef | undefined {
  return items.find(item => item.package?.name === packageName)
}

/** Locale key for a finished one-click install. */
export function summarizeWorkerPackInstallResults(
  results: readonly WorkerPackInstallResult[],
): 'installRestart' | 'installPartial' | 'installMissing' | 'installError' {
  if (results.length === 0) return 'installError'
  const wrote = results.some(result => result.status === 'installed')
  const incomplete = results.some(result => result.status === 'missing' || result.status === 'failed')
  if (wrote && incomplete) return 'installPartial'
  if (wrote || results.every(result => result.status === 'already')) return 'installRestart'
  if (results.every(result => result.status === 'missing')) return 'installMissing'
  return 'installError'
}
