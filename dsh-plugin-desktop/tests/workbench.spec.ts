import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  DESKTOP_WORKBENCH_SETTINGS_NAMESPACE,
  inject,
  name,
  WORKBENCH_API_PREFIX,
} from '../src/workbench.ts'
import { DESKTOP_WORKBENCH_SETTINGS_KEY } from '../src/workbench-settings.ts'

describe('desktop workbench host', () => {
  it('registers default-off settings and loopback-only routes', () => {
    const registerSettings = vi.fn(() => ({
      get: () => ({
        localModels: { autoStart: false },
        home: { lastSource: '' },
        remote: { enabled: false, trustedHost: '' },
      }),
    }))
    const registerRoute = vi.fn(() => () => {})
    apply({
      settings: { register: registerSettings },
      webServer: { host: '127.0.0.1', port: 43189, register: registerRoute },
      effect: (factory: () => () => void) => factory(),
      logger: { warn: vi.fn() },
    } as never)

    expect(name).toBe('desktop-workbench')
    expect(inject).toEqual(['settings', 'webServer'])
    expect(String(DESKTOP_WORKBENCH_SETTINGS_NAMESPACE)).toBe(DESKTOP_WORKBENCH_SETTINGS_KEY)
    expect(WORKBENCH_API_PREFIX).toBe('/api/desktop/workbench')
    expect(registerSettings).toHaveBeenCalledTimes(1)
    expect(registerRoute).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'prefix',
      path: WORKBENCH_API_PREFIX,
    }))
  })

  it('refuses to boot when the Web server is not loopback', () => {
    expect(() => apply({
      settings: { register: vi.fn() },
      webServer: { host: '0.0.0.0', port: 43189, register: vi.fn() },
      effect: vi.fn(),
    } as never)).toThrow('loopback')
  })

  it('does not add a first-party office IM channel', () => {
    const source = readFileSync(new URL('../src/workbench.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/dingtalk|wecom|wechat|feishu|lark/i)
  })
})
