/** Shared MCP settings types. The official client is mounted one server at a time. */

/** Settings document key owned by the desktop MCP host plugin. */
export const DESKTOP_MCP_SETTINGS_KEY = 'dsh-desktop-mcp'

/** Official Cordis package mounted once per enabled server. */
export const DESKTOP_MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** Valid `serverName` used in public tool names `mcp__<serverName>__<rawName>`. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** One saved MCP server. Unused transport fields stay empty strings. */
export interface DesktopMcpServerSettings {
  /** Stable local id; never sent to the MCP server. */
  id: string
  /** When false the host skips mounting this server. */
  enabled: boolean
  /** Unique namespace for this server's model-facing tool names. */
  serverName: string
  /** Official client transport. */
  transport: 'stdio' | 'streamable-http'
  /** Executable for stdio servers. */
  command: string
  /** Arguments passed without shell interpolation. */
  args: string[]
  /** Extra env merged onto a scrubbed ambient environment. */
  env: Record<string, string>
  /** Working directory for a stdio child; empty uses the Host cwd. */
  cwd: string
  /** Streamable HTTP endpoint. */
  url: string
  /** Extra headers for Streamable HTTP. */
  headers: Record<string, string>
}

/** User-authored MCP server list. Empty by default — no tokens or child processes. */
export interface DesktopMcpSettings {
  servers: DesktopMcpServerSettings[]
}

/** Recommended templates. None are enabled until the user adds them. */
export interface DesktopMcpServerTemplate {
  readonly id: string
  readonly serverName: string
  readonly transport: DesktopMcpServerSettings['transport']
  readonly command: string
  readonly args: readonly string[]
  readonly url: string
}

export const DESKTOP_MCP_SERVER_TEMPLATES: readonly DesktopMcpServerTemplate[] = Object.freeze([
  {
    id: 'filesystem',
    serverName: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: Object.freeze(['-y', '@modelcontextprotocol/server-filesystem', '.']),
    url: '',
  },
  {
    id: 'custom-stdio',
    serverName: 'custom',
    transport: 'stdio',
    command: '',
    args: Object.freeze([]),
    url: '',
  },
  {
    id: 'custom-http',
    serverName: 'remote',
    transport: 'streamable-http',
    command: '',
    args: Object.freeze([]),
    url: '',
  },
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${label} must be a string map`)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`${label}.${key} must be a string`)
    result[key] = entry
  }
  return result
}

function readStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string list`)
  }
  return [...value]
}

/** Normalize one saved server and reject values the official client cannot mount. */
export function parseDesktopMcpServerSettings(value: unknown): DesktopMcpServerSettings {
  if (!isRecord(value)) throw new Error('MCP server must be an object')
  const id = value.id
  const serverName = value.serverName
  if (typeof id !== 'string' || id.length === 0) throw new Error('MCP server id must be a non-empty string')
  if (typeof serverName !== 'string' || !MCP_SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`MCP serverName "${String(serverName)}" must match ${String(MCP_SERVER_NAME_PATTERN)}`)
  }
  const transport = value.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const enabled = value.enabled === true
  const command = typeof value.command === 'string' ? value.command : ''
  const url = typeof value.url === 'string' ? value.url : ''
  if (enabled && transport === 'stdio' && command.trim() === '') {
    throw new Error(`MCP server "${serverName}" needs a stdio command`)
  }
  if (enabled && transport === 'streamable-http') {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`MCP server "${serverName}" needs an http(s) url`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`MCP server "${serverName}" url must use http or https`)
    }
  }
  return {
    id,
    enabled,
    serverName,
    transport,
    command,
    args: readStringArray(value.args, `MCP server "${serverName}" args`),
    env: readStringRecord(value.env, `MCP server "${serverName}" env`),
    cwd: typeof value.cwd === 'string' ? value.cwd : '',
    url,
    headers: readStringRecord(value.headers, `MCP server "${serverName}" headers`),
  }
}

/** Normalize the settings document and reject duplicate server namespaces. */
export function parseDesktopMcpSettings(value: unknown): DesktopMcpSettings {
  if (value === undefined) return { servers: [] }
  if (!isRecord(value)) throw new Error('MCP settings must be a map')
  const rawServers = value.servers
  if (rawServers === undefined) return { servers: [] }
  if (!Array.isArray(rawServers)) throw new Error('MCP servers must be a list')
  const servers = rawServers.map(entry => parseDesktopMcpServerSettings(entry))
  const names = new Set<string>()
  const ids = new Set<string>()
  for (const server of servers) {
    if (ids.has(server.id)) throw new Error(`duplicate MCP server id "${server.id}"`)
    if (names.has(server.serverName)) {
      throw new Error(`duplicate MCP serverName "${server.serverName}"`)
    }
    ids.add(server.id)
    names.add(server.serverName)
  }
  return { servers }
}

/** Default per-tool timeout used by the official MCP client. */
export const DESKTOP_MCP_TOOL_CALL_TIMEOUT_MS = 60_000

/** Config accepted by `@deepseek-ai/dsh-mcp-client`. */
export type DesktopMcpClientConfig = {
  readonly transport: 'stdio'
  readonly serverName: string
  readonly command: string
  readonly args: string[]
  readonly env: Record<string, string>
  readonly cwd: string
  readonly toolCallTimeoutMs: number
  readonly failOnStartupError: false
} | {
  readonly transport: 'streamable-http'
  readonly serverName: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly toolCallTimeoutMs: number
  readonly failOnStartupError: false
}

/** Map one enabled settings row onto the official MCP client. */
export function createMcpClientConfig(server: DesktopMcpServerSettings): DesktopMcpClientConfig {
  const parsed = parseDesktopMcpServerSettings(server)
  if (!parsed.enabled) throw new Error(`MCP server "${parsed.serverName}" is disabled`)
  if (parsed.transport === 'streamable-http') {
    return {
      transport: 'streamable-http',
      serverName: parsed.serverName,
      url: parsed.url,
      headers: parsed.headers,
      toolCallTimeoutMs: DESKTOP_MCP_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: false,
    }
  }
  return {
    transport: 'stdio',
    serverName: parsed.serverName,
    command: parsed.command,
    args: parsed.args,
    env: parsed.env,
    cwd: parsed.cwd,
    toolCallTimeoutMs: DESKTOP_MCP_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: false,
  }
}

/** Build a disabled settings row from a recommended template. */
export function desktopMcpServerFromTemplate(
  template: DesktopMcpServerTemplate,
  id: string,
): DesktopMcpServerSettings {
  return {
    id,
    enabled: false,
    serverName: template.serverName,
    transport: template.transport,
    command: template.command,
    args: [...template.args],
    env: {},
    cwd: '',
    url: template.url,
    headers: {},
  }
}
