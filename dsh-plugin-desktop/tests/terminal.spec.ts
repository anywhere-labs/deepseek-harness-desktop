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

  it('fails loud if a Linux profile activates the unsupported terminal row', () => {
    const ctx = {
      desktopRuntime: { platform: 'linux' },
    } as unknown as Context

    expect(() => apply(ctx)).toThrow('supported on macOS and Windows')
  })
})
