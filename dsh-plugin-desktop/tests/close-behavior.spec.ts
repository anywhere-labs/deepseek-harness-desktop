import { describe, expect, it } from 'vitest'
import { resolveCloseAction } from '../src/close-behavior.ts'

describe('resolveCloseAction', () => {
  it('allows the close when the app is already quitting', () => {
    expect(resolveCloseAction({ isQuitting: true, closeBehavior: 'tray', trayAvailable: true })).toBe('allow')
    expect(resolveCloseAction({ isQuitting: true, closeBehavior: 'quit', trayAvailable: false })).toBe('allow')
  })

  it('hides to the tray for tray mode with an available tray', () => {
    expect(resolveCloseAction({ isQuitting: false, closeBehavior: 'tray', trayAvailable: true })).toBe('hide')
  })

  it('quits for explicit quit behavior regardless of tray availability', () => {
    expect(resolveCloseAction({ isQuitting: false, closeBehavior: 'quit', trayAvailable: true })).toBe('quit')
    expect(resolveCloseAction({ isQuitting: false, closeBehavior: 'quit', trayAvailable: false })).toBe('quit')
  })

  it('quits for tray mode when the tray is unavailable (degradation)', () => {
    expect(resolveCloseAction({ isQuitting: false, closeBehavior: 'tray', trayAvailable: false })).toBe('quit')
  })
})
