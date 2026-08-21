import { describe, expect, it } from 'vitest'
import {
  DESKTOP_BOOT_RECOVERY_SCRIPT,
  DESKTOP_BOOT_RECOVERY_STYLE,
  DESKTOP_BOOT_TERMINAL_STYLE,
  DESKTOP_BOOT_TERMINAL_SCRIPT,
  DESKTOP_TERMINAL_OPEN_REQUEST,
  desktopBootRecoveryInjections,
} from '../src/desktop-boot-recovery.ts'

describe('Desktop early-boot recovery injection', () => {
  it('injects a bilingual terminal action through the exact empty-body endpoint', () => {
    expect(desktopBootRecoveryInjections()).toEqual([
      { kind: 'style', text: DESKTOP_BOOT_RECOVERY_STYLE },
      { kind: 'script', placement: 'body', text: DESKTOP_BOOT_RECOVERY_SCRIPT },
    ])
    expect(DESKTOP_BOOT_TERMINAL_STYLE).toBe(DESKTOP_BOOT_RECOVERY_STYLE)
    expect(DESKTOP_BOOT_TERMINAL_SCRIPT).toBe(DESKTOP_BOOT_RECOVERY_SCRIPT)
    expect(DESKTOP_BOOT_TERMINAL_SCRIPT).toContain('Failed to load plugins')
    expect(DESKTOP_BOOT_TERMINAL_SCRIPT).toContain('打开 DSH 终端 / Open DSH Terminal')
    expect(DESKTOP_BOOT_TERMINAL_SCRIPT).toContain('/api/desktop/terminal/open')
    expect(DESKTOP_BOOT_TERMINAL_SCRIPT).toContain(JSON.stringify(DESKTOP_TERMINAL_OPEN_REQUEST))
    expect(DESKTOP_BOOT_TERMINAL_SCRIPT).toContain('/api/desktop/diagnostics/export')
    expect(DESKTOP_BOOT_TERMINAL_SCRIPT).toContain('/api/desktop/profiles/rollback')
    expect(DESKTOP_BOOT_TERMINAL_SCRIPT).toContain('/api/desktop/profiles/create-window')
    expect(DESKTOP_BOOT_TERMINAL_SCRIPT).toContain('/api/desktop/profiles/select')
    expect(DESKTOP_BOOT_TERMINAL_SCRIPT).toContain('运行回滚 / Run Rollback')
    expect(DESKTOP_BOOT_TERMINAL_SCRIPT).not.toContain('command')
    expect(DESKTOP_BOOT_TERMINAL_SCRIPT).not.toContain('style.cssText')
    expect(DESKTOP_BOOT_TERMINAL_STYLE).toContain('[data-dsh-desktop-recovery]')
    expect(DESKTOP_BOOT_TERMINAL_STYLE).toContain('--dsw-alias-button-primary-fill')
    expect(DESKTOP_BOOT_TERMINAL_STYLE).toContain('border-radius: 18px')
    expect(DESKTOP_BOOT_TERMINAL_STYLE).toContain(':focus-visible')
    expect(DESKTOP_BOOT_TERMINAL_STYLE).toContain('prefers-color-scheme: dark')
    expect(() => Function(DESKTOP_BOOT_RECOVERY_SCRIPT)).not.toThrow()
  })
})
