import { describe, expect, it } from 'vitest'
import {
  effectiveDesktopWindowMaterial,
  parseMacosWindowMaterial,
  parseWindowsWindowMaterial,
} from '../src/window-material.ts'

describe('desktop window material capabilities', () => {
  it('keeps platform preferences portable and always renders Windows opaque', () => {
    expect(effectiveDesktopWindowMaterial('compatibility', 'win32', 'transparent')).toBe('off')
    expect(effectiveDesktopWindowMaterial('extended', 'win32', 'transparent')).toBe('off')
    expect(effectiveDesktopWindowMaterial('advanced', 'win32', 'transparent')).toBe('off')
    expect(effectiveDesktopWindowMaterial('compatibility', 'darwin', 'transparent')).toBe('transparent')
    expect(effectiveDesktopWindowMaterial('extended', 'darwin', 'transparent')).toBe('transparent')
    expect(effectiveDesktopWindowMaterial('extended', 'darwin', 'off')).toBe('off')
  })

  it('validates persisted material values independently for each platform', () => {
    expect(parseMacosWindowMaterial(undefined)).toBe('transparent')
    expect(parseWindowsWindowMaterial(undefined)).toBe('off')
    expect(parseWindowsWindowMaterial('off')).toBe('off')
    // Removed Windows materials remain readable and fail closed to opaque.
    expect(parseWindowsWindowMaterial('acrylic')).toBe('off')
    expect(parseWindowsWindowMaterial('mica')).toBe('off')
    expect(() => parseMacosWindowMaterial('mica')).toThrow('macosMaterial')
    expect(() => parseWindowsWindowMaterial('transparent')).toThrow('windowsMaterial')
  })
})
