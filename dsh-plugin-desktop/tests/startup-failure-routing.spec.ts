import { describe, expect, it } from 'vitest'
import {
  routeDesktopStartupFailure,
  type DesktopStartupFailureContext,
} from '../src/startup-failure-routing.ts'
import type { DesktopStartupFailureStage } from '../src/startup-recovery-window.ts'

const STAGES: readonly DesktopStartupFailureStage[] = [
  'electron-ready',
  'shell-environment',
  'runtime-bootstrap',
  'profile-selection',
  'install-recovery',
  'profile-composition',
  'host-boot',
  'renderer-startup',
  'health-commit',
]

function context(
  overrides: Partial<DesktopStartupFailureContext> = {},
): DesktopStartupFailureContext {
  return {
    appReady: true,
    stage: 'profile-composition',
    verifyingProtectedInstall: false,
    ...overrides,
  }
}

describe('Desktop startup failure routing', () => {
  it('routes every Electron-ready stage to the native recovery window by default', () => {
    for (const stage of STAGES) {
      expect(routeDesktopStartupFailure(context({ stage }))).toBe('startup-recovery')
    }
  })

  it('uses stderr when Electron cannot create a safe native window', () => {
    for (const stage of STAGES) {
      expect(routeDesktopStartupFailure(context({ appReady: false, stage }))).toBe('stderr-only')
    }
  })

  it('keeps protected install recovery ahead of profile fallback', () => {
    expect(routeDesktopStartupFailure(context({
      verifyingProtectedInstall: true,
      profile: { active: 'candidate', lastKnownGood: 'desktop' },
    }))).toBe('protected-install-recovery')
  })

  it('falls back only from an unconfirmed profile and otherwise opens recovery', () => {
    expect(routeDesktopStartupFailure(context({
      profile: { active: 'candidate', lastKnownGood: 'desktop' },
    }))).toBe('last-known-good')
    expect(routeDesktopStartupFailure(context({
      profile: { active: 'desktop', lastKnownGood: 'desktop' },
    }))).toBe('startup-recovery')
  })
})
