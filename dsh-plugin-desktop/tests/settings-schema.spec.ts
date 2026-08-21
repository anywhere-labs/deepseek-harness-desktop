import { describe, expect, it } from 'vitest'
import { DesktopSettingsSchema, type DesktopSettings } from '../src/index.ts'

describe('DesktopSettingsSchema', () => {
  it('defaults the close behavior to tray mode', () => {
    const settings = DesktopSettingsSchema({} as DesktopSettings)
    expect(settings.closeBehavior).toBe('tray')
  })

  it('accepts an explicit quit close behavior', () => {
    const settings = DesktopSettingsSchema({ closeBehavior: 'quit' } as DesktopSettings)
    expect(settings.closeBehavior).toBe('quit')
  })
})
