import { describe, expect, it, vi } from 'vitest'
import {
  installDesktopDirectoryPickerBridge,
  requestDesktopDirectory,
  type DesktopDirectoryPickerWindow,
} from '../src/client/directory-picker.ts'
import { DESKTOP_DIRECTORY_PICKER_PATH } from '../src/directory-picker-contract.ts'

describe('desktop directory picker client bridge', () => {
  it('returns a native path from the same-origin desktop route', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ path: 'C:\\Work' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(requestDesktopDirectory(request)).resolves.toBe('C:\\Work')
    expect(request).toHaveBeenCalledWith(DESKTOP_DIRECTORY_PICKER_PATH, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
  })

  it('rejects invalid and failed route responses', async () => {
    await expect(requestDesktopDirectory(async () => new Response('{}')))
      .rejects.toThrow('invalid response')
    await expect(requestDesktopDirectory(async () => new Response('', { status: 500 })))
      .rejects.toThrow('could not open the system folder picker')
  })

  it('installs and restores the window bridge consumed by the browse panel', async () => {
    const previous = vi.fn(async () => null)
    const target = { __DSH_DESKTOP_PICK_DIRECTORY__: previous } as DesktopDirectoryPickerWindow
    const request = vi.fn(async () => new Response(JSON.stringify({ path: null })))

    const dispose = installDesktopDirectoryPickerBridge(target, request)
    expect(target.__DSH_DESKTOP_PICK_DIRECTORY__).not.toBe(previous)
    await expect(target.__DSH_DESKTOP_PICK_DIRECTORY__?.()).resolves.toBeNull()
    dispose()
    expect(target.__DSH_DESKTOP_PICK_DIRECTORY__).toBe(previous)
  })
})
