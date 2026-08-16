/** Desktop software-update row registered in General settings. */

import type { PropsLocale, PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DesktopUpdateState } from '../update-contract.ts'
import type { DesktopUpdateKey } from './update-locales.ts'
import css from './UpdateRow.module.css'

/** Actions shared by the settings row and frame banner. */
export interface DesktopUpdateActions {
  /** Check the stable release channel. */
  readonly check: () => Promise<void>
  /** Download the available release. */
  readonly download: () => Promise<void>
  /** Cancel an active download. */
  readonly cancel: () => Promise<void>
  /** Restart into the downloaded release. */
  readonly install: () => Promise<void>
  /** Open the fixed latest-release page. */
  readonly openReleasePage: () => Promise<void>
}

/** Injected state hook and update actions. */
export interface DesktopUpdateInjected extends DesktopUpdateActions {
  /** Shared update snapshot hook. */
  useUpdate: SnapshotSelectorHook<DesktopUpdateState>
}

/** Full General-row props. */
export type UpdateRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.desktopUpdate'> & DesktopUpdateInjected

function assertNever(value: never): never {
  throw new Error(`unexpected desktop update value: ${String(value)}`)
}

function errorStatusKey(state: DesktopUpdateState): DesktopUpdateKey {
  const reason = state.errorReason ?? 'unknown'
  switch (reason) {
    case 'network-unavailable':
      return state.errorOperation === 'download' ? 'status.downloadNetworkError' : 'status.checkNetworkError'
    case 'release-unavailable': return 'status.releaseUnavailable'
    case 'insufficient-space': return 'status.insufficientSpace'
    case 'download-too-large': return 'status.downloadTooLarge'
    case 'download-cleanup': return 'status.downloadCleanup'
    case 'release-page-unavailable': return 'status.releasePageUnavailable'
    case 'unknown':
      if (state.errorOperation === 'download') return 'status.downloadUnknownError'
      if (state.errorOperation === 'install') return 'status.installUnknownError'
      return 'status.checkUnknownError'
    default: return assertNever(reason)
  }
}

/** Resolve localized status copy for every controller phase. */
export function updateStatusKey(state: DesktopUpdateState): DesktopUpdateKey {
  switch (state.phase) {
    case 'idle': return state.currentVersion === '' ? 'status.loading' : 'status.idle'
    case 'checking': return 'status.checking'
    case 'current': return 'status.current'
    case 'available': return state.installMode === 'automatic' ? 'status.available' : 'status.availableManual'
    case 'downloading': return 'status.downloading'
    case 'downloaded': return 'status.downloaded'
    case 'error': return errorStatusKey(state)
    case 'unsupported': return 'status.unsupported'
  }
}

function statusText(state: DesktopUpdateState, t: UpdateRowProps['t']): string {
  return t(updateStatusKey(state), {
    version: state.availableVersion ?? '',
    percent: Math.round(state.progress?.percent ?? 0),
  })
}

/** Resolve the primary action shown for one update snapshot. */
export function primaryUpdateAction(state: DesktopUpdateState): {
  readonly key: DesktopUpdateKey
  readonly operation: keyof DesktopUpdateActions
  readonly disabled?: boolean
} {
  switch (state.phase) {
    case 'checking': return { key: 'action.checking', operation: 'check', disabled: true }
    case 'available': return state.installMode === 'automatic'
      ? { key: 'action.download', operation: 'download' }
      : { key: 'action.release', operation: 'openReleasePage' }
    case 'downloading': return { key: 'action.cancel', operation: 'cancel' }
    case 'downloaded': return { key: 'action.install', operation: 'install' }
    case 'error':
      if (state.errorReason === 'release-unavailable'
        || state.errorReason === 'download-too-large'
        || state.errorReason === 'release-page-unavailable') {
        return { key: 'action.release', operation: 'openReleasePage' }
      }
      if (state.retryable === false) return { key: 'action.wait', operation: 'check', disabled: true }
      if (state.errorOperation === 'install') {
        return { key: 'action.retryInstall', operation: 'install' }
      }
      return state.errorOperation === 'download' && state.installMode === 'automatic'
        ? { key: 'action.retryDownload', operation: 'download' }
        : { key: 'action.retryCheck', operation: 'check' }
    case 'unsupported': return { key: 'action.release', operation: 'openReleasePage' }
    case 'idle': return { key: 'action.check', operation: 'check' }
    case 'current': return { key: 'action.recheck', operation: 'check' }
  }
}

/**
 * Render current version, update status, progress, and the phase action.
 * @param props - slot runtime, locale, state hook, and update actions.
 * @returns the General settings row.
 */
export function UpdateRow(props: UpdateRowProps) {
  const state = props.useUpdate(value => value)
  const action = primaryUpdateAction(state)
  const progress = state.phase === 'downloading' ? Math.round(state.progress?.percent ?? 0) : undefined
  return (
    <div className={css.row} data-update-phase={state.phase}>
      <div className={css.rowText}>
        <div className={css.title}>{props.t('title')}</div>
        {state.currentVersion !== '' && (
          <div className={css.version}>{props.t('version.current', { version: state.currentVersion })}</div>
        )}
        <div className={css.status}>{statusText(state, props.t)}</div>
        {progress !== undefined && (
          <div
            className={css.progressTrack}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div className={css.progressValue} style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
      <button
        type="button"
        className={css.action}
        disabled={action.disabled}
        onClick={() => { void props[action.operation]() }}
      >
        {props.t(action.key)}
      </button>
    </div>
  )
}
