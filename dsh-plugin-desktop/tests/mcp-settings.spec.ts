import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  DESKTOP_MCP_SETTINGS_NAMESPACE,
  inject,
  name,
} from '../src/mcp.ts'
import {
  createMcpClientConfig,
  DESKTOP_MCP_CLIENT_PACKAGE,
  DESKTOP_MCP_SERVER_TEMPLATES,
  desktopMcpServerFromTemplate,
  parseDesktopMcpSettings,
} from '../src/mcp-settings.ts'

describe('desktop MCP settings', () => {
  it('starts with no servers and no official GitHub token template', () => {
    expect(parseDesktopMcpSettings(undefined)).toEqual({ servers: [] })
    expect(DESKTOP_MCP_CLIENT_PACKAGE).toBe('@deepseek-ai/dsh-mcp-client')
    expect(DESKTOP_MCP_SERVER_TEMPLATES.map(template => template.id)).toEqual([
      'filesystem',
      'custom-stdio',
      'custom-http',
    ])
    expect(JSON.stringify(DESKTOP_MCP_SERVER_TEMPLATES)).not.toMatch(/github|token|ghp_/i)
  })

  it('maps an enabled stdio server onto the official client', () => {
    const server = {
      ...desktopMcpServerFromTemplate(DESKTOP_MCP_SERVER_TEMPLATES[0]!, 'fs-1'),
      enabled: true,
      cwd: '/workspace',
    }
    expect(createMcpClientConfig(server)).toEqual({
      transport: 'stdio',
      serverName: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      env: {},
      cwd: '/workspace',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    })
  })

  it('rejects duplicate namespaces and enabled servers that cannot start', () => {
    expect(() => parseDesktopMcpSettings({
      servers: [
        { id: 'a', serverName: 'one', transport: 'stdio', command: 'npx', enabled: true },
        { id: 'b', serverName: 'one', transport: 'stdio', command: 'npx', enabled: false },
      ],
    })).toThrow('duplicate MCP serverName')
    expect(() => parseDesktopMcpSettings({
      servers: [{ id: 'a', serverName: 'broken', transport: 'stdio', enabled: true }],
    })).toThrow('needs a stdio command')
    expect(() => parseDesktopMcpSettings({
      servers: [{
        id: 'a',
        serverName: 'broken',
        transport: 'streamable-http',
        url: 'ftp://example.invalid',
        enabled: true,
      }],
    })).toThrow('http or https')
  })

  it('registers settings and mounts only enabled official clients', () => {
    const plugin = vi.fn()
    const register = vi.fn(() => ({
      get: () => ({
        servers: [
          {
            id: 'off',
            enabled: false,
            serverName: 'sleeping',
            transport: 'stdio',
            command: 'npx',
            args: [],
            env: {},
            cwd: '',
            url: '',
            headers: {},
          },
          {
            id: 'on',
            enabled: true,
            serverName: 'docs',
            transport: 'streamable-http',
            command: '',
            args: [],
            env: {},
            cwd: '',
            url: 'https://example.invalid/mcp',
            headers: { Authorization: 'Bearer user-supplied' },
          },
        ],
      }),
    }))

    expect(name).toBe('desktop-mcp')
    expect(inject).toEqual(['settings', 'tools'])
    expect(String(DESKTOP_MCP_SETTINGS_NAMESPACE)).toBe('dsh-desktop-mcp')
    apply({ settings: { register }, plugin } as never)

    expect(register).toHaveBeenCalledTimes(1)
    expect(plugin).toHaveBeenCalledTimes(1)
    expect(plugin.mock.calls[0]?.[1]).toEqual({
      transport: 'streamable-http',
      serverName: 'docs',
      url: 'https://example.invalid/mcp',
      headers: { Authorization: 'Bearer user-supplied' },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    })
  })
})
