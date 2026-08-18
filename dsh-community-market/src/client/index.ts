import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MarketLocaleKey } from './locales.js'
import { MarketLauncher } from './MarketLauncher.js'
import { MarketOverlay } from './MarketOverlay.js'
import { MarketSettingsTab } from './MarketSettingsTab.js'
import { createMarketViewStore } from './market-view-store.js'
import { en, zh } from './locales.js'
import { installMarketStyles } from './styles.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'community-market': MarketLocaleKey
  }
}

export const inject = ['slots', 'locale']
export const NS = 'community-market'

export function apply(ctx: ClientContext): void {
  const marketView = createMarketViewStore()
  const readLocale = () => ctx.locale.getLocale().active
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'community-market: dictionaries')
  ctx.effect(() => installMarketStyles(), 'community-market: styles')
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'community-market',
    order: 20,
    label: () => ctx.locale.bind(NS)('tab'),
    locale: NS,
    inject: () => ({ readLocale }),
  }, MarketSettingsTab))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'community-market',
    order: 10,
    label: () => ctx.locale.bind(NS)('tab'),
    locale: NS,
    store: marketView,
  }, MarketLauncher))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'community-market',
    order: 10,
    locale: NS,
    store: marketView,
    inject: () => ({ readLocale }),
  }, MarketOverlay))
}
