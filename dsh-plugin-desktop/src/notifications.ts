/** Cordis Host plugin surfacing privacy-safe native attention for jobs and user turns. */

import type { Context } from '@deepseek-ai/cordis'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-jobs'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from './runtime.ts'
import {
  desktopJobNotificationCopy,
  desktopTurnNotificationCopy,
} from './tray-locale.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-notifications'

/** Native runtime is required; settings, jobs, and sessions remain optional. */
export const inject = ['desktopRuntime']

/** Live settings namespace controlling native attention. */
export const DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE = settingsNamespace('dsh-desktop-notifications')

/** User-configurable native attention settings. */
export interface DesktopNotificationSettings {
  /** Notify when a direct user turn finishes successfully. */
  notifyOnTurnCompletion: boolean
  /** Notify when a direct user turn fails or needs attention. */
  notifyOnTurnFailure: boolean
  /** Notify when a background job finishes successfully. */
  notifyOnJobCompletion: boolean
  /** Notify when a background job fails. */
  notifyOnJobFailure: boolean
}

/** Validated live settings schema for native attention. */
export const DesktopNotificationSettingsSchema: z<DesktopNotificationSettings> = z.object({
  notifyOnTurnCompletion: z.boolean().default(true),
  notifyOnTurnFailure: z.boolean().default(true),
  notifyOnJobCompletion: z.boolean().default(true),
  notifyOnJobFailure: z.boolean().default(true),
})

const DEFAULT_SETTINGS = DesktopNotificationSettingsSchema({} as DesktopNotificationSettings)

interface OpenTurnState {
  readonly turn: number
  userInitiated: boolean
}

function notifyJob(runtime: Context['desktopRuntime'], settings: DesktopNotificationSettings, snapshot: JobSnapshot): void {
  if (snapshot.status === 'killed') return
  if (snapshot.status === 'completed') {
    if (!settings.notifyOnJobCompletion) return
    runtime.notifyAttention(desktopJobNotificationCopy(runtime.locale, 'completed'))
    return
  }
  if (snapshot.status === 'failed') {
    if (!settings.notifyOnJobFailure) return
    runtime.notifyAttention(desktopJobNotificationCopy(runtime.locale, 'failed'))
  }
}

function sessionKey(session: Session): string {
  return String(session.header.id)
}

function trackTurnEvent(
  session: Session,
  event: SessionEvent,
  openTurns: Map<string, OpenTurnState>,
  settings: DesktopNotificationSettings,
  runtime: Context['desktopRuntime'],
): void {
  if (session.header.origin === 'subagent') return
  const key = sessionKey(session)

  if (event.type === 'turn/start') {
    openTurns.set(key, {
      turn: event.data.turn,
      userInitiated: false,
    })
    return
  }

  if (event.type === 'user/message') {
    const active = openTurns.get(key)
    if (active === undefined) return
    if (event.data.source.kind === 'user') active.userInitiated = true
    return
  }

  if (event.type !== 'turn/end') return
  const active = openTurns.get(key)
  if (active === undefined) return
  if (active.turn !== event.data.turn) return
  openTurns.delete(key)
  if (!active.userInitiated) return

  const { kind } = event.data.reason
  if (kind === 'completed') {
    if (!settings.notifyOnTurnCompletion) return
    runtime.notifyAttention(desktopTurnNotificationCopy(runtime.locale, 'completed'))
    return
  }
  if (kind === 'error' || kind === 'max-tokens') {
    if (!settings.notifyOnTurnFailure) return
    runtime.notifyAttention(desktopTurnNotificationCopy(runtime.locale, 'failed'))
  }
}

/** Register optional live settings plus job and session native attention handling. */
export function apply(ctx: Context): void {
  let settings = DEFAULT_SETTINGS

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => {
      const scope = settingsCtx.settings.register(
        DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE,
        DesktopNotificationSettingsSchema,
        { applies: 'live' },
      )
      settings = scope.get()
      const stopWatching = scope.watch((next) => {
        settings = next
      })
      return () => {
        stopWatching()
        settings = DEFAULT_SETTINGS
      }
    }, 'dsh-plugin-desktop: native notification settings')
  })

  ctx.inject(['jobs'], (jobsCtx) => {
    jobsCtx.effect(() => jobsCtx.jobs.onJobDone((snapshot) => {
      notifyJob(jobsCtx.desktopRuntime, settings, snapshot)
    }), 'dsh-plugin-desktop: background job attention')
  })

  ctx.inject(['sessions'], (sessionsCtx) => {
    sessionsCtx.effect(() => {
      const openTurns = new Map<string, OpenTurnState>()
      return sessionsCtx.on('session/event', (session, event) => {
        trackTurnEvent(session, event, openTurns, settings, sessionsCtx.desktopRuntime)
      })
    }, 'dsh-plugin-desktop: direct user turn attention')
  })
}
