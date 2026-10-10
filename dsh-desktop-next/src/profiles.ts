/** Next-owned profile state. Recovery works without importing any user plugin. */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initProfile, loadOverlayPatches, loadProfileDirectory, PROFILE_TEMPLATES, readProfilePatches, type Profile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { atomicJson, atomicText, readPrivateFile } from './private-files.ts'
import { NextRecovery } from './recovery.ts'
import { DEFAULT_PROFILE } from './desktop-contract.ts'
import { computerUsePatch } from './profile-computer-use.ts'
import { RETIRED_SCHEDULE_BUNDLE, retiredSchedulePatch } from './profile-schedule.ts'
import { removeLinkProjectionsSafely } from '../../dsh-plugin-desktop-beta/src/link-projections.ts'

export const NEXT_PACKAGE = fileURLToPath(new URL('../package.json', import.meta.url))
export const WEB_BUNDLES = [...PROFILE_TEMPLATES.web!.bundles]
const NEXT_BUNDLE_PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
export const AA_PACKAGE = '@agents-anywhere/dsh-bridge-next'
export const COMMUNITY_MARKET_PACKAGE = 'dsh-community-market'
export const DSH_MARKET_PACKAGE = 'dshmarket'
/** Legacy shell shape, now projected from the standard Profile bundle selection. */
export interface Features { remoteControl: boolean; market: boolean; dshMarket?: boolean }
export interface OnboardingChoices { features: Features; computerUse: boolean }
export const DEFAULT_FEATURES: Readonly<Features> = { remoteControl: false, market: false }

interface ProfileManifest {
  dsh: {
    desktopNextPlugins?: number
    /**
     * Scheduled Tasks migration step: 1 carried 0.1.7 Web-row choices onto the
     * rc.2 optional bundle, 2 retired that bundle once upstream removed it.
     */
    desktopNextScheduleBundle?: number
    desktopNextOnboarding?: { version: number; outcome: 'completed' | 'skipped'; accountPending?: boolean }
    /** Names recovery removed from `profile.bundles`; a UI ledger, never a policy. */
    desktopNextDeselectedBundles?: string[]
    profile: { bundles: string[] }
  }
  [key: string]: unknown
}

function applyFeatures(manifest: ProfileManifest, features: Features): void {
  const optional = [AA_PACKAGE, COMMUNITY_MARKET_PACKAGE, DSH_MARKET_PACKAGE]
  manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles.filter(name => !optional.includes(name)),
    ...(features.market ? [COMMUNITY_MARKET_PACKAGE] : []), ...(features.dshMarket ? [DSH_MARKET_PACKAGE] : []),
    ...(features.remoteControl ? [AA_PACKAGE] : [])]
  manifest.dsh.desktopNextPlugins = 1
}

export function profileName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(value)
    || /^(?:node_modules|con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(value)) {
    throw new Error('Profile 名称需为 1–64 个英文字母、数字、下划线或连字符，且不能是系统保留名称。')
  }
  return value
}

export function parseFeatures(value: unknown): Features {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Next features')
  const features = value as Record<string, unknown>
  if (typeof features.remoteControl !== 'boolean' || typeof features.market !== 'boolean'
    || (features.dshMarket !== undefined && typeof features.dshMarket !== 'boolean')
    || Object.keys(features).some(key => !['remoteControl', 'market', 'dshMarket'].includes(key))) throw new Error('Invalid Next features')
  return { remoteControl: features.remoteControl, market: features.market, ...(features.dshMarket ? { dshMarket: true } : {}) }
}

