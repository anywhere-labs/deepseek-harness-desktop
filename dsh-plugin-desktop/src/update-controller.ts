/** Event-driven desktop update state machine independent from Electron imports. */

import type {
  DesktopUpdateErrorReason,
  DesktopUpdateInstallMode,
  DesktopUpdateOperation,
  DesktopUpdateProgress,
  DesktopUpdateState,
} from './update-contract.ts'

/** Cancellation token face needed by the update downloader. */
export interface UpdateCancellation {
  /** Request cancellation of the current download. */
  cancel(): void
}

/** Stable update details emitted by the provider. */
export interface ProviderUpdateInfo {
  /** Release version. */
  readonly version: string
  /** Installation capability declared by the target release metadata. */
  readonly desktopUpdateMode?: unknown
  /** Provider files used to enforce the automatic-download size policy. */
  readonly files?: readonly { readonly size?: unknown }[]
}

/** Progress fields emitted by electron-updater. */
interface ProviderDownloadProgress {
  /** Completed percentage. */
  readonly percent: number
  /** Bytes received. */
  readonly transferred: number
  /** Total bytes. */
  readonly total: number
}

/** Narrow updater adapter that never exposes downloaded paths to the browser. */
export interface DesktopUpdaterAdapter {
  /** Register one provider event listener. */
  on(event: string, listener: (...args: unknown[]) => void): void
  /** Remove one provider event listener. */
  off(event: string, listener: (...args: unknown[]) => void): void
  /** Query the stable configured channel. */
  checkForUpdates(): Promise<{ readonly updateInfo?: ProviderUpdateInfo } | null>
  /** Download the selected update. */
  downloadUpdate(cancellation: UpdateCancellation, expectedBytes: number): Promise<void>
}

/** Dependencies for one controller instance. */
export interface DesktopUpdateControllerOptions {
  /** Running application version. */
  readonly currentVersion: string
  /** Installation support encoded into this artifact. */
  readonly installMode: DesktopUpdateInstallMode
  /** Provider adapter; absent for unsupported environments. */
  readonly updater?: DesktopUpdaterAdapter
  /** Construct a fresh token for each download. */
  readonly createCancellation?: () => UpdateCancellation
  /** Begin the shared desktop update-exit lifecycle. */
  readonly requestInstall?: () => Promise<void>
}

/** Public update controller used by RPC and application scheduling. */
export interface DesktopUpdateController {
  /** Whether scheduled checks can run. */
  readonly canCheck: boolean
  /** Read the current immutable snapshot. */
  getState(): DesktopUpdateState
  /** Subscribe to future immutable snapshots. */
  subscribe(listener: (state: DesktopUpdateState) => void): () => void
  /** Query the configured update provider. */
  check(): Promise<DesktopUpdateState>
  /** Download the available update. */
  download(): Promise<DesktopUpdateState>
  /** Cancel the active download. */
  cancel(): Promise<DesktopUpdateState>
  /** Enter the update-specific desktop exit sequence. */
  install(): Promise<DesktopUpdateState>
  /** Release provider listeners and cancel any active transfer. */
  dispose(): Promise<void>
}

const EVENT_NAMES = [
  'checking-for-update',
  'update-available',
  'update-not-available',
  'download-progress',
  'update-downloaded',
  'update-cancelled',
  'error',
] as const

/** Hard byte ceiling for one automatic update artifact. */
export const MAX_AUTOMATIC_UPDATE_BYTES = 1024 * 1024 * 1024

/** Maximum wait for provider cancellation cleanup. */
export const DOWNLOAD_CANCEL_SETTLE_TIMEOUT_MS = 15_000

const NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK',
  'ETIMEDOUT',
])

/** Main-process failure with a browser-safe update category. */
export class DesktopUpdateFailure extends Error {
  /** Browser-safe failure category. */
  readonly reason: DesktopUpdateErrorReason

  /**
   * Create a categorized update failure.
   * @param reason - Browser-safe failure category.
   * @param message - Diagnostic retained in the Host log.
   */
  constructor(reason: DesktopUpdateErrorReason, message: string) {
    super(message)
    this.name = 'DesktopUpdateFailure'
    this.reason = reason
  }
}

