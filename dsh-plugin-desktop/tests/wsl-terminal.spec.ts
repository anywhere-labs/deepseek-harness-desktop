import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { openWslDesktopTerminal } from '../src/wsl-terminal.ts'

describe('WSL terminal launch', () => {
  it('passes every user value as an argv word after a constant shell program', () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawn = vi.fn(() => child as never)
    openWslDesktopTerminal({
      distribution: 'Ubuntu-24.04',
      homeDir: '/home/alice/dsh home',
      profileName: 'work profile',
      profileDir: '/home/alice/work project',
      runtimeRoot: '/home/alice/.local/share/dsh desktop/runtime/2.0.2',
      spawn: spawn as never,
      onLaunchError: vi.fn(),
    })
    const [executable, args, options] = spawn.mock.calls[0] as unknown as [string, string[], object]
    expect(executable).toBe('wt.exe')
    expect(args).toContain('Ubuntu-24.04')
    expect(args).toContain('/home/alice/work project')
    expect(args).toContain('work profile')
    expect(args.join(' ')).not.toContain("'/home/alice/work project'")
    expect(options).toMatchObject({ shell: false, detached: true })
  })
})
