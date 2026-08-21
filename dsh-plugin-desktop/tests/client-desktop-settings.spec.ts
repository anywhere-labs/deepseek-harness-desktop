import { describe, expect, it, vi } from 'vitest'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { DesktopSettingsSection } from '../src/client/DesktopSettingsSection.tsx'
import { DesktopTerminalSettingsAction } from '../src/client/DesktopTerminalSettingsAction.tsx'
import {
  createDesktopSettingsApi,
  desktopSettingsPaths,
  parseDesktopActionAcceptance,
  parseDesktopRestartAcceptance,
  parseDesktopSettingsView,
  type DesktopSettingsView,
} from '../src/client/desktop-settings-api.ts'
import {
  applyDesktopSettings,
  DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE,
  DESKTOP_SETTINGS_LOCALE_NAMESPACE,
  DESKTOP_SHELL_SETTINGS_NAMESPACE,
} from '../src/client/desktop-settings.ts'

const VIEW: DesktopSettingsView = {
  current: 'desktop',
  profiles: [
    { name: 'desktop', exists: true, webCapable: true, selectable: true, deletable: false },
    { name: 'headless', exists: true, webCapable: false, selectable: false, deletable: false },
    { name: 'work', exists: true, webCapable: true, selectable: true, deletable: true },
  ],
  market: { requested: 'disabled', effective: 'disabled', legacyDefaulted: true },
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Desktop settings API', () => {
  it('validates the bounded launcher projection', () => {
    expect(parseDesktopSettingsView(VIEW)).toEqual(VIEW)
    expect(() => parseDesktopSettingsView({ ...VIEW, profiles: [...VIEW.profiles, VIEW.profiles[0]] }))
      .toThrow('duplicate profile')
    expect(() => parseDesktopSettingsView({ ...VIEW, market: { ...VIEW.market, requested: 'unknown' } }))
      .toThrow('invalid Desktop settings response')
    expect(parseDesktopRestartAcceptance({ accepted: true, restartRequired: true }))
      .toEqual({ accepted: true, restartRequired: true })
    expect(parseDesktopRestartAcceptance({ accepted: true, restartRequired: false }))
      .toEqual({ accepted: true, restartRequired: false })
    expect(() => parseDesktopRestartAcceptance({ accepted: true })).toThrow('invalid Desktop restart response')
    expect(parseDesktopActionAcceptance({ accepted: true })).toBeUndefined()
    expect(() => parseDesktopActionAcceptance({ accepted: true, detail: 'extra' }))
      .toThrow('invalid Desktop action response')
  })

  it('uses the strict same-origin routes and request bodies', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input)
      if (path === desktopSettingsPaths.terminalOpen) return json({ accepted: true })
      return path === desktopSettingsPaths.settings || path === desktopSettingsPaths.profileCreate || path === desktopSettingsPaths.profileDelete
        ? json(VIEW)
        : json({ accepted: true, restartRequired: true })
    })
    const api = createDesktopSettingsApi(fetcher)

    await expect(api.read()).resolves.toEqual(VIEW)
    await expect(api.createProfile('work')).resolves.toEqual(VIEW)
    await expect(api.selectProfile('work')).resolves.toEqual({ accepted: true, restartRequired: true })
    await expect(api.deleteProfile('work')).resolves.toEqual(VIEW)
    await expect(api.selectMarket('community-market')).resolves.toEqual({ accepted: true, restartRequired: true })
    await expect(api.openTerminal()).resolves.toBeUndefined()

    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      desktopSettingsPaths.settings,
      desktopSettingsPaths.profileCreate,
      desktopSettingsPaths.profileSelect,
      desktopSettingsPaths.profileDelete,
      desktopSettingsPaths.marketSelect,
      desktopSettingsPaths.terminalOpen,
    ])
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      body: JSON.stringify({ name: 'work' }),
    })
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({
      body: JSON.stringify({ name: 'work' }),
    })
    expect(fetcher.mock.calls[4]?.[1]).toMatchObject({
      body: JSON.stringify({ provider: 'community-market' }),
    })
    expect(fetcher.mock.calls[5]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({}),
    })
  })

  it('does not reflect an untrusted error body into its public error', async () => {
    const api = createDesktopSettingsApi(async () => json({ error: '/Users/private/profile failed' }, 400))
    await expect(api.read()).rejects.toThrow('Desktop settings request failed (400)')
    await expect(api.read()).rejects.not.toThrow('/Users/private')
  })
})

describe('Desktop settings Slot registration', () => {
  it('registers the official Desktop section, terminal action, and both settings scopes', () => {
    const scope = {
      getSnapshot: () => ({
        status: 'loading' as const,
        value: undefined,
        base: undefined,
        user: undefined,
        revision: undefined,
        writable: false,
        mode: 'host' as const,
      }),
      subscribe: () => () => {},
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    } satisfies SettingsScope<unknown>
    const bind = vi.fn(() => scope)
    const register = vi.fn(() => () => {})
    const inject = vi.fn((_name: string, mount: () => unknown) => mount())
    const localeRegister = vi.fn(() => () => {})
    const ctx = {
      settingsScope: { bind },
      locale: {
        bind: (namespace: string) => (key: string) => `${namespace}:${key}`,
        register: localeRegister,
      },
      effect: vi.fn(),
      slots: { inject, register },
    } as unknown as ClientContext

    applyDesktopSettings(ctx, { mode: 'compatibility', platform: 'darwin' })

    expect(bind).toHaveBeenNthCalledWith(1, { namespace: DESKTOP_SHELL_SETTINGS_NAMESPACE })
    expect(bind).toHaveBeenNthCalledWith(2, { namespace: DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE })
    expect(inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    expect(inject).toHaveBeenCalledWith('settings.action', expect.any(Function))
    const [options, component] = register.mock.calls[0] as unknown as [
      { id: string; order: number; locale: string; label: () => string; inject: () => Record<string, unknown> },
      unknown,
    ]
    expect(options).toMatchObject({
      name: 'settings.section',
      id: 'desktop',
      order: 100,
      locale: DESKTOP_SETTINGS_LOCALE_NAMESPACE,
    })
    expect(options.label()).toBe(`${DESKTOP_SETTINGS_LOCALE_NAMESPACE}:nav`)
    expect(options.inject()).toMatchObject({ platform: 'darwin', initialMode: 'compatibility' })
    expect(component).toBe(DesktopSettingsSection)

    const [actionOptions, actionComponent] = register.mock.calls[1] as unknown as [
      { id: string; order: number; locale: string; inject: () => Record<string, unknown> },
      unknown,
    ]
    expect(actionOptions).toMatchObject({
      name: 'settings.action',
      id: 'open-desktop-terminal',
      order: 1,
      locale: DESKTOP_SETTINGS_LOCALE_NAMESPACE,
    })
    expect(actionOptions.inject()).toHaveProperty('api')
    expect(actionComponent).toBe(DesktopTerminalSettingsAction)
  })
})
