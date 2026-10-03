import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from './contracts.ts'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { DesktopLayoutState } from './layout-state.ts'

/** Install the layout selected by Advanced or Extended profile composition. */
export function installDesktopLayout(ctx: ClientContext, layout: DesktopLayoutState): void {
  if (ctx.reflect.get('layout', false) !== undefined) {
    throw new Error('dsh-plugin-desktop: advanced and extended modes require exclusive layout ownership')
  }

  ctx.effect(() => {
    const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } })
    const dispose = ctx.reflect.provide('layout', layout)
    const disposePanels = ctx.slots.subscribe('main', () => layout.retainMainPanels())
    layout.retainMainPanels()
    return () => {
      layout.dispose()
      disposePanels()
      disposePanelInfo()
      void dispose()
    }
  }, 'desktop: layout service')
  // Advanced and Extended replace the official layout owner, including its command.
  ctx.inject(['shortcuts', 'locale'], scope => {
    scope.effect(() => scope.locale.register('shortcuts.layout', {
      zh: { toggle: '展开／收起左侧栏' }, en: { toggle: 'Toggle left sidebar' },
    }), 'desktop: layout command labels')
    const t = scope.locale.bind('shortcuts.layout')
    scope.effect(() => scope.shortcuts.register({
      id: 'sidebar.left.toggle' as ShortcutCommandId,
      label: () => t('toggle'), aliases: ['sidebar', 'toggle left sidebar'],
      defaults: {
        'desktop:macos': { code: 'KeyB', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyB', modifiers: ['primary'] },
        'web:macos': { code: 'KeyB', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyB', modifiers: ['primary', 'alt'] },
      },
      regions: ['page', 'editable'], modals: [],
      resolve: () => ({ status: 'handled', run: () => { layout.toggleSidebar() } }),
    }), 'desktop: layout sidebar command')
  })
}
