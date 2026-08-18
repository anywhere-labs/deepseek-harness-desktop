/** Headless decision table for failures raised while Electron main is starting. */

import type { DesktopStartupFailureStage } from './startup-recovery-window.ts'

export type DesktopStartupFailureRoute =
  | 'stderr-only'
  | 'protected-install-recovery'
  | 'last-known-good'
  | 'startup-recovery'

export interface DesktopStartupFailureContext {
  readonly appReady: boolean
  readonly stage: DesktopStartupFailureStage
  readonly verifyingProtectedInstall: boolean
  readonly profile?: {
    readonly active: string
    readonly lastKnownGood: string
  }
}

/**
 * Route one startup exception without inspecting its message. Error strings are
 * diagnostics, never authority for deciding whether Desktop may mutate state.
 */
export function routeDesktopStartupFailure(
  context: DesktopStartupFailureContext,
): DesktopStartupFailureRoute {
  if (!context.appReady) return 'stderr-only'
  if (context.verifyingProtectedInstall) return 'protected-install-recovery'
  if (context.profile !== undefined && context.profile.active !== context.profile.lastKnownGood) {
    return 'last-known-good'
  }
  return 'startup-recovery'
}
