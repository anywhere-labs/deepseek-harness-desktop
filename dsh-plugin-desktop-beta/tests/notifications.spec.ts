import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE,
  DesktopNotificationSettingsSchema,
  inject,
  name,
  type Config as DesktopNotificationConfig,
  type DesktopNotificationSettings,
} from '../src/notifications.ts'
import type { DesktopRuntime } from '../src/runtime.ts'

type OptionalService = 'jobs' | 'sessions' | 'settings'

/**
 * Terminal job projection the 0.1.7 event stream carries.
 *
 * `JobSnapshot` is gone; a `settled` event hands out a `JobView`. Only `status`
 * reaches `src/jobs-bridge.ts`, but the fixtures keep the private-looking
 * neighbouring fields so the no-leak assertion still has something to catch.
 */
interface SettledJobFixture {
  readonly id: JobId
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly detail?: string
  readonly output?: string
}

interface NotificationHarness {
  readonly notifyAttention: ReturnType<typeof vi.fn>
  readonly configureSettings: ReturnType<typeof vi.fn>
  readonly jobFilters: unknown[]
  readonly stopJobs: ReturnType<typeof vi.fn>
  readonly stopSessions: ReturnType<typeof vi.fn>
  jobSettled(job: SettledJobFixture): Promise<void>
  jobEvent(event: unknown): Promise<void>
  sessionEvent(session: Session, event: SessionEvent): Promise<void>
  sessionDisposed(session: Session): Promise<void>
  updateSettings(settings: DesktopNotificationSettings): Promise<void>
  teardownSessions(): void
  reattachSessions(): void
  dispose(): void
}

function createHarness(available: readonly OptionalService[] = ['jobs', 'sessions', 'settings']): NotificationHarness {
  const notifyAttention = vi.fn()
  const configureSettings = vi.fn()
  const stopJobs = vi.fn()
  const stopSessions = vi.fn()
  const jobFilters: unknown[] = []
  const enabled = new Set(available)
  const injections = new Map<OptionalService, (ctx: Context) => void>()
  const disposers = new Map<OptionalService, Array<() => void>>()
  const rootDisposers: Array<() => void> = []
  let activeService: OptionalService | undefined
  let jobListener: ((event: unknown) => void | PromiseLike<void>) | undefined
  let sessionListener: ((session: Session, event: SessionEvent) => void | PromiseLike<void>) | undefined
  let sessionDisposedListener: ((session: Session) => void | PromiseLike<void>) | undefined
  const volatileListeners = new Set<() => void | Promise<void>>()
  let currentSettings = DesktopNotificationSettingsSchema({} as DesktopNotificationSettings)

  const runtime = {
    platform: 'darwin',
    locale: 'en',
    notifyAttention,
  } as unknown as DesktopRuntime

  // 0.1.7 hands a plugin its own live configuration as volatile references
  // rather than a registered settings scope, so the fixture is a live view onto
  // whatever `updateSettings` last wrote.
  const field = <K extends keyof DesktopNotificationSettings>(key: K): Volatile<DesktopNotificationSettings[K]> =>
    ({ get: () => currentSettings[key] }) as unknown as Volatile<DesktopNotificationSettings[K]>
  const config: DesktopNotificationConfig = {
    enabled: field('enabled'),
    notifyOnTurnCompletion: field('notifyOnTurnCompletion'),
    notifyOnTurnFailure: field('notifyOnTurnFailure'),
    notifyOnJobCompletion: field('notifyOnJobCompletion'),
    notifyOnJobFailure: field('notifyOnJobFailure'),
    notifyOnScheduleCompletion: field('notifyOnScheduleCompletion'),
    notifyOnScheduleFailure: field('notifyOnScheduleFailure'),
  }

  const fiber = { id: 'desktop-notifications' }

  const ctx = {
    desktopRuntime: runtime,
    fiber,
    settings: { configure: configureSettings },
    jobs: {
      events: {
        subscribe: (filter: unknown, listener: typeof jobListener) => {
          jobFilters.push(filter)
          jobListener = listener
          return () => {
            jobListener = undefined
            stopJobs()
          }
        },
      },
    },
    on: (
      event: string,
      listener: typeof sessionListener | typeof sessionDisposedListener | (() => void),
    ) => {
      if (event === 'loader/volatile-update') {
        const volatileListener = listener as () => void
        volatileListeners.add(volatileListener)
        return () => { volatileListeners.delete(volatileListener) }
      }
      if (event === 'session/event') sessionListener = listener as typeof sessionListener
      else if (event === 'session/disposed') sessionDisposedListener = listener as typeof sessionDisposedListener
      else return () => {}
      return () => {
        if (event === 'session/event') sessionListener = undefined
        else sessionDisposedListener = undefined
        stopSessions()
      }
    },
    inject: (services: OptionalService[], callback: (child: Context) => void) => {
      const service = services[0]
      if (service === undefined) return
      const previous = activeService
      injections.set(service, callback)
      if (!enabled.has(service)) return
      activeService = service
      callback(ctx as unknown as Context)
      activeService = previous
    },
    effect: (register: () => void | (() => void)) => {
      const dispose = register()
      if (activeService !== undefined && typeof dispose === 'function') {
        disposers.set(activeService, [...(disposers.get(activeService) ?? []), dispose])
      } else if (typeof dispose === 'function') {
        rootDisposers.push(dispose)
      }
      return dispose
    },
  } as unknown as Context

  const teardown = (service: OptionalService): void => {
    for (const dispose of [...(disposers.get(service) ?? [])].reverse()) dispose()
    disposers.delete(service)
  }

  apply(ctx, config)

  return {
    notifyAttention,
    configureSettings,
    jobFilters,
    stopJobs,
    stopSessions,
    async jobSettled(job) { await jobListener?.({ type: 'settled', job, cause: 'natural', awaited: false }) },
    async jobEvent(event) { await jobListener?.(event) },
    async sessionEvent(session, event) { await sessionListener?.(session, event) },
    async sessionDisposed(session) { await sessionDisposedListener?.(session) },
    async updateSettings(next) {
      currentSettings = next
      for (const listener of [...volatileListeners]) await listener()
    },
    teardownSessions() { teardown('sessions') },
    reattachSessions() {
      activeService = 'sessions'
      injections.get('sessions')?.(ctx)
      activeService = undefined
    },
    dispose() {
      teardown('sessions')
      teardown('jobs')
      teardown('settings')
      for (const dispose of rootDisposers.splice(0).reverse()) dispose()
    },
  }
}

