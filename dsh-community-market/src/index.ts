import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { registerMarketRoutes, registerMarketSettings } from './host/routes.js'

export const name = 'community-market'
export const inject = ['webServer', 'settings']

export function apply(ctx: Context): void {
  const scope = registerMarketSettings(ctx)
  ctx.effect(() => registerMarketRoutes(ctx, scope), 'community-market: routes')
}

export { marketRoutes } from './host/routes.js'
export { BUILT_IN_PROVIDERS, DefaultCatalogService } from './catalog/service.js'
export { dsh1024StoreAdapter } from './adapters/dsh-1024store.js'
export type * from './api-types.js'
export * from './contracts/index.js'
