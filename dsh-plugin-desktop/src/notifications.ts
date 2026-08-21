/** Privacy-safe desktop attention for completed user turns and background jobs. */

import type { Context } from '@deepseek-ai/cordis'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { DesktopLocale, DesktopNotification } from './runtime.ts'

export const name = 'desktop-notifications'
export const inject = ['desktopRuntime']

export const DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE = settingsNamespace('dsh-desktop-notifications')

export interface DesktopNotificationSettings {
  enabled: boolean
  notifyOnTurnCompletion: boolean
  notifyOnTurnFailure: boolean
  notifyOnJobCompletion: boolean
  notifyOnJobFailure: boolean
}

export const DesktopNotificationSettingsSchema: z<DesktopNotificationSettings> = z.object({
  enabled: z.boolean().default(true),
  notifyOnTurnCompletion: z.boolean().default(true),
  notifyOnTurnFailure: z.boolean().default(true),
  notifyOnJobCompletion: z.boolean().default(true),
  notifyOnJobFailure: z.boolean().default(true),
})

const DEFAULT_SETTINGS = DesktopNotificationSettingsSchema({} as DesktopNotificationSettings)

type NotificationOutcome = 'turn-completed' | 'turn-failed' | 'job-completed' | 'job-failed'

const NOTIFICATION_COPY: Record<DesktopLocale, Record<NotificationOutcome, DesktopNotification>> = {
  en: {
    'turn-completed': { title: 'Turn Completed', body: 'A direct user turn has finished.' },
    'turn-failed': { title: 'User Turn Failed', body: 'A direct user turn needs attention.' },
    'job-completed': { title: 'Background Job Completed', body: 'A background job has finished.' },
    'job-failed': { title: 'Background Job Failed', body: 'A background job needs attention.' },
  },
  zh: {
    'turn-completed': { title: '用户回合已完成', body: '有一个用户回合已结束。' },
    'turn-failed': { title: '用户回合失败', body: '有一个用户回合需要处理。' },
    'job-completed': { title: '后台任务已完成', body: '有一个后台任务已结束。' },
    'job-failed': { title: '后台任务失败', body: '有一个后台任务需要处理。' },
  },
}

interface OpenTurn {
  readonly turn: number
  userInitiated: boolean
}

function notifyJob(
  runtime: Context['desktopRuntime'],
  settings: DesktopNotificationSettings,
  snapshot: JobSnapshot,
): void {
  if (!settings.enabled) return
  if (snapshot.status === 'completed' && settings.notifyOnJobCompletion) {
    runtime.notifyAttention(NOTIFICATION_COPY[runtime.locale]['job-completed'])
  } else if (snapshot.status === 'failed' && settings.notifyOnJobFailure) {
    runtime.notifyAttention(NOTIFICATION_COPY[runtime.locale]['job-failed'])
  }
}

function trackTurn(
  runtime: Context['desktopRuntime'],
  settings: DesktopNotificationSettings,
  openTurns: Map<string, OpenTurn>,
  session: Session,
  event: SessionEvent,
): void {
  if (!settings.enabled) return
  if (session.header.origin === 'subagent') return
  const sessionId = String(session.header.id)

  if (event.type === 'turn/start') {
    openTurns.set(sessionId, { turn: event.data.turn, userInitiated: false })
    return
  }
  if (event.type === 'user/message') {
    const openTurn = openTurns.get(sessionId)
    if (openTurn !== undefined && event.data.source.kind === 'user') openTurn.userInitiated = true
    return
  }
  if (event.type !== 'turn/end') return

  const openTurn = openTurns.get(sessionId)
  if (openTurn === undefined || openTurn.turn !== event.data.turn) return
  openTurns.delete(sessionId)
  if (!openTurn.userInitiated) return

  const reason = event.data.reason.kind
  if (reason === 'completed' && settings.notifyOnTurnCompletion) {
    runtime.notifyAttention(NOTIFICATION_COPY[runtime.locale]['turn-completed'])
  } else if ((reason === 'error' || reason === 'max-tokens') && settings.notifyOnTurnFailure) {
    runtime.notifyAttention(NOTIFICATION_COPY[runtime.locale]['turn-failed'])
  }
}

/** Register independently optional settings, job, and live-session observers. */
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
      const stopWatching = scope.watch((next) => { settings = next })
      return () => {
        stopWatching()
        settings = DEFAULT_SETTINGS
      }
    }, 'dsh-plugin-desktop: native notification settings')
  })

  ctx.inject(['jobs'], (jobsCtx) => {
    jobsCtx.effect(
      () => jobsCtx.jobs.onJobDone(snapshot => { notifyJob(jobsCtx.desktopRuntime, settings, snapshot) }),
      'dsh-plugin-desktop: background job attention',
    )
  })

  ctx.inject(['sessions'], (sessionsCtx) => {
    sessionsCtx.effect(() => {
      const openTurns = new Map<string, OpenTurn>()
      const stopEvents = sessionsCtx.on('session/event', (session, event) => {
        trackTurn(sessionsCtx.desktopRuntime, settings, openTurns, session, event)
      })
      const stopDisposed = sessionsCtx.on('session/disposed', (session) => {
        openTurns.delete(String(session.header.id))
      })
      return () => {
        stopDisposed()
        stopEvents()
      }
    }, 'dsh-plugin-desktop: direct user turn attention')
  })
}
