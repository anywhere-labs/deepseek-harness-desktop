import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { DEFAULT_PREFERENCES } from '../src/desktop-contract.ts'
import { installNotifications, isDesktopNotification, notificationCopy, notificationEnabled, TurnAttention } from '../src/notifications.ts'

const session = { header: { id: 'main' } } as Session
const event = (type: string, data: object) => ({ type, data }) as SessionEvent
const text = (value: string) => ({ type: 'text', text: value })
const user = (message: string, kind = 'user') => event('user/message', { source: { kind }, content: [text(message)] })
const assistant = (turn: number, message: string) => event('assistant/message', { turn, message: { content: [text(message)] } })
const end = (turn: number, kind = 'completed') => event('turn/end', { turn, reason: { kind } })

it('notifies for the initiating user turn, not subagents, unknown automation, or duplicate endings', () => {
  const notify = vi.fn()
  const tracker = new TurnAttention(notify)
  tracker.event(session, event('turn/start', { turn: 1 }))
  tracker.event(session, user('Check my code'))
  tracker.event(session, assistant(1, 'Fixed the issue.'))
  tracker.event(session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  tracker.event(session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  tracker.event(session, event('turn/start', { turn: 2 }))
  tracker.event(session, event('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  const child = { header: { id: 'child', origin: 'subagent' } } as unknown as Session
  tracker.event(child, event('turn/start', { turn: 1 }))
  tracker.event(child, user('Subagent work'))
  tracker.event(child, event('turn/end', { turn: 1, reason: { kind: 'error' } }))
  expect(notify.mock.calls).toEqual([[{ outcome: 'turn-completed', userMessage: 'Check my code', assistantMessage: 'Fixed the issue.' }]])
  expect(notificationEnabled({ ...DEFAULT_PREFERENCES, notifications: false }, 'turn-completed')).toBe(false)
  expect(notificationEnabled({ ...DEFAULT_PREFERENCES, turnFailed: false }, 'turn-failed')).toBe(false)
  expect(notificationEnabled({ ...DEFAULT_PREFERENCES }, 'turn-completed')).toBe(true)
})

it('notifies for scheduled turn outcomes without exposing the reminder or reply', () => {
  const notify = vi.fn()
  const tracker = new TurnAttention(notify)
  tracker.event(session, event('turn/start', { turn: 1 }))
  tracker.event(session, user('Private reminder', 'schedule'))
  tracker.event(session, assistant(1, 'Private result'))
  tracker.event(session, end(1))
  tracker.event(session, end(1))
  tracker.event(session, event('turn/start', { turn: 2 }))
  tracker.event(session, user('Another private reminder', 'schedule'))
  tracker.event(session, end(2, 'error'))
  expect(notify.mock.calls.map(([value]) => value)).toEqual([
    { outcome: 'schedule-completed' }, { outcome: 'schedule-failed' },
  ])
  expect(notificationCopy({ outcome: 'schedule-completed' }, 'zh')).toEqual({ title: '自动化任务完成', body: '一个自动化任务已完成。' })
  expect(notificationEnabled({ ...DEFAULT_PREFERENCES, scheduleCompleted: false }, 'schedule-completed')).toBe(false)
  expect(notificationEnabled({ ...DEFAULT_PREFERENCES, scheduleFailed: false }, 'schedule-failed')).toBe(false)
  expect(isDesktopNotification({ outcome: 'schedule-completed' })).toBe(true)
  expect(isDesktopNotification({ outcome: 'schedule-failed' })).toBe(true)
})

it('uses the actual user prompt and final visible assistant reply from the same turn', () => {
  const notify = vi.fn()
  const tracker = new TurnAttention(notify)
  tracker.event(session, event('turn/start', { turn: 1 }))
  tracker.event(session, user('帮我检查\n这段代码'))
  tracker.event(session, assistant(1, '正在检查'))
  tracker.event(session, user('plugin context', 'plugin'))
  tracker.event(session, event('assistant/message', { turn: 1, message: { content: [
    { type: 'reasoning', text: 'private reasoning' }, text('检查完成。'), text('已经修复。'),
    { type: 'tool-call', name: 'shell', arguments: 'private command' },
  ] } }))
  tracker.event(session, assistant(0, 'stale reply'))
  tracker.event(session, end(0))
  tracker.event(session, end(1))
  expect(notify.mock.calls).toEqual([[{ outcome: 'turn-completed', userMessage: '帮我检查 这段代码', assistantMessage: '检查完成。 已经修复。' }]])
  expect(notificationCopy(notify.mock.calls[0]![0], 'zh')).toEqual({ title: '帮我检查 这段代码', body: '检查完成。 已经修复。' })
})

it('projects Markdown previews to plain text before sending native notifications', () => {
  const notify = vi.fn()
  const tracker = new TurnAttention(notify)
  tracker.event(session, event('turn/start', { turn: 1 }))
  tracker.event(session, user('**Check** [docs](https://example.com)'))
  tracker.event(session, assistant(1, '# Result\n\n- **Done**\n- `code`'))
  tracker.event(session, end(1))
  expect(notify).toHaveBeenCalledWith({
    outcome: 'turn-completed', userMessage: 'Check docs', assistantMessage: 'Result Done code',
  })
  expect(notificationCopy(notify.mock.calls[0]![0], 'en')).toEqual({ title: 'Check docs', body: 'Result Done code' })
})

it('keeps sessions and turns separate and sends generic failures', () => {
  const notify = vi.fn()
  const tracker = new TurnAttention(notify)
  const other = { header: { id: 'other' } } as Session
  for (const target of [session, other]) {
    tracker.event(target, event('turn/start', { turn: 1 }))
    tracker.event(target, user(String(target.header.id)))
    tracker.event(target, assistant(1, `reply ${target.header.id}`))
  }
  tracker.event(other, end(1))
  tracker.event(session, end(1))
  tracker.event(session, event('turn/start', { turn: 2 }))
  tracker.event(session, user(''))
  tracker.event(session, end(2))
  tracker.event(session, event('turn/start', { turn: 3 }))
  tracker.event(session, user('failed prompt'))
  tracker.event(session, end(3, 'error'))
  tracker.event(session, event('turn/start', { turn: 4 }))
  tracker.event(session, user('disposed prompt'))
  tracker.dispose(session)
  tracker.event(session, end(4))
  expect(notify.mock.calls.map(([value]) => value)).toEqual([
    { outcome: 'turn-completed', userMessage: 'other', assistantMessage: 'reply other' },
    { outcome: 'turn-completed', userMessage: 'main', assistantMessage: 'reply main' },
    { outcome: 'turn-completed', userMessage: '', assistantMessage: '' },
    { outcome: 'turn-failed' },
  ])
  expect(notificationCopy(notify.mock.calls[2]![0], 'en')).toEqual({ title: 'Turn completed', body: 'A turn you started has finished.' })
})

it('bounds notification previews and validates the IPC payload', () => {
  const notify = vi.fn()
  const tracker = new TurnAttention(notify)
  tracker.event(session, event('turn/start', { turn: 1 }))
  tracker.event(session, user('😀'.repeat(200)))
  tracker.event(session, assistant(1, '答'.repeat(2000)))
  tracker.event(session, end(1))
  const notification = notify.mock.calls[0]![0]
  expect(notification.userMessage.length).toBeLessThanOrEqual(160)
  expect(notification.userMessage).toMatch(/😀…$/u)
  expect(notification.assistantMessage).toHaveLength(1000)
  expect(isDesktopNotification(notification)).toBe(true)
  for (const value of [null, { outcome: 'job-completed' }, { outcome: 'job-failed' }, { outcome: 'turn-completed' },
    { ...notification, userMessage: 1 }, { ...notification, assistantMessage: 'x'.repeat(1001) }]) {
    expect(isDesktopNotification(value)).toBe(false)
  }
})

it('subscribes only to sessions', () => {
  const inject = vi.fn()
  installNotifications({ inject } as unknown as Context, vi.fn())
  expect(inject.mock.calls.map(([dependencies]) => dependencies)).toEqual([['sessions']])
})
