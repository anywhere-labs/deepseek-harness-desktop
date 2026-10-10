import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { configureDeveloperLogging, developerLoggingEnabled, initializeDeveloperLogging } from '../src/developer-logging.ts'
import { DesktopSettingsSchema, DesktopShellConfig, observeDesktopPreferenceSettings } from '../src/settings-bridge.ts'

afterEach(() => {
  configureDeveloperLogging({ developerLogging: false, logLevel: 'info' })
  initializeDeveloperLogging(() => {})
})
it('defaults existing profiles to disabled and publishes a volatile setting', () => {
  expect(DesktopSettingsSchema({} as never)).toMatchObject({ developerLogging: false, logLevel: 'info' })
  expect(DesktopShellConfig({}).developerLogging.get()).toBe(false)
  expect(DesktopShellConfig({ developerLogging: true }).developerLogging.get()).toBe(true)
})
it('applies tracing and kernel thresholds live and forwards them to Electron even without notification settings', () => {
  let desktop = { developerLogging: false, logLevel: 'info' }
  let changed: ((namespace: string) => void) | undefined
  const native = vi.fn()
  const threshold = vi.fn()
  const write = vi.fn(async () => {})
  const ctx = {
    get(name: string) {
      if (name === 'settings') return { describe: () => [{ ns: 'desktop-shell', value: desktop }] }
      if (name === 'desktopRuntime') return { configureDeveloperLogging: native }
      return undefined
    },
    loader: { entries: () => [] },
    on(_event: string, callback: typeof changed) { changed = callback },
  } as unknown as Context
  observeDesktopPreferenceSettings(ctx, { setThreshold: threshold }, write)
  expect(developerLoggingEnabled()).toBe(false)
  desktop = { developerLogging: true, logLevel: 'debug' }
  changed?.('desktop-shell')
  expect(developerLoggingEnabled()).toBe(true)
  expect(native).toHaveBeenLastCalledWith(desktop)
  expect(threshold).toHaveBeenLastCalledWith('debug')
  expect(write).not.toHaveBeenCalled()
  desktop = { developerLogging: false, logLevel: 'error' }
  changed?.('desktop-shell')
  expect(developerLoggingEnabled()).toBe(false)
})
