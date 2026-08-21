import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  parseDesktopRemoteSettings,
  parseDesktopWorkbenchSettings,
  parseTrustedHost,
  remoteEntranceEnabled,
  trustedHostsForWebRuntime,
} from '../src/workbench-settings.ts'

describe('desktop workbench settings', () => {
  it('keeps shared workbench helpers off the client schemastery import graph', () => {
    expect(readFileSync(new URL('../src/workbench-settings.ts', import.meta.url), 'utf8'))
      .not.toMatch(/schemastery/)
  })

  it('starts every Host surface disabled and secret-free', () => {
    expect(parseDesktopWorkbenchSettings(undefined)).toEqual({
      localModels: { autoStart: false },
      home: { lastSource: '' },
      remote: { enabled: false, trustedHost: '' },
    })
    expect(JSON.stringify(parseDesktopWorkbenchSettings(undefined))).not.toMatch(/token|secret|ghp_/i)
  })

  it('accepts a Tailscale hostname and rejects loopback or scheme-bearing values', () => {
    expect(parseTrustedHost('ai-buddy.tailnet.ts.net')).toBe('ai-buddy.tailnet.ts.net')
    expect(parseTrustedHost('ai-buddy.tailnet.ts.net:443')).toBe('ai-buddy.tailnet.ts.net:443')
    expect(() => parseTrustedHost('https://ai-buddy.tailnet.ts.net')).toThrow('bare host')
    expect(() => parseTrustedHost('127.0.0.1')).toThrow('loopback')
    expect(() => parseTrustedHost('0.0.0.0')).toThrow('unspecified')
    expect(() => parseTrustedHost('*')).toThrow('unspecified')
  })

  it('projects trustedHosts only after an explicit enable', () => {
    expect(trustedHostsForWebRuntime({ enabled: false, trustedHost: 'ai-buddy.tailnet.ts.net' })).toEqual([])
    expect(trustedHostsForWebRuntime({ enabled: true, trustedHost: 'ai-buddy.tailnet.ts.net' }))
      .toEqual(['ai-buddy.tailnet.ts.net'])
    expect(remoteEntranceEnabled({ enabled: false, trustedHost: '' })).toBe(false)
    expect(() => parseDesktopRemoteSettings({ enabled: true, trustedHost: '' })).toThrow('trustedHost')
  })
})
