/** Launcher-backed controller for the private Desktop settings API. */

import type {
  DesktopMarketProvider,
  DesktopMarketSnapshot,
} from './desktop-market.ts'
import type { DesktopProfileSummary } from './profile-manager.ts'
import type { DesktopProfiles } from './profile-service.ts'
import type {
  DesktopMarketSelectResponse,
  DesktopProfileCreateResponse,
  DesktopProfileSelectResponse,
  DesktopSettingsMarketView,
  DesktopSettingsProfileView,
  DesktopSettingsResponse,
} from './desktop-settings-contract.ts'

/** Launcher capabilities used without exposing their filesystem roots. */
export interface DesktopSettingsControllerBootstrap {
  /** Generation-scoped profile service. */
  readonly profiles: Pick<DesktopProfiles, 'current' | 'list' | 'create'>
  /** Persist one already-validated profile as pending without restarting. */
  persistProfileSelection(name: string): void | Promise<void>
  /** Read the latest persisted request and the startup-effective provider. */
  readMarket(): DesktopMarketSnapshot
  /** Persist an explicit provider request. */
  selectMarket(provider: DesktopMarketProvider): Promise<DesktopMarketSnapshot>
  /** Queue an orderly restart after a response confirms persisted selection. */
  scheduleRestart(): void
}

/** A persisted response plus work that must run only after `res.end()`. */
export interface DesktopSettingsPostResponse<T extends object> {
  readonly response: T
  readonly afterResponse?: () => void
}

/** Remove paths, bundle identities, and parser diagnostics from a profile. */
export function projectDesktopSettingsProfile(
  profile: DesktopProfileSummary,
): DesktopSettingsProfileView {
  return Object.freeze({
    name: profile.name,
    exists: profile.exists,
    webCapable: profile.webCapable,
    selectable: profile.webCapable && profile.problem === undefined,
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

  constructor(private readonly bootstrap: DesktopSettingsControllerBootstrap) {
    this.effectiveMarket = bootstrap.readMarket().effective
  }

  /** Read a fresh, renderer-safe settings projection. */
  read(): DesktopSettingsResponse {
    return Object.freeze({
      current: this.bootstrap.profiles.current.name,
      profiles: Object.freeze(
        this.bootstrap.profiles.list().map(projectDesktopSettingsProfile),
      ),
      market: projectMarket(this.bootstrap.readMarket(), this.effectiveMarket),
    })
  }

  /** Create one safe profile without selecting it or requesting restart. */
  createProfile(name: string): DesktopProfileCreateResponse {
    this.bootstrap.profiles.create(name)
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
}

export default DesktopSettingsController
