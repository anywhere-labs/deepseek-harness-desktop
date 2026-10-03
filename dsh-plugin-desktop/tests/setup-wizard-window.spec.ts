import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopSetupWizardInput,
  DesktopSetupWizardSelection,
} from '../src/setup-wizard-contract.ts'

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const windows: BrowserWindow[] = []
  class BrowserWindow {
    readonly onceListeners = new Map<string, Listener>()
    readonly listeners = new Map<string, Listener>()
    readonly webListeners = new Map<string, Listener>()
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, listener: Listener) => { this.webListeners.set(event, listener) }),
    }
    accessibleTitle = ''
    readonly isDestroyed = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn()
    readonly removeMenu = vi.fn()
    readonly destroy = vi.fn()
    readonly loadFile = vi.fn(async () => {})
    readonly once = vi.fn((event: string, listener: Listener) => { this.onceListeners.set(event, listener) })
    readonly on = vi.fn((event: string, listener: Listener) => { this.listeners.set(event, listener) })
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) { windows.push(this) }
  }
  return {
    app: { isHidden: vi.fn(() => false), show: vi.fn() },
    BrowserWindow,
    windows,
  }
})

vi.mock('electron', () => ({ app: electron.app, BrowserWindow: electron.BrowserWindow }))

import {
  DesktopSetupWizardWindow,
  parseDesktopSetupWizardAction,
} from '../src/setup-wizard-window.ts'

const notifications = Object.freeze({
  enabled: true,
  notifyOnTurnCompletion: true,
  notifyOnTurnFailure: false,
  notifyOnJobCompletion: true,
  notifyOnJobFailure: false,
  notifyOnScheduleCompletion: false,
  notifyOnScheduleFailure: false,
})

function input(overrides: Partial<DesktopSetupWizardInput> = {}): DesktopSetupWizardInput {
  return {
    appVersion: '2.0.6-beta.1',
    profileName: 'work',
    platform: 'win32',
    mode: 'compatibility',
    macosMaterial: 'transparent',
    windowsMaterial: 'off',
    openBrowser: true,
    networkExposure: 'loopback',
    aaEnabled: false,
  market: 'community-market',
    notifications,
    ...overrides,
  }
}

function completeUrl(selection: DesktopSetupWizardSelection = input()): string {
  const url = new URL('dsh-setup-wizard://complete')
  url.searchParams.set('mode', selection.mode)
  url.searchParams.set('macosMaterial', selection.macosMaterial)
  url.searchParams.set('windowsMaterial', selection.windowsMaterial)
  url.searchParams.set('openBrowser', String(selection.openBrowser))
  url.searchParams.set('networkExposure', selection.networkExposure)
  url.searchParams.set('market', selection.market)
  url.searchParams.set('aaEnabled', String(selection.aaEnabled === true))
  url.searchParams.set('notificationsEnabled', String(selection.notifications.enabled))
  url.searchParams.set('notifyOnTurnCompletion', String(selection.notifications.notifyOnTurnCompletion))
  url.searchParams.set('notifyOnTurnFailure', String(selection.notifications.notifyOnTurnFailure))
  url.searchParams.set('notifyOnJobCompletion', String(selection.notifications.notifyOnJobCompletion))
  url.searchParams.set('notifyOnJobFailure', String(selection.notifications.notifyOnJobFailure))
  url.searchParams.set('notifyOnScheduleCompletion', String(selection.notifications.notifyOnScheduleCompletion))
  url.searchParams.set('notifyOnScheduleFailure', String(selection.notifications.notifyOnScheduleFailure))
  return url.href
}

function navigate(window: InstanceType<typeof electron.BrowserWindow>, href: string): ReturnType<typeof vi.fn> {
  const event = { preventDefault: vi.fn() }
  const listener = window.webListeners.get('will-navigate') as ((navigationEvent: typeof event, href: string) => void) | undefined
  listener?.(event, href)
  return event.preventDefault
}

describe('Desktop Setup Wizard action parser', () => {
  it('accepts only complete selections and a parameter-free explicit skip', () => {
    expect(parseDesktopSetupWizardAction(completeUrl())).toEqual({
      action: 'complete',
      selection: {
        mode: 'compatibility',
        macosMaterial: 'transparent',
        windowsMaterial: 'off',
        openBrowser: true,
        networkExposure: 'loopback',
        aaEnabled: false,
  market: 'community-market',
        notifications,
      },
    })
    expect(parseDesktopSetupWizardAction('dsh-setup-wizard://skip')).toEqual({ action: 'skip' })
    expect(parseDesktopSetupWizardAction('dsh-setup-wizard://skip?reason=later')).toBeUndefined()
    expect(parseDesktopSetupWizardAction('https://complete/')).toBeUndefined()
  })

  it('rejects partial, duplicate, extra, malformed, and oversized payloads', () => {
    const partial = new URL(completeUrl())
    partial.searchParams.delete('market')
    expect(parseDesktopSetupWizardAction(partial.href)).toBeUndefined()
    const duplicate = new URL(completeUrl())
    duplicate.searchParams.append('mode', 'advanced')
    expect(parseDesktopSetupWizardAction(duplicate.href)).toBeUndefined()
    const extra = new URL(completeUrl())
    extra.searchParams.set('command', 'bad')
    expect(parseDesktopSetupWizardAction(extra.href)).toBeUndefined()
    const malformed = new URL(completeUrl())
    malformed.searchParams.set('openBrowser', '1')
    expect(parseDesktopSetupWizardAction(malformed.href)).toBeUndefined()
    // Windows no longer offers Mica, so a stale page cannot select it.
    const removedMaterial = new URL(completeUrl())
    removedMaterial.searchParams.set('windowsMaterial', 'mica')
    expect(parseDesktopSetupWizardAction(removedMaterial.href)).toBeUndefined()
    expect(parseDesktopSetupWizardAction(`${completeUrl()}${'x'.repeat(8192)}`)).toBeUndefined()
  })
})

