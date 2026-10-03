import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDesktopOnboarding } from '../src/client/onboarding.tsx'
import { SESSION_WINDOW_BRIDGE, SESSION_WINDOW_CHANNEL, SESSION_WINDOW_TARGET, sessionWindowUrl,
  type SessionWindowBridge } from '../src/session-window-contract.ts'
import { SETUP_ONBOARDING_CHANNEL, type DesktopOnboardingBridge } from '../src/setup-onboarding-bridge.ts'

const electron = vi.hoisted(() => ({ invoke: vi.fn(async () => null), send: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => { Object.assign(window, { [name]: value }) },
  },
  ipcRenderer: electron,
  webUtils: { getPathForFile: vi.fn() },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, Toast: () => null }))

type PreloadWindow = {
  location: { search: string }
  dshDesktop?: { protocolVersion: number }
  dshDesktopSetup?: DesktopOnboardingBridge
  [SESSION_WINDOW_TARGET]?: string | null
  [SESSION_WINDOW_BRIDGE]?: SessionWindowBridge
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })
afterEach(() => { vi.unstubAllGlobals() })

async function loadPreload(url: string): Promise<PreloadWindow> {
  const page: PreloadWindow = { location: { search: new URL(url).search } }
  vi.stubGlobal('window', page)
  await import('../src/preload.ts')
  return page
}

function registerOnboarding() {
  const inject = vi.fn()
  registerDesktopOnboarding({ slots: { inject } } as unknown as Context, () => null)
  return inject
}

describe('Desktop preload onboarding scope', () => {
  it.each(['advanced', 'extended', 'compatibility'])('keeps setup available in the %s main window', async mode => {
    const page = await loadPreload(`http://localhost:3000/?dsh-desktop-mode=${mode}`)
    expect(page[SESSION_WINDOW_TARGET]).toBeNull()
    expect(registerOnboarding()).toHaveBeenCalledWith('onboarding.desktop.before', expect.any(Function))
    await page.dshDesktopSetup!.read()
    await page.dshDesktopSetup!.dismissAccount('default')
    await page.dshDesktopSetup!.applyPending!('default')
    await page.dshDesktopSetup!.finish('default')
    expect(electron.invoke.mock.calls).toEqual([
      [SETUP_ONBOARDING_CHANNEL, { action: 'read' }],
      [SETUP_ONBOARDING_CHANNEL, { action: 'dismiss-account', profile: 'default' }],
      [SETUP_ONBOARDING_CHANNEL, { action: 'apply-pending', profile: 'default' }],
      [SETUP_ONBOARDING_CHANNEL, { action: 'finish', profile: 'default', selection: undefined }],
    ])
  })

  it.each([
    ['advanced', 'session-a'], ['extended', 'session-a'], ['compatibility', 'session-a'],
    ['advanced', 'id&other=value'],
  ] as const)('skips setup in the %s independent session window (%#)', async (mode, sessionId) => {
    const page = await loadPreload(sessionWindowUrl(`http://localhost:3000/?dsh-desktop-mode=${mode}`, sessionId))
    expect(page[SESSION_WINDOW_TARGET]).toBe(sessionId)
    expect(page.dshDesktop).toEqual({ protocolVersion: 1 })
    expect(page.dshDesktopSetup).toBeUndefined()
    expect(registerOnboarding()).not.toHaveBeenCalled()
    expect(electron.invoke).not.toHaveBeenCalled()
    page[SESSION_WINDOW_BRIDGE]!.ready('Existing session')
    expect(electron.send).toHaveBeenCalledExactlyOnceWith(`${SESSION_WINDOW_CHANNEL}:ready`, 'Existing session')
  })

  it.each(['', 'two words', '\u0000', 'x'.repeat(257)])('retains main-window setup for an invalid session target (%#)', async target => {
    const page = await loadPreload(`http://localhost:3000/?dsh-desktop-session=${encodeURIComponent(target)}`)
    expect(page[SESSION_WINDOW_TARGET]).toBeNull()
    expect(registerOnboarding()).toHaveBeenCalledOnce()
    await page.dshDesktopSetup!.read()
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(SETUP_ONBOARDING_CHANNEL, { action: 'read' })
  })
})
