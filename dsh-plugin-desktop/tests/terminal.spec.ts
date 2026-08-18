import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopRuntime, DesktopTrayItem } from '../src/runtime.ts'
import { apply, inject, name } from '../src/terminal.ts'

describe('desktop terminal Host plugin', () => {
  it('owns an effect-scoped tray command that opens the configured terminal', () => {
    let trayItem: DesktopTrayItem | undefined
    let disposeEffect: (() => void) | undefined
    const openTerminal = vi.fn()
    const disposeRegistration = vi.fn()
    let locale: DesktopRuntime['locale'] = 'en'
    const runtime = {
      platform: 'darwin',
      get locale() { return locale },
      openTerminal,
      registerTrayItem: (item: DesktopTrayItem) => {
        trayItem = item
        return { refresh: () => {}, dispose: disposeRegistration }
      },
    } as unknown as DesktopRuntime
    const ctx = {
      desktopRuntime: runtime,
      effect: (register: () => (() => void)) => {
        disposeEffect = register()
        return disposeEffect
      },
    } as unknown as Context

    apply(ctx)

    expect(name).toBe('desktop-terminal')
    expect(inject).toEqual(['desktopRuntime'])
    expect(trayItem).toMatchObject({ group: 'tools', order: 10 })
    expect(trayItem?.label()).toBe('Open DSH Terminal')
    locale = 'zh'
    expect(trayItem?.label()).toBe('打开 DSH 终端')
    trayItem?.invoke()
    expect(openTerminal).toHaveBeenCalledOnce()

    disposeEffect?.()
    expect(disposeRegistration).toHaveBeenCalledOnce()
  })

  it('registers the tray command on Linux like the other desktop platforms', () => {
    let registered = false
    const ctx = {
      desktopRuntime: {
        platform: 'linux',
        locale: 'en',
        registerTrayItem: () => {
          registered = true
          return { dispose: () => {} }
        },
        openTerminal: () => {},
      },
      effect: (factory: () => () => void) => { factory() },
    } as unknown as Context

    expect(() => apply(ctx)).not.toThrow()
    expect(registered).toBe(true)
  })
})
