import { expect, it, vi } from 'vitest'
import { DEFAULT_PREFERENCES, type DesktopBridge, type DesktopState } from '../src/desktop-contract.ts'
import { NextSettingsAdapter } from '../src/client/settings-adapter.ts'
import { NativeDesktop } from '../src/native-desktop.ts'

const { show } = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean { return true }
    once(): void {}
    show = show
    close(): void {}
  },
}))

it('uses notification switches saved by the settings form on every native delivery', async () => {
  const state = {
    preferences: { ...DEFAULT_PREFERENCES }, busy: false, notificationsAvailable: true,
  } as DesktopState
  const command = vi.fn(async (command: Parameters<DesktopBridge['command']>[0]) => {
    if (command.type === 'preferences') state.preferences = command.preferences
  })
  const adapter = new NextSettingsAdapter({
    state: async () => structuredClone(state), command,
    browserLinks: async () => ({ localUrl: null, lanUrls: [] }),
  })
  const native = new NativeDesktop({
    root: '/fixture', language: () => 'en', state: () => state, window: () => undefined,
    show() {}, run() {}, warn() {},
  })
  const completed = { outcome: 'turn-completed', userMessage: 'Prompt', assistantMessage: 'Reply' } as const
  const failed = { outcome: 'turn-failed' } as const
  const scheduled = { outcome: 'schedule-completed' } as const
  const scheduledFailed = { outcome: 'schedule-failed' } as const
  show.mockClear()
  try {
    native.notify(completed)
    expect(show).toHaveBeenCalledTimes(1)
    await adapter.notificationSettings.set('enabled', false)
    native.notify(completed)
    native.notify(failed)
    expect(show).toHaveBeenCalledTimes(1)

    await adapter.notificationSettings.set('enabled', true)
    await adapter.notificationSettings.set('notifyOnTurnCompletion', false)
    native.notify(completed)
    native.notify(failed)
    expect(show).toHaveBeenCalledTimes(2)

    await adapter.notificationSettings.set('notifyOnTurnFailure', false)
    native.notify(failed)
    expect(show).toHaveBeenCalledTimes(2)
    await adapter.notificationSettings.set('notifyOnTurnCompletion', true)
    native.notify(completed)
    expect(show).toHaveBeenCalledTimes(3)
    await adapter.notificationSettings.set('notifyOnScheduleCompletion', false)
    native.notify(scheduled)
    expect(show).toHaveBeenCalledTimes(3)
    native.notify(scheduledFailed)
    expect(show).toHaveBeenCalledTimes(4)
    await adapter.notificationSettings.set('notifyOnScheduleFailure', false)
    native.notify(scheduledFailed)
    expect(show).toHaveBeenCalledTimes(4)
    expect(command.mock.calls.every(([command]) => command.type === 'preferences')).toBe(true)
  } finally { native.close() }
})
