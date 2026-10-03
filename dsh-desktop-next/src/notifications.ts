/** Native notifications for user and scheduled turns, with bounded user previews. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { toString } from 'mdast-util-to-string'
import { gfm } from 'micromark-extension-gfm'
import type { DesktopNotification, DesktopPreferences, NotificationOutcome } from './desktop-contract.ts'

const TITLE_LIMIT = 160
const BODY_LIMIT = 1000

/** The native notification API accepts plain text, so project the Web client's GFM grammar before truncating. */
function plainText(node: Nodes): string {
  if (node.type === 'root' || node.type === 'list' || node.type === 'listItem'
    || node.type === 'blockquote' || node.type === 'table' || node.type === 'tableRow') {
    return node.children.map(plainText).filter(Boolean).join(' ')
  }
  return toString(node, { includeHtml: false })
}

function preview(content: readonly ContentBlock[], limit: number): string {
  const markdown = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  let text: string
  try {
    text = plainText(fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }))
      .replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
  return text.length <= limit ? text : `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '')}…`
}

export function isDesktopNotification(value: unknown): value is DesktopNotification {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  if (candidate.outcome === 'turn-failed' || candidate.outcome === 'schedule-completed' || candidate.outcome === 'schedule-failed') return true
  return candidate.outcome === 'turn-completed'
    && typeof candidate.userMessage === 'string' && candidate.userMessage.length <= TITLE_LIMIT
    && typeof candidate.assistantMessage === 'string' && candidate.assistantMessage.length <= BODY_LIMIT
}

export function notificationCopy(notification: DesktopNotification, language: string): { title: string; body: string } {
  const zh = language.startsWith('zh')
  if (notification.outcome === 'schedule-completed') return {
    title: zh ? '自动化任务完成' : 'Automation task completed',
    body: zh ? '一个自动化任务已完成。' : 'An automation task has finished.',
  }
  if (notification.outcome === 'schedule-failed') return {
    title: zh ? '自动化任务失败' : 'Automation task failed',
    body: zh ? '打开 DSH NEXT 查看详情。' : 'Open DSH NEXT for details.',
  }
  return notification.outcome === 'turn-completed' ? {
    title: notification.userMessage || (zh ? '回合已完成' : 'Turn completed'),
    body: notification.assistantMessage || (zh ? '你发起的回合已完成。' : 'A turn you started has finished.'),
  } : {
    title: zh ? '回合未能完成' : 'Turn could not finish',
    body: zh ? '打开 DSH NEXT 查看详情。' : 'Open DSH NEXT for details.',
  }
}

export function notificationEnabled(preferences: DesktopPreferences, outcome: NotificationOutcome): boolean {
  const key = { 'turn-completed': 'turnCompleted', 'turn-failed': 'turnFailed', 'schedule-completed': 'scheduleCompleted', 'schedule-failed': 'scheduleFailed' } as const
  return preferences.notifications && preferences[key[outcome]]
}

export class TurnAttention {
  private readonly open = new Map<string, { turn: number; source: 'user' | 'schedule' | undefined; userMessage: string; assistantMessage: string }>()
  constructor(private readonly notify: (notification: DesktopNotification) => void) {}
  event(session: Session, event: SessionEvent): void {
    if (session.header.origin === 'subagent') return
    const id = String(session.header.id)
    if (event.type === 'turn/start') { this.open.set(id, { turn: event.data.turn, source: undefined, userMessage: '', assistantMessage: '' }); return }
    const turn = this.open.get(id)
    if (!turn) return
    if (event.type === 'user/message') {
      const source = event.data.source.kind as string
      if (source !== 'user' && source !== 'schedule') return
      turn.source = source
      if (turn.source === 'user') turn.userMessage = preview(event.data.content, TITLE_LIMIT)
    }
    if (event.type === 'assistant/message' && turn.source === 'user' && event.data.turn === turn.turn && !event.data.interrupted) {
      turn.assistantMessage = preview(event.data.message.content, BODY_LIMIT)
    }
    if (event.type !== 'turn/end' || event.data.turn !== turn.turn) return
    this.open.delete(id)
    if (!turn.source) return
    const reason = event.data.reason.kind
    if (turn.source === 'schedule') {
      if (reason === 'completed') this.notify({ outcome: 'schedule-completed' })
      else if (reason === 'error' || reason === 'max-tokens') this.notify({ outcome: 'schedule-failed' })
    } else if (reason === 'completed') this.notify({ outcome: 'turn-completed', userMessage: turn.userMessage, assistantMessage: turn.assistantMessage })
    else if (reason === 'error' || reason === 'max-tokens') this.notify({ outcome: 'turn-failed' })
  }
  dispose(session: Session): void { this.open.delete(String(session.header.id)) }
}

export function installNotifications(ctx: Context, notify: (notification: DesktopNotification) => void): void {
  ctx.inject(['sessions'], child => child.effect(() => {
    const turns = new TurnAttention(notify)
    const events = child.on('session/event', (session, event) => turns.event(session, event))
    const disposed = child.on('session/disposed', session => turns.dispose(session))
    return () => { events(); disposed() }
  }, 'Next turn notifications'))
}
