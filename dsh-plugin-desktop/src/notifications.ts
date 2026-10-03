/** Privacy-safe desktop attention for completed user turns and background jobs. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { DesktopLocale, DesktopNotification } from './runtime.ts'
import { observeDesktopJobOutcomes, type DesktopJobOutcome } from './jobs-bridge.ts'
import {
  bindDesktopNotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS,
  DESKTOP_NOTIFICATIONS_SETTINGS_ENTRY_ID,
  type DesktopNotificationConfig,
  type DesktopNotificationSettings,
} from './settings-bridge.ts'

export const name = 'desktop-notifications'
export const inject = ['desktopRuntime']

export const DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE = DESKTOP_NOTIFICATIONS_SETTINGS_ENTRY_ID

/**
 * The editable notification preference subset and this instance's validated
 * configuration are edition-local because the two channels' cores model plugin
 * configuration differently; see `src/settings-bridge.ts`.
 */
export {
  DesktopNotificationSettingsSchema,
  DesktopNotificationConfig as Config,
  type DesktopNotificationSettings,
} from './settings-bridge.ts'

type NotificationOutcome = 'turn-completed' | 'turn-failed' | 'job-completed' | 'job-failed' | 'schedule-completed' | 'schedule-failed'

const NOTIFICATION_COPY: Record<DesktopLocale, Record<NotificationOutcome, DesktopNotification>> = {
  en: {
    'turn-completed': { title: 'User Turn Completed', body: 'A user-initiated turn has finished.' },
    'turn-failed': { title: 'User Turn Failed', body: 'A user-initiated turn could not finish. Open DSH Desktop for details.' },
    'job-completed': { title: 'Background Job Completed', body: 'A background job has finished.' },
    'job-failed': { title: 'Background Job Failed', body: 'A background job could not finish. Open DSH Desktop for details.' },
    'schedule-completed': { title: 'Automation Task Completed', body: 'An automation task has finished.' },
    'schedule-failed': { title: 'Automation Task Failed', body: 'An automation task could not finish. Open DSH Desktop for details.' },
  },
  zh: {
    'turn-completed': { title: '用户回合已完成', body: '一个由你发起的回合已完成。' },
    'turn-failed': { title: '用户回合失败', body: '一个由你发起的回合未能完成，请打开 DSH Desktop 查看详情。' },
    'job-completed': { title: '后台任务已完成', body: '有一个后台任务已结束。' },
    'job-failed': { title: '后台任务失败', body: '一个后台任务未能完成，请打开 DSH Desktop 查看详情。' },
    'schedule-completed': { title: '自动化任务完成', body: '一个自动化任务已完成。' },
    'schedule-failed': { title: '自动化任务失败', body: '一个自动化任务未能完成，请打开 DSH Desktop 查看详情。' },
  },
}

interface OpenTurn {
  readonly turn: number
  source: 'user' | 'schedule' | undefined
}

function notifyJob(
  runtime: Context['desktopRuntime'],
  settings: DesktopNotificationSettings,
  outcome: DesktopJobOutcome,
): void {
  if (!settings.enabled) return
  if (outcome === 'completed' && settings.notifyOnJobCompletion) {
    runtime.notifyAttention(NOTIFICATION_COPY[runtime.locale]['job-completed'])
  } else if (outcome === 'failed' && settings.notifyOnJobFailure) {
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
    openTurns.set(sessionId, { turn: event.data.turn, source: undefined })
    return
  }
  if (event.type === 'user/message') {
    const openTurn = openTurns.get(sessionId)
    const source = event.data.source.kind as string
    if (openTurn !== undefined && (source === 'user' || source === 'schedule')) {
      openTurn.source = source
    }
    return
  }
  if (event.type !== 'turn/end') return

  const openTurn = openTurns.get(sessionId)
  if (openTurn === undefined || openTurn.turn !== event.data.turn) return
  openTurns.delete(sessionId)
  if (!openTurn.source) return

  const reason = event.data.reason.kind
  const outcome = reason === 'completed' ? 'completed'
    : reason === 'error' || reason === 'max-tokens' ? 'failed' : undefined
  if (!outcome) return
  const enabled = openTurn.source === 'schedule'
    ? outcome === 'completed' ? settings.notifyOnScheduleCompletion : settings.notifyOnScheduleFailure
    : outcome === 'completed' ? settings.notifyOnTurnCompletion : settings.notifyOnTurnFailure
  if (enabled) runtime.notifyAttention(NOTIFICATION_COPY[runtime.locale][`${openTurn.source === 'schedule' ? 'schedule' : 'turn'}-${outcome}`])
}

/** Register independently optional settings, job, and live-session observers.
 * @param ctx - the notification plugin context.
 * @param config - validated live notification preferences.
 */
export function apply(ctx: Context, config: DesktopNotificationConfig): void {
  let settings = DEFAULT_NOTIFICATION_SETTINGS

  // Loader sends volatile updates only to this plugin's fiber. An injected
  // settings child owns a different fiber and cannot receive those updates.
  ctx.effect(
    () => bindDesktopNotificationSettings(ctx, config, (next) => { settings = next }),
    'dsh-plugin-desktop: native notification settings',
  )

  ctx.inject(['jobs'], (jobsCtx) => {
    jobsCtx.effect(
      () => observeDesktopJobOutcomes(jobsCtx, (outcome) => { notifyJob(jobsCtx.desktopRuntime, settings, outcome) }),
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