function errorFacts(error: unknown): {
  readonly codes: ReadonlySet<string>
  readonly statuses: ReadonlySet<number>
  readonly text: string
} {
  const codes = new Set<string>()
  const statuses = new Set<number>()
  const text: string[] = []
  const seen = new Set<object>()
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'string') {
      text.push(current)
      break
    }
    if (typeof current !== 'object' || seen.has(current)) break
    seen.add(current)
    const record = current as Record<string, unknown>
    for (const key of ['name', 'message'] as const) {
      if (typeof record[key] === 'string') text.push(record[key])
    }
    if (typeof record.code === 'string') codes.add(record.code.toUpperCase())
    const status = typeof record.statusCode === 'number' ? record.statusCode : record.status
    if (typeof status === 'number' && Number.isInteger(status)) statuses.add(status)
    current = record.cause
  }
  return { codes, statuses, text: text.join(' ').toLowerCase() }
}

/** Map provider errors onto copy-safe user actions. */
export function desktopUpdateErrorReason(
  operation: DesktopUpdateOperation,
  error: unknown,
): DesktopUpdateErrorReason {
  if (error instanceof DesktopUpdateFailure) return error.reason
  const facts = errorFacts(error)
  if (facts.text.includes('insufficient disk space') || facts.codes.has('ENOSPC')) return 'insufficient-space'
  if (operation === 'check' && (
    facts.codes.has('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')
    || facts.statuses.has(404)
    || (facts.text.includes('404') && (facts.text.includes('latest-mac.yml') || facts.text.includes('latest.yml')))
  )) return 'release-unavailable'
  if ([...facts.codes].some(code => NETWORK_ERROR_CODES.has(code))
    || facts.text.includes('getaddrinfo')
    || facts.text.includes('network is offline')
    || facts.text.includes('net::err_')
    || facts.text.includes('socket hang up')
    || facts.text.includes('timed out')) return 'network-unavailable'
  return 'unknown'
}

function progressSnapshot(value: ProviderDownloadProgress): DesktopUpdateProgress {
  return Object.freeze({
    percent: Math.max(0, Math.min(100, value.percent)),
    transferred: Math.max(0, value.transferred),
    total: Math.max(0, value.total),
  })
}

/**
 * Create the desktop update state machine.
 * @param options - Version, artifact capability, provider, and install lifecycle.
 * @returns A single-flight controller with ordered provider-event handling.
 */
