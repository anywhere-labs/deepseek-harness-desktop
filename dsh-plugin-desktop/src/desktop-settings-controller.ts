/** Launcher-backed controller for the private Desktop settings API. */

import type {
  DesktopMarketProvider,
  DesktopMarketSnapshot,
} from './desktop-market.ts'
import type { DesktopHostTargetSelection, DesktopHostTargetView } from './host-target.ts'
import type { DesktopProfileSummary } from './profile-manager.ts'
import type { DesktopProfiles } from './profile-service.ts'
import type {
  DesktopHostTargetSelectResponse,
  DesktopMarketSelectResponse,
  DesktopDiagnosticsExportResponse,
  DesktopProfileCreateResponse,
  DesktopProfileCreateWindowResponse,
  DesktopProfileDeleteResponse,
  DesktopProfileRollbackResponse,
  DesktopProfileSelectResponse,
  DesktopSettingsMarketView,
  DesktopSettingsProfileView,
  DesktopSettingsResponse,
  DesktopTerminalOpenResponse,
} from './desktop-settings-contract.ts'

/** Launcher capabilities used without exposing their filesystem roots. */
export interface DesktopSettingsControllerBootstrap {
  /** Generation-scoped profile service. */
  readonly profiles: Pick<DesktopProfiles, 'current' | 'list' | 'create'>
    & Partial<Pick<DesktopProfiles, 'canDelete' | 'delete'>>
  /** Persist one already-validated profile as pending without restarting. */
  persistProfileSelection(name: string): void | Promise<void>
  /** Read the latest persisted request and the startup-effective provider. */
  readMarket(): DesktopMarketSnapshot
  /** Persist an explicit provider request. */
  selectMarket(provider: DesktopMarketProvider): Promise<DesktopMarketSnapshot>
  /** Queue an orderly restart after a response confirms persisted selection. */
  scheduleRestart(): void
  /** Open the launcher-owned DSH terminal. */
  openTerminal(): void
  /** Export diagnostics through the launcher-owned privacy flow. */
  exportDiagnostics(): void | Promise<void>
  /** Open the isolated native Profile creator. */
  openProfileCreator(): void
  /** Prepare a last-known-good rollback without quiescing the Host yet. */
  prepareProfileRollback(): DesktopSettingsPostResponse<DesktopProfileRollbackResponse>
  /** Read native Host-target discovery without exposing persistence paths. */
  readHostTarget?(): DesktopHostTargetView
  /** Persist the complete Host location selected for the next generation. */
  selectHostTarget?(selection: DesktopHostTargetSelection): void | Promise<void>
}

/** A persisted response plus work that must run only after `res.end()`. */
export interface DesktopSettingsPostResponse<T extends object> {
  readonly response: T
  readonly afterResponse?: () => void
}

/** Remove paths, bundle identities, and parser diagnostics from a profile. */
export function projectDesktopSettingsProfile(
  profile: DesktopProfileSummary,
  deletable = false,
): DesktopSettingsProfileView {
  return Object.freeze({
    name: profile.name,
    exists: profile.exists,
    webCapable: profile.webCapable,
    selectable: profile.webCapable && profile.problem === undefined,
    deletable,
  })
}

function projectMarket(
  value: DesktopMarketSnapshot,
  effective: DesktopMarketProvider,
): DesktopSettingsMarketView {
  return Object.freeze({
    requested: value.requested,
    effective,
    legacyDefaulted: value.legacyDefaulted,
  })
}

/**
 * Generation-scoped controller for Profile and Market preferences.
 *
 * The provider composed at startup remains `effective` for this controller's
 * lifetime. Persisting another provider changes only `requested` until the
 * queued restart creates a new Host generation.
 */
export class DesktopSettingsController {
  private readonly effectiveMarket: DesktopMarketProvider
  private readonly effectiveHostTarget: DesktopHostTargetSelection | undefined

  constructor(private readonly bootstrap: DesktopSettingsControllerBootstrap) {
    this.effectiveMarket = bootstrap.readMarket().effective
    this.effectiveHostTarget = bootstrap.readHostTarget?.().current
  }

