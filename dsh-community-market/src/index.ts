import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import {
  registerMarketRoutes,
  registerMarketSettings,
  type MarketDesktopPlugins,
} from './host/routes.js'
import { createRestrictedHttpClient } from './network/restricted-http.js'
import {
  createNpmRegistryVerifier,
  MarketInstallService,
  type MarketDesktopPnpm,
  type MarketDesktopProfile,
} from './install/service.js'

export const name = 'community-market'
export const inject = ['webServer', 'settings']

interface DesktopProfilesCapability {
  readonly current: MarketDesktopProfile
}

interface DesktopActionsCapability {
  openTerminal(): void
  requestRestart(): Promise<void>
}

const npmRegistryHttp = createRestrictedHttpClient({
  // This is a compiled-in official registry hostname, never provider input.
  syntheticProxyHostnames: ['registry.npmjs.org'],
})

export function apply(ctx: Context): void {
  const scope = registerMarketSettings(ctx)
  let installService: MarketInstallService | undefined
  let desktopActions: DesktopActionsCapability | undefined
  let desktopPlugins: MarketDesktopPlugins | undefined
  const installProvider = { get: () => installService }
  const desktopActionsProvider = { get: () => desktopActions }
  const desktopPluginsProvider = { get: () => desktopPlugins }
  ctx.effect(
    () => registerMarketRoutes(ctx, scope, installProvider, desktopActionsProvider, desktopPluginsProvider),
    'community-market: routes',
  )
  ctx.inject(['desktopActions'], (desktopCtx) => {
    const actions = desktopCtx.get('desktopActions') as DesktopActionsCapability
    desktopCtx.effect(() => {
      desktopActions = actions
      return () => {
        if (desktopActions === actions) desktopActions = undefined
      }
    }, 'community-market: optional desktop actions')
  })
  ctx.inject(['desktopPlugins'], (desktopCtx) => {
    const plugins = desktopCtx.get('desktopPlugins') as MarketDesktopPlugins
    desktopCtx.effect(() => {
      desktopPlugins = plugins
      return () => {
        if (desktopPlugins === plugins) desktopPlugins = undefined
      }
    }, 'community-market: optional desktop plugin management')
  })
  // Browsing remains portable. Desktop-only package operations appear whenever
  // the narrow profile and package-manager capabilities are live.
  ctx.inject(['desktopProfiles', 'desktopPnpm'], (desktopCtx) => {
    const profiles = desktopCtx.get('desktopProfiles') as DesktopProfilesCapability
    const pnpm = desktopCtx.get('desktopPnpm') as MarketDesktopPnpm
    desktopCtx.effect(() => {
      const service = new MarketInstallService(
        scope,
        () => profiles.current,
        pnpm,
        createNpmRegistryVerifier(npmRegistryHttp),
        {
          disabledPackageNames: () => {
            const plugins = desktopPlugins
            if (plugins === undefined) {
              throw new Error('desktop plugin policy unavailable')
            }
            return plugins.disabledPackageNames()
          },
        },
      )
      installService = service
      return () => {
        if (installService === service) installService = undefined
        service.dispose()
      }
    }, 'community-market: desktop package operations')
  })
}

export { marketRoutes } from './host/routes.js'
export { BUILT_IN_PROVIDERS, DefaultCatalogService } from './catalog/service.js'
export { dsh1024StoreAdapter } from './adapters/dsh-1024store.js'
export { dshfindAdapter } from './adapters/dshfind.js'
export { companyStoreAdapter } from './adapters/company-store.js'
export {
  COMPANY_STORE_KEY,
  COMPANY_STORE_ADAPTER_ID,
  COMPANY_STORE_PROVIDER_ID,
} from './adapters/company-store.js'
export type * from './api-types.js'
export * from './contracts/index.js'
