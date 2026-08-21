import type { Context } from '@deepseek-ai/cordis'
import type { JobId, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE,
  DesktopNotificationSettingsSchema,
  inject,
  name,
  type DesktopNotificationSettings,
} from '../src/notifications.ts'
import type { DesktopRuntime } from '../src/runtime.ts'

type OptionalService = 'jobs' | 'sessions' | 'settings'

interface NotificationHarness {
  readonly notifyAttention: ReturnType<typeof vi.fn>
  readonly registerSettings: ReturnType<typeof vi.fn>
  readonly stopJobs: ReturnType<typeof vi.fn>
  readonly stopSessions: ReturnType<typeof vi.fn>
  jobDone(snapshot: JobSnapshot): Promise<void>
  sessionEvent(session: Session, event: SessionEvent): Promise<void>
  sessionDisposed(session: Session): Promise<void>
  updateSettings(settings: DesktopNotificationSettings): Promise<void>
  teardownSessions(): void
  reattachSessions(): void
  dispose(): void
}

function createHarness(available: readonly OptionalService[] = ['jobs', 'sessions', 'settings']): NotificationHarness {
  const notifyAttention = vi.fn()
  const stopJobs = vi.fn()
  const stopSessions = vi.fn()
  const enabled = new Set(available)
  const injections = new Map<OptionalService, (ctx: Context) => void>()
  const disposers = new Map<OptionalService, Array<() => void>>()
  let activeService: OptionalService | undefined
  let jobListener: ((snapshot: JobSnapshot) => void | PromiseLike<void>) | undefined
  let sessionListener: ((session: Session, event: SessionEvent) => void | PromiseLike<void>) | undefined
  let sessionDisposedListener: ((session: Session) => void | PromiseLike<void>) | undefined
  let settingsWatcher:
    | ((next: DesktopNotificationSettings, previous: DesktopNotificationSettings) => void | Promise<void>)
    | undefined
  let currentSettings = DesktopNotificationSettingsSchema({} as DesktopNotificationSettings)

  const runtime = {
    platform: 'darwin',
    locale: 'en',
    notifyAttention,
  } as unknown as DesktopRuntime

  const registerSettings = vi.fn(() => ({
    get: () => currentSettings,
    watch: (watcher: typeof settingsWatcher) => {
      settingsWatcher = watcher
      return () => { settingsWatcher = undefined }
    },
    update: vi.fn(async () => {}),
    replace: vi.fn(async () => {}),
  }))

  const ctx = {
    desktopRuntime: runtime,
    settings: { register: registerSettings },
    jobs: {
      onJobDone: (listener: typeof jobListener) => {
        jobListener = listener
        return () => {
          jobListener = undefined
          stopJobs()
        }
      },
    },
    on: (event: string, listener: typeof sessionListener | typeof sessionDisposedListener) => {
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
      injections.set(service, callback)
      if (!enabled.has(service)) return
      activeService = service
      callback(ctx as unknown as Context)
      activeService = undefined
    },
    effect: (register: () => void | (() => void)) => {
      const dispose = register()
      if (activeService !== undefined && typeof dispose === 'function') {
        disposers.set(activeService, [...(disposers.get(activeService) ?? []), dispose])
      }
      return dispose
    },
  } as unknown as Context

  const teardown = (service: OptionalService): void => {
    for (const dispose of [...(disposers.get(service) ?? [])].reverse()) dispose()
    disposers.delete(service)
  }

  apply(ctx)

  return {
    notifyAttention,
    registerSettings,
    stopJobs,
    stopSessions,
    async jobDone(snapshot) { await jobListener?.(snapshot) },
    async sessionEvent(session, event) { await sessionListener?.(session, event) },
    async sessionDisposed(session) { await sessionDisposedListener?.(session) },
    async updateSettings(next) {
      const previous = currentSettings
      currentSettings = next
      await settingsWatcher?.(next, previous)
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
    },
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

function userMessage(source: 'user' | 'plugin', seq: number): SessionEvent<'user/message'> {
  return event('user/message', {
    id: `message-${String(seq)}` as never,
    role: 'user',
    content: [{ type: 'text', text: 'secret /Users/example session-123' }] as never,
    source: source === 'user'
      ? { kind: 'user' }
      : { kind: 'plugin', plugin: 'test', form: 'notice', summary: 'continuation' },
  } as never, seq)
}

describe('desktop notifications Host plugin', () => {
  it('registers live notification settings with the global switch enabled by default', () => {
    const harness = createHarness(['settings'])

    expect(name).toBe('desktop-notifications')
    expect(inject).toEqual(['desktopRuntime'])
    expect(String(DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE)).toBe('dsh-desktop-notifications')
    expect(DesktopNotificationSettingsSchema({} as DesktopNotificationSettings)).toEqual({
      enabled: true,
      notifyOnTurnCompletion: true,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: true,
      notifyOnJobFailure: true,
    })
    expect(harness.registerSettings).toHaveBeenCalledWith(
      DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE,
      DesktopNotificationSettingsSchema,
      { applies: 'live' },
    )
  })

  it('notifies for completed and failed jobs without exposing job details', async () => {
    const harness = createHarness(['jobs', 'settings'])
    const snapshot = {
      id: 'bash-1' as JobId,
      kind: 'bash',
      label: 'node /Users/example/private.js --token secret',
      status: 'completed',
      detail: 'session-123',
      output: 'private output',
      startedAt: 1,
      finishedAt: 2,
      reported: false,
    } satisfies JobSnapshot & { output: string }

    await harness.jobDone(snapshot)
    await harness.jobDone({ ...snapshot, status: 'failed' })
    await harness.jobDone({ ...snapshot, status: 'killed' })

    expect(harness.notifyAttention.mock.calls).toEqual([
      [{ title: 'Background Job Completed', body: 'A background job has finished.' }],
      [{ title: 'Background Job Failed', body: 'A background job needs attention.' }],
    ])
    expect(JSON.stringify(harness.notifyAttention.mock.calls)).not.toMatch(/Users|private|secret|session-123/u)
  })

  it('applies live settings independently to successful and failed outcomes', async () => {
    const harness = createHarness()
    const snapshot = {
      id: 'bash-2' as JobId,
      kind: 'bash',
      label: 'build',
      status: 'completed',
      startedAt: 1,
      finishedAt: 2,
      reported: false,
    } satisfies JobSnapshot

    await harness.updateSettings({
      enabled: true,
      notifyOnTurnCompletion: false,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: false,
      notifyOnJobFailure: true,
    })
    await harness.jobDone(snapshot)
    await harness.jobDone({ ...snapshot, status: 'failed' })

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
      [{ title: 'Background Job Failed', body: 'A background job needs attention.' }],
      [{ title: 'User Turn Failed', body: 'A direct user turn needs attention.' }],
    ])
  })

  it('keeps fine-grained choices while the live global switch is disabled', async () => {
    const harness = createHarness()
    const snapshot = {
      id: 'bash-disabled' as JobId,
      kind: 'bash',
      label: 'build',
      status: 'completed',
      startedAt: 1,
      finishedAt: 2,
      reported: false,
    } satisfies JobSnapshot

    await harness.updateSettings({
      enabled: false,
      notifyOnTurnCompletion: true,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: true,
      notifyOnJobFailure: true,
    })
    await harness.jobDone(snapshot)

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
      title: 'Turn Completed',
      body: 'A direct user turn has finished.',
    })
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
      body: 'A direct user turn needs attention.',
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
