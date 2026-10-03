import { openNativePath, revealNativePath, runNativeCommand } from '@deepseek-ai/dsh-native-command'
import { beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ execFile: vi.fn(), error: null as Error | null }))

vi.mock('node:child_process', () => ({ execFile: fixture.execFile }))

beforeEach(() => {
  fixture.error = null
  fixture.execFile.mockReset().mockImplementation((_command, _args, _options, callback) => {
    callback(fixture.error, '', '')
  })
})

it('opens Windows workspace directories without hiding Explorer', async () => {
  const signal = new AbortController().signal
  await openNativePath('C:\\项目 workspace\\repo', signal, { platform: 'win32' })
  expect(fixture.execFile).toHaveBeenCalledWith('explorer.exe', ['file:///C:/项目%20workspace/repo'],
    { encoding: 'utf8', signal, windowsHide: false }, expect.any(Function))
})

it('reveals Windows files without hiding Explorer', async () => {
  await revealNativePath('C:\\workspace\\file.txt', new AbortController().signal, { platform: 'win32' })
  expect(fixture.execFile).toHaveBeenCalledWith('explorer.exe', ['/select,', 'file:///C:/workspace/file.txt'],
    expect.objectContaining({ windowsHide: false }), expect.any(Function))
})

it('keeps GUI launchers visible', async () => {
  await runNativeCommand('explorer.exe', [], new AbortController().signal, 'visible')
  expect(fixture.execFile).toHaveBeenCalledWith('explorer.exe', [],
    expect.objectContaining({ windowsHide: false }), expect.any(Function))
})

it.each(['powershell.exe', 'reg.exe', 'wslpath'])(
  'still hides background commands: %s', async command => {
    await runNativeCommand(command, [], new AbortController().signal, 'hidden')
    expect(fixture.execFile).toHaveBeenCalledWith(command, [],
      expect.objectContaining({ windowsHide: true }), expect.any(Function))
  },
)

it('accepts Explorer handoff exit 1 but preserves other launch errors', async () => {
  fixture.error = Object.assign(new Error('delegated'), { code: 1 })
  await expect(openNativePath('C:\\workspace', new AbortController().signal, { platform: 'win32' })).resolves.toBeUndefined()
  fixture.error = Object.assign(new Error('missing'), { code: 'ENOENT' })
  await expect(openNativePath('C:\\workspace', new AbortController().signal, { platform: 'win32' })).rejects.toMatchObject({ code: 'ENOENT' })
})
