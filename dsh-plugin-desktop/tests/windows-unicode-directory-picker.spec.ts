import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import {
  pickWindowsUnicodeDirectory,
  windowsUnicodePickerEnvironment,
} from '../src/windows-unicode-directory-picker.ts'

describe('Windows Unicode directory picker', () => {
  it('removes inherited Electron Node mode and preserves the Unicode title without mutating the parent environment', () => {
    const source = { Path: 'C:\\Windows', electron_run_as_node: 'inherited', ELECTRON_RUN_AS_NODE: '1' }
    const environment = windowsUnicodePickerEnvironment(source, '选择工作区目录')

    expect(environment).toEqual({ Path: 'C:\\Windows', DSH_DIALOG_TITLE: '选择工作区目录' })
    expect(source.electron_run_as_node).toBe('inherited')
    expect(source.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it.each([
    'D:\\测试\\迅雷下载',
    'C:\\测试目录\\空 格与\'引号😀',
    '\\\\server\\共享\\项目',
  ])('preserves %s through an ASCII-only UTF-16LE Base64 carrier', async (path) => {
    const run = vi.fn(async (_executable: string, _args: readonly string[], _options: object) => ({
      stdout: '\r\n' + Buffer.from(path, 'utf16le').toString('base64') + '\r\n',
      stderr: '',
    }))

    await expect(pickWindowsUnicodeDirectory('选择工作区目录', 'powershell.exe', run)).resolves.toBe(path)
    expect(run).toHaveBeenCalledWith('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', expect.any(String),
    ], expect.objectContaining({ env: expect.objectContaining({ DSH_DIALOG_TITLE: '选择工作区目录' }), windowsHide: true }))
    const args = run.mock.calls[0]?.[1]
    const command = Buffer.from(args?.[5] ?? '', 'base64').toString('utf16le')
    expect(command).toContain('[System.Text.Encoding]::Unicode.GetBytes($dialog.SelectedPath)')
    expect(command).toContain('[Console]::Out.Write([System.Convert]::ToBase64String($bytes))')
    expect(command).toContain('$ErrorActionPreference = \'Stop\'')
    expect(command).toContain('$dialog.Dispose()')
    expect(command).not.toContain('选择工作区目录')
  })

  it('maps cancellation onto null and propagates process failures', async () => {
    await expect(pickWindowsUnicodeDirectory(
      'Select Workspace Directory', 'powershell.exe', async () => ({ stdout: '', stderr: '' }),
    )).resolves.toBeNull()
    await expect(pickWindowsUnicodeDirectory(
      'Select Workspace Directory', 'powershell.exe', async () => { throw new Error('PowerShell failed') },
    )).rejects.toThrow('PowerShell failed')
  })

  it.each([
    ['not base64!', 'invalid Base64 path'],
    [Buffer.from([65]).toString('base64'), 'invalid UTF-16 path'],
    [Buffer.from('relative\\目录', 'utf16le').toString('base64'), 'invalid absolute path'],
    [Buffer.from('C:\\测试\0目录', 'utf16le').toString('base64'), 'invalid absolute path'],
  ])('rejects malformed carrier %s', async (stdout, message) => {
    await expect(pickWindowsUnicodeDirectory(
      'Select Workspace Directory', 'powershell.exe', async () => ({ stdout, stderr: '' }),
    )).rejects.toThrow(message)
  })
})
