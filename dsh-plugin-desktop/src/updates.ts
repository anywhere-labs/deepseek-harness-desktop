/** Cordis Host plugin for scheduled and interactive GitHub desktop updates. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from './runtime.ts'
import { createDesktopUpdateController } from './update-controller.ts'
import {
  DESKTOP_UPDATE_RPC_CHANNEL,
  type DesktopUpdateRpcMethod,
  type DesktopUpdateState,
} from './update-contract.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-updates'

/** Native and loopback services required for update coordination. */
export const inject = ['desktopRuntime', 'connection']

const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Scheduled update policy. */
export interface Config {
  /** Enable background checks in packaged applications. */
  enabled: boolean
  /** Delay before the first background check after plugin activation. */
  initialDelayMs: number
  /** Delay between completion of one background check and the next attempt. */
  intervalMs: number
}

/** Validated scheduled update policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(60_000),
  intervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(6 * 60 * 60 * 1000),
})

/**
 * Register update polling, the loopback RPC channel, and its dynamic tray command.
 * @param ctx - Host context carrying the native updater and Connection transport.
 * @param config - validated polling values.
 */
export function apply(ctx: Context, config: Config): void {
  const adapter = ctx.desktopRuntime.updates
  ctx.effect(() => {
    let disposed = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let notifiedAvailableVersion: string | undefined
    let notifiedDownloadedVersion: string | undefined

    const controller = createDesktopUpdateController({
      currentVersion: adapter.currentVersion,
      installMode: adapter.installMode,
      ...(adapter.updater === undefined ? {} : { updater: adapter.updater }),
      createCancellation: adapter.createCancellation,
      requestInstall: adapter.requestInstall,
    })

    const invokeTray = async (): Promise<void> => {
      const state = controller.getState()
      if (state.phase === 'available') {
        if (state.installMode === 'automatic') await controller.download()
        else await adapter.openReleasePage()
        return
      }
      if (state.phase === 'downloading') {
        await controller.cancel()
        return
      }
      if (state.phase === 'downloaded') {
        await controller.install()
        return
      }
      if (state.phase === 'unsupported') {
        await adapter.openReleasePage()
        return
      }
      await controller.check()
    }

    const registration = ctx.desktopRuntime.registerTrayItem({
      group: 'status',
      order: 10,
      label: () => trayLabel(controller.getState()),
      invoke: invokeTray,
    })

    const stopObserving = controller.subscribe((state) => {
      registration.refresh()
      if (state.phase === 'available'
        && state.availableVersion !== undefined
        && notifiedAvailableVersion !== state.availableVersion) {
        notifiedAvailableVersion = state.availableVersion
        adapter.notify({
          title: 'DSH Desktop Update Available',
          body: `Version ${state.availableVersion} is ready to download.`,
        })
      }
      if (state.phase === 'downloaded'
        && state.availableVersion !== undefined
        && notifiedDownloadedVersion !== state.availableVersion) {
        notifiedDownloadedVersion = state.availableVersion
        adapter.notify({
          title: 'DSH Desktop Update Ready',
          body: `Restart DSH Desktop to install version ${state.availableVersion}.`,
        })
      }
    })

    const rpcDispose = ctx.connection.rpc.handle(
      DESKTOP_UPDATE_RPC_CHANNEL,
      async (endpoint, payload) => handleUpdateRpc(
        endpoint,
        payload,
        controller,
        adapter.openReleasePage,
      ),
      { authority: 'loopback' },
    )

    const runBackgroundCheck = async (): Promise<void> => {
      if (disposed || !controller.canCheck) return
      await controller.check()
    }

    const scheduleBackgroundCheck = (delayMs: number): void => {
      pollTimer = setTimeout(() => {
        pollTimer = undefined
        void runBackgroundCheck().finally(() => {
          if (!disposed) scheduleBackgroundCheck(config.intervalMs)
        })
      }, delayMs)
    }

    if (adapter.isPackaged && config.enabled && controller.canCheck) {
      scheduleBackgroundCheck(config.initialDelayMs)
    }

    return async () => {
      disposed = true
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      stopObserving()
      registration.dispose()
      await rpcDispose()
      await controller.dispose()
    }
  }, 'dsh-plugin-desktop: GitHub update polling, RPC, and installer handoff')
}

function trayLabel(state: DesktopUpdateState): string {
  switch (state.phase) {
    case 'idle': return 'Check for Updates…'
    case 'checking': return 'Checking for Updates…'
    case 'current': return 'DSH Desktop Is Up to Date'
    case 'available': return `DSH Desktop ${state.availableVersion ?? ''} Available`
    case 'downloading': return `Downloading DSH Desktop ${state.availableVersion ?? ''}…`
    case 'downloaded': return `Restart to Install ${state.availableVersion ?? 'Update'}`
    case 'error': return state.errorOperation === 'download' ? 'Retry Update Download…' : 'Retry Update Check…'
    case 'unsupported': return 'View DSH Desktop Releases…'
  }
}

async function handleUpdateRpc(
  endpoint: string,
  payload: unknown,
  controller: ReturnType<typeof createDesktopUpdateController>,
  openReleasePage: () => Promise<void>,
) {
  if (!isEmptyRecord(payload)) return badRequest('desktop update actions accept no payload fields')
  switch (endpoint as DesktopUpdateRpcMethod) {
    case 'state': return success(controller.getState())
    case 'check': return success(await controller.check())
    case 'download': return success(await controller.download())
    case 'cancel': return success(await controller.cancel())
    case 'install': return success(await controller.install())
    case 'open-release-page':
      await openReleasePage()
      return success(null)
    default: return badRequest(`unknown desktop update action ${JSON.stringify(endpoint)}`)
  }
}

function success<T>(value: T) {
  return { ok: true as const, value }
}

function badRequest(message: string) {
  return {
    ok: false as const,
    error: { code: 'bad-request' as const, message, details: { issues: [] } },
  }
}

function isEmptyRecord(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 0
}
