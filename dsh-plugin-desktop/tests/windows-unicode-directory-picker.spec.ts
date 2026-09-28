import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import {
  pickWindowsUnicodeDirectory,
  windowsUnicodePickerEnvironment,
} from '../src/windows-unicode-directory-picker.ts'

describe('Windows Unicode directory picker', () => {
  it('removes inherited Electron Node mode and preserves the Unicode dialog title', () => {
    const environment = windowsUnicodePickerEnvironment({
      Path: 'C:\\Windows',
      electron_run_as_node: 'inherited',
    }, '选择工作区目录')

    expect(environment).toMatchObject({
      Path: 'C:\\Windows',
      DSH_DIALOG_TITLE: '选择工作区目录',
    })
    expect(environment).not.toHaveProperty('electron_run_as_node')
    expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('preserves a Chinese path through the UTF-16LE Base64 carrier', async () => {
    const path = 'D:\\测试\\迅雷下载'
    let captured: {
      executable: string
      args: readonly string[]
      env: NodeJS.ProcessEnv
      windowsHide: boolean
    } | undefined
    const run = vi.fn(async (executable, args, options) => {
      captured = { executable, args, ...options }
      return {
        stdout: Buffer.from(path, 'utf16le').toString('base64'),
        stderr: '',
      }
    })

    await expect(pickWindowsUnicodeDirectory(
      '选择工作区目录',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      run,
    )).resolves.toBe(path)
    expect(captured).toMatchObject({
      executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-EncodedCommand',
        expect.any(String),
      ],
      env: { DSH_DIALOG_TITLE: '选择工作区目录' },
      windowsHide: true,
    })
  })

  it('maps cancellation onto null and rejects malformed output', async () => {
    await expect(pickWindowsUnicodeDirectory(
      'Select Workspace Directory',
      'powershell.exe',
      async () => ({ stdout: '', stderr: '' }),
    )).resolves.toBeNull()

    await expect(pickWindowsUnicodeDirectory(
      'Select Workspace Directory',
      'powershell.exe',
      async () => ({ stdout: 'not base64!', stderr: '' }),
    )).rejects.toThrow('invalid Base64 path')
  })
})
