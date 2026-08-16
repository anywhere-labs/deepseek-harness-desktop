import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  getPathForFile: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  webUtils: { getPathForFile: electron.getPathForFile },
}))

await import('../src/preload.ts')

describe('desktop preload', () => {
  beforeEach(() => {
    electron.getPathForFile.mockReset()
  })

  it('exposes only the native path lookup for renderer File objects', () => {
    expect(electron.exposeInMainWorld).toHaveBeenCalledOnce()
    expect(electron.exposeInMainWorld).toHaveBeenCalledWith('__DSH_DESKTOP__', {
      getPathForFile: expect.any(Function),
    })

    const bridge = electron.exposeInMainWorld.mock.calls[0]?.[1] as {
      getPathForFile(file: File): string
    }
    const file = { name: 'source.json' } as File
    electron.getPathForFile.mockReturnValue('C:\\sources\\source.json')

    expect(bridge.getPathForFile(file)).toBe('C:\\sources\\source.json')
    expect(electron.getPathForFile).toHaveBeenCalledWith(file)
    expect(Object.keys(bridge)).toEqual(['getPathForFile'])
  })
})
