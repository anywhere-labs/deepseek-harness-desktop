import { describe, expect, it, vi } from 'vitest'
import {
  ElectronWorkspaceAdmission,
  type ElectronWorkspaceAdmissionOptions,
} from '../src/workspace-admission.ts'

function admission(overrides: Partial<ElectronWorkspaceAdmissionOptions> = {}) {
  const options: ElectronWorkspaceAdmissionOptions = {
    platform: 'win32',
    canPickDirectory: true,
    locale: () => 'en',
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    logError: vi.fn(),
    volumeQuery: () => ({ root: 'C:\\', fileSystem: 'NTFS', driveType: 3 }),
    ...overrides,
  }
  return { options, admission: new ElectronWorkspaceAdmission(options) }
}

describe('Electron workspace admission', () => {
  it('coalesces concurrent native selections and releases the task after completion', async () => {
    let finish: ((value: { canceled: false; filePaths: string[] }) => void) | undefined
    const showOpenDialog = vi.fn<ElectronWorkspaceAdmissionOptions['showOpenDialog']>(() => new Promise((resolve) => {
      finish = resolve
    }))
    const { admission: subject } = admission({ showOpenDialog })

    const first = subject.pickDirectory()
    const second = subject.pickDirectory()
    expect(showOpenDialog).toHaveBeenCalledOnce()
    finish?.({ canceled: false, filePaths: ['C:\\Work'] })

    await expect(Promise.all([first, second])).resolves.toEqual(['C:\\Work', 'C:\\Work'])
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(subject.pickDirectory()).resolves.toBeNull()
    expect(showOpenDialog).toHaveBeenCalledTimes(2)
  })

  it('rejects native selection on a platform without the capability', async () => {
    const showOpenDialog = vi.fn()
    const { admission: subject } = admission({
      platform: 'linux',
      canPickDirectory: false,
      showOpenDialog,
    })

    await expect(subject.pickDirectory()).rejects.toThrow('native workspace picker is unavailable on linux')
    expect(showOpenDialog).not.toHaveBeenCalled()
  })

  it('allows a fixed NTFS workspace without prompting or logging', async () => {
    const { admission: subject, options } = admission()

    await expect(subject.validateDirectory('C:\\repo')).resolves.toBe(true)
    expect(options.showMessageBox).not.toHaveBeenCalled()
    expect(options.logError).not.toHaveBeenCalled()
  })

  it('blocks unsupported storage and records the decision', async () => {
    const { admission: subject, options } = admission({
      volumeQuery: () => ({ root: 'E:\\', fileSystem: 'EXFAT', driveType: 2 }),
    })

    await expect(subject.validateDirectory('E:\\repo')).resolves.toBe(false)
    expect(options.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('EXFAT'),
    }))
    expect(options.logError).toHaveBeenLastCalledWith(
      'dsh-plugin-desktop: workspace volume decision=blocked path=E:\\repo',
    )
  })

  it.each([
    [1, false, 'cancelled'],
    [0, true, 'confirmed'],
  ] as const)('requires an explicit decision for removable NTFS (response %s)', async (response, allowed, decision) => {
    const { admission: subject, options } = admission({
      showMessageBox: vi.fn(async () => ({ response, checkboxChecked: false })),
      volumeQuery: () => ({ root: 'E:\\', fileSystem: 'NTFS', driveType: 2 }),
    })

    await expect(subject.validateDirectory('E:\\repo')).resolves.toBe(allowed)
    expect(options.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      defaultId: 1,
      cancelId: 1,
    }))
    expect(options.logError).toHaveBeenLastCalledWith(
      `dsh-plugin-desktop: workspace volume decision=${decision} path=E:\\repo`,
    )
  })

  it('fails closed when the selected volume disappears during inspection', async () => {
    const { admission: subject, options } = admission({
      volumeQuery: () => { throw new Error('drive disconnected') },
    })

    await expect(subject.validateDirectory('E:\\repo')).resolves.toBe(false)
    expect(options.logError).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('drive disconnected'),
    )
  })
})
