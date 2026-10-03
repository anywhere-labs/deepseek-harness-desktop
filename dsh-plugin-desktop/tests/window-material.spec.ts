import { describe, expect, it } from 'vitest'
import {
  effectiveDesktopWindowMaterial,
  parseMacosWindowMaterial,
  parseWindowsWindowMaterial,
  parseLinuxWindowMaterial,
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

  it('resolves Linux generations from their own transparent-or-solid preference', () => {
    expect(effectiveDesktopWindowMaterial(
      'compatibility', 'linux', 'transparent', 'off',
    )).toBe('off')
    expect(effectiveDesktopWindowMaterial(
      'compatibility', 'linux', 'transparent', 'transparent',
    )).toBe('transparent')
    expect(effectiveDesktopWindowMaterial(
      'compatibility', 'linux', 'transparent',
    )).toBe('off')
  })

  it('validates persisted material values independently for each platform', () => {
    expect(parseMacosWindowMaterial(undefined)).toBe('transparent')
    expect(parseWindowsWindowMaterial(undefined)).toBe('off')
    expect(parseWindowsWindowMaterial('off')).toBe('off')
    // Removed Windows materials remain readable and fail closed to opaque.
    expect(parseWindowsWindowMaterial('acrylic')).toBe('off')
    expect(parseWindowsWindowMaterial('mica')).toBe('off')
    expect(parseLinuxWindowMaterial(undefined)).toBe('off')
    expect(parseLinuxWindowMaterial('transparent')).toBe('off')
    expect(() => parseLinuxWindowMaterial('mica')).toThrow('linuxMaterial')
    expect(() => parseMacosWindowMaterial('mica')).toThrow('macosMaterial')
    expect(() => parseWindowsWindowMaterial('transparent')).toThrow('windowsMaterial')
  })
})
