/** Same-origin browser client for launcher-owned Desktop settings operations. */

const SETTINGS_PATH = '/api/desktop/settings'
const PROFILE_CREATE_PATH = '/api/desktop/profiles/create'
const PROFILE_SELECT_PATH = '/api/desktop/profiles/select'
const PROFILE_DELETE_PATH = '/api/desktop/profiles/delete'
const MARKET_SELECT_PATH = '/api/desktop/market/select'
const HOST_TARGET_SELECT_PATH = '/api/desktop/host-target/select'
const TERMINAL_OPEN_PATH = '/api/desktop/terminal/open'
const MAX_PROFILES = 256
const MAX_PROFILE_NAME_LENGTH = 255
const MAX_DISTRIBUTIONS = 128

/** Launcher-supported plugin market implementations. */
export type DesktopMarketProvider = 'disabled' | 'community-market' | 'dsh-market'

/** Safe profile projection returned to the renderer. */
export interface DesktopProfileView {
  readonly name: string
  readonly exists: boolean
  readonly webCapable: boolean
  readonly selectable: boolean
  readonly deletable: boolean
}

/** Market selection fixed for the running generation. */
export interface DesktopMarketView {
  readonly requested: DesktopMarketProvider
  readonly effective: DesktopMarketProvider
  readonly legacyDefaulted: boolean
}

/** Process boundary that owns the complete DSH Host generation. */
export type DesktopHostTargetSelection =
  | Readonly<{ mode: 'local' }>
  | Readonly<{ mode: 'wsl', distribution: string }>

/** Renderer-safe native discovery for Host target selection. */
export interface DesktopHostTargetView {
  readonly current: DesktopHostTargetSelection
  readonly distributions: readonly string[]
  readonly wslSupported: boolean
  readonly problem?: string
}

/** Complete launcher-owned settings projection. */
export interface DesktopSettingsView {
  readonly current: string
  readonly profiles: readonly DesktopProfileView[]
  readonly market: DesktopMarketView
  readonly hostTarget?: DesktopHostTargetView
}

/** A persisted selection that requires a new Desktop generation. */
export interface DesktopRestartAcceptance {
  readonly accepted: true
  readonly restartRequired: boolean
}

/** Browser operations consumed by the Desktop settings section. */
export interface DesktopSettingsApi {
  read(): Promise<DesktopSettingsView>
  createProfile(name: string): Promise<DesktopSettingsView>
  selectProfile(name: string): Promise<DesktopRestartAcceptance>
  deleteProfile(name: string): Promise<DesktopSettingsView>
  selectMarket(provider: DesktopMarketProvider): Promise<DesktopRestartAcceptance>
  selectHostTarget(selection: DesktopHostTargetSelection): Promise<DesktopRestartAcceptance>
  openTerminal(): Promise<void>
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMarketProvider(value: unknown): value is DesktopMarketProvider {
  return value === 'disabled' || value === 'community-market' || value === 'dsh-market'
}

function parseProfile(value: unknown): DesktopProfileView {
  if (!isObject(value)
    || typeof value.name !== 'string'
    || value.name.length === 0
    || value.name.length > MAX_PROFILE_NAME_LENGTH
    || typeof value.exists !== 'boolean'
    || typeof value.webCapable !== 'boolean'
    || typeof value.selectable !== 'boolean'
    || typeof value.deletable !== 'boolean') {
    throw new Error('dsh-plugin-desktop: invalid profile settings response')
  }
  return Object.freeze({
    name: value.name,
    exists: value.exists,
    webCapable: value.webCapable,
    selectable: value.selectable,
    deletable: value.deletable,
  })
}

function parseDistributionName(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 128
    || value.trim() !== value
    || /[\0\r\n]/u.test(value)) {
    throw new Error('dsh-plugin-desktop: invalid WSL distribution in settings response')
  }
  return value
}

function parseHostTargetSelection(value: unknown): DesktopHostTargetSelection {
  if (!isObject(value)) throw new Error('dsh-plugin-desktop: invalid Host target in settings response')
  if (value.mode === 'local' && value.distribution === undefined) return Object.freeze({ mode: 'local' })
  if (value.mode === 'wsl') {
    return Object.freeze({ mode: 'wsl', distribution: parseDistributionName(value.distribution) })
  }
  throw new Error('dsh-plugin-desktop: invalid Host target in settings response')
}

