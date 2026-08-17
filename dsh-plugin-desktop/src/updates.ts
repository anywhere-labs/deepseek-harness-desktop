/** Cordis Host plugin for scheduled and interactive DSH Desktop updates. */

import { open } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import z from '@deepseek-ai/schemastery'
import type {} from './runtime.ts'
import { desktopTrayLabel } from './tray-locale.ts'
import {
  checkForStableUpdate,
  parseSemVer,
  type UpdateCheckResult,
} from './update-checker.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-updates'

/** Native adapter required for network, tray, confirmation, and installer access. */
export const inject = ['desktopRuntime']

const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_STATE_BYTES = 4 * 1024

/** Scheduled update policy. */
export interface Config {
  /** Enable background checks in packaged applications. */
  enabled: boolean
  /** Delay before the first background check after plugin activation. */
  initialDelayMs: number
  /** Delay between completion of one background check and the next attempt. */
  intervalMs: number
  /** Maximum duration of one version request before caller-owned cancellation. */
  requestTimeoutMs: number
}

/** Validated scheduled update policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(60_000),
  intervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(6 * 60 * 60 * 1000),
  requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
})

interface UpdateStateV2 {
  readonly version: 2
  readonly lastPromptedVersion?: string
}

const EMPTY_STATE: UpdateStateV2 = { version: 2 }

/**
 * Register effect-scoped update polling and its dynamic tray command.
 * @param ctx - Host context carrying the desktop native adapter.
 * @param config - validated polling and timeout values.
 */
