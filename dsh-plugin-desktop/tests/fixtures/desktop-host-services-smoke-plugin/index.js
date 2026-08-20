/** Real profile-local Host plugin used by the complete Loader smoke. */

export const name = 'desktop-host-services-smoke-plugin'

/** Both Desktop services must exist before Loader may activate this entry. */
export const inject = ['desktopProfiles', 'desktopPnpm']

/** Read the supported contracts and publish an assertion-friendly result. */
export function apply(ctx) {
  const current = ctx.desktopProfiles.current
  const pnpm = ctx.desktopPnpm
  ctx.provide('desktopHostServiceProbe', Object.freeze({
    current: Object.freeze({ name: current.name, dir: current.dir }),
    pnpm: Object.freeze({
      serviceName: pnpm.name,
      lookupRun: typeof ctx.get('desktopPnpm')?.run,
      run: typeof pnpm.run,
      runPlugin: typeof pnpm.runPlugin,
      installPlugin: typeof pnpm.installPlugin,
      recoveredInstallReceiptIds: typeof pnpm.recoveredInstallReceiptIds,
      acknowledgeRecoveredInstall: typeof pnpm.acknowledgeRecoveredInstall,
      rollbackPluginInstall: typeof pnpm.rollbackPluginInstall,
    }),
  }))
}
