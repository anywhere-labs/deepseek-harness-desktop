/** Opt-in cross-profile bundle synchronization for the desktop launcher. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import type {} from './pnpm.ts'

const BIN_NAME = 'dsh-plugin-desktop'

/** Standalone Web profile name managed by the ordinary `dsh web` command. */
export const WEB_PROFILE_NAME = 'web'
/** Launcher-owned desktop profile name. */
export const DESKTOP_PROFILE_NAME = 'desktop'
const DESKTOP_PACKAGE_NAME = 'dsh-plugin-desktop'

/**
 * Bundles that belong to the shared framework or the launcher shell. They are
 * present in every product profile by construction and must never be copied
 * across profiles: doing so would duplicate the framework or re-introduce the
 * launcher-owned shell into `dsh.profile.bundles`, which `profile-manager`
 * explicitly forbids.
 */
const PROTECTED_BUNDLES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  DESKTOP_PACKAGE_NAME,
  ...(PROFILE_TEMPLATES.web ?? []),
])

/** Return whether a bundle is a candidate for cross-profile synchronization. */
export function isSyncedBundle(name: string): boolean {
  return !PROTECTED_BUNDLES.has(name)
}

/** Read the ordered bundle list declared by one profile manifest. */
export function readProfileBundles(dir: string): string[] {
  let manifest: ProfileManifest
  try {
    manifest = readProfileManifest(BIN_NAME, dir)
  } catch {
    return []
  }
  const raw = (manifest.dsh?.profile as { bundles?: unknown } | undefined)?.bundles
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string')) {
    throw new Error(`${BIN_NAME}: dsh.profile.bundles must be an array of package names`)
  }
  return [...raw] as string[]
}

/** Return whether two ordered bundle lists are identical. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Merge one profile's existing bundles with the union of third-party bundles.
 *
 * Framework bundles keep their original order; existing third-party bundles
 * keep their order; newly shared third-party bundles are appended. The
 * protected framework set is never duplicated or relocated.
 *
 * @param existing - current bundle list of the target profile.
 * @param unionThirdParty - union of third-party bundles across all synced profiles.
 * @returns the merged bundle list for the target profile.
 */
export function mergeBundlesForProfile(
  existing: readonly string[],
  unionThirdParty: ReadonlySet<string>,
): string[] {
  const protectedExisting = existing.filter(name => PROTECTED_BUNDLES.has(name))
  const thirdPartyExisting = existing.filter(name => !PROTECTED_BUNDLES.has(name))
  const added = [...unionThirdParty].filter(name => !thirdPartyExisting.includes(name))
  return [...protectedExisting, ...thirdPartyExisting, ...added]
}

/**
 * Collect the union of third-party bundles across the given profiles.
 * @param home - Harness home containing the shared profile directory.
 * @param profiles - profile names to include in the union.
 * @returns every user bundle present in at least one existing profile.
 */
export function computeProfileBundleUnion(home: string, profiles: readonly string[]): Set<string> {
  const union = new Set<string>()
  for (const name of profiles) {
    const dir = resolveProfileDir(name, home)
    if (!existsSync(join(dir, 'package.json'))) continue
    for (const bundle of readProfileBundles(dir)) {
      if (isSyncedBundle(bundle)) union.add(bundle)
    }
  }
  return union
}

/** Result of aligning profile manifests to the shared bundle union. */
export interface ProfileManifestSyncReport {
  /** Profiles whose manifest was rewritten to include the shared bundles. */
  readonly updatedProfiles: string[]
}

/**
 * Align every existing profile manifest to the shared third-party bundle union.
 *
 * Only `package.json` is rewritten; package installation is handled separately
 * so this step never performs network I/O and cannot block startup.
 *
 * @param home - Harness home containing the shared profile directory.
 * @param profiles - profile names to synchronize.
 * @returns which profiles had their manifest updated.
 */
export function syncProfileManifests(home: string, profiles: readonly string[]): ProfileManifestSyncReport {
  const union = computeProfileBundleUnion(home, profiles)
  const updated: string[] = []
  for (const name of profiles) {
    const dir = resolveProfileDir(name, home)
    if (!existsSync(join(dir, 'package.json'))) continue
    const existing = readProfileBundles(dir)
    const merged = mergeBundlesForProfile(existing, union)
    if (!sameList(existing, merged)) {
      const manifest = readProfileManifest(BIN_NAME, dir)
      writeProfileManifest(dir, {
        ...manifest,
        dsh: {
          ...manifest.dsh,
          profile: {
            ...manifest.dsh?.profile,
            bundles: merged,
          },
        },
      })
      updated.push(name)
    }
  }
  return { updatedProfiles: updated }
}

/** Return whether a package is materialized under a profile's node_modules. */
function packageInstalled(dir: string, name: string): boolean {
  return existsSync(join(dir, 'node_modules', ...name.split('/')))
}

/** Result of installing shared bundles that were missing on disk. */
export interface ProfileInstallSyncReport {
  /** `package@profile` entries successfully installed. */
  readonly installed: string[]
  /** `package@profile` entries skipped (not available elsewhere or failed). */
  readonly skipped: string[]
}

/**
 * Install shared bundles that are missing on disk but already installed in
 * another synced profile.
 *
 * The "available elsewhere" gate keeps startup offline: a bundle is only
 * installed into a profile when it already exists under a sibling profile, so
 * `dsh plugin add` resolves from the local store instead of the network.
 *
 * @param ctx - Cordis context providing the managed package-manager service.
 * @param home - Harness home containing the shared profile directory.
 * @param profiles - profile names to synchronize.
 * @param signal - optional cancellation for every install operation.
 * @returns installed and skipped `package@profile` entries.
 */
export async function installSyncedBundles(
  ctx: Context,
  home: string,
  profiles: readonly string[],
  signal?: AbortSignal,
): Promise<ProfileInstallSyncReport> {
  const union = computeProfileBundleUnion(home, profiles)
  const installed: string[] = []
  const skipped: string[] = []
  const dirs = new Map<string, string>()
  for (const name of profiles) {
    const dir = resolveProfileDir(name, home)
    if (existsSync(join(dir, 'package.json'))) dirs.set(name, dir)
  }
  for (const name of profiles) {
    const dir = dirs.get(name)
    if (dir === undefined) continue
    for (const bundle of union) {
      if (packageInstalled(dir, bundle)) continue
      const availableElsewhere = [...dirs.entries()]
        .some(([other, otherDir]) => other !== name && packageInstalled(otherDir, bundle))
      if (!availableElsewhere) {
        skipped.push(`${bundle}@${name}`)
        continue
      }
      try {
        const handle = ctx.desktopPnpm.runPlugin(['add', bundle], dir, signal, name)
        const outcome = await handle.done
        if (outcome.exitCode === 0) installed.push(`${bundle}@${name}`)
        else skipped.push(`${bundle}@${name}`)
      } catch {
        skipped.push(`${bundle}@${name}`)
      }
    }
  }
  return { installed, skipped }
}

/**
 * Run the full opt-in synchronization: align manifests, then install bundles
 * that are missing on disk but available in a sibling profile.
 * @param ctx - Cordis context providing the managed package-manager service.
 * @param home - Harness home containing the shared profile directory.
 * @param profiles - profile names to synchronize.
 * @param signal - optional cancellation for the install phase.
 */
export async function runProfileSync(
  ctx: Context,
  home: string,
  profiles: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  syncProfileManifests(home, profiles)
  await installSyncedBundles(ctx, home, profiles, signal)
}
