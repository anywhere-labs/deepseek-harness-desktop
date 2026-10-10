// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_FILE_PATH_BRIDGE } from '../src/file-path-bridge-contract.ts'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  getPathForFile: vi.fn(),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  webUtils: { getPathForFile: electron.getPathForFile },
  ipcRenderer: { invoke: vi.fn() },
}))

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  electron.getPathForFile.mockReset()
  await import('../src/preload.ts')
})

function bridge(key: string): { getPathForFile?: (file: File) => string; pathFor?: (file: File) => string } | undefined {
  return electron.exposeInMainWorld.mock.calls.find(([name]) => name === key)?.[1]
}

describe('context-isolated file path capabilities', () => {
  it('publishes the pathFor seam consumed by the official conversation client', () => {
    const file = new File(['image'], 'pixel.png', { type: 'image/png' })
    electron.getPathForFile.mockReturnValue('/workspace/pixel.png')
    expect(bridge('__DSH_HOST_PATHS__')?.pathFor?.(file)).toBe('/workspace/pixel.png')
    expect(electron.getPathForFile).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('preserves the existing Desktop bridge for installed plugins', () => {
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    electron.getPathForFile.mockReturnValue('C:\\Work\\notes.txt')
    expect(bridge(DESKTOP_FILE_PATH_BRIDGE)?.getPathForFile?.(file)).toBe('C:\\Work\\notes.txt')
    expect(electron.getPathForFile).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('preserves the empty-path result for browser-created files', () => {
    const file = new File(['image'], 'pixel.png', { type: 'image/png' })
    electron.getPathForFile.mockReturnValue('')
    expect(bridge('__DSH_HOST_PATHS__')?.pathFor?.(file)).toBe('')
  })

  it('leaves File validation and errors with Electron instead of trusting a path property', () => {
    const forged = { path: '/private/secret.txt', name: 'secret.txt' } as unknown as File
    electron.getPathForFile.mockImplementation(() => { throw new TypeError('A File object is required') })
    expect(() => bridge('__DSH_HOST_PATHS__')?.pathFor?.(forged)).toThrow('A File object is required')
    expect(electron.getPathForFile).toHaveBeenCalledExactlyOnceWith(forged)
  })
})