export function createDesktopUpdateController(
  options: DesktopUpdateControllerOptions,
): DesktopUpdateController {
  const updater = options.updater
  const supported = updater !== undefined && options.installMode !== 'unsupported'
  const artifactInstallMode = options.installMode
  let state: DesktopUpdateState = Object.freeze({
    phase: supported ? 'idle' : 'unsupported',
    currentVersion: options.currentVersion,
    installMode: options.installMode,
  })
  const listeners = new Set<(snapshot: DesktopUpdateState) => void>()
  const providerListeners = new Map<string, (...args: unknown[]) => void>()
  let checkPromise: Promise<DesktopUpdateState> | undefined
  let downloadPromise: Promise<DesktopUpdateState> | undefined
  let installPromise: Promise<DesktopUpdateState> | undefined
  let cancellation: UpdateCancellation | undefined
  let cancellationRequested = false
  let cancellationFailure: DesktopUpdateFailure | undefined
  let checkActive = false
  let downloadedSnapshot: DesktopUpdateState | undefined
  let availableDownloadSize: number | undefined
  let downloadedVersion: string | undefined

  const publish = (next: DesktopUpdateState): DesktopUpdateState => {
    state = Object.freeze(next)
    for (const listener of [...listeners]) {
      try {
        listener(state)
      } catch (error) {
        console.error('desktop update state listener failed:', error)
      }
    }
    return state
  }

  const fail = (operation: DesktopUpdateOperation, error: unknown): DesktopUpdateState => {
    console.error(`desktop update ${operation} failed:`, error)
    if (operation === 'check' && downloadedSnapshot !== undefined) return publish(downloadedSnapshot)
    const reason = desktopUpdateErrorReason(operation, error)
    return publish({
      phase: 'error',
      currentVersion: state.currentVersion,
      installMode: reason === 'download-too-large' ? 'manual' : state.installMode,
      ...(state.availableVersion === undefined ? {} : { availableVersion: state.availableVersion }),
      errorReason: reason,
      errorOperation: operation,
      ...((reason === 'download-too-large' || reason === 'download-cleanup') ? { retryable: false } : {}),
    })
  }

  const downloadSize = (info: ProviderUpdateInfo): number | undefined => {
    const sizes = info.files?.map(file => file.size).filter((size): size is number =>
      typeof size === 'number' && Number.isFinite(size)) ?? []
    return sizes.length === 0 ? undefined : Math.max(...sizes)
  }

  const availableInstallMode = (info: ProviderUpdateInfo): DesktopUpdateInstallMode => {
    const size = downloadSize(info)
    return artifactInstallMode === 'automatic'
      && info.desktopUpdateMode === 'automatic'
      && size !== undefined && size > 0 && size <= MAX_AUTOMATIC_UPDATE_BYTES
      ? 'automatic'
      : artifactInstallMode === 'unsupported' ? 'unsupported' : 'manual'
  }

  const publishAvailable = (info: ProviderUpdateInfo): DesktopUpdateState => {
    const installMode = availableInstallMode(info)
    availableDownloadSize = installMode === 'automatic' ? downloadSize(info) : undefined
    if (downloadedSnapshot?.availableVersion === info.version && installMode === 'automatic') {
      return publish(downloadedSnapshot)
    }
    downloadedSnapshot = undefined
    return publish({
      phase: 'available',
      currentVersion: state.currentVersion,
      availableVersion: info.version,
      installMode,
    })
  }

  const publishCurrent = (): DesktopUpdateState => {
    downloadedSnapshot = undefined
    availableDownloadSize = undefined
    return publish({ phase: 'current', currentVersion: state.currentVersion, installMode: artifactInstallMode })
  }

  const publishDownloaded = (availableVersion: string | undefined): DesktopUpdateState => {
    downloadedSnapshot = publish({
      phase: 'downloaded',
      currentVersion: state.currentVersion,
      ...(availableVersion === undefined ? {} : { availableVersion }),
      installMode: state.installMode,
      progress: Object.freeze({
        percent: 100,
        transferred: state.progress?.total ?? 0,
        total: state.progress?.total ?? 0,
      }),
    })
    return downloadedSnapshot
  }

  const bind = (event: string, listener: (...args: unknown[]) => void): void => {
    providerListeners.set(event, listener)
    updater?.on(event, listener)
  }

  if (supported) {
    bind('checking-for-update', () => {
      if (!checkActive) return
      publish({ phase: 'checking', currentVersion: state.currentVersion, installMode: state.installMode })
    })
    bind('update-available', (raw) => {
      if (!checkActive) return
      checkActive = false
      publishAvailable(raw as ProviderUpdateInfo)
    })
    bind('update-not-available', () => {
      if (!checkActive) return
      checkActive = false
      publishCurrent()
    })
    bind('download-progress', (raw) => {
      if (state.phase !== 'downloading' || cancellationRequested) return
      const progress = raw as ProviderDownloadProgress
      if (progress.transferred > MAX_AUTOMATIC_UPDATE_BYTES) {
        cancellationRequested = true
        cancellationFailure = new DesktopUpdateFailure(
          'download-too-large',
          'The update exceeded the automatic download limit.',
        )
        cancellation?.cancel()
        return
      }
      publish({ ...state, progress: progressSnapshot(progress) })
    })
    bind('update-downloaded', (raw) => {
      if (state.phase !== 'downloading' || cancellationRequested) return
      const info = raw as ProviderUpdateInfo
      downloadedVersion = info.version || state.availableVersion
    })
    bind('update-cancelled', () => {
      if (state.phase === 'downloading') cancellation = undefined
    })
    bind('error', (error) => {
      if (checkActive) {
        checkActive = false
        fail('check', error)
      } else if (state.phase === 'downloading') {
        cancellation = undefined
        if (!cancellationRequested) fail('download', error)
      }
    })
  }

  const check = (): Promise<DesktopUpdateState> => {
    if (!supported) return Promise.resolve(state)
    if (checkPromise !== undefined) return checkPromise
    if (downloadPromise !== undefined) return Promise.resolve(state)
    checkActive = true
    publish({ phase: 'checking', currentVersion: state.currentVersion, installMode: artifactInstallMode })
    checkPromise = updater.checkForUpdates().then((result) => {
      if (!checkActive) return state
      checkActive = false
      const info = result?.updateInfo
      return info === undefined ? publishCurrent() : publishAvailable(info)
    }).catch((error: unknown) => {
      if (!checkActive) return state
      checkActive = false
      return fail('check', error)
    }).finally(() => { checkPromise = undefined })
    return checkPromise
  }

  const download = (): Promise<DesktopUpdateState> => {
    if (downloadPromise !== undefined) return downloadPromise
    if (updater === undefined || state.installMode !== 'automatic' || options.createCancellation === undefined
      || availableDownloadSize === undefined
      || (state.phase !== 'available' && !(state.phase === 'error' && state.errorOperation === 'download'))) {
      return Promise.resolve(state)
    }
    const token = options.createCancellation()
    cancellation = token
    cancellationRequested = false
    cancellationFailure = undefined
    downloadedVersion = undefined
    downloadedSnapshot = undefined
    publish({
      phase: 'downloading',
      currentVersion: state.currentVersion,
      ...(state.availableVersion === undefined ? {} : { availableVersion: state.availableVersion }),
      installMode: state.installMode,
      progress: Object.freeze({ percent: 0, transferred: 0, total: 0 }),
    })
    downloadPromise = (async () => {
      try {
        await updater.downloadUpdate(token, availableDownloadSize)
        if (state.phase === 'downloading') publishDownloaded(downloadedVersion ?? state.availableVersion)
      } catch (error) {
        if (state.phase === 'downloading' && !cancellationRequested) fail('download', error)
      } finally {
        cancellation = undefined
        if (cancellationRequested) {
          if (cancellationFailure !== undefined) fail('download', cancellationFailure)
          else {
            publish({
              phase: 'available',
              currentVersion: state.currentVersion,
              ...(state.availableVersion === undefined ? {} : { availableVersion: state.availableVersion }),
              installMode: state.installMode,
            })
          }
        }
        downloadPromise = undefined
        cancellationRequested = false
        cancellationFailure = undefined
        downloadedVersion = undefined
      }
      return state
    })()
    return downloadPromise
  }

  const waitForDownloadSettlement = async (): Promise<boolean> => {
    const activeDownload = downloadPromise
    if (activeDownload === undefined) return true
    let timeout!: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<false>((resolve) => {
      timeout = setTimeout(() => { resolve(false) }, DOWNLOAD_CANCEL_SETTLE_TIMEOUT_MS)
    })
    const settled = await Promise.race([activeDownload.then(() => true), timeoutPromise])
    clearTimeout(timeout)
    return settled
  }

  const cancel = async (): Promise<DesktopUpdateState> => {
    if (state.phase !== 'downloading') return state
    if (!cancellationRequested) {
      cancellationRequested = true
      cancellation?.cancel()
    }
    if (await waitForDownloadSettlement()) return state
    cancellationFailure = new DesktopUpdateFailure(
      'download-cleanup',
      'Update cancellation cleanup timed out.',
    )
    return fail('download', cancellationFailure)
  }

  const install = (): Promise<DesktopUpdateState> => {
    if (state.phase !== 'downloaded' || state.installMode !== 'automatic' || options.requestInstall === undefined) {
      return Promise.resolve(state)
    }
    installPromise ??= options.requestInstall().then(() => state).finally(() => { installPromise = undefined })
    return installPromise
  }

  return {
    canCheck: supported,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    check,
    download,
    cancel,
    install,
    async dispose() {
      listeners.clear()
      if (downloadPromise !== undefined) {
        cancellationRequested = true
        cancellation?.cancel()
        const settled = await waitForDownloadSettlement()
        if (!settled) console.error('desktop update cancellation cleanup timed out')
      }
      cancellation = undefined
      for (const event of EVENT_NAMES) {
        const listener = providerListeners.get(event)
        if (listener !== undefined) updater?.off(event, listener)
      }
      providerListeners.clear()
    },
  }
}
