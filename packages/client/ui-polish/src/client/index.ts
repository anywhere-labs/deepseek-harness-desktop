/**
 * Polish surface plugin, browser half: one entry in the composer's
 * `conversation.input.right` list (the seat immediately left of the model
 * select). The button consumes the generated polish Remote through the Client
 * assembly; inject carries only the two verbs bound to the entry's session,
 * live draft state arrives through the framework session kit.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.right entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PolishActions } from './slots.ts'
import { PolishButton } from './PolishButton.tsx'
import { en, zh, type PolishKey } from './locales.ts'

export { PolishButton } from './PolishButton.tsx'
export type { PolishOutcome } from './slots.ts'
export type { PolishKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The polish button's copy. */
    polish: PolishKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'polish'

/** Required services for the polish entry and copy. */
export const inject = ['slots', 'sessions', 'remote', 'remote.polish', 'locale']

/**
 * Client plugin body: the polish button with its Remote verbs.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-polish: dictionaries')

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'polish',
    order: 10,
    locale: NS,
    inject: (sessionId: SessionId): PolishActions => ({
      modelOf: async () => {
        const result = await ctx.remote.polish.model({ sessionId })
        return result.ok ? result.value.label : ''
      },
      polish: async (message) => {
        const result = await ctx.remote.polish.polish({ sessionId, message })
        if (!result.ok) {
          return { ok: false, code: result.error.code, message: result.error.message }
        }
        if (result.value.ok) return { ok: true, text: result.value.value.text }
        return { ok: false, code: result.value.error.code, message: result.value.error.code }
      },
    }),
  }, PolishButton))
}
