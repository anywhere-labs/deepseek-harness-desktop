/** Launcher facts shared by embedded and isolated Desktop Hosts. */
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { AppReady } from '@deepseek-ai/dsh-cmdline'
import type { DesktopPnpmBootstrap } from './pnpm.ts'
import { findOverlayPackage } from './package-overlay.ts'
import { withDesktopPnpmPolicy } from './pnpm-policy.ts'
import { desktopInstallAnchor, prepareDesktopProfile, type PreparedDesktopProfile } from './profile.ts'

/** Keep package operations and subsequent HMR on the launcher's actual Profile. */
export function createDesktopProfileBoot(prepared: PreparedDesktopProfile, pnpm: DesktopPnpmBootstrap) {
  const options = prepared.reloadOptions
  if (pnpm.activeProfileName !== options.profileName || pnpm.activeProfileDir !== prepared.profile.dir
    || pnpm.homeDir !== prepared.homeDir) {
    throw new Error('Desktop Profile context and package-manager identity disagree')
  }
  const inheritedPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
  const context: ProfileContext = {
    name: options.profileName,
    dir: prepared.profile.dir,
    patchPath: prepared.profile.patchPath,
    installAnchor: desktopInstallAnchor(),
    // Compatibility checks must inspect the same artifact as the module loader,
    // even before pluginPackages exists. Never inspect stale ancestor copies.
    resolvePackageManifest: packageName => findOverlayPackage(packageName, {
      installPackageUrl: pathToFileURL(desktopInstallAnchor()).href,
      profilePackageUrl: pathToFileURL(join(prepared.profile.dir, 'package.json')).href,
    })?.selected.manifestPath,
    cwd: process.cwd(),
    home: prepared.homeDir,
    startedBundles: prepared.profile.layers.map(layer => layer.packageName),
    overlays: structuredClone(prepared.overlays ?? []),
    telemetryDisabledEnv: options.telemetryDisabled,
    packageManager: {
      command: pnpm.appExecutable,
      args: ['--import', pathToFileURL(pnpm.clearEnvironmentPath).href, pnpm.pnpmBinPath,
        ...withDesktopPnpmPolicy([])],
      env: {
        PATH: [pnpm.nodeBinDir, inheritedPath].filter(Boolean).join(delimiter),
        NODE: pnpm.nodeShimPath,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: prepared.homeDir,
        CI: 'true',
        npm_config_runtime: 'electron',
        npm_config_target: pnpm.electronVersion,
        npm_config_disturl: 'https://electronjs.org/headers',
      },
    },
    // The pinned app-boot patch delegates both manager operations and HMR here.
    // CLI reconstruction would drop Desktop shell/platform overrides and bypass
    // the disabled-bundle, Market-provider and AA admission rules.
    //
    // `profilePatches` is the caller's pending profile patch document, supplied
    // by the config editor while a settings write is still being validated. It
    // replaces only the profile layer; everything else above stays ours. When
    // absent (HMR, package operations) preparation reads the document from disk
    // as before.
    readPatches: profilePatches => [...prepareDesktopProfile(
      options.telemetryDisabled ?? '', prepared.homeDir, options.platform, options.profileName,
      options.pluginStatePath, options.marketSelection,
      {
        aaEnabled: options.aaEnabled,
        lanAddresses: prepared.lanAddresses,
        generationMode: prepared.mode,
        ...(profilePatches === undefined ? {} : { profilePatches }),
      },
    ).patches, ...context.overlays],
  }
  let ready = false
  let disposed = false
  const listeners = new Set<() => void>()
  const readiness: AppReady = {
    onReady(listener) {
      if (disposed) return () => {}
      if (ready) listener()
      else listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    prepare(ctx: Context): void {
      ctx.provide('profileContext', context)
      ctx.provide('appReady', readiness)
      ctx.effect(() => () => { disposed = true; listeners.clear() }, 'Desktop Profile readiness')
    },
    /** Signal only after boot has settled successfully, never on a failed tree. */
    markReady(): void {
      if (disposed || ready) return
      ready = true
      const pending = [...listeners]
      listeners.clear()
      for (const listener of pending) listener()
    },
  }
}