function parseHostTarget(value: unknown): DesktopHostTargetView {
  if (!isObject(value)
    || !Array.isArray(value.distributions)
    || value.distributions.length > MAX_DISTRIBUTIONS
    || typeof value.wslSupported !== 'boolean'
    || (value.problem !== undefined && (typeof value.problem !== 'string' || value.problem.length > 1024))) {
    throw new Error('dsh-plugin-desktop: invalid Host target settings response')
  }
  const distributions = value.distributions.map(parseDistributionName)
  if (new Set(distributions).size !== distributions.length || (!value.wslSupported && distributions.length > 0)) {
    throw new Error('dsh-plugin-desktop: invalid Host target settings response')
  }
  return Object.freeze({
    current: parseHostTargetSelection(value.current),
    distributions: Object.freeze(distributions),
    wslSupported: value.wslSupported,
    ...(value.problem === undefined ? {} : { problem: value.problem as string }),
  })
}

/** Validate the bounded settings projection before it reaches React state. */
export function parseDesktopSettingsView(value: unknown): DesktopSettingsView {
  if (!isObject(value)
    || typeof value.current !== 'string'
    || value.current.length === 0
    || value.current.length > MAX_PROFILE_NAME_LENGTH
    || !Array.isArray(value.profiles)
    || value.profiles.length > MAX_PROFILES
    || !isObject(value.market)
    || !isMarketProvider(value.market.requested)
    || !isMarketProvider(value.market.effective)
    || typeof value.market.legacyDefaulted !== 'boolean') {
    throw new Error('dsh-plugin-desktop: invalid Desktop settings response')
  }
  const profiles = value.profiles.map(parseProfile)
  if (new Set(profiles.map(profile => profile.name)).size !== profiles.length) {
    throw new Error('dsh-plugin-desktop: duplicate profile in settings response')
  }
  return Object.freeze({
    current: value.current,
    profiles: Object.freeze(profiles),
    market: Object.freeze({
      requested: value.market.requested,
      effective: value.market.effective,
      legacyDefaulted: value.market.legacyDefaulted,
    }),
    ...(value.hostTarget === undefined
      ? {}
      : { hostTarget: parseHostTarget(value.hostTarget) }),
  })
}

/** Validate restart acknowledgement returned before the Host generation exits. */
export function parseDesktopRestartAcceptance(value: unknown): DesktopRestartAcceptance {
  if (!isObject(value) || value.accepted !== true || typeof value.restartRequired !== 'boolean') {
    throw new Error('dsh-plugin-desktop: invalid Desktop restart response')
  }
  return Object.freeze({ accepted: true, restartRequired: value.restartRequired })
}

/** Validate the exact acknowledgement returned by a Desktop side effect. */
export function parseDesktopActionAcceptance(value: unknown): void {
  if (!isObject(value)
    || Object.keys(value).length !== 1
    || value.accepted !== true) {
    throw new Error('dsh-plugin-desktop: invalid Desktop action response')
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`dsh-plugin-desktop: Desktop settings request failed (${String(response.status)})`)
  }
  try {
    return await response.json() as unknown
  } catch {
    throw new Error('dsh-plugin-desktop: Desktop settings response was not JSON')
  }
}

function post(fetcher: FetchLike, path: string, body: object): Promise<Response> {
  return fetcher(path, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

/** Construct the default same-origin API, with a fetch seam for focused tests. */
export function createDesktopSettingsApi(fetcher: FetchLike = globalThis.fetch.bind(globalThis)): DesktopSettingsApi {
  return Object.freeze({
    async read() {
      const response = await fetcher(SETTINGS_PATH, {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
      })
      return parseDesktopSettingsView(await readResponse(response))
    },
    async createProfile(name: string) {
      return parseDesktopSettingsView(await readResponse(await post(fetcher, PROFILE_CREATE_PATH, { name })))
    },
    async selectProfile(name: string) {
      return parseDesktopRestartAcceptance(await readResponse(await post(fetcher, PROFILE_SELECT_PATH, { name })))
    },
    async deleteProfile(name: string) {
      return parseDesktopSettingsView(await readResponse(await post(fetcher, PROFILE_DELETE_PATH, { name })))
    },
    async selectMarket(provider: DesktopMarketProvider) {
      return parseDesktopRestartAcceptance(await readResponse(await post(fetcher, MARKET_SELECT_PATH, { provider })))
    },
    async selectHostTarget(selection: DesktopHostTargetSelection) {
      return parseDesktopRestartAcceptance(await readResponse(await post(fetcher, HOST_TARGET_SELECT_PATH, selection)))
    },
    async openTerminal() {
      parseDesktopActionAcceptance(await readResponse(await post(fetcher, TERMINAL_OPEN_PATH, {})))
    },
  })
}

export const desktopSettingsPaths = Object.freeze({
  settings: SETTINGS_PATH,
  profileCreate: PROFILE_CREATE_PATH,
  profileSelect: PROFILE_SELECT_PATH,
  profileDelete: PROFILE_DELETE_PATH,
  marketSelect: MARKET_SELECT_PATH,
  hostTargetSelect: HOST_TARGET_SELECT_PATH,
  terminalOpen: TERMINAL_OPEN_PATH,
})
