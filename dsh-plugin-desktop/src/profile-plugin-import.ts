/** Cross-profile plugin import planning for launcher-owned desktop surfaces. */

import {
  DESKTOP_PACKAGE_NAME,
  DESKTOP_PROFILE_NAME,
  desktopRequiredBundleNames,
} from './profile.ts'
import type { DesktopProfileSummary } from './profile-manager.ts'

/** Official Web profile that carries the upstream default plugin set. */
export const WEB_PROFILE_NAME = 'web'

/** One ordered import offer computed from two profile manifests. */
export interface PluginImportPlan {
  /** Profile supplying the community bundles. */
  readonly source: string
  /** Profile receiving the community bundles. */
  readonly target: string
  /** Bundles to install, in source manifest order. */
  readonly toImport: readonly string[]
  /** Bundles already present in the target profile. */
  readonly alreadyPresent: readonly string[]
  /** Launcher-owned bundles skipped to preserve the desktop shell invariant. */
  readonly skippedOwned: readonly string[]
}

/**
 * Return the launcher-owned bundle set that must never be imported across profiles.
 * @returns required Web bundles plus the desktop shell package.
 */
export function desktopOwnedBundles(): readonly string[] {
  return [...desktopRequiredBundleNames(), DESKTOP_PACKAGE_NAME]
}

/**
 * Compute an import plan without modifying either profile.
 * @param source - profile whose community bundles are inspected.
 * @param target - profile receiving the community bundles.
 * @param ownedBundles - launcher-owned bundle names excluded from the offer.
 * @returns ordered plan with every source bundle classified exactly once.
 */
export function computePluginImportPlan(
  source: DesktopProfileSummary,
  target: DesktopProfileSummary,
  ownedBundles: readonly string[],
): PluginImportPlan {
  const owned = new Set(ownedBundles)
  const targetBundles = new Set(target.bundles)
  const toImport: string[] = []
  const alreadyPresent: string[] = []
  const skippedOwned: string[] = []
  for (const bundle of source.bundles) {
    if (owned.has(bundle)) skippedOwned.push(bundle)
    else if (targetBundles.has(bundle)) alreadyPresent.push(bundle)
    else toImport.push(bundle)
  }
  return { source: source.name, target: target.name, toImport, alreadyPresent, skippedOwned }
}

/**
 * Build the web-to-target import offer for one target profile, if any.
 * @param summaries - current profile discovery.
 * @param targetName - profile that would receive the bundles.
 * @param ownedBundles - launcher-owned bundle names excluded from the offer.
 * @returns a non-empty offer, or `undefined` when nothing can be imported.
 */
export function pluginImportPlanForProfiles(
  summaries: readonly DesktopProfileSummary[],
  targetName: string,
  ownedBundles: readonly string[],
): PluginImportPlan | undefined {
  const source = summaries.find(profile => profile.name === WEB_PROFILE_NAME
    && profile.exists
    && profile.problem === undefined)
  const target = summaries.find(profile => profile.name === targetName && profile.problem === undefined)
  if (source === undefined || target === undefined) return undefined
  const plan = computePluginImportPlan(source, target, ownedBundles)
  return plan.toImport.length === 0 ? undefined : plan
}

/**
 * Return whether the desktop profile is being created for the first time.
 * @param hadDesktopProfile - whether the desktop manifest existed before this launch.
 * @param activeProfileName - profile selected for this generation.
 * @returns true only when the desktop profile is fresh and active.
 */
export function desktopProfileJustCreated(hadDesktopProfile: boolean, activeProfileName: string): boolean {
  return !hadDesktopProfile && activeProfileName === DESKTOP_PROFILE_NAME
}
