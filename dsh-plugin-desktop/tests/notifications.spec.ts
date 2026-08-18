import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { JobId, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { DesktopRuntime } from '../src/runtime.ts'
import {
  apply,
  DesktopNotificationSettingsSchema,
  DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE,
  inject,
  name,
  type DesktopNotificationSettings,
} from '../src/notifications.ts'

interface HarnessOptions {
  readonly jobs?: boolean
  readonly sessions?: boolean
  readonly settings?: boolean
  readonly locale?: DesktopRuntime['locale']
}

interface Harness {
  readonly runtime: DesktopRuntime
  readonly notifyAttention: ReturnType<typeof vi.fn>
  readonly on: ReturnType<typeof vi.fn>
  readonly register: ReturnType<typeof vi.fn>
  readonly watchStop: ReturnType<typeof vi.fn>
  readonly disposeJobs: ReturnType<typeof vi.fn>
  readonly stopSessionEvents: ReturnType<typeof vi.fn>
  readonly disposers: Array<() => void>
  jobDone(snapshot: JobSnapshot): Promise<void>
  sessionEvent(session: Session, event: SessionEvent): Promise<void>
  updateSettings(next: DesktopNotificationSettings): Promise<void>
  teardownSessions(): void
  reattachSessions(): void
  dispose(): void
}

function createHarness(options: HarnessOptions = {}): Harness {
  const notifyAttention = vi.fn()
  const watchStop = vi.fn()
  const disposeJobs = vi.fn()
  const stopSessionEvents = vi.fn()
  const settingsState = {
    current: DesktopNotificationSettingsSchema({} as DesktopNotificationSettings),
  }
  let watcher:
    | ((next: DesktopNotificationSettings, prev: DesktopNotificationSettings) => void | Promise<void>)
    | undefined
  let onJobDone:
    | ((snapshot: JobSnapshot) => void | PromiseLike<void>)
    | undefined
  let onSessionEvent:
    | ((session: Session, event: SessionEvent) => void | PromiseLike<void>)
    | undefined
  let attachSessions:
    | (() => void)
    | undefined
  let stopSessionsEffect:
    | (() => void)
    | undefined
  let activeInjection:
    | 'sessions'
    | undefined
  const disposers: Array<() => void> = []
  const runtime = {
    locale: options.locale ?? 'en',
    platform: 'darwin',
    updates: {
      isPackaged: false,
      canDownload: false,
      currentVersion: '2.0.1',
      statePath: '/tmp/dsh-desktop-update-state.json',
      request: async () => new Response(null, { status: 304 }),
      confirmDownload: async () => false,
      showManualCheckResult: async () => {},
      downloadAndOpen: async () => {},
      notify: () => {},
    },
    schedule: () => async () => {},
    mountScheduled: async () => {},
    show: () => {},
    notifyAttention,
    registerTrayItem: () => ({ refresh: () => {}, dispose: () => {} }),
    openTerminal: () => {},
    exportDiagnostics: async () => {},
    reportRendererBoot: () => {},
    setLocalePreference: () => {},
    setThemeSource: () => {},
    requestRestart: async () => {},
    prepareToQuit: () => {},
  } as unknown as DesktopRuntime
  const register = vi.fn((_namespace, _schema, _options) => ({
    get: () => settingsState.current,
    watch: (callback: typeof watcher) => {
      watcher = callback
      return watchStop
    },
    update: vi.fn(async () => {}),
    replace: vi.fn(async () => {}),
  } satisfies SettingsScope<DesktopNotificationSettings>))
  const ctx = {
    desktopRuntime: runtime,
    settings: { register },
    jobs: {
      onJobDone: vi.fn((listener: typeof onJobDone) => {
        onJobDone = listener
        return disposeJobs
      }),
    },
    inject: vi.fn((services: string[], callback: (child: Context) => void) => {
      const serviceKey = services.join(',')
      const runInjection = () => {
        activeInjection = serviceKey === 'sessions' ? 'sessions' : undefined
        callback(ctx as unknown as Context)
        activeInjection = undefined
      }
      if (serviceKey === 'sessions') attachSessions = runInjection
      if (services.every(service => options[service as keyof HarnessOptions] ?? true)) {
        runInjection()
      }
    }),
    on: vi.fn((event: string, listener: typeof onSessionEvent) => {
      if (event !== 'session/event') return () => {}
      onSessionEvent = listener
      return stopSessionEvents
    }),
    effect: vi.fn((registerEffect: () => (() => void) | void) => {
      const dispose = registerEffect()
      if (activeInjection === 'sessions') {
        stopSessionsEffect = typeof dispose === 'function' ? dispose : undefined
      }
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    }),
  } as unknown as Context

  apply(ctx)

  return {
    runtime,
    notifyAttention,
    on: vi.mocked((ctx as Context & { on: ReturnType<typeof vi.fn> }).on),
    register,
    watchStop,
    disposeJobs,
    stopSessionEvents,
    disposers,
    async jobDone(snapshot: JobSnapshot) {
      await onJobDone?.(snapshot)
    },
    async sessionEvent(session: Session, event: SessionEvent) {
      await onSessionEvent?.(session, event)
    },
    async updateSettings(next: DesktopNotificationSettings) {
      const previous = settingsState.current
      settingsState.current = next
      await watcher?.(next, previous)
    },
    teardownSessions() {
      stopSessionsEffect?.()
      stopSessionsEffect = undefined
      onSessionEvent = undefined
    },
    reattachSessions() {
      attachSessions?.()
    },
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}

function session(origin?: 'subagent'): Session {
  return {
    header: {
      id: 'session-123' as SessionId,
      version: 0,
      createdAt: 1,
      ...(origin === undefined ? {} : { origin }),
    },
  } as unknown as Session
}

function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
  seq = 0,
): Extract<SessionEvent, { type: T }> {
  return {
    type,
    seq,
    time: seq + 1,
    data,
  } as Extract<SessionEvent, { type: T }>
}

function userMessage(
  turn: number,
  sourceKind: 'user' | 'plugin' = 'user',
  text = 'sensitive prompt text /Users/example/workspace',
): SessionEvent<'user/message'> {
  return event('user/message', {
    id: `message-${turn}` as never,
    role: 'user',
    content: [{ type: 'text', text }] as never,
    source: sourceKind === 'user'
      ? { kind: 'user' }
      : { kind: 'plugin', plugin: 'test-plugin', form: 'notice', summary: 'goal continuation' },
  } as never, turn)
}

describe('desktop notifications Host plugin', () => {
  it('registers live settings defaults when a settings service is present', () => {
    const harness = createHarness({ jobs: false, sessions: false, settings: true })

    expect(name).toBe('desktop-notifications')
    expect(inject).toEqual(['desktopRuntime'])
    expect(DesktopNotificationSettingsSchema({} as DesktopNotificationSettings)).toEqual({
      notifyOnTurnCompletion: true,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: true,
      notifyOnJobFailure: true,
    })
    expect(String(DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE)).toBe('dsh-desktop-notifications')
    expect(harness.register).toHaveBeenCalledWith(
      DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE,
      DesktopNotificationSettingsSchema,
      { applies: 'live' },
    )
  })

  it('wires optional services independently and disposes their registrations', () => {
    const jobsOnly = createHarness({ jobs: true, sessions: false, settings: false })
    const sessionsOnly = createHarness({ jobs: false, sessions: true, settings: false })
    const settingsOnly = createHarness({ jobs: false, sessions: false, settings: true })

    expect(jobsOnly.register).not.toHaveBeenCalled()
    expect(jobsOnly.disposeJobs).not.toHaveBeenCalled()
    jobsOnly.dispose()
    expect(jobsOnly.disposeJobs).toHaveBeenCalledOnce()

    expect(sessionsOnly.on).toHaveBeenCalledWith('session/event', expect.any(Function))
    sessionsOnly.dispose()
    expect(sessionsOnly.stopSessionEvents).toHaveBeenCalledOnce()

    expect(settingsOnly.register).toHaveBeenCalledOnce()
    expect(settingsOnly.disposeJobs).not.toHaveBeenCalled()
    settingsOnly.dispose()
    expect(settingsOnly.watchStop).toHaveBeenCalledOnce()
  })

  it('routes completed and failed jobs, suppresses killed jobs, and keeps native copy privacy-safe', async () => {
    const harness = createHarness({ jobs: true, settings: true, locale: 'zh' })
    const sensitive = {
      id: 'bash-7' as JobId,
      kind: 'bash',
      label: 'python /Users/example/project/run_secret.py --workspace /tmp/private',
      status: 'completed',
      detail: 'exit code: 0',
      output: 'session-123 /Users/example/private-output',
      startedAt: 1,
      finishedAt: 2,
      reported: false,
    } satisfies JobSnapshot & { output?: string }

    await harness.jobDone(sensitive)
    await harness.jobDone({ ...sensitive, status: 'failed' })
    await harness.jobDone({ ...sensitive, status: 'killed' })

    expect(harness.notifyAttention).toHaveBeenCalledTimes(2)
    expect(harness.notifyAttention).toHaveBeenNthCalledWith(1, {
      title: '后台任务已完成',
      body: '有一个后台任务已结束。',
    })
    expect(harness.notifyAttention).toHaveBeenNthCalledWith(2, {
      title: '后台任务失败',
      body: '有一个后台任务需要处理。',
    })
    for (const [{ title, body }] of harness.notifyAttention.mock.calls) {
      expect(`${title} ${body}`).not.toContain('/Users/example')
      expect(`${title} ${body}`).not.toContain('run_secret.py')
      expect(`${title} ${body}`).not.toContain('session-123')
      expect(`${title} ${body}`).not.toContain('private-output')
    }
  })

  it('suppresses the matching outcome when live settings disable it', async () => {
    const harness = createHarness({ jobs: true, sessions: true, settings: true })
    const baseSnapshot: JobSnapshot = {
      id: 'bash-2' as JobId,
      kind: 'bash',
      label: 'pnpm install',
      status: 'completed',
      startedAt: 1,
      finishedAt: 2,
      reported: false,
    }

    await harness.updateSettings({
      notifyOnTurnCompletion: true,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: false,
      notifyOnJobFailure: true,
    })
    await harness.jobDone(baseSnapshot)
    await harness.jobDone({ ...baseSnapshot, status: 'failed' })

    await harness.updateSettings({
      notifyOnTurnCompletion: true,
      notifyOnTurnFailure: true,
      notifyOnJobCompletion: true,
      notifyOnJobFailure: false,
    })
    await harness.jobDone(baseSnapshot)
    await harness.jobDone({ ...baseSnapshot, status: 'failed' })

    expect(harness.notifyAttention.mock.calls).toEqual([
      [{ title: 'Background Job Failed', body: 'A background job needs attention.' }],
      [{ title: 'Background Job Completed', body: 'A background job has finished.' }],
    ])
  })

  it('notifies only when a direct-user turn ends successfully', async () => {
    const harness = createHarness({ jobs: false, sessions: true, settings: true, locale: 'en' })
    const activeSession = session()

    await harness.sessionEvent(activeSession, event('turn/start', { turn: 7 }, 1))
    await harness.sessionEvent(activeSession, userMessage(7, 'user'))

    expect(harness.notifyAttention).not.toHaveBeenCalled()

    await harness.sessionEvent(activeSession, event('turn/end', {
      turn: 7,
      reason: { kind: 'completed' },
    }, 3))

    expect(harness.notifyAttention).toHaveBeenCalledWith({
      title: 'Turn Completed',
      body: 'A direct user turn has finished.',
    })
  })

  it('notifies turn failures for error and max-tokens without leaking session or error details', async () => {
    const harness = createHarness({ jobs: false, sessions: true, settings: true, locale: 'zh' })
    const activeSession = session()

    await harness.sessionEvent(activeSession, event('turn/start', { turn: 1 }, 1))
    await harness.sessionEvent(activeSession, userMessage(1, 'user', 'secret prompt session-123 /Users/example'))
    await harness.sessionEvent(activeSession, event('turn/end', {
      turn: 1,
      reason: {
        kind: 'error',
        error: { code: 'UNKNOWN', message: 'private stack trace session-123 /Users/example' },
      },
    }, 3))

    await harness.sessionEvent(activeSession, event('turn/start', { turn: 2 }, 4))
    await harness.sessionEvent(activeSession, userMessage(2, 'user'))
    await harness.sessionEvent(activeSession, event('turn/end', {
      turn: 2,
      reason: { kind: 'max-tokens' },
    }, 6))

    expect(harness.notifyAttention).toHaveBeenNthCalledWith(1, {
      title: '用户回合失败',
      body: '有一个用户回合需要处理。',
    })
    expect(harness.notifyAttention).toHaveBeenNthCalledWith(2, {
      title: '用户回合失败',
      body: '有一个用户回合需要处理。',
    })
    for (const [{ title, body }] of harness.notifyAttention.mock.calls) {
      expect(`${title} ${body}`).not.toContain('/Users/example')
      expect(`${title} ${body}`).not.toContain('session-123')
      expect(`${title} ${body}`).not.toContain('stack trace')
      expect(`${title} ${body}`).not.toContain('secret prompt')
    }
  })

  it('suppresses non-notifying turn endings and non-direct-user turn sources', async () => {
    const harness = createHarness({ jobs: false, sessions: true, settings: true })
    const activeSession = session()
    const subagentSession = session('subagent')

    for (const reason of [
      { kind: 'aborted', reason: { kind: 'user' } },
      { kind: 'blocked' },
      { kind: 'interrupted' },
      { kind: 'custom-extension' },
    ] as const) {
      await harness.sessionEvent(activeSession, event('turn/start', { turn: 1 }, 1))
      await harness.sessionEvent(activeSession, userMessage(1, 'user'))
      await harness.sessionEvent(activeSession, event('turn/end', {
        turn: 1,
        reason,
      } as never, 2))
    }

    await harness.sessionEvent(subagentSession, event('turn/start', { turn: 1 }, 3))
    await harness.sessionEvent(subagentSession, userMessage(1, 'user'))
    await harness.sessionEvent(subagentSession, event('turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    }, 4))

    await harness.sessionEvent(activeSession, event('turn/start', { turn: 2 }, 5))
    await harness.sessionEvent(activeSession, userMessage(2, 'plugin'))
    await harness.sessionEvent(activeSession, event('turn/end', {
      turn: 2,
      reason: { kind: 'completed' },
    }, 6))

    await harness.sessionEvent(activeSession, event('turn/start', { turn: 3 }, 7))
    await harness.sessionEvent(activeSession, event('turn/end', {
      turn: 3,
      reason: { kind: 'completed' },
    }, 8))

    expect(harness.notifyAttention).not.toHaveBeenCalled()
  })

  it('tracks multiple sessions independently and ignores mismatched turn endings', async () => {
    const harness = createHarness({ jobs: false, sessions: true, settings: true })
    const first = session()
    const second = {
      header: {
        id: 'session-456' as SessionId,
        version: 0,
        createdAt: 1,
      },
    } as Session

    await harness.sessionEvent(first, event('turn/start', { turn: 1 }, 1))
    await harness.sessionEvent(first, userMessage(1, 'user'))
    await harness.sessionEvent(second, event('turn/start', { turn: 1 }, 2))
    await harness.sessionEvent(second, userMessage(1, 'user'))
    await harness.sessionEvent(first, event('turn/end', {
      turn: 9,
      reason: { kind: 'completed' },
    }, 3))
    await harness.sessionEvent(second, event('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'boom' } },
    }, 4))
    await harness.sessionEvent(first, event('turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    }, 5))

    expect(harness.notifyAttention.mock.calls).toEqual([
      [{ title: 'User Turn Failed', body: 'A direct user turn needs attention.' }],
      [{ title: 'Turn Completed', body: 'A direct user turn has finished.' }],
    ])
  })

  it('drops open turns when the optional sessions wiring is torn down and reattached', async () => {
    const harness = createHarness({ jobs: false, sessions: true, settings: true })
    const activeSession = session()

    await harness.sessionEvent(activeSession, event('turn/start', { turn: 7 }, 1))
    await harness.sessionEvent(activeSession, userMessage(7, 'user'))

    harness.teardownSessions()
    harness.reattachSessions()

    await harness.sessionEvent(activeSession, event('turn/end', {
      turn: 7,
      reason: { kind: 'completed' },
    }, 3))

    expect(harness.notifyAttention).not.toHaveBeenCalled()
  })
})
