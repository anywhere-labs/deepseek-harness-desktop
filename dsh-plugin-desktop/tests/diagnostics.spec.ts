import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopRuntime, DesktopTrayItem } from '../src/runtime.ts'
import { apply, inject, name } from '../src/diagnostics.ts'

describe('desktop diagnostics Host plugin', () => {
  it('owns an effect-scoped tray command that exports diagnostics', async () => {
    let trayItem: DesktopTrayItem | undefined
    let disposeEffect: (() => void) | undefined
    const exportDiagnostics = vi.fn(async () => {})
    const disposeRegistration = vi.fn()
    const runtime = {
      locale: 'en',
      exportDiagnostics,
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

    expect(name).toBe('desktop-diagnostics')
    expect(inject).toEqual(['desktopRuntime'])
    expect(trayItem).toMatchObject({ group: 'tools', order: 20 })
    expect(trayItem?.label()).toBe('Export Diagnostics…')
    await trayItem?.invoke()
    expect(exportDiagnostics).toHaveBeenCalledOnce()

    disposeEffect?.()
    expect(disposeRegistration).toHaveBeenCalledOnce()
  })

  it('uses the active desktop locale for its tray label', () => {
    let trayItem: DesktopTrayItem | undefined
    const runtime = {
      locale: 'zh',
      exportDiagnostics: vi.fn(async () => {}),
      registerTrayItem: (item: DesktopTrayItem) => {
        trayItem = item
        return { refresh: () => {}, dispose: () => {} }
      },
    } as unknown as DesktopRuntime
    const ctx = {
      desktopRuntime: runtime,
      effect: (register: () => (() => void)) => register(),
    } as unknown as Context

    apply(ctx)

    expect(trayItem?.label()).toBe('导出诊断信息…')
  })
})
