// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopSettingsSection, type DesktopSettingsSectionProps } from '../src/client/DesktopSettingsSection.tsx'
import { zh } from '../src/client/desktop-settings-locales.ts'

let root: Root | undefined
let container: HTMLDivElement | undefined

function scope(value: unknown) {
  const snapshot = { status: 'ready', writable: true, value }
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}

async function mount(selectAa: (enabled: boolean) => Promise<{ accepted: true; restartRequired: boolean }>, aa = { requested: false, effective: false }) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const props = {
    t: (key: keyof typeof zh) => zh[key],
    api: {
      read: async () => ({ current: 'desktop', profiles: [],
        aa,
        market: { requested: 'disabled', effective: 'disabled', legacyDefaulted: false },
        web: { localUrl: '', lanUrls: [], lanState: 'inactive', lanError: null, lanCaFingerprint: null, lanCaUrls: [] },
      }), selectAa,
    },
    platform: 'darwin', version: '2.0.3', initialMode: 'compatibility', setMode: async () => {},
    desktopSettings: scope({ mode: 'compatibility', openBrowser: false, networkExposure: 'loopback', macosMaterial: 'off', windowsMaterial: 'off' }),
    notificationSettings: scope({ enabled: false }),
  } as unknown as DesktopSettingsSectionProps
  await act(async () => { root!.render(createElement(DesktopSettingsSection, props)) })
  return container.querySelector('[aria-labelledby="dsh-desktop-aa-title"]')!
}

function enabledChoice(section: Element): HTMLElement {
  return section.querySelectorAll<HTMLElement>('[role="radio"]')[1]!
}

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  vi.unstubAllGlobals()
})

describe('AA settings clicks', () => {
  it('shows a failed bundle load and allows retrying the already selected option', async () => {
    const select = vi.fn(async () => ({ accepted: true as const, restartRequired: true }))
    const section = await mount(select, { requested: true, effective: false })
    expect(section.textContent).toContain(zh.aaLoadFailed)
    expect(enabledChoice(section).textContent).toContain(zh.retryAa)
    await act(async () => { enabledChoice(section).click() })
    expect(select).toHaveBeenCalledWith(true)
  })

  it('shows pending feedback next to the cards, then selects AA only after persistence succeeds', async () => {
    let complete!: (value: { accepted: true; restartRequired: boolean }) => void
    const select = vi.fn(() => new Promise<{ accepted: true; restartRequired: boolean }>(resolve => { complete = resolve }))
    const section = await mount(select)
    await act(async () => { enabledChoice(section).click() })
    expect(select).toHaveBeenCalledWith(true)
    expect(section.querySelector('[role="status"]')?.textContent).toBe(zh.aaSaving)
    expect(enabledChoice(section).getAttribute('aria-checked')).toBe('false')
    await act(async () => { complete({ accepted: true, restartRequired: true }) })
    expect(enabledChoice(section).getAttribute('aria-checked')).toBe('true')
    expect(section.querySelector('[role="status"]')?.textContent).toBe(zh.restarting)
    expect(section.textContent).toContain(zh.aaEnabledBody)
  })

  it('shows a local error on rejection and lets the same card retry', async () => {
    const select = vi.fn().mockRejectedValueOnce(new Error('preference validation failed'))
      .mockResolvedValueOnce({ accepted: true, restartRequired: true })
    const section = await mount(select)
    await act(async () => { enabledChoice(section).click() })
    expect(section.querySelector('[role="alert"]')?.textContent).toBe(zh.aaSaveFailed)
    expect(enabledChoice(section).getAttribute('aria-checked')).toBe('false')
    await act(async () => { enabledChoice(section).click() })
    expect(select).toHaveBeenCalledTimes(2)
    expect(section.querySelector('[role="alert"]')).toBeNull()
    expect(enabledChoice(section).getAttribute('aria-checked')).toBe('true')
  })
})
