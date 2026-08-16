/** Browser controller adapting the fixed loopback update RPC to a snapshot store. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import {
  DESKTOP_UPDATE_RPC_CHANNEL,
  parseDesktopUpdateState,
  type DesktopUpdateOperation,
  type DesktopUpdateRpcMethod,
  type DesktopUpdateState,
} from '../update-contract.ts'

/** Delay between local state refreshes while the renderer is active. */
export const UPDATE_STATE_POLL_INTERVAL_MS = 5_000

const INITIAL_STATE: DesktopUpdateState = Object.freeze({
  phase: 'idle',
  currentVersion: '',
  installMode: 'unsupported',
})

function createUpdateStore(init: DesktopUpdateState): SnapshotStore<DesktopUpdateState> {
  let state = init
  const listeners = new Set<() => void>()
  const set = (next: DesktopUpdateState): void => {
    state = Object.freeze(next)
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(mutator) {
      const next = { ...state }
      mutator(next)
      set(next)
    },
    set,
  }
}

/** Client-side update state and actions. */
export interface DesktopUpdateClientController {
  /** Observable update state used by the settings row and frame banner. */
  readonly store: SnapshotStore<DesktopUpdateState>
  /** Check for a stable release. */
  check(): Promise<void>
  /** Download the discovered release. */
  download(): Promise<void>
  /** Cancel the active update download. */
  cancel(): Promise<void>
  /** Stop the Host and install the downloaded release. */
  install(): Promise<void>
  /** Open the fixed latest-release page. */
  openReleasePage(): Promise<void>
  /** Stop polling and ignore later operation results. */
  dispose(): void
}

/**
 * Create one controller over the existing same-origin Connection transport.
 * @param rpc - browser Connection RPC caller.
 * @param pollIntervalMs - local refresh cadence.
 * @returns shared state and actions for the desktop update UI.
 */
export function createDesktopUpdateClientController(
  rpc: ClientConnectionRpc,
  pollIntervalMs = UPDATE_STATE_POLL_INTERVAL_MS,
): DesktopUpdateClientController {
  const store = createUpdateStore(INITIAL_STATE)
  let disposed = false
  let operation: Promise<void> | undefined
  let localFailure = false

  const adopt = (state: DesktopUpdateState): void => {
    if (!disposed) store.set(state)
  }

  const call = async (method: DesktopUpdateRpcMethod): Promise<DesktopUpdateState> => {
    const result = await rpc.call(DESKTOP_UPDATE_RPC_CHANNEL, method, {})
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return parseDesktopUpdateState(result.value)
  }

  const fail = (failed: DesktopUpdateOperation): void => {
    localFailure = true
    const prior = store.getSnapshot()
    adopt({
      phase: 'error',
      currentVersion: prior.currentVersion,
      installMode: prior.installMode,
      ...(prior.availableVersion === undefined ? {} : { availableVersion: prior.availableVersion }),
      errorOperation: failed,
      errorReason: 'unknown',
    })
  }

  const run = (method: Exclude<DesktopUpdateRpcMethod, 'state' | 'open-release-page'>): Promise<void> => {
    if (operation !== undefined) return operation
    localFailure = false
    operation = call(method).then(adopt).catch(() => {
      fail(method === 'download' || method === 'cancel'
        ? 'download'
        : method === 'install' ? 'install' : 'check')
    }).finally(() => { operation = undefined })
    return operation
  }

  const refresh = async (surfaceFailure: boolean): Promise<void> => {
    if (operation !== undefined || disposed || localFailure) return
    try {
      adopt(await call('state'))
    } catch {
      if (surfaceFailure) fail('check')
    }
  }

  void refresh(true)
  const timer = setInterval(() => { void refresh(false) }, pollIntervalMs)

  return {
    store,
    check: async () => { await run('check') },
    download: async () => { await run('download') },
    cancel: async () => { await run('cancel') },
    install: async () => { await run('install') },
    openReleasePage: async () => {
      localFailure = false
      try {
        const result = await rpc.call(DESKTOP_UPDATE_RPC_CHANNEL, 'open-release-page', {})
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        adopt(await call('state'))
      } catch (error) {
        console.error('desktop update release page failed to open:', error)
        localFailure = true
        const prior = store.getSnapshot()
        adopt({
          phase: 'error',
          currentVersion: prior.currentVersion,
          installMode: prior.installMode,
          ...(prior.availableVersion === undefined ? {} : { availableVersion: prior.availableVersion }),
          errorOperation: 'check',
          errorReason: 'release-page-unavailable',
        })
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(timer)
    },
  }
}
