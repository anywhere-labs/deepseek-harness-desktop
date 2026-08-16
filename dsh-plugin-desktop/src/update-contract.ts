/** JSON-safe contracts shared by the desktop Host and browser client. */

/** Fixed loopback RPC channel used by the desktop update client. */
export const DESKTOP_UPDATE_RPC_CHANNEL = '/desktop-updates'

/** Public page used for manual updates and unsupported platforms. */
export const DESKTOP_RELEASE_URL = 'https://github.com/anywhere-labs/deepseek-harness-desktop/releases/latest'

/** Update-controller phases exposed to the browser client. */
export type DesktopUpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

/** Installation capability of the running and selected artifacts. */
export type DesktopUpdateInstallMode = 'automatic' | 'manual' | 'unsupported'

/** Operation whose failure is represented by an error snapshot. */
export type DesktopUpdateOperation = 'check' | 'download' | 'install'

/** User-actionable category for an update failure. */
export type DesktopUpdateErrorReason =
  | 'network-unavailable'
  | 'release-unavailable'
  | 'insufficient-space'
  | 'download-too-large'
  | 'download-cleanup'
  | 'release-page-unavailable'
  | 'unknown'

/** Download progress without local file paths. */
export interface DesktopUpdateProgress {
  /** Completed percentage in the inclusive 0-100 range. */
  readonly percent: number
  /** Bytes received so far. */
  readonly transferred: number
  /** Total bytes reported by the update provider. */
  readonly total: number
}

/** Immutable update snapshot returned through the loopback RPC channel. */
export interface DesktopUpdateState {
  /** Current controller phase. */
  readonly phase: DesktopUpdatePhase
  /** Version of the running application. */
  readonly currentVersion: string
  /** Latest stable version when one has been discovered. */
  readonly availableVersion?: string
  /** Current download progress. */
  readonly progress?: DesktopUpdateProgress
  /** Whether this build and release can perform an in-app installation. */
  readonly installMode: DesktopUpdateInstallMode
  /** User-actionable category for the latest failure. */
  readonly errorReason?: DesktopUpdateErrorReason
  /** Failed operation used to select the retry action. */
  readonly errorOperation?: DesktopUpdateOperation
  /** Whether the failed operation can be retried immediately. */
  readonly retryable?: boolean
}

/** Update actions accepted by the fixed RPC channel. */
export type DesktopUpdateRpcMethod =
  | 'state'
  | 'check'
  | 'download'
  | 'cancel'
  | 'install'
  | 'open-release-page'

/** Validate and copy one update snapshot received across the RPC boundary. */
export function parseDesktopUpdateState(value: unknown): DesktopUpdateState {
  if (!isRecord(value)
    || !isPhase(value.phase)
    || typeof value.currentVersion !== 'string'
    || !isInstallMode(value.installMode)
    || (value.availableVersion !== undefined && typeof value.availableVersion !== 'string')
    || (value.errorReason !== undefined && !isErrorReason(value.errorReason))
    || (value.errorOperation !== undefined && !isOperation(value.errorOperation))
    || (value.retryable !== undefined && typeof value.retryable !== 'boolean')
    || (value.progress !== undefined && !isProgress(value.progress))) {
    throw new Error('desktop update RPC returned an invalid snapshot')
  }
  return {
    phase: value.phase,
    currentVersion: value.currentVersion,
    installMode: value.installMode,
    ...(value.availableVersion === undefined ? {} : { availableVersion: value.availableVersion }),
    ...(value.progress === undefined ? {} : { progress: { ...value.progress } }),
    ...(value.errorReason === undefined ? {} : { errorReason: value.errorReason }),
    ...(value.errorOperation === undefined ? {} : { errorOperation: value.errorOperation }),
    ...(value.retryable === undefined ? {} : { retryable: value.retryable }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPhase(value: unknown): value is DesktopUpdatePhase {
  return value === 'idle' || value === 'checking' || value === 'current'
    || value === 'available' || value === 'downloading' || value === 'downloaded'
    || value === 'error' || value === 'unsupported'
}

function isInstallMode(value: unknown): value is DesktopUpdateInstallMode {
  return value === 'automatic' || value === 'manual' || value === 'unsupported'
}

function isOperation(value: unknown): value is DesktopUpdateOperation {
  return value === 'check' || value === 'download' || value === 'install'
}

function isErrorReason(value: unknown): value is DesktopUpdateErrorReason {
  return value === 'network-unavailable' || value === 'release-unavailable'
    || value === 'insufficient-space' || value === 'download-too-large'
    || value === 'download-cleanup' || value === 'release-page-unavailable'
    || value === 'unknown'
}

function isProgress(value: unknown): value is DesktopUpdateProgress {
  return isRecord(value)
    && typeof value.percent === 'number' && Number.isFinite(value.percent)
    && typeof value.transferred === 'number' && Number.isFinite(value.transferred)
    && typeof value.total === 'number' && Number.isFinite(value.total)
}