function job(id: string, status: string): SettledJobFixture {
  return {
    id: id as JobId,
    kind: 'bash',
    label: 'node /Users/example/private.js --token secret',
    status,
    detail: 'session-123',
    output: 'private output',
  }
}

function session(id: string, origin?: 'subagent'): Session {
  return {
    header: {
      id: id as SessionId,
      version: 0,
      createdAt: 1,
      ...(origin === undefined ? {} : { origin }),
    },
  } as unknown as Session
}

function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
  seq: number,
): Extract<SessionEvent, { type: T }> {
  return { type, data, seq, time: seq } as Extract<SessionEvent, { type: T }>
}

function userMessage(source: 'user' | 'plugin' | 'schedule', seq: number): SessionEvent<'user/message'> {
  return event('user/message', {
    id: `message-${String(seq)}` as never,
    role: 'user',
    content: [{ type: 'text', text: 'secret /Users/example session-123' }] as never,
    source: source === 'user' ? { kind: 'user' }
      : source === 'schedule' ? { kind: 'schedule' }
        : { kind: 'plugin', plugin: 'test', form: 'notice', summary: 'continuation' },
  } as never, seq)
}

describe('desktop notifications Host plugin', () => {
  it('publishes live notification settings with the global switch enabled by default', () => {
    const harness = createHarness(['settings'])

    expect(name).toBe('desktop-notifications')
    expect(inject).toEqual(['desktopRuntime'])
    expect(String(DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE)).toBe('desktop-notifications')
    expect(DesktopNotificationSettingsSchema({} as DesktopNotificationSettings)).toEqual({
      enabled: true,
      notifyOnTurnCompletion: true,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: true,
      notifyOnJobFailure: true,
      notifyOnScheduleCompletion: true,
      notifyOnScheduleFailure: true,
    })
    // The preferences are published by the plugin's own volatile Config fields;
    // the only call Desktop makes on the service withdraws the automatic form,
    // because Desktop renders these five switches in its own settings section.
    expect(harness.configureSettings).toHaveBeenCalledWith({ auto: false }, expect.anything())
  })

  it('observes every job composed under its own scope', () => {
    const harness = createHarness(['jobs'])

    expect(harness.jobFilters).toEqual([{ owners: 'scope' }])
  })

  it('notifies for completed and failed jobs without exposing job details', async () => {
    const harness = createHarness(['jobs', 'settings'])

    await harness.jobSettled(job('bash-1', 'completed'))
    await harness.jobSettled(job('bash-1', 'failed'))
    await harness.jobSettled(job('bash-1', 'killed'))

    expect(harness.notifyAttention.mock.calls).toEqual([
      [{ title: 'Background Job Completed', body: 'A background job has finished.' }],
      [{ title: 'Background Job Failed', body: 'A background job could not finish. Open DSH Desktop for details.' }],
    ])
    expect(JSON.stringify(harness.notifyAttention.mock.calls)).not.toMatch(/Users|private|secret|session-123/u)
  })

  it('ignores the non-terminal events sharing the job stream', async () => {
    const harness = createHarness(['jobs', 'settings'])

    await harness.jobEvent({ type: 'registered', job: job('bash-2', 'running') })
    await harness.jobEvent({ type: 'progress', job: job('bash-2', 'running') })
    await harness.jobEvent({ type: 'stopping', job: job('bash-2', 'stopping') })
    await harness.jobEvent({ type: 'removed', job: job('bash-2', 'completed') })

    expect(harness.notifyAttention).not.toHaveBeenCalled()
  })

  it('applies live settings independently to successful and failed outcomes', async () => {
    const harness = createHarness()

    await harness.updateSettings({
      enabled: true,
      notifyOnTurnCompletion: false,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: false,
      notifyOnJobFailure: true,
      notifyOnScheduleCompletion: true,
      notifyOnScheduleFailure: true,
    })
    await harness.jobSettled(job('bash-3', 'completed'))
    await harness.jobSettled(job('bash-3', 'failed'))

    const active = session('session-1')
    await harness.sessionEvent(active, event('turn/start', { turn: 1 }, 1))
    await harness.sessionEvent(active, userMessage('user', 2))
    await harness.sessionEvent(active, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3))
    await harness.sessionEvent(active, event('turn/start', { turn: 2 }, 4))
    await harness.sessionEvent(active, userMessage('user', 5))
    await harness.sessionEvent(active, event('turn/end', {
      turn: 2,
      reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'private error' } },
    }, 6))

    expect(harness.notifyAttention.mock.calls).toEqual([
      [{ title: 'Background Job Failed', body: 'A background job could not finish. Open DSH Desktop for details.' }],
      [{ title: 'User Turn Failed', body: 'A user-initiated turn could not finish. Open DSH Desktop for details.' }],
    ])
  })

  it('keeps fine-grained choices while the live global switch is disabled', async () => {
    const harness = createHarness()

    await harness.updateSettings({
      enabled: false,
      notifyOnTurnCompletion: true,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: true,
      notifyOnJobFailure: true,
      notifyOnScheduleCompletion: true,
      notifyOnScheduleFailure: true,
    })
    await harness.jobSettled(job('bash-disabled', 'completed'))

    const active = session('disabled')
    await harness.sessionEvent(active, event('turn/start', { turn: 1 }, 1))
    await harness.sessionEvent(active, userMessage('user', 2))
    await harness.sessionEvent(active, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3))

    expect(harness.notifyAttention).not.toHaveBeenCalled()
  })

  it('notifies only matching direct-user turn endings', async () => {
    const harness = createHarness(['sessions'])
    const direct = session('direct')
    const plugin = session('plugin')
    const subagent = session('subagent', 'subagent')

    await harness.sessionEvent(direct, event('turn/start', { turn: 7 }, 1))
    await harness.sessionEvent(direct, userMessage('user', 2))
    await harness.sessionEvent(direct, event('turn/end', { turn: 8, reason: { kind: 'completed' } }, 3))
    await harness.sessionEvent(direct, event('turn/end', { turn: 7, reason: { kind: 'completed' } }, 4))

    await harness.sessionEvent(plugin, event('turn/start', { turn: 1 }, 5))
    await harness.sessionEvent(plugin, userMessage('plugin', 6))
    await harness.sessionEvent(plugin, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 7))

    await harness.sessionEvent(subagent, event('turn/start', { turn: 1 }, 8))
    await harness.sessionEvent(subagent, userMessage('user', 9))
    await harness.sessionEvent(subagent, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 10))

    expect(harness.notifyAttention).toHaveBeenCalledOnce()
    expect(harness.notifyAttention).toHaveBeenCalledWith({
      title: 'User Turn Completed',
      body: 'A user-initiated turn has finished.',
    })
  })

  it('uses the existing turn observer and live switches for scheduled completions and failures', async () => {
    const harness = createHarness(['sessions', 'settings'])
    const active = session('scheduled')
    await harness.sessionEvent(active, event('turn/start', { turn: 1 }, 1))
    await harness.sessionEvent(active, userMessage('schedule', 2))
    await harness.sessionEvent(active, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3))
    expect(harness.notifyAttention).toHaveBeenCalledWith({ title: 'Automation Task Completed', body: 'An automation task has finished.' })
    expect(JSON.stringify(harness.notifyAttention.mock.calls)).not.toContain('secret')
    harness.notifyAttention.mockClear()

    await harness.updateSettings({ ...DesktopNotificationSettingsSchema({} as DesktopNotificationSettings), notifyOnScheduleCompletion: false })
    await harness.sessionEvent(active, event('turn/start', { turn: 2 }, 4))
    await harness.sessionEvent(active, userMessage('schedule', 5))
    await harness.sessionEvent(active, event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 6))
    await harness.sessionEvent(active, event('turn/start', { turn: 3 }, 7))
    await harness.sessionEvent(active, userMessage('schedule', 8))
    await harness.sessionEvent(active, event('turn/end', { turn: 3, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'private error' } } }, 9))
    expect(harness.notifyAttention.mock.calls).toEqual([[
      { title: 'Automation Task Failed', body: 'An automation task could not finish. Open DSH Desktop for details.' },
    ]])
    harness.notifyAttention.mockClear()
    await harness.updateSettings({ ...DesktopNotificationSettingsSchema({} as DesktopNotificationSettings), notifyOnScheduleFailure: false })
    await harness.sessionEvent(active, event('turn/start', { turn: 4 }, 10))
    await harness.sessionEvent(active, userMessage('schedule', 11))
    await harness.sessionEvent(active, event('turn/end', { turn: 4, reason: { kind: 'max-tokens' } }, 12))
    expect(harness.notifyAttention).not.toHaveBeenCalled()
  })

  it('treats max-tokens as a failure and keeps non-failure endings silent', async () => {
    const harness = createHarness(['sessions'])
    const active = session('direct')
    const endings: Array<Extract<SessionEvent, { type: 'turn/end' }>['data']['reason']> = [
      { kind: 'max-tokens' },
      { kind: 'aborted', reason: { kind: 'user' } },
      { kind: 'blocked' },
      { kind: 'interrupted' },
    ]

    for (const [index, reason] of endings.entries()) {
      const turn = index + 1
      await harness.sessionEvent(active, event('turn/start', { turn }, turn * 3))
      await harness.sessionEvent(active, userMessage('user', turn * 3 + 1))
      await harness.sessionEvent(active, event('turn/end', { turn, reason } as never, turn * 3 + 2))
    }

    expect(harness.notifyAttention).toHaveBeenCalledOnce()
    expect(harness.notifyAttention).toHaveBeenCalledWith({
      title: 'User Turn Failed',
      body: 'A user-initiated turn could not finish. Open DSH Desktop for details.',
    })
  })

  it('drops open turn state when sessions detach and disposes optional observers', async () => {
    const harness = createHarness()
    const active = session('session-1')
    await harness.sessionEvent(active, event('turn/start', { turn: 1 }, 1))
    await harness.sessionEvent(active, userMessage('user', 2))

    harness.teardownSessions()
    harness.reattachSessions()
    await harness.sessionEvent(active, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3))

    expect(harness.notifyAttention).not.toHaveBeenCalled()
    expect(harness.stopSessions).toHaveBeenCalledTimes(2)
    harness.dispose()
    expect(harness.stopSessions).toHaveBeenCalledTimes(4)
    expect(harness.stopJobs).toHaveBeenCalledOnce()
  })

  it('drops an unfinished turn when its session is disposed', async () => {
    const harness = createHarness(['sessions'])
    const active = session('session-1')
    await harness.sessionEvent(active, event('turn/start', { turn: 1 }, 1))
    await harness.sessionEvent(active, userMessage('user', 2))
    await harness.sessionDisposed(active)
    await harness.sessionEvent(active, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3))

    expect(harness.notifyAttention).not.toHaveBeenCalled()
  })
})
