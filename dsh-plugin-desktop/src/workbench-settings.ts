/** Shared workbench settings. Host surfaces stay off until the user opts in. */

/** Settings document key owned by the desktop workbench host plugin. */
export const DESKTOP_WORKBENCH_SETTINGS_KEY = 'dsh-desktop-workbench'

/** Same-origin workbench HTTP prefix. Safe to import from the client bundle. */
export const WORKBENCH_API_PREFIX = '/api/desktop/workbench'

/** Official LLM adapter namespace written when a discovered local runtime is applied. */
export const LOCAL_MODEL_LLM_SETTINGS_KEY = 'llm-pi-ai'

/** Placeholder credential reference for keyless loopback OpenAI-compatible servers. */
export const LOCAL_MODEL_API_KEY_ENV = 'DSH_DESKTOP_LOCAL_MODEL_KEY'

/** Whether a supported local runtime may be started when it is not already listening. */
export interface DesktopLocalModelsSettings {
  /** When true the Host may spawn a supported runtime that is not running. */
  autoStart: boolean
}

/** Default-off private remote entrance. Trust is reachability, not authentication. */
export interface DesktopRemoteSettings {
  /** When false the control plane rejects remote callers and trustedHosts stay empty. */
  enabled: boolean
  /** Bare Tailscale or private host, optionally with a port. Empty until the user sets one. */
  trustedHost: string
}

/** Last data-home preview path. Apply still requires an explicit confirm token. */
export interface DesktopHomeMigrationSettings {
  /** Absolute source home from the last preview. Never switched automatically. */
  lastSource: string
}

/** User-authored workbench settings. Every Host action stays off by default. */
export interface DesktopWorkbenchSettings {
  localModels: DesktopLocalModelsSettings
  home: DesktopHomeMigrationSettings
  remote: DesktopRemoteSettings
}

/** Empty defaults: no auto-start, no last source, no remote entrance. */
export const DEFAULT_DESKTOP_WORKBENCH_SETTINGS: DesktopWorkbenchSettings = Object.freeze({
  localModels: Object.freeze({ autoStart: false }),
  home: Object.freeze({ lastSource: '' }),
  remote: Object.freeze({ enabled: false, trustedHost: '' }),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Accept a Tailscale Serve or private hostname, optionally with a port.
 * Rejects schemes, paths, wildcards, unspecified addresses, and loopback.
 */
export function parseTrustedHost(value: unknown): string {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string') throw new Error('remote trustedHost must be a string')
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  if (/[\s/\\?#@[\]]/u.test(trimmed) || trimmed.includes('://')) {
    throw new Error('remote trustedHost must be a bare host or host:port')
  }
  const host = trimmed.includes(':') ? trimmed.slice(0, trimmed.lastIndexOf(':')) : trimmed
  const portPart = trimmed.includes(':') ? trimmed.slice(trimmed.lastIndexOf(':') + 1) : ''
  if (host.length === 0) throw new Error('remote trustedHost must include a host')
  if (portPart.length > 0) {
    const port = Number(portPart)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('remote trustedHost port must be an integer from 1 through 65535')
    }
  }
  const normalized = host.toLowerCase()
  if (
    normalized === '*'
    || normalized === '0.0.0.0'
    || normalized === '::'
    || normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
  ) {
    throw new Error('remote trustedHost must be a private or Tailscale hostname, not loopback or unspecified')
  }
  return trimmed
}

/** Normalize local-model discovery settings. Auto-start stays off unless explicitly true. */
export function parseDesktopLocalModelsSettings(value: unknown): DesktopLocalModelsSettings {
  if (value === undefined) return { autoStart: false }
  if (!isRecord(value)) throw new Error('localModels settings must be a map')
  return { autoStart: value.autoStart === true }
}

/** Normalize home-migration memory. A path here is not a migrate-on-boot switch. */
export function parseDesktopHomeMigrationSettings(value: unknown): DesktopHomeMigrationSettings {
  if (value === undefined) return { lastSource: '' }
  if (!isRecord(value)) throw new Error('home settings must be a map')
  return { lastSource: typeof value.lastSource === 'string' ? value.lastSource : '' }
}

/** Normalize remote settings. Enabled with an empty host is rejected. */
export function parseDesktopRemoteSettings(value: unknown): DesktopRemoteSettings {
  if (value === undefined) return { enabled: false, trustedHost: '' }
  if (!isRecord(value)) throw new Error('remote settings must be a map')
  const enabled = value.enabled === true
  const trustedHost = parseTrustedHost(value.trustedHost)
  if (enabled && trustedHost.length === 0) {
    throw new Error('remote.enabled requires a trustedHost')
  }
  return { enabled, trustedHost }
}

/** Normalize the workbench settings document. Absent values stay disabled. */
export function parseDesktopWorkbenchSettings(value: unknown): DesktopWorkbenchSettings {
  if (value === undefined) return { ...DEFAULT_DESKTOP_WORKBENCH_SETTINGS }
  if (!isRecord(value)) throw new Error('workbench settings must be a map')
  return {
    localModels: parseDesktopLocalModelsSettings(value.localModels),
    home: parseDesktopHomeMigrationSettings(value.home),
    remote: parseDesktopRemoteSettings(value.remote),
  }
}

/** Trusted hosts projected into web-runtime only after an explicit enable. */
export function trustedHostsForWebRuntime(remote: DesktopRemoteSettings): string[] {
  if (!remote.enabled || remote.trustedHost.length === 0) return []
  return [remote.trustedHost]
}

/** True when the Host may accept a remote Origin or Host header. */
export function remoteEntranceEnabled(remote: DesktopRemoteSettings): boolean {
  return trustedHostsForWebRuntime(remote).length > 0
}
