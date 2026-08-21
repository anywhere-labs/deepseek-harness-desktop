import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_QUIT_FLAG, hasDesktopQuitFlag } from '../src/desktop-quit-flag.ts'

describe('desktop quit flag', () => {
  it('detects the installer-owned quit argument', () => {
    expect(DESKTOP_QUIT_FLAG).toBe('--quit')
    expect(hasDesktopQuitFlag(['DSH Desktop.exe', '--quit'])).toBe(true)
    expect(hasDesktopQuitFlag(['DSH Desktop.exe', '--updated', '--force-run'])).toBe(false)
    expect(hasDesktopQuitFlag(['DSH Desktop.exe'])).toBe(false)
  })

  it('is handled before the first instance shows a window', () => {
    const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8')
    const lock = main.indexOf('if (!app.requestSingleInstanceLock())')
    const earlyQuit = main.indexOf('if (hasDesktopQuitFlag(process.argv))')
    const secondInstance = main.indexOf("app.on('second-instance'")

    expect(lock).toBeGreaterThanOrEqual(0)
    expect(earlyQuit).toBeGreaterThan(lock)
    expect(secondInstance).toBeGreaterThan(earlyQuit)
    expect(main).toContain('hasDesktopQuitFlag(argv)')
    expect(main).toContain('requestQuit(0)')
  })
})