export function apply(ctx: Context, config: Config): void {
  const adapter = ctx.desktopRuntime.updates
  ctx.effect(() => {
    let disposed = false
    let checking = false
    let availableVersion: string | undefined
    let downloadingVersion: string | undefined
    let state: UpdateStateV2 = EMPTY_STATE
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let requestTimer: ReturnType<typeof setTimeout> | undefined
    let requestController: AbortController | undefined
    let downloadController: AbortController | undefined
    let inFlight: Promise<UpdateCheckResult | null> | undefined
    let manualTask: Promise<void> | undefined
    let downloadTask: Promise<void> | undefined
    let refreshTray = (): void => {}

    const persistState = async (): Promise<void> => {
      try {
        await writeFileAtomic(adapter.statePath, renderState(state), {
          mode: 0o600,
          dirMode: 0o700,
        })
      } catch {
        // Update state is optional; failures must not affect application startup or user activity.
      }
    }

    const stateReady = (async () => {
      try {
        state = parseState(await readState(adapter.statePath))
      } catch (cause) {
        if (isEnoent(cause)) return
        state = EMPTY_STATE
        if (!disposed) await persistState()
      }
    })()

    const rememberPrompt = async (version: string): Promise<void> => {
      await stateReady
      if (state.lastPromptedVersion === version) return
      state = { version: 2, lastPromptedVersion: version }
      await persistState()
    }

    const startCheck = (): Promise<UpdateCheckResult | null> => {
      if (inFlight !== undefined) return inFlight
      checking = true
      refreshTray()
      const controller = new AbortController()
      requestController = controller

      const task = (async () => {
        requestTimer = setTimeout(() => { controller.abort() }, config.requestTimeoutMs)
        try {
          return await checkForStableUpdate({
            currentVersion: adapter.currentVersion,
            signal: controller.signal,
            request: adapter.request,
          })
        } catch {
          return null
        }
      })().finally(() => {
        if (requestTimer !== undefined) clearTimeout(requestTimer)
        requestTimer = undefined
        if (requestController === controller) requestController = undefined
        inFlight = undefined
        checking = false
        refreshTray()
      })
      inFlight = task
      return task
    }

    const observeResult = (result: UpdateCheckResult | null): string | undefined => {
      if (disposed || result === null) return undefined
      availableVersion = result.status === 'update-available' && adapter.canDownload
        ? result.latestVersion
        : undefined
      refreshTray()
      return availableVersion
    }

    const startDownload = (version: string): Promise<void> => {
      if (downloadTask !== undefined) return downloadTask
      const task = (async () => {
        let confirmed: boolean
        try {
          confirmed = await adapter.confirmDownload(version)
        } catch {
          return
        }
        if (!confirmed || disposed) return

        const confirmedVersion = observeResult(await startCheck())
        if (confirmedVersion !== version || disposed) return

        const controller = new AbortController()
        downloadController = controller
        downloadingVersion = version
        refreshTray()
        try {
          await adapter.downloadAndOpen(version, controller.signal)
        } catch {
          // Network, filesystem, and installer-opening failures are deliberately silent.
        } finally {
          if (downloadController === controller) downloadController = undefined
          downloadingVersion = undefined
          refreshTray()
        }
      })().finally(() => {
        if (downloadTask === task) downloadTask = undefined
      })
      downloadTask = task
      return task
    }

    const offerDownload = async (version: string, automatic: boolean): Promise<void> => {
      if (disposed || !adapter.canDownload) return
      await stateReady
      if (disposed || (automatic && state.lastPromptedVersion === version)) return
      await rememberPrompt(version)
      if (!disposed) await startDownload(version)
    }

    const runManualCheck = (): Promise<void> => {
      manualTask ??= (async () => {
        if (availableVersion !== undefined) {
          await offerDownload(availableVersion, false)
          return
        }
        const result = await startCheck()
        if (disposed) return
        const version = observeResult(result)
        if (version !== undefined) {
          await offerDownload(version, false)
          return
        }
        await adapter.showManualCheckResult(result)
      })().catch(() => undefined).finally(() => { manualTask = undefined })
      return manualTask
    }

    const runBackgroundCheck = async (): Promise<void> => {
      if (inFlight !== undefined || disposed) return
      try {
        const version = observeResult(await startCheck())
        if (version !== undefined) await offerDownload(version, true)
      } catch {
        // Scheduled checks never surface failures to the user or the application log.
      }
    }

    const scheduleBackgroundCheck = (delayMs: number): void => {
      pollTimer = setTimeout(() => {
        pollTimer = undefined
        void runBackgroundCheck().finally(() => {
          if (!disposed) scheduleBackgroundCheck(config.intervalMs)
        })
      }, delayMs)
    }

    const registration = ctx.desktopRuntime.registerTrayItem({
      group: 'status',
      order: 10,
      label: () => downloadingVersion === undefined
        ? availableVersion === undefined
          ? desktopTrayLabel(ctx.desktopRuntime.locale, checking ? 'checkingForUpdates' : 'checkForUpdates')
          : desktopTrayLabel(ctx.desktopRuntime.locale, 'updateAvailable', availableVersion)
        : desktopTrayLabel(ctx.desktopRuntime.locale, 'downloadingUpdate', downloadingVersion),
      invoke: runManualCheck,
    })
    refreshTray = registration.refresh

    if (adapter.isPackaged && config.enabled) scheduleBackgroundCheck(config.initialDelayMs)

    return async () => {
      disposed = true
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      if (requestTimer !== undefined) clearTimeout(requestTimer)
      requestController?.abort()
      downloadController?.abort()
      registration.dispose()
      // Native dialogs are not cancellable. Await only file state and the abortable version request.
      const pending: Promise<unknown>[] = [stateReady]
      if (inFlight !== undefined) pending.push(inFlight)
      await Promise.allSettled(pending)
    }
  }, 'dsh-plugin-desktop: update polling, confirmation, and installer handoff')
}

function parseState(text: string): UpdateStateV2 {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)
    || value.version !== 2
    || (value.lastPromptedVersion !== undefined && !isStableVersion(value.lastPromptedVersion))
    || Object.keys(value).some(key => !['version', 'lastPromptedVersion'].includes(key))) {
    throw new Error('invalid v2 update state')
  }
  return value.lastPromptedVersion === undefined
    ? EMPTY_STATE
    : { version: 2, lastPromptedVersion: value.lastPromptedVersion as string }
}

async function readState(filename: string): Promise<string> {
  const handle = await open(filename, 'r')
  try {
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    if (bytesRead > MAX_STATE_BYTES) throw new Error(`update state exceeds ${MAX_STATE_BYTES} bytes`)
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

function renderState(state: UpdateStateV2): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function isStableVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = parseSemVer(value)
  return parsed !== null && parsed.prerelease.length === 0 && parsed.version === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnoent(value: unknown): boolean {
  return isRecord(value) && value.code === 'ENOENT'
}