export class NextProfiles {
  constructor(readonly home: string) {
    if (!isAbsolute(home)) throw new Error('Next home must be absolute')
  }
  directory(name: string): string {
    const root = join(this.home, 'profiles')
    const dir = join(root, profileName(name))
    for (const path of [this.home, root, dir]) {
      if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) {
        throw new Error(`Next profile path must be a real directory: ${path}`)
      }
    }
    return dir
  }
  get active(): string {
    const file = join(this.home, 'desktop-next.json')
    const text = readPrivateFile(file)
    if (text === undefined) return DEFAULT_PROFILE
    return profileName((JSON.parse(text) as { active?: unknown }).active)
  }
  select(name: string): void {
    if (!this.selectable(name)) throw new Error('Profile is unavailable for Desktop Next')
    atomicJson(join(this.home, 'desktop-next.json'), { version: 1, active: name })
  }
  /** Read configuration only; never load plugins just to render the native selector. */
  selectable(name: string): boolean {
    try {
      const value = JSON.parse(readPrivateFile(join(this.directory(name), 'package.json')) ?? 'null') as { dsh?: { profile?: { bundles?: unknown } } } | null
      const bundles = value?.dsh?.profile?.bundles
      this.features(name)
      return Array.isArray(bundles) && bundles.every(item => typeof item === 'string')
        && PROFILE_TEMPLATES.web!.bundles.every(bundle => bundles.includes(bundle))
    } catch { return false }
  }
  list(): string[] {
    const root = join(this.home, 'profiles')
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true }).filter(entry => {
      if (!entry.isDirectory()) return false
      try { return existsSync(join(this.directory(entry.name), 'package.json')) } catch { return false }
    }).map(entry => entry.name).sort()
  }
  ensure(name: string): string {
    const dir = this.directory(name)
    const existing = existsSync(join(dir, 'package.json'))
    if (!existing) initProfile(dir, WEB_BUNDLES)
    if (existing) {
      const manifest = this.manifest(name)
      if (manifest.dsh.profile.bundles.includes('dsh-desktop-next')) {
        // Retire the former Next-specific selection from the shared manifest.
        // Other launchers must not inherit this application's capability.
        new NextRecovery(this).backup(name, 'before-next-bundle-removal')
        this.migrateFeatures(name)
        const migrated = this.manifest(name)
        migrated.dsh.profile.bundles = migrated.dsh.profile.bundles.filter(bundle => bundle !== 'dsh-desktop-next')
        atomicJson(join(dir, 'package.json'), migrated)
      }
    } else this.setFeatures(name, DEFAULT_FEATURES)
    this.migrateSchedule(name)
    return dir
  }
  create(name: string): string {
    const dir = this.directory(name)
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 })
    mkdirSync(dir, { mode: 0o700 })
    initProfile(dir, WEB_BUNDLES)
    this.setFeatures(name, DEFAULT_FEATURES)
    this.migrateSchedule(name)
    return dir
  }
  features(name: string): Features {
    const manifest = this.manifest(name)
    if (manifest.dsh.desktopNextPlugins === 1 || !manifest.dsh.profile.bundles.includes('dsh-desktop-next')) {
      const bundles = manifest.dsh.profile.bundles
      return { remoteControl: bundles.includes(AA_PACKAGE), market: bundles.includes(COMMUNITY_MARKET_PACKAGE),
        ...(bundles.includes(DSH_MARKET_PACKAGE) ? { dshMarket: true } : {}) }
    }
    const file = join(this.directory(name), 'desktop-next.features.json')
    const text = readPrivateFile(file)
    return text === undefined ? { ...DEFAULT_FEATURES } : parseFeatures(JSON.parse(text))
  }
  setFeatures(name: string, value: unknown): void {
    const features = parseFeatures(value)
    const manifest = this.manifest(name)
    applyFeatures(manifest, features)
    atomicJson(join(this.directory(name), 'package.json'), manifest)
  }
  onboardingRequired(name: string): boolean {
    const saved = this.manifest(name).dsh.desktopNextOnboarding
    return saved?.version !== 1 || !['completed', 'skipped'].includes(saved.outcome)
  }
  accountSetupPending(name: string): boolean {
    return !this.onboardingRequired(name) && this.manifest(name).dsh.desktopNextOnboarding?.accountPending === true
  }
  dismissAccountSetup(name: string): void {
    const manifest = this.manifest(name)
    if (manifest.dsh.desktopNextOnboarding?.accountPending !== true) return
    delete manifest.dsh.desktopNextOnboarding.accountPending
    atomicJson(join(this.directory(name), 'package.json'), manifest)
  }
  /** Read the saved native-provider choice without importing any user plugin. */
  computerUseEnabled(name: string): boolean {
    return computerUsePatch(readPrivateFile(join(this.directory(name), 'cordis.patch.yml')) ?? '[]\n').enabled
  }
  /** Save choices before completion. Skip preserves both bundles and the user's patch verbatim. */
  finishOnboarding(name: string, value?: unknown): void {
    const manifest = this.manifest(name)
    const patchPath = join(this.directory(name), 'cordis.patch.yml')
    let originalPatch: string | undefined
    let nextPatch: string | undefined
    if (value !== undefined) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['features', 'computerUse'].includes(key))) throw new Error('Invalid onboarding choices')
      const choices = value as Record<string, unknown>
      const features = parseFeatures(choices.features)
      if (features.market && features.dshMarket) throw new Error('Select only one plugin market')
      if (typeof choices.computerUse !== 'boolean') throw new Error('Invalid Computer Use choice')
      originalPatch = readPrivateFile(patchPath)
      nextPatch = computerUsePatch(originalPatch ?? '[]\n', choices.computerUse).text
      applyFeatures(manifest, features)
    }
    manifest.dsh.desktopNextOnboarding = { version: 1, outcome: value === undefined ? 'skipped' : 'completed',
      ...(value === undefined ? {} : { accountPending: true }) }
    const patchChanged = nextPatch !== undefined && nextPatch !== originalPatch
    if (patchChanged && nextPatch !== undefined) atomicText(patchPath, nextPatch)
    try {
      // Completion is the final write: a failed/interrupted save must never start the Host.
      atomicJson(join(this.directory(name), 'package.json'), manifest)
    } catch (error) {
      if (patchChanged) {
        if (originalPatch === undefined) unlinkSync(patchPath)
        else atomicText(patchPath, originalPatch)
      }
      throw error
    }
  }
  /** Once per Profile, preserve the old choices without overriding future plugin-manager edits. */
  migrateFeatures(name: string): void {
    const manifest = this.manifest(name)
    if (manifest.dsh.desktopNextPlugins === 1) return
    this.setFeatures(name, { ...this.features(name), dshMarket: manifest.dsh.profile.bundles.includes(DSH_MARKET_PACKAGE) })
  }
  /**
   * Once per Profile: upstream retired the Scheduled Tasks bundle and the Web
   * composition now mounts Schedule. Drop the bundle (app-boot would on load,
   * but Next reads the list first) and the `time-context` overrides that no
   * longer match a row; overrides on `schedule` and `ui-schedule` keep applying.
   */
  private migrateSchedule(name: string): void {
    const manifest = this.manifest(name)
    if (manifest.dsh.desktopNextScheduleBundle === 2) return
    const patchPath = join(this.directory(name), 'cordis.patch.yml')
    let patch: string | undefined
    // A malformed patch is left for recovery to handle; retry on the next start.
    try { patch = retiredSchedulePatch(readPrivateFile(patchPath) ?? '[]\n') } catch { return }
    const bundles = manifest.dsh.profile.bundles.filter(bundle => bundle !== RETIRED_SCHEDULE_BUNDLE)
    if (patch !== undefined || bundles.length !== manifest.dsh.profile.bundles.length) {
      new NextRecovery(this).backup(name, 'before-schedule-bundle-retirement')
    }
    // Patch first: both steps are idempotent, so an interrupted run simply repeats.
    if (patch !== undefined) atomicText(patchPath, patch)
    manifest.dsh.profile.bundles = bundles
    manifest.dsh.desktopNextScheduleBundle = 2
    atomicJson(join(this.directory(name), 'package.json'), manifest)
  }
  private manifest(name: string): ProfileManifest {
    const value = JSON.parse(readPrivateFile(join(this.directory(name), 'package.json')) ?? 'null')
    if (!value || !Array.isArray(value.dsh?.profile?.bundles) || value.dsh.profile.bundles.some((item: unknown) => typeof item !== 'string')) throw new Error('Invalid Next Profile manifest')
    return value
  }
  /** The shell must stop this profile's Host before calling recovery. */
  async recover(name: string): Promise<string | undefined> {
    const dir = this.directory(name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return withFileLock(join(dir, 'lock'), async () => {
      const backup = new NextRecovery(this).backup(name, 'before-profile-repair')
      let manifest: Record<string, unknown> = { name, private: true }
      try {
        const value: unknown = JSON.parse(readPrivateFile(join(dir, 'package.json')) ?? '{}')
        if (value && typeof value === 'object' && !Array.isArray(value)) manifest = value as Record<string, unknown>
      } catch { /* The original bytes have already been backed up. */ }
      // Keep installed dependencies, but remove malformed activation metadata.
      const onboarding = (manifest.dsh as Partial<ProfileManifest['dsh']> | undefined)?.desktopNextOnboarding
      manifest.dsh = { profile: { bundles: WEB_BUNDLES },
        ...(onboarding?.version === 1 && ['completed', 'skipped'].includes(onboarding.outcome) ? { desktopNextOnboarding: onboarding } : {}) }
      atomicJson(join(dir, 'package.json'), manifest)
      atomicText(join(dir, 'cordis.patch.yml'), '[]\n')
      this.setFeatures(name, { remoteControl: false, market: false })
      return readPrivateFile(join(backup, 'cordis.patch.yml')) === undefined ? undefined : join(backup, 'cordis.patch.yml')
    })
  }
}

