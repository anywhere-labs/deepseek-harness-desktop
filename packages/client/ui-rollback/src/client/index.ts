/**
 * Rollback surface plugin, browser half: one entry in the conversation's
 * `conversation.chat.assistant-leading-actions` list, rendered before the
 * finalized assistant message's copy control. The button consumes the
 * generated rollback Remote through the Client assembly; inject carries the
 * single verb bound to the entry's session, and the owner supplies the
 * message's event seq — the anchor the rollback truncates the session log at.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the leading-actions entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { RollbackActions } from './slots.ts'
import { normalizeRollback } from './slots.ts'
import { RollbackButton } from './RollbackButton.tsx'
import { en, zh, type RollbackKey } from './locales.ts'

export { RollbackButton } from './RollbackButton.tsx'
export type { RollbackActions, RollbackButtonProps, RollbackFailureView, RollbackOutcome } from './slots.ts'
export type { RollbackKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The rollback button's copy. */
    rollback: RollbackKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'rollback'

/** Required services for the rollback entry and copy. */
export const inject = ['slots', 'remote', 'remote.rollback', 'locale']

/**
 * Client plugin body: the rollback button with its Remote verb.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-rollback: dictionaries')

  ctx.slots.inject('conversation.chat.assistant-leading-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-leading-actions',
    id: 'rollback',
    order: 10,
    locale: NS,
    inject: (sessionId: SessionId): RollbackActions => ({
      rollback: async (messageSeq, code) => {
        const result = await ctx.remote.rollback.rollback({ sessionId, messageSeq, code })
        return normalizeRollback(result)
      },
    }),
  }, RollbackButton))
}
