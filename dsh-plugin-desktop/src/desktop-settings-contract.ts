/** Private same-origin Desktop settings API shared with the bundled renderer. */

import type { DesktopMarketProvider } from './desktop-market.ts'

/** Read the current Desktop-owned settings state. */
export const DESKTOP_SETTINGS_PATH = '/api/desktop/settings'

/** Create one safe Web profile without selecting it. */
export const DESKTOP_PROFILE_CREATE_PATH = '/api/desktop/profiles/create'

/** Select one compatible profile for the next Desktop generation. */
export const DESKTOP_PROFILE_SELECT_PATH = '/api/desktop/profiles/select'

/** Persist the Market provider selected for the next Desktop generation. */
export const DESKTOP_MARKET_SELECT_PATH = '/api/desktop/market/select'

/** Renderer-safe projection of one discovered profile. */
export interface DesktopSettingsProfileView {
  /** Profile name accepted by the launcher. */
  readonly name: string
  /** Whether its manifest already exists on disk. */
  readonly exists: boolean
  /** Whether it contains the Web application required by Desktop. */
  readonly webCapable: boolean
  /** Whether the launcher can select it. */
  readonly selectable: boolean
}

/** Requested and generation-effective Market provider state. */
export interface DesktopSettingsMarketView {
  /** Explicit or fail-safe provider requested on disk. */
  readonly requested: DesktopMarketProvider
  /** Provider composed into the currently running generation. */
  readonly effective: DesktopMarketProvider
  /** Whether an absent or invalid legacy state produced the fail-safe default. */
  readonly legacyDefaulted: boolean
}

/** Complete renderer-safe Desktop settings state. */
export interface DesktopSettingsResponse {
  /** Profile backing the currently running generation. */
  readonly current: string
  /** Fresh profile discovery without filesystem paths or manifest details. */
  readonly profiles: readonly DesktopSettingsProfileView[]
  /** Market choice for the current and next generation. */
  readonly market: DesktopSettingsMarketView
}

/** Exact body accepted by the profile-creation endpoint. */
export interface DesktopProfileCreateRequest {
  readonly name: string
}

/** Successful creation returns a fresh state that includes the new profile. */
export type DesktopProfileCreateResponse = DesktopSettingsResponse

/** Exact body accepted by the profile-selection endpoint. */
export interface DesktopProfileSelectRequest {
  readonly name: string
}

/** Successful persisted selection returned before the Host restarts. */
export interface DesktopRestartAcceptance {
  readonly accepted: true
  readonly restartRequired: boolean
}

/** Successful profile selection handoff. */
export type DesktopProfileSelectResponse = DesktopRestartAcceptance

/** Exact body accepted by the Market-provider endpoint. */
export interface DesktopMarketSelectRequest {
  readonly provider: DesktopMarketProvider
}

/** Successful Market selection handoff. */
export type DesktopMarketSelectResponse = DesktopRestartAcceptance

/** Stable API failure shape that never contains native paths or raw causes. */
export interface DesktopSettingsErrorResponse {
  readonly error: string
}
