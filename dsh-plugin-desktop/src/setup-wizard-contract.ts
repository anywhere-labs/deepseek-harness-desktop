/** Data contract shared by the isolated native Setup Wizard and its owner. */

export type DesktopSetupWizardPlatform = 'darwin' | 'win32' | 'linux'
export type DesktopSetupWizardMode = 'compatibility' | 'extended' | 'advanced'
export type DesktopSetupWizardMacosMaterial = 'off' | 'transparent'
/** Windows has no selectable material; Setup always keeps the opaque window. */
export type DesktopSetupWizardWindowsMaterial = 'off'
export type DesktopSetupWizardNetworkExposure = 'loopback' | 'lan'
export type DesktopSetupWizardMarket = 'disabled' | 'community-market' | 'dsh-market'

export interface DesktopSetupWizardNotifications {
  readonly enabled: boolean
  readonly notifyOnTurnCompletion: boolean
  readonly notifyOnTurnFailure: boolean
  readonly notifyOnJobCompletion: boolean
  readonly notifyOnJobFailure: boolean
  readonly notifyOnScheduleCompletion: boolean
  readonly notifyOnScheduleFailure: boolean
}

/** Every value the launcher needs to persist after Setup completes. */
export interface DesktopSetupWizardSelection {
  readonly mode: DesktopSetupWizardMode
  readonly macosMaterial: DesktopSetupWizardMacosMaterial
  readonly windowsMaterial: DesktopSetupWizardWindowsMaterial
  readonly openBrowser: boolean
  readonly networkExposure: DesktopSetupWizardNetworkExposure
  readonly aaEnabled?: boolean
  readonly market: DesktopSetupWizardMarket
  readonly notifications: DesktopSetupWizardNotifications
}

/** Fixed capabilities and current values supplied when Desktop setup is opened. */
export interface DesktopSetupWizardInput extends DesktopSetupWizardSelection {
  readonly appVersion: string
  readonly profileName: string
  readonly platform: DesktopSetupWizardPlatform
}

export type DesktopSetupWizardResult =
  | { readonly action: 'complete'; readonly selection: DesktopSetupWizardSelection }
  | { readonly action: 'skip' }
  | { readonly action: 'quit' }

const SELECTION_KEYS = Object.freeze([
  'mode',
  'macosMaterial',
  'windowsMaterial',
  'openBrowser',
  'networkExposure',
  'aaEnabled',
  'market',
  'notifications',
] as const)
const INPUT_KEYS = Object.freeze([
  ...SELECTION_KEYS,
  'appVersion',
  'profileName',
  'platform',
] as const)
const NOTIFICATION_KEYS = Object.freeze([
  'enabled',
  'notifyOnTurnCompletion',
  'notifyOnTurnFailure',
  'notifyOnJobCompletion',
  'notifyOnJobFailure',
  'notifyOnScheduleCompletion',
  'notifyOnScheduleFailure',
] as const)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(expected.includes('aaEnabled') ? { aaEnabled: false, ...value } : value)
  return actual.length === expected.length && actual.every(key => expected.includes(key))
}

function isMode(value: unknown): value is DesktopSetupWizardMode {
  return value === 'compatibility' || value === 'extended' || value === 'advanced'
}

function isMacosMaterial(value: unknown): value is DesktopSetupWizardMacosMaterial {
  return value === 'off' || value === 'transparent'
}

function isWindowsMaterial(value: unknown): value is DesktopSetupWizardWindowsMaterial {
  return value === 'off'
}

function isNetworkExposure(value: unknown): value is DesktopSetupWizardNetworkExposure {
  return value === 'loopback' || value === 'lan'
}

function isMarket(value: unknown): value is DesktopSetupWizardMarket {
  return value === 'disabled' || value === 'community-market' || value === 'dsh-market'
}

function isPlatform(value: unknown): value is DesktopSetupWizardPlatform {
  return value === 'darwin' || value === 'win32' || value === 'linux'
}

export function isDesktopSetupWizardNotifications(
  value: unknown,
): value is DesktopSetupWizardNotifications {
  return isObject(value)
    && hasExactKeys(value, NOTIFICATION_KEYS)
    && NOTIFICATION_KEYS.every(key => typeof value[key] === 'boolean')
}

function hasSelectionValues(value: Record<string, unknown>): boolean {
  return (value.aaEnabled === undefined || typeof value.aaEnabled === 'boolean')
    && isMode(value.mode)
    && isMacosMaterial(value.macosMaterial)
    && isWindowsMaterial(value.windowsMaterial)
    && typeof value.openBrowser === 'boolean'
    && isNetworkExposure(value.networkExposure)
    && isMarket(value.market)
    && isDesktopSetupWizardNotifications(value.notifications)
}

/** Strictly validate a renderer-supplied complete selection. */
export function isDesktopSetupWizardSelection(
  value: unknown,
): value is DesktopSetupWizardSelection {
  return isObject(value)
    && hasExactKeys(value, SELECTION_KEYS)
    && hasSelectionValues(value)
}

/** Strictly validate the bounded JSON state loaded by the local document. */
export function isDesktopSetupWizardInput(value: unknown): value is DesktopSetupWizardInput {
  if (!isObject(value) || !hasExactKeys(value, INPUT_KEYS) || !hasSelectionValues(value)) {
    return false
  }
  return typeof value.appVersion === 'string'
    && value.appVersion.length > 0
    && value.appVersion.length <= 128
    && /^[0-9A-Za-z.+-]+$/u.test(value.appVersion)
    && typeof value.profileName === 'string'
    && value.profileName.length > 0
    && new TextEncoder().encode(value.profileName).byteLength <= 255
    && !value.profileName.includes('/')
    && !value.profileName.includes('\\')
    && value.profileName !== '.'
    && value.profileName !== '..'
    && value.profileName !== 'node_modules'
    && !/[\0-\x1f\x7f-\x9f]/u.test(value.profileName)
    && !/[<>:"|?*]/u.test(value.profileName)
    && !/[. ]$/u.test(value.profileName)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(value.profileName)
    && isPlatform(value.platform)
}

/** Reject selections the current platform cannot actually present. */
export function desktopSetupWizardSelectionIsAvailable(
  selection: DesktopSetupWizardSelection,
  capabilities: Pick<DesktopSetupWizardInput, 'platform'>,
): boolean {
  if (selection.openBrowser && selection.mode !== 'compatibility') return false
  if (!selection.openBrowser && selection.networkExposure === 'lan') return false
  return capabilities.platform !== 'linux' || selection.mode === 'compatibility'
}

/** LAN always needs a fresh confirmation when moving away from loopback-only access. */
export function desktopSetupWizardRequiresLanConfirmation(
  current: DesktopSetupWizardNetworkExposure,
  requested: DesktopSetupWizardNetworkExposure,
): boolean {
  return current === 'loopback' && requested === 'lan'
}

/** A first-run Wizard must record a fresh acknowledgement before it can expose LAN. */
export function desktopSetupWizardRequiresLanAcknowledgement(
  current: DesktopSetupWizardNetworkExposure,
  requested: DesktopSetupWizardNetworkExposure,
  acknowledged: boolean,
): boolean {
  return requested === 'lan'
    && (!acknowledged || desktopSetupWizardRequiresLanConfirmation(current, requested))
}

/** Freeze a complete result before it crosses back into launcher orchestration. */
export function freezeDesktopSetupWizardSelection(
  selection: DesktopSetupWizardSelection,
): DesktopSetupWizardSelection {
  const notifications = Object.freeze({ ...selection.notifications })
  return Object.freeze({ ...selection, notifications })
}