/**
 * Remove the package links a dsh 0.1.5 launcher (Stable before 2.0.14, the 0.1.5 CLI)
 * projected into this shared Profile. They point at that launcher's installation, so the
 * Host would load a second copy of every Harness package through them: a second
 * `dsh-scope` loses preset scope tags and new sessions fail with `agent-preset/invalid`.
 * Upstream sweeps them in `loadProfile`, which Next bypasses. A locked link must not keep
 * the Host from starting; the next launch retries.
 */
function retireLinkProjections(projectDir: string): void {
  try {
    removeLinkProjectionsSafely(projectDir)
  } catch (cause) {
    process.stderr.write(`dsh-desktop-next: could not remove dsh 0.1.5 link projections from ${projectDir}: ${String(cause)}\n`)
  }
}

/** Add product capabilities without replacing the upstream Web presentation. */
export function loadNextProfile(projectDir: string, home: string, installAnchor = NEXT_PACKAGE): Profile {
  const manager = new NextProfiles(home)
  if (manager.directory(basename(projectDir)) !== resolve(projectDir)) throw new Error('Profile must belong to Next home')
  manager.ensure(basename(projectDir))
  retireLinkProjections(projectDir)
  // Upstream bundle discovery walks physical node_modules before installing its
  // runtime resolver. Project only this application's bundle, not its dependency
  // tree; the alpha.2 runtime resolver owns all other package fallbacks.
  const modules = join(home, 'profiles', 'node_modules')
  const existingModules = lstatSync(modules, { throwIfNoEntry: false })
  if (existingModules && !existingModules.isDirectory()) throw new Error('Next bundle fallback must be a real directory')
  mkdirSync(modules, { recursive: true, mode: 0o700 })
  const link = join(modules, 'dsh-desktop-next')
  const target = realpathSync(dirname(installAnchor))
  const existingLink = lstatSync(link, { throwIfNoEntry: false })
  if (existingLink && !existingLink.isSymbolicLink()) throw new Error('Next bundle fallback is occupied by an unmanaged package')
  if (existingLink && resolve(modules, readlinkSync(link)) !== target) unlinkSync(link)
  if (!lstatSync(link, { throwIfNoEntry: false })) symlinkSync(target, link, 'junction')
  const profile = loadProfileDirectory('dsh-desktop-next', projectDir, installAnchor)
  profile.layers.push({ packageName: 'dsh-desktop-next', packageDir: target,
    patchPaths: [NEXT_BUNDLE_PATCH], patches: loadOverlayPatches('dsh-desktop-next', NEXT_BUNDLE_PATCH) })
  const overlay = [
    { id: 'agents-anywhere-bridge-next', config: {
      dshHome: home,
    } },
  ]
  // Leave AA stateRoot unset to share its default credentials and device binding with Stable/Beta.
  // Rewriting the generated overlay also removes the former per-Profile stateRoot on upgrade.
  // The official manager still owns per-Profile bundle/row enablement.
  atomicJson(join(projectDir, 'desktop-next.cordis.patch.json'), overlay)
  return profile
}

/** Recompose Next's own layer before user/global patches on every manager or HMR read. */
export function readNextProfilePatches(projectDir: string, home: string, overlays: readonly string[], profilePatches?: readonly Profile['patches'][number][]) {
  const profile = loadProfileDirectory('dsh-desktop-next', projectDir, NEXT_PACKAGE, { userLayer: false })
  profile.layers.push({ packageName: 'dsh-desktop-next', packageDir: dirname(NEXT_PACKAGE),
    patchPaths: [NEXT_BUNDLE_PATCH], patches: loadOverlayPatches('dsh-desktop-next', NEXT_BUNDLE_PATCH) })
  profile.patches = profilePatches === undefined
    ? existsSync(profile.patchPath) ? loadOverlayPatches('dsh-desktop-next', profile.patchPath) : []
    : [...profilePatches]
  const context: ProfileContext = { name: basename(projectDir), dir: projectDir, patchPath: profile.patchPath,
    installAnchor: NEXT_PACKAGE, cwd: process.cwd(), home, startedBundles: profile.layers.map(layer => layer.packageName),
    overlays: overlays.flatMap(path => loadOverlayPatches('dsh-desktop-next', path)),
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED }
  return readProfilePatches('dsh-desktop-next', context, profile)
}
