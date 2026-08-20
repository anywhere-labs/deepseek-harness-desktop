/**
 * Close-behavior settings row: registers the preference into the General
 * section item slot and binds reads/writes to the dsh-desktop namespace scope.
 */
import type { ClientContext, EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { DESKTOP_SETTINGS_NAMESPACE } from '../settings-namespaces.ts'
import type { DesktopCloseBehavior } from '../runtime.ts'
import type { CloseBehaviorRowState } from './close-behavior-settings-state.ts'
import type { CloseBehaviorRowActions } from './close-behavior-settings-store.ts'
import { CloseBehaviorRow, type CloseBehaviorRowInjected } from './CloseBehaviorRow.tsx'
import { en, zh } from './close-behavior-locale.ts'

/** Locale namespace owning the row copy. */
export const CLOSE_BEHAVIOR_SETTINGS_NS = 'settings.desktop'

/** Narrow desktop section read by the row. */
interface DesktopSettingsSection {
  closeBehavior: DesktopCloseBehavior
}

/**
 * Register the close-behavior row into the General settings section.
 * @param ctx - desktop client context (injects slots, locale, settingsScope).
 * @param createStore - row store factory; injected so the glue stays node-testable.
 */
export function registerCloseBehaviorRow(
  ctx: ClientContext,
  createStore: () => EngineStoreHandle<CloseBehaviorRowState, CloseBehaviorRowActions>,
): void {
  const host = ctx.settingsScope.bind<DesktopSettingsSection>({ namespace: DESKTOP_SETTINGS_NAMESPACE })
  ctx.locale.register(CLOSE_BEHAVIOR_SETTINGS_NS, { zh, en })

  const store = createStore()
  let bound: BoundActions<typeof store> | undefined
  const sync = (): void => {
    const snapshot = host.getSnapshot()
    const section = snapshot.value
    if (section === undefined || snapshot.revision === undefined) return
    bound?.sync(section.closeBehavior, snapshot.revision)
  }
  ctx.effect(() => host.subscribe(sync), 'dsh-plugin-desktop: close-behavior settings scope adoption')
  const injected = (actions: BoundActions<typeof store>): CloseBehaviorRowInjected => {
    bound = actions
    sync()
    return { setCloseBehavior: value => { void host.set('closeBehavior', value) } }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'close-behavior',
    order: 10,
    store,
    locale: CLOSE_BEHAVIOR_SETTINGS_NS,
    inject: injected,
  }, CloseBehaviorRow))
}
