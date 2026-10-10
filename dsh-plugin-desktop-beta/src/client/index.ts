import { installUiDiagnostics } from './ui-diagnostics.ts'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only service and SlotMap convergence for the Desktop settings section.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only service convergence for the launch-folder bridge's scoped inject.
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { registerDesktopOnboarding } from './onboarding.tsx'
import { createElement } from 'react'
import { SetupWizardApp, type EmbeddedSetupWizard } from '../native-ui/setup-wizard/App.tsx'
import './onboarding.css'
import { applySessionTrash } from './session-trash.tsx'
import { applyAdvancedShell } from './advanced-shell.ts'
import { startRendererBootReporter } from './boot-health.ts'
import { applyDesktopSettings } from './desktop-settings.ts'
import { installDesktopDirectoryPickerBridge } from './directory-picker.ts'
import { parseDesktopClientEnvironment } from './environment.ts'
import { applyExtendedShell } from './extended-shell.ts'
import { installDesktopLaunchWorkspaceBridge } from './launch-workspace.ts'
import { DESKTOP_SETTINGS_FORMS_SERVICE } from './settings-bridge.ts'
import { installSidebarFooterStyles } from './sidebar-footer-styles.ts'
import { desktopWindowService, provideDesktopWindow } from './window-service.ts'

export { applyAdvancedShell } from './advanced-shell.ts'
export { applyDesktopSettings } from './desktop-settings.ts'
export { applyExtendedShell, applyFramedShell } from './extended-shell.ts'
export {
  createDesktopSettingsApi,
  desktopSettingsPaths,
  parseDesktopActionAcceptance,
  parseDesktopRestartAcceptance,
  parseDesktopSettingsView,
} from './desktop-settings-api.ts'
export type {
  DesktopMarketProvider,
  DesktopMarketView,
  DesktopProfileView,
  DesktopRestartAcceptance,
  DesktopSettingsApi,
  DesktopSettingsView,
} from './desktop-settings-api.ts'
export { DesktopSettingsSection } from './DesktopSettingsSection.tsx'
export { DesktopTerminalSettingsAction } from './DesktopTerminalSettingsAction.tsx'
export type {
  DesktopTerminalSettingsActionInjected,
  DesktopTerminalSettingsActionProps,
} from './DesktopTerminalSettingsAction.tsx'
export type {
  DesktopNotificationSettings,
  DesktopSettingsSectionInjected,
  DesktopSettingsSectionProps,
  DesktopShellSettings,
} from './DesktopSettingsSection.tsx'
export {
  RENDERER_BOOT_REPORT_PATH,
  rendererBootReport,
  sendRendererBootReport,
  startRendererBootReporter,
} from './boot-health.ts'
export type { RendererBootLoader, RendererBootReport } from './boot-health.ts'
export { parseDesktopClientEnvironment } from './environment.ts'
export type {
  DesktopClientEnvironment,
  DesktopClientMaterial,
  DesktopClientMode,
  DesktopClientPlatform,
} from './environment.ts'
export { desktopWindowService, provideDesktopWindow } from './window-service.ts'
export type {
  DesktopWindowDragRegion,
  DesktopWindowInsets,
  DesktopWindowService,
} from './contracts.ts'
export {
  installDesktopLaunchWorkspaceBridge,
  openDesktopLaunchWorkspace,
} from './launch-workspace.ts'
export type {
  DesktopLaunchWorkspaceTarget,
  DesktopLaunchWorkspaceWindow,
} from './launch-workspace.ts'

/**
 * Settle once both Host-backed lists the open path depends on have arrived.
 *
 * Registering before the first Workspace baseline installs is not merely early:
 * the baseline replaces the list wholesale, so the echoed row disappears and the
 * open that follows fails against an id the list no longer holds. Waiting for
 * the session list as well keeps a repeated launch from minting a second blank
 * session that the reuse scan could not yet see.
 * @param ctx - scope holding both controller services.
 */
async function whenWorkspaceListsReady(ctx: ClientContext): Promise<void> {
  const settled = (): boolean => ctx.workspaces.list.getSnapshot().phase === 'ready'
    && ctx.sessions.list.getSnapshot().phase === 'ready'
  if (settled()) return
  await new Promise<void>(resolve => {
    const disposers: (() => void)[] = []
    const check = (): void => {
      if (!settled()) return
      for (const dispose of disposers.splice(0)) dispose()
      resolve()
    }
    disposers.push(ctx.workspaces.list.subscribe(check), ctx.sessions.list.subscribe(check))
    check()
  })
}

/** Services required by Desktop settings and Desktop-owned presentations. */
export const inject = [
  'slots',
  'locale',
  'connection',
  'remote',
  DESKTOP_SETTINGS_FORMS_SERVICE,
  'sessions',
  'theme',
  'uiRenderer',
]

/** Register desktop-owned client surfaces for the current BrowserWindow mode. @param ctx - browser Cordis context. */
export function apply(ctx: ClientContext): void {
  const environment = parseDesktopClientEnvironment(window.location.search)
  if (!environment) return
  ctx.effect(installUiDiagnostics, 'Desktop client failure diagnostics')
  ctx.effect(
    () => provideDesktopWindow(ctx, desktopWindowService(environment)),
    'dsh-plugin-desktop: native window geometry service',
  )
  const desktopSettings = applyDesktopSettings(ctx, environment)
  ctx.inject(['uiWorkspace'], scope => { applySessionTrash(scope) })
  registerDesktopOnboarding(ctx, (snapshot, locale, finish, renderNavigation) => createElement<{ embedded?: EmbeddedSetupWizard }>(SetupWizardApp, {
    embedded: { input: snapshot.input, locale, renderNavigation, finish: selection => finish(snapshot.profile, selection) },
  }))
  // Every mode shares the footer seat: upstream's row flex would otherwise let
  // two launchers crush each other, and compatibility mode installs no frame styles.
  ctx.effect(
    () => installSidebarFooterStyles(),
    'dsh-plugin-desktop: sidebar footer stacking styles',
  )
  ctx.effect(
    () => startRendererBootReporter(ctx.loader),
    'dsh-plugin-desktop: renderer boot health report',
  )
  if (environment.platform === 'win32') {
    ctx.effect(
      () => installDesktopDirectoryPickerBridge(),
      'dsh-plugin-desktop: native directory picker bridge',
    )
  }
  if (environment.mode === 'advanced') applyAdvancedShell(ctx, environment)
  if (environment.mode === 'extended') applyExtendedShell(ctx, environment, desktopSettings)
  // Scoped rather than module-level on purpose: the shells above provide
  // `layout`, and upstream's `uiWorkspace` injects it. Naming `uiWorkspace` in
  // the module-level inject list would deadlock the two against each other.
  // Not gated on win32 either — the launcher's folder argument works on Linux.
  ctx.inject(['workspaces', 'uiWorkspace'], (scope: ClientContext) => {
    scope.effect(
      () => installDesktopLaunchWorkspaceBridge({
        ready: async () => { await whenWorkspaceListsReady(scope) },
        create: async path => (await scope.workspaces.create({ path })).workspaceId,
        open: async workspaceId => { await scope.uiWorkspace.openWorkspace(workspaceId) },
        reportError: message => { console.error(`dsh-plugin-desktop: ${message}`) },
      }),
      'dsh-plugin-desktop: launch workspace bridge',
    )
  })
}
