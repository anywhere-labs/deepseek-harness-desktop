import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUpdateState } from '../src/update-contract.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function windowFor(updates: 'enabled' | 'disabled'): Window {
  return {
    location: {
      search: `?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin&dsh-desktop-updates=${updates}`,
    },
  } as unknown as Window
}

describe('desktop update client plugin', () => {
  it('registers the General row, frame banner, and dictionaries only for packaged desktop pages', async () => {
    vi.useFakeTimers()
    const state: DesktopUpdateState = {
      phase: 'current',
      currentVersion: '2.0.1',
      installMode: 'automatic',
    }
    const rpc = { call: vi.fn(async () => ({ ok: true as const, value: state })) }
    const registered: Array<{ name: string; id?: string }> = []
    const disposers: Array<() => void> = []
    const localeRegister = vi.fn(() => () => {})
    const ctx = {
      get: vi.fn(() => ({ rpc })),
      locale: { register: localeRegister },
      slots: {
        inject: vi.fn((_name: string, register: () => unknown) => register()),
        register: vi.fn((options: { name: string; id?: string }) => {
          registered.push(options)
          return () => {}
        }),
      },
      effect: vi.fn((register: () => () => void) => {
        const dispose = register()
        disposers.push(dispose)
        return dispose
      }),
    } as unknown as ClientContext
    const { apply, DESKTOP_UPDATE_SETTINGS_NS } = await import('../src/client/index.ts')

    vi.stubGlobal('window', windowFor('enabled'))
    apply(ctx)
    await vi.waitFor(() => { expect(rpc.call).toHaveBeenCalled() })

    expect(localeRegister).toHaveBeenCalledWith(
      DESKTOP_UPDATE_SETTINGS_NS,
      expect.objectContaining({ zh: expect.any(Object), en: expect.any(Object) }),
    )
    expect(registered).toEqual([
      expect.objectContaining({ name: 'settings.general.item', id: 'desktop-update' }),
      expect.objectContaining({ name: 'shell.overlay', id: 'desktop-update' }),
    ])
    for (const dispose of disposers.reverse()) dispose()

    registered.length = 0
    localeRegister.mockClear()
    vi.stubGlobal('window', windowFor('disabled'))
    apply(ctx)
    expect(registered).toEqual([])
    expect(localeRegister).not.toHaveBeenCalled()
  })
})
