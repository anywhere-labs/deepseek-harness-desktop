/** Cordis Host plugin exposing diagnostic export through the native tray. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from './runtime.ts'
import { desktopTrayLabel } from './tray-locale.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-diagnostics'

/** Native adapter required to create diagnostic archives and reveal them. */
export const inject = ['desktopRuntime']

/** Register the diagnostic export command for one Host generation. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const registration = ctx.desktopRuntime.registerTrayItem({
      group: 'tools',
      order: 20,
      label: () => desktopTrayLabel(ctx.desktopRuntime.locale, 'exportDiagnostics'),
      invoke: () => ctx.desktopRuntime.exportDiagnostics(),
    })
    return () => { registration.dispose() }
  }, 'dsh-plugin-desktop: diagnostic export tray command')
}
