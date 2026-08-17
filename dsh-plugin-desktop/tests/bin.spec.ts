import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_CLI_HELP, parseDesktopCli, runDesktopCli } from '../src/bin.ts'

vi.mock('electron', () => ({ default: undefined }))

describe('desktop npm launcher', () => {
  it('launches with no arguments', () => {
    expect(parseDesktopCli([])).toBe('launch')
  })

  it.each([
    ['--help', 'help'],
    ['-h', 'help'],
    ['--version', 'version'],
    ['-V', 'version'],
  ] as const)('parses %s', (argument, action) => {
    expect(parseDesktopCli([argument])).toBe(action)
  })

  it('rejects arguments that belong to the profile app', () => {
    expect(() => parseDesktopCli(['--port', '3000'])).toThrow('unknown arguments')
  })

  it('names the installed product and selected profile behavior', () => {
    expect(DESKTOP_CLI_HELP).toContain('DSH Desktop')
    expect(DESKTOP_CLI_HELP).toContain('selected Web-capable profile')
  })

  it('reports a clear message when electron is missing', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const code = await runDesktopCli([])
      expect(code).toBe(1)
      expect(write).toHaveBeenCalledWith(expect.stringContaining('electron is not available'))
      expect(write).toHaveBeenCalledWith(expect.stringContaining('npm install -g dsh-plugin-desktop'))
    } finally {
      write.mockRestore()
    }
  })
})
