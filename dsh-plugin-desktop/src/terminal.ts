/** Cordis Host plugin contributing the packaged DSH terminal to the native tray. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from './runtime.ts'
import { desktopTrayLabel } from './tray-locale.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-terminal'

/** Native adapter required to create shims and launch the system terminal. */
export const inject = ['desktopRuntime']

/**
 * Register the system-terminal command for one Host generation.
 * @param ctx - Host context carrying the Electron adapter.
 */
export function apply(ctx: Context): void {
  if (ctx.desktopRuntime.platform === 'linux') {
    throw new Error('dsh-plugin-desktop: the packaged terminal is supported on macOS and Windows')
  }
  ctx.effect(() => {
    const registration = ctx.desktopRuntime.registerTrayItem({
      group: 'tools',
      order: 10,
      label: () => desktopTrayLabel(ctx.desktopRuntime.locale, 'openTerminal'),
      invoke: () => { ctx.desktopRuntime.openTerminal() },
    })
    return () => { registration.dispose() }
  }, 'dsh-plugin-desktop: packaged terminal tray command')
}
