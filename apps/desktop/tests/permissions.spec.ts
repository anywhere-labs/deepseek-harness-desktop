import { describe, expect, it } from 'vitest'
import { ALLOWED_RENDERER_PERMISSIONS, isAllowedPermission } from '../src/permissions.ts'

describe('desktop renderer permission policy', () => {
  it('allows the sanitized clipboard write used by Web UI copy controls', () => {
    expect(ALLOWED_RENDERER_PERMISSIONS.has('clipboard-sanitized-write')).toBe(true)
    expect(isAllowedPermission('clipboard-sanitized-write')).toBe(true)
  })

  it('denies every other permission, including raw clipboard access', () => {
    for (const permission of [
      'clipboard-read',
      'clipboard-write',
      'media',
      'geolocation',
      'notifications',
      'fullscreen',
      'pointerLock',
      'display-capture',
      'unknown-future-permission',
    ]) {
      expect(isAllowedPermission(permission)).toBe(false)
    }
  })

  it('rejects an empty permission name', () => {
    expect(isAllowedPermission('')).toBe(false)
  })
})
