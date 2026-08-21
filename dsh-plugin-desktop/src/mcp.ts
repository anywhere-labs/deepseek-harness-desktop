/** Desktop-owned official MCP client settings. No servers are mounted by default. */

import type { Context } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  createMcpClientConfig,
  DESKTOP_MCP_SETTINGS_KEY,
  MCP_SERVER_NAME_PATTERN,
  parseDesktopMcpSettings,
  type DesktopMcpServerSettings,
  type DesktopMcpSettings,
} from './mcp-settings.ts'

const stringRecord = z.dict(String).default({})

const DesktopMcpServerSettingsSchema: z<DesktopMcpServerSettings> = z.object({
  id: z.string().required(),
  enabled: z.boolean().default(false),
  serverName: z.string().required().pattern(MCP_SERVER_NAME_PATTERN),
  transport: z.union(['stdio', 'streamable-http'] as const).default('stdio'),
  command: z.string().default(''),
  args: z.array(String).default([]),
  env: stringRecord,
  cwd: z.string().default(''),
  url: z.string().default(''),
  headers: stringRecord,
})

const DesktopMcpSettingsSchema: z<DesktopMcpSettings> = z.object({
  servers: z.array(DesktopMcpServerSettingsSchema).default([]),
})

/** Stable Cordis plugin name. */
export const name = 'desktop-mcp'

/** Settings and the tool registry required before official MCP clients can mount. */
export const inject = ['settings', 'tools']

/** Settings namespace presented by the standard settings service. */
export const DESKTOP_MCP_SETTINGS_NAMESPACE = settingsNamespace(DESKTOP_MCP_SETTINGS_KEY)

/**
 * Register settings and mount one official MCP client per enabled server.
 * Startup failures stay isolated: a dead server must not brick the desktop Host.
 */
export function apply(ctx: Context): void {
  const scope = ctx.settings.register(
    DESKTOP_MCP_SETTINGS_NAMESPACE,
    DesktopMcpSettingsSchema,
    {
      applies: 'restart',
      validate: (value) => {
        parseDesktopMcpSettings(value)
      },
    },
  )
  const settings = parseDesktopMcpSettings(scope.get())
  for (const server of settings.servers) {
    if (!server.enabled) continue
    try {
      ctx.plugin(mcpClient, createMcpClientConfig(server))
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      process.stderr.write(
        `dsh-plugin-desktop/mcp: skipped server "${server.serverName}": ${detail}\n`,
      )
    }
  }
}
