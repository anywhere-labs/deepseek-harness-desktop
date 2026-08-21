/** Curated worker-pack metadata. Catalog listing is not a security review. */

/** Desktop-owned engineering default for new sessions that name no preset. */
export const DESKTOP_DEFAULT_AGENT_PRESET = 'code'

/** Built-in catalog key the worker pack can add when the user asks. */
export const WORKER_PACK_CATALOG_SOURCE_KEY = 'dsh-1024store'

/** One community plugin the worker pack can point the market at. */
export interface WorkerPackRecommendedPlugin {
  readonly packageName: string
  readonly displayName: string
  readonly role: 'workspace-shell' | 'workspace-context' | 'office-dingtalk' | 'office-wecom'
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
