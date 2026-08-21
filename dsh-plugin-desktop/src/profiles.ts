/** Cordis Host surface for selecting the launcher-owned DSH profile. */

import type { Context } from '@deepseek-ai/cordis'
import type { DesktopProfileSummary } from './profile-manager.ts'
import type {} from './profile-service.ts'
import type { DesktopTraySubmenuItem } from './runtime.ts'
import { desktopTrayLabel } from './tray-locale.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-profiles'

/** Native tray and launcher profile services required by this Host surface. */
export const inject = ['desktopRuntime', 'desktopProfiles']

/** Return whether a discovered profile can back the desktop Web surface. */
function selectable(profile: DesktopProfileSummary): boolean {
  return profile.webCapable && profile.problem === undefined
}

/** Render unavailable profiles without exposing manifest diagnostics in native menus. */
function profileLabel(profile: DesktopProfileSummary, locale: Context['desktopRuntime']['locale']): string {
  return selectable(profile)
    ? profile.name
    : desktopTrayLabel(locale, 'unavailableForDesktop', profile.name)
}

/** Register the current profile and restart-safe switch commands in the native tray. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const registration = ctx.desktopRuntime.registerTrayItem({
      group: 'profiles',
      order: 10,
      label: () => desktopTrayLabel(ctx.desktopRuntime.locale, 'profile', ctx.desktopProfiles.current.name),
      invoke: () => {},
      submenu: (): DesktopTraySubmenuItem[] => [
        ...ctx.desktopProfiles.list().map(profile => ({
          label: () => profileLabel(profile, ctx.desktopRuntime.locale),
          type: 'radio' as const,
          checked: () => profile.name === ctx.desktopProfiles.current.name,
          enabled: () => selectable(profile),
          invoke: async () => {
            if (profile.name === ctx.desktopProfiles.current.name) return
            await ctx.desktopProfiles.select(profile.name)
          },
        })),
        {
          label: () => desktopTrayLabel(ctx.desktopRuntime.locale, 'addProfile'),
          invoke: () => {
            ctx.desktopRuntime.openProfileCreateWindow({
              onSubmit: async name => {
                ctx.desktopProfiles.create(name)
                await ctx.desktopProfiles.select(name)
              },
            })
          },
        },
      ],
    })
    return () => { registration.dispose() }
  }, 'dsh-plugin-desktop: native profile selector')
}
