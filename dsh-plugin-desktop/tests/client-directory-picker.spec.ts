import { describe, expect, it, vi } from 'vitest'
import {
  installDesktopDirectoryPickerBridge,
  requestDesktopDirectory,
  requestDesktopDirectoryValidation,
  type DesktopDirectoryPickerWindow,
} from '../src/client/directory-picker.ts'
import {
  DESKTOP_DIRECTORY_PICKER_PATH,
  DESKTOP_DIRECTORY_VALIDATOR_PATH,
} from '../src/directory-picker-contract.ts'

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

  it('validates a manually entered workspace path through the desktop Host', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ allowed: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(requestDesktopDirectoryValidation('E:\\repo', request)).resolves.toBe(false)
    expect(request).toHaveBeenCalledWith(DESKTOP_DIRECTORY_VALIDATOR_PATH, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: 'E:\\repo' }),
    })
  })

  it('installs and restores the window bridge consumed by the browse panel', async () => {
    const previous = vi.fn(async () => null)
    const previousValidation = vi.fn(async () => true)
    const target = {
      __DSH_DESKTOP_PICK_DIRECTORY__: previous,
      __DSH_DESKTOP_VALIDATE_DIRECTORY__: previousValidation,
    } as DesktopDirectoryPickerWindow
    const request = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input) === DESKTOP_DIRECTORY_VALIDATOR_PATH ? { allowed: true } : { path: null },
    )))

    const dispose = installDesktopDirectoryPickerBridge(target, request)
    expect(target.__DSH_DESKTOP_PICK_DIRECTORY__).not.toBe(previous)
    expect(target.__DSH_DESKTOP_VALIDATE_DIRECTORY__).not.toBe(previousValidation)
    await expect(target.__DSH_DESKTOP_PICK_DIRECTORY__?.()).resolves.toBeNull()
    await expect(target.__DSH_DESKTOP_VALIDATE_DIRECTORY__?.('C:\\Work')).resolves.toBe(true)
    dispose()
    expect(target.__DSH_DESKTOP_PICK_DIRECTORY__).toBe(previous)
    expect(target.__DSH_DESKTOP_VALIDATE_DIRECTORY__).toBe(previousValidation)
  })
})
