import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { applyAdvancedShell } from './advanced-shell.ts'
import { parseDesktopClientEnvironment } from './environment.ts'
import { createDesktopUpdateClientController } from './update-controller.ts'
import type { DesktopUpdateKey } from './update-locales.ts'
import { en, zh } from './update-locales.ts'
import { UpdateBanner } from './UpdateBanner.tsx'
import { UpdateRow, type DesktopUpdateInjected } from './UpdateRow.tsx'

export { applyAdvancedShell } from './advanced-shell.ts'
export { parseDesktopClientEnvironment } from './environment.ts'
export type { DesktopClientEnvironment, DesktopClientMode, DesktopClientPlatform } from './environment.ts'
export { createDesktopUpdateClientController } from './update-controller.ts'
export { en as desktopUpdateEnglish, zh as desktopUpdateChinese } from './update-locales.ts'
export { UpdateBanner } from './UpdateBanner.tsx'
export { UpdateRow } from './UpdateRow.tsx'

/** Locale namespace shared by the settings row and update banner. */
export const DESKTOP_UPDATE_SETTINGS_NS = 'settings.desktopUpdate'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop update settings and banner copy. */
    'settings.desktopUpdate': DesktopUpdateKey
  }
}

/** Services required by advanced presentation. */
export const inject = [
  'connection',
  'locale',
  'slots',
  'sessions',
  'theme',
]

/** Register desktop-owned client surfaces for the current BrowserWindow mode. @param ctx - browser Cordis context. */
export function apply(ctx: ClientContext): void {
  const environment = parseDesktopClientEnvironment(window.location.search)
  if (environment.mode === 'advanced') applyAdvancedShell(ctx, environment)
  if (environment.updates) applyDesktopUpdates(ctx)
}

/** Register the packaged desktop update row and frame banner. */
function applyDesktopUpdates(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = createDesktopUpdateClientController(connection.rpc)
  const injected: DesktopUpdateInjected = {
    useUpdate: bindSnapshotSelector(controller.store),
    check: async () => { await controller.check() },
    download: async () => { await controller.download() },
    cancel: async () => { await controller.cancel() },
    install: async () => { await controller.install() },
    openReleasePage: async () => { await controller.openReleasePage() },
  }
  ctx.effect(() => () => { controller.dispose() }, 'desktop: update RPC polling')
  ctx.effect(
    () => ctx.locale.register(DESKTOP_UPDATE_SETTINGS_NS, { zh, en }),
    'desktop: update dictionaries',
  )
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'desktop-update',
    order: 100,
    locale: DESKTOP_UPDATE_SETTINGS_NS,
    inject: () => injected,
  }, UpdateRow))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'desktop-update',
    order: 100,
    locale: DESKTOP_UPDATE_SETTINGS_NS,
    inject: () => injected,
  }, UpdateBanner))
}
