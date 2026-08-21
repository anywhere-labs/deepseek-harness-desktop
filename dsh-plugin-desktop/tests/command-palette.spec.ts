import { describe, expect, it, vi } from 'vitest'
import { collectPaletteCommands, isPaletteToggleEvent } from '../src/command-palette.ts'
import { en, zh } from '../src/client/locales.ts'

describe('command palette', () => {
  it('navigates sessions and workspaces without owning conversation', () => {
    const onNewSession = vi.fn()
    const onOpenSession = vi.fn()
    const onForkSession = vi.fn()
    const onSearch = vi.fn()
    const commands = collectPaletteCommands({
      sessions: [
        { id: 's1', displayTitle: 'Fix login', blank: false },
        { id: 's2', displayTitle: 'blank', blank: true },
      ],
      workspaces: [{ id: 'w1', title: 'desktop' }],
      currentSessionId: 's1',
      query: '',
      onNewSession,
      onOpenSession,
      onForkSession,
      onSearch,
    })
    expect(commands.map(command => command.id)).toEqual([
      'session.new',
      'session.fork',
      'session.open.s1',
      'workspace.session.w1',
    ])
    commands.find(command => command.id === 'session.open.s1')?.run()
    expect(onOpenSession).toHaveBeenCalledWith('s1')
    expect(onNewSession).not.toHaveBeenCalled()
  })

  it('filters by query and toggles on Mod+K', () => {
    const commands = collectPaletteCommands({
      sessions: [{ id: 's1', displayTitle: 'Fix login', blank: false }],
      workspaces: [],
      query: 'login',
      onNewSession: () => {},
      onOpenSession: () => {},
      onForkSession: () => {},
      onSearch: () => {},
    })
    expect(commands.some(command => command.id === 'session.search')).toBe(true)
    expect(commands.some(command => command.id === 'session.open.s1')).toBe(true)
    expect(isPaletteToggleEvent({ key: 'k', metaKey: true, ctrlKey: false, altKey: false, repeat: false })).toBe(true)
    expect(isPaletteToggleEvent({ key: 'k', metaKey: false, ctrlKey: true, altKey: false, repeat: false })).toBe(true)
    expect(isPaletteToggleEvent({ key: 'k', metaKey: true, ctrlKey: false, altKey: false, repeat: true })).toBe(false)
  })

  it('keeps palette locale keys aligned', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(zh.remoteBody).toContain('像素流')
    expect(en.remoteBody).toContain('pixel stream')
  })
})
