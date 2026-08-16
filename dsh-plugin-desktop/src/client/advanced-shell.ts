import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from './contracts.ts'
import type { DesktopClientEnvironment } from './environment.ts'
import { AdvancedFrame } from './AdvancedFrame.tsx'
import { DesktopLayoutState } from './layout-state.ts'
import { provideDesktopLayout } from './layout-service.ts'
import { installAdvancedStyles } from './styles.ts'
import { DesktopThemePresenter } from './theme-presenter.ts'
import { ConnectionFilePreviewGateway } from './file-preview/gateway.ts'
import { FilePreviewController } from './file-preview/controller.ts'
import { FilePreviewRegistry } from './file-preview/registry.ts'
import { registerFilePreviewProviders } from './file-preview/providers/index.ts'
import { WorkspacesOpenPathDecorator } from './file-preview/open-path-decorator.ts'

/**
 * Provide the advanced layout service, the file-preview surface, and own the
 * desktop root slot (design §16.10). The effect order is fixed so teardown
 * unwinds in a safe sequence: root UI first, then styles/injections, then the
 * open-path wrapper restore, then provider unregistration, then the controller
 * release wait, and finally the layout service.
 * @param ctx - active browser Cordis context.
 * @param environment - validated mode and platform marker.
 */
export function applyAdvancedShell(ctx: ClientContext, environment: DesktopClientEnvironment): void {
  if (environment.mode !== 'advanced') {
    throw new Error(`dsh-plugin-desktop: advanced shell received mode ${JSON.stringify(environment.mode)}`)
  }

  // 1. Captured dependencies: the layout, the provider registry, the RPC
  // gateway, and the decorator that captures the original system opener.
  const desktopLayout = new DesktopLayoutState()
  const registry = new FilePreviewRegistry()
  const gateway = new ConnectionFilePreviewGateway(
    ctx.connection.rpc,
    { debug: ctx.logger.debug.bind(ctx.logger) },
  )
  const decorator = new WorkspacesOpenPathDecorator(
    ctx.workspaces,
    () => ctx.sessions.list.getSnapshot().current,
  )

  // 2. Controller wired to the layout surface, the captured system opener, and
  // the live current-session reader.
  const controller = new FilePreviewController(gateway, registry, {
    openFile: () => { desktopLayout.openFile() },
    closeFile: () => { desktopLayout.closeFile() },
    openSystemPath: (path) => decorator.openSystemPath(path),
    getCurrentSessionId: () => ctx.sessions.list.getSnapshot().current,
  })

  // 3. Layout service registration.
  ctx.effect(
    () => provideDesktopLayout(ctx, desktopLayout),
    'desktop: layout service',
  )

  // 4. Awaitable controller cleanup; dispose releases held resources.
  ctx.effect(() => () => void controller.dispose(), 'desktop: file preview controller cleanup')

  // 5. Register the four built-in providers and their disposers.
  ctx.effect(() => {
    const disposers = registerFilePreviewProviders(registry)
    return () => { for (const disposer of disposers) disposer() }
  }, 'desktop: file preview providers')

  // 6. Install the reversible open-path wrapper routing clicks into the controller.
  ctx.effect(() => {
    decorator.install((sessionId, path) => controller.preview(sessionId, path))
    return () => { decorator.dispose() }
  }, 'desktop: open-path decorator')

  // 7. Every details selection suspends an early file probe/read.
  ctx.effect(
    () => desktopLayout.onDetailsIntent(() => { controller.suspend() }),
    'desktop: file preview suspend on details intent',
  )

  // 8. Advanced shell styles and the theme presenter.
  ctx.effect(() => {
    document.body.dataset.dshDesktopMode = 'advanced'
    document.body.dataset.dshDesktopPlatform = environment.platform
    const removeStyles = installAdvancedStyles()
    return () => {
      removeStyles()
      delete document.body.dataset.dshDesktopMode
      delete document.body.dataset.dshDesktopPlatform
    }
  }, 'desktop: advanced shell styles')

  ctx.effect(() => {
    const presenter = new DesktopThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', snapshot => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'desktop: theme presenter')

  // 9. Root slot injecting the stable layout, platform, controller, and registry.
  ctx.effect(() => ctx.slots.register({
    name: 'root',
    children: {
      'sidebar': { kind: 'single', scope: 'root' },
      'conversation': { kind: 'single', scope: 'session-maybe' },
      'details': { kind: 'single', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
    inject: () => ({
      layout: desktopLayout,
      platform: environment.platform,
      filePreview: controller,
      filePreviewRegistry: registry,
    }),
  }, AdvancedFrame), 'desktop: advanced root slot')
}