  /** Read a fresh, renderer-safe settings projection. */
  read(): DesktopSettingsResponse {
    return Object.freeze({
      current: this.bootstrap.profiles.current.name,
      profiles: Object.freeze(
        this.bootstrap.profiles.list().map(profile => projectDesktopSettingsProfile(
          profile,
          this.bootstrap.profiles.canDelete?.(profile.name) ?? false,
        )),
      ),
      market: projectMarket(this.bootstrap.readMarket(), this.effectiveMarket),
      ...(this.bootstrap.readHostTarget === undefined
        ? {}
        : { hostTarget: this.bootstrap.readHostTarget() }),
    })
  }

  /** Create one safe profile without selecting it or requesting restart. */
  createProfile(name: string): DesktopProfileCreateResponse {
    this.bootstrap.profiles.create(name)
    return this.read()
  }

  /** Delete one inactive user profile and return the fresh settings state. */
  async deleteProfile(name: string): Promise<DesktopProfileDeleteResponse> {
    if (this.bootstrap.profiles.delete === undefined) {
      throw new Error('dsh-plugin-desktop: profile deletion is unavailable')
    }
    await this.bootstrap.profiles.delete(name)
    return this.read()
  }

  /** Persist a fresh compatible profile, deferring restart until after response. */
  async selectProfile(
    name: string,
  ): Promise<DesktopSettingsPostResponse<DesktopProfileSelectResponse>> {
    const restartRequired = name !== this.bootstrap.profiles.current.name
    if (restartRequired) {
      const profile = this.bootstrap.profiles.list().find(candidate => candidate.name === name)
      if (profile === undefined || !profile.webCapable || profile.problem !== undefined) {
        throw new Error(`dsh-plugin-desktop: profile ${JSON.stringify(name)} is not selectable`)
      }
      await this.bootstrap.persistProfileSelection(name)
    }
    return Object.freeze({
      response: Object.freeze({ accepted: true, restartRequired }),
      ...(restartRequired ? { afterResponse: () => { this.bootstrap.scheduleRestart() } } : {}),
    })
  }

  /** Persist a provider and defer restart until after the response is ended. */
  async selectMarket(
    provider: DesktopMarketProvider,
  ): Promise<DesktopSettingsPostResponse<DesktopMarketSelectResponse>> {
    await this.bootstrap.selectMarket(provider)
    const restartRequired = provider !== this.effectiveMarket
    return Object.freeze({
      response: Object.freeze({ accepted: true, restartRequired }),
      ...(restartRequired ? { afterResponse: () => { this.bootstrap.scheduleRestart() } } : {}),
    })
  }

  /** Persist a complete Host target and restart after the response is committed. */
  async selectHostTarget(
    selection: DesktopHostTargetSelection,
  ): Promise<DesktopSettingsPostResponse<DesktopHostTargetSelectResponse>> {
    if (this.bootstrap.selectHostTarget === undefined || this.effectiveHostTarget === undefined) {
      throw new Error('dsh-plugin-desktop: Host target switching is unavailable')
    }
    const restartRequired = this.effectiveHostTarget.mode !== selection.mode
      || (this.effectiveHostTarget.mode === 'wsl'
        && selection.mode === 'wsl'
        && this.effectiveHostTarget.distribution !== selection.distribution)
    if (restartRequired) await this.bootstrap.selectHostTarget(selection)
    return Object.freeze({
      response: Object.freeze({ accepted: true, restartRequired }),
      ...(restartRequired ? { afterResponse: () => { this.bootstrap.scheduleRestart() } } : {}),
    })
  }

  /** Open the native terminal through the launcher-owned action. */
  openTerminal(): DesktopTerminalOpenResponse {
    this.bootstrap.openTerminal()
    return Object.freeze({ accepted: true })
  }

  /** Export diagnostics through the native confirmation and reveal flow. */
  async exportDiagnostics(): Promise<DesktopDiagnosticsExportResponse> {
    await this.bootstrap.exportDiagnostics()
    return Object.freeze({ accepted: true })
  }

  /** Open the native creator that creates, selects, and restarts safely. */
  openProfileCreator(): DesktopProfileCreateWindowResponse {
    this.bootstrap.openProfileCreator()
    return Object.freeze({ accepted: true })
  }

  /** Hand off a validated rollback that starts only after the HTTP response. */
  rollbackProfile(): DesktopSettingsPostResponse<DesktopProfileRollbackResponse> {
    return this.bootstrap.prepareProfileRollback()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned controller behind the private loopback settings API. */
    desktopSettingsController: DesktopSettingsController
  }
}

export default DesktopSettingsController
