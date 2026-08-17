/** Desktop Host surface: one-click import of community plugins from the web profile. */

import type { Context } from '@deepseek-ai/cordis'
import type { PluginImportPlan } from './profile-plugin-import.ts'
import { desktopOwnedBundles, pluginImportPlanForProfiles } from './profile-plugin-import.ts'
import type {} from './profile-service.ts'
import type {} from './pnpm.ts'
import type {} from './runtime.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-plugin-import'

/** Services required before the import surface can offer or run an import. */
export const inject = ['desktopRuntime', 'desktopProfiles', 'desktopPnpm']

/** Per-package outcome of one import run, in source manifest order. */
export interface PluginImportOutcome {
  /** Bundles installed successfully. */
  readonly imported: readonly string[]
  /** Bundles that failed to install. */
  readonly failed: readonly string[]
}

/** Build the web-to-active-profile import offer, or `undefined` when nothing can be imported. */
export function importPlanForActiveProfile(ctx: Context): PluginImportPlan | undefined {
  return pluginImportPlanForProfiles(
    ctx.desktopProfiles.list(),
    ctx.desktopProfiles.current.name,
    desktopOwnedBundles(),
  )
}

/**
 * Install every planned bundle through the authoritative DSH plugin CLI.
 * @param ctx - Host context carrying the active-profile package manager.
 * @param plan - validated import offer.
 * @returns per-package success and failure lists.
 */
export async function executePluginImport(ctx: Context, plan: PluginImportPlan): Promise<PluginImportOutcome> {
  const imported: string[] = []
  const failed: string[] = []
  for (const bundle of plan.toImport) {
    try {
      const handle = ctx.desktopPnpm.runPlugin(['add', bundle], ctx.desktopProfiles.current.dir)
      handle.stdout.resume()
      handle.stderr.resume()
      const outcome = await handle.done
      if (outcome.exitCode === 0) imported.push(bundle)
      else failed.push(bundle)
    } catch (cause) {
      ctx.logger.warn(`dsh-plugin-desktop: failed to import ${bundle}`)
      ctx.logger.warn(cause)
      failed.push(bundle)
    }
  }
  return { imported, failed }
}

/**
 * Confirm, run, and report one import, restarting when every bundle was installed.
 * @param ctx - Host context carrying the native runtime and profile services.
 * @param plan - validated import offer.
 */
export async function runPluginImportFlow(ctx: Context, plan: PluginImportPlan): Promise<void> {
  let confirmed: boolean
  try {
    confirmed = await ctx.desktopRuntime.confirm({
      title: 'Import Community Plugins',
      message: `Import ${plan.toImport.length} plugin(s) from the ${plan.source} profile into ${plan.target}?`,
      detail: plan.toImport.join('\n'),
      confirmLabel: 'Import',
      cancelLabel: 'Cancel',
    })
  } catch (cause) {
    ctx.logger.warn('dsh-plugin-desktop: failed to show plugin import confirmation')
    ctx.logger.warn(cause)
    return
  }
  if (!confirmed) return
  let outcome: PluginImportOutcome
  try {
    outcome = await executePluginImport(ctx, plan)
  } catch (cause) {
    ctx.logger.error('dsh-plugin-desktop: failed to import web profile plugins')
    ctx.logger.error(cause)
    return
  }
  if (outcome.failed.length === 0) {
    ctx.desktopRuntime.updates.notify({
      title: 'Plugins Imported',
      body: `Imported ${outcome.imported.length} plugin(s) into ${plan.target}. Restarting to apply.`,
    })
    try {
      await ctx.desktopRuntime.requestRestart()
    } catch (cause) {
      ctx.logger.warn('dsh-plugin-desktop: failed to restart after plugin import')
      ctx.logger.warn(cause)
    }
  } else {
    ctx.desktopRuntime.updates.notify({
      title: 'Plugin Import Incomplete',
      body: `Imported ${outcome.imported.length}, failed ${outcome.failed.length}: ${outcome.failed.join(', ')}. Restart DSH Desktop to apply the imported plugins.`,
    })
  }
}

/**
 * Register the native tray command for one active-profile generation.
 * @param ctx - Host context carrying the desktop runtime and profile services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const registration = ctx.desktopRuntime.registerTrayItem({
      group: 'profiles',
      order: 20,
      label: () => 'Import Web Profile Plugins…',
      enabled: () => importPlanForActiveProfile(ctx) !== undefined,
      invoke: async () => {
        try {
          const plan = importPlanForActiveProfile(ctx)
          if (plan === undefined) return
          await runPluginImportFlow(ctx, plan)
        } catch (cause) {
          ctx.logger.error('dsh-plugin-desktop: web profile plugin import tray command failed')
          ctx.logger.error(cause)
        }
      },
    })
    return () => { registration.dispose() }
  }, 'dsh-plugin-desktop: web profile plugin import tray command')
}
