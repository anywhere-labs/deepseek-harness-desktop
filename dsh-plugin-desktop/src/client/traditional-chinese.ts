/** Traditional Chinese language pack registration shared by the Desktop shells. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'

/** Selectable id of the Desktop Traditional Chinese language pack. */
export const TRADITIONAL_CHINESE = 'zh-TW'

/** Self-described label shown in Settings → Language. */
export const TRADITIONAL_CHINESE_LABEL = '繁體中文'

/**
 * Add Traditional Chinese to the shared locale catalog once.
 *
 * The upstream catalog only ships `zh`/`en`, so the desktop side owns this
 * language pack. `zh` is its declared fallback: any namespace the Desktop does
 * not translate yet (every upstream UI namespace) keeps rendering Simplified
 * Chinese instead of falling all the way back to English.
 *
 * @param ctx - client plugin context owning the locale service.
 * @returns the registration disposer; a no-op when the id is already taken.
 */
export function registerTraditionalChinese(ctx: ClientContext): () => void {
  if (ctx.locale.getLocale().locales.some(locale => locale.id === TRADITIONAL_CHINESE)) return () => {}
  return ctx.locale.addLanguage({
    id: TRADITIONAL_CHINESE,
    label: TRADITIONAL_CHINESE_LABEL,
    fallback: 'zh',
  })
}