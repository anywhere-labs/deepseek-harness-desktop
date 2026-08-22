import { describe, expect, it, vi } from 'vitest'
import { WslWorkspaceAdapter } from '../src/wsl-workspace.ts'
import type { DesktopCommandCapture } from '../src/wsl.ts'

describe('WSL workspace admission', () => {
  it('returns a Linux path only after the selected distribution validates it', async () => {
    const capture = vi.fn<DesktopCommandCapture>(async () => ({
      exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
    }))
    const adapter = new WslWorkspaceAdapter({
      distribution: 'Ubuntu-24.04',
      homeDir: '/home/alice',
      capture,
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: ['\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\project'],
      }),
      reportOutsideDistribution: vi.fn(),
    })
    await expect(adapter.pickDirectory()).resolves.toBe('/home/alice/project')
    expect(capture).toHaveBeenCalledWith('wsl.exe', [
      '--distribution', 'Ubuntu-24.04', '--exec', '/usr/bin/test', '-d', '/home/alice/project',
    ])
  })

  it('rejects a Windows selection without invoking Linux validation', async () => {
    const capture = vi.fn<DesktopCommandCapture>()
    const report = vi.fn()
    const adapter = new WslWorkspaceAdapter({
      distribution: 'Ubuntu', homeDir: '/home/alice', capture,
      showOpenDialog: async () => ({ canceled: false, filePaths: ['C:\\work'] }),
      reportOutsideDistribution: report,
    })
    await expect(adapter.pickDirectory()).resolves.toBeNull()
    expect(report).toHaveBeenCalledWith('C:\\work')
    expect(capture).not.toHaveBeenCalled()
  })
})
