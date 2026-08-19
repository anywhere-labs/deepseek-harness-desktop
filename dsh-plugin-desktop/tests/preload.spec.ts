import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_ARTIFACT_CONTEXT_MENU_BRIDGE,
  DESKTOP_ARTIFACT_CONTEXT_MENU_CHANNEL,
  type DesktopArtifactContextMenuBridge,
} from '../src/artifact-context-menu-contract.ts'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  getPathForFile: vi.fn(),
  invoke: vi.fn(async () => undefined),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke },
  webUtils: { getPathForFile: electron.getPathForFile },
}))

describe('desktop preload', () => {
  it('exposes a narrow artifact-menu bridge over the private IPC channel', async () => {
    await import('../src/preload.ts')
    const exposure = electron.exposeInMainWorld.mock.calls
      .find(([key]) => key === DESKTOP_ARTIFACT_CONTEXT_MENU_BRIDGE)
    expect(exposure).toBeDefined()
    const bridge = exposure?.[1] as DesktopArtifactContextMenuBridge
    const request = { cwd: '/workspace', path: 'report.md' }

    await bridge.show(request)
    expect(electron.invoke).toHaveBeenCalledWith(DESKTOP_ARTIFACT_CONTEXT_MENU_CHANNEL, request)
  })
})