describe('DesktopSetupWizardWindow', () => {
  beforeEach(() => {
    electron.windows.length = 0
    vi.clearAllMocks()
  })

  it('loads bounded local state in a sandboxed window with no IPC or new-window path', async () => {
    const result = new DesktopSetupWizardWindow({ locale: 'zh', input: input() }).run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(1) })
    const window = electron.windows[0]
    expect(window?.options).toEqual(expect.objectContaining({
      width: 880,
      height: 720,
      minWidth: 680,
      minHeight: 560,
      useContentSize: true,
      show: true,
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        partition: 'dsh-setup-wizard',
      }),
    }))
    expect(window?.options.webPreferences).not.toHaveProperty('preload')
    const deny = window?.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as (() => unknown) | undefined
    expect(deny?.()).toEqual({ action: 'deny' })
    const attachEvent = { preventDefault: vi.fn() }
    const attach = window?.webListeners.get('will-attach-webview') as ((event: typeof attachEvent) => void) | undefined
    attach?.(attachEvent)
    expect(attachEvent.preventDefault).toHaveBeenCalledOnce()
    const loadCall = window?.loadFile.mock.calls[0] as unknown as [string, { query: Record<string, string> }] | undefined
    expect(loadCall?.[0]).toMatch(/[\\/]native-ui[\\/]setup-wizard\.html$/u)
    expect(loadCall?.[1].query).toMatchObject({ locale: 'zh', platform: 'win32', frame: 'true' })
    expect(JSON.parse(Buffer.from(loadCall?.[1].query.state ?? '', 'base64url').toString('utf8'))).toEqual(input())

    const prevented = navigate(window!, 'dsh-setup-wizard://skip')
    await expect(result).resolves.toEqual({ action: 'skip' })
    expect(prevented).toHaveBeenCalledOnce()
    expect(window?.destroy).toHaveBeenCalledOnce()
  })

  it('keeps non-Windows Wizards hidden until Electron reports them ready', async () => {
    const result = new DesktopSetupWizardWindow({
      locale: 'en',
      input: input({ platform: 'darwin' }),
    }).run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(1) })
    const window = electron.windows[0]
    expect(window?.options.show).toBe(false)
    window?.onceListeners.get('ready-to-show')?.()
    expect(window?.show).toHaveBeenCalledOnce()
    expect(window?.focus).toHaveBeenCalledOnce()
    const prevented = navigate(window!, 'dsh-setup-wizard://skip')
    await expect(result).resolves.toEqual({ action: 'skip' })
    expect(prevented).toHaveBeenCalledOnce()
  })

  it('returns the full immutable selection after explicit completion', async () => {
    const source = input()
    const expected: DesktopSetupWizardSelection = {
      mode: source.mode,
      macosMaterial: source.macosMaterial,
      windowsMaterial: source.windowsMaterial,
      openBrowser: source.openBrowser,
      networkExposure: source.networkExposure,
      aaEnabled: false,
      market: source.market,
      notifications: source.notifications,
    }
    const result = new DesktopSetupWizardWindow({ locale: 'en', input: input() }).run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(1) })
    navigate(electron.windows[0]!, completeUrl(expected))
    await expect(result).resolves.toEqual({ action: 'complete', selection: expected })
  })

  it('maps an ordinary window close to quit instead of skip', async () => {
    const wizard = new DesktopSetupWizardWindow({ locale: 'en', input: input() })
    const result = wizard.run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(1) })
    wizard.show()
    expect(electron.windows[0]?.show).toHaveBeenCalledOnce()
    expect(electron.windows[0]?.focus).toHaveBeenCalledOnce()
    electron.windows[0]?.listeners.get('closed')?.()
    await expect(result).resolves.toEqual({ action: 'quit' })
    wizard.show()
    expect(electron.windows[0]?.show).toHaveBeenCalledOnce()
  })

  it('ignores selections unavailable for the supplied platform capabilities', async () => {
    const linuxInput = input({ platform: 'linux', mode: 'compatibility' })
    const result = new DesktopSetupWizardWindow({ locale: 'en', input: linuxInput }).run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(1) })
    navigate(electron.windows[0]!, completeUrl({ ...linuxInput, mode: 'advanced' }))
    expect(electron.windows[0]?.destroy).not.toHaveBeenCalled()
    electron.windows[0]?.listeners.get('closed')?.()
    await expect(result).resolves.toEqual({ action: 'quit' })
  })
})
