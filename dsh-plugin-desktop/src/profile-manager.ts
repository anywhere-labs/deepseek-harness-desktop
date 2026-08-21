/** Desktop-owned profile discovery and restart-safe selection state. */

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  PROFILE_TEMPLATES,
  initProfile,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
} from '@deepseek-ai/dsh-app-boot'

const BIN_NAME = 'dsh-plugin-desktop'
const DEFAULT_PROFILE_NAME = 'desktop'
const WEB_PROFILE_NAME = 'web'
const BASE_BUNDLE_NAME = '@deepseek-ai/dsh-base'
const WEB_BUNDLE_NAME = '@deepseek-ai/dsh-web-app'
const DESKTOP_BUNDLE_NAME = 'dsh-plugin-desktop'
const PROFILE_MANIFEST_FILENAME = 'package.json'
const STATE_VERSION = 1
const MAX_STATE_BYTES = 4 * 1024
const STATE_DIRECTORY_MODE = 0o700
const STATE_FILE_MODE = 0o600
const MAX_PROFILE_NAME_BYTES = 255

/** One discovered or lazily available DSH profile. */
export interface DesktopProfileSummary {
  /** Profile name passed to `dsh --profile`. */
  readonly name: string
  /** Absolute profile directory under the active Harness home. */
  readonly dir: string
  /** Whether the profile manifest already exists on disk. */
  readonly exists: boolean
  /** Ordered bundle list declared by the profile or its shipped template. */
  readonly bundles: readonly string[]
  /** Whether the desktop launcher can layer its shell over this profile. */
  readonly webCapable: boolean
  /** Manifest diagnostic that prevents selection. */
  readonly problem?: string
}

/** Minimal recovery reader used while deleting a profile. */
export interface DesktopProfileInstallRecoveryReader {
  read(): Promise<{ readonly profileName: string } | undefined>
}

/** Inputs for the narrow, restart-safe profile deletion boundary. */
export interface DesktopProfileDeletionOptions {
  readonly home: string
  readonly selectionStatePath: string
  readonly currentProfileName: string
  readonly installRecovery?: DesktopProfileInstallRecoveryReader
  readonly clearDisabledState?: () => void | Promise<void>
  readonly clearCheckpoint?: () => void | Promise<void>
}

/** Private desktop selection state persisted outside `$DSH_HOME/profiles`. */
export interface DesktopProfileStateV1 {
  /** Stored format discriminator. */
  readonly version: 1
  /** Profile selected for the current or next confirmed generation. */
  readonly active: string
  /** Profile requested for the next application restart. */
  readonly pending?: string
  /** Most recent profile whose native shell mounted successfully. */
  readonly lastKnownGood: string
}

/** Startup decision derived from selection state and current profile discovery. */
export interface DesktopProfileStartup {
  /** Profile that this process must prepare and boot. */
  readonly profileName: string
  /** State persisted before profile preparation begins. */
  readonly state: DesktopProfileStateV1
  /** Whether malformed or unavailable state was replaced with a safe choice. */
  readonly recoveredState: boolean
  /** Unconfirmed or unavailable profile replaced by the last known good choice. */
  readonly rolledBackFrom?: string
}

interface LoadedDesktopProfileState {
  state: DesktopProfileStateV1
  recovered: boolean
}

/** Internal marker separating invalid contents from filesystem access failures. */
class InvalidDesktopProfileStateError extends Error {}

/** Return a fresh default so callers cannot mutate shared state. */
function defaultState(): DesktopProfileStateV1 {
  return {
    version: STATE_VERSION,
    active: DEFAULT_PROFILE_NAME,
    lastKnownGood: DEFAULT_PROFILE_NAME,
  }
}

/** Reject profile names that cannot safely cross the persisted state boundary. */
export function assertDesktopProfileName(name: string): void {
  if (typeof name !== 'string' || name.length === 0
    || name.includes('/') || name.includes('\\') || name === '.' || name === '..'
    || name === 'node_modules' || Buffer.byteLength(name, 'utf8') > MAX_PROFILE_NAME_BYTES
    || /[\0-\x1f\x7f-\x9f]/.test(name)
    || /[<>:"|?*]/.test(name) || /[. ]$/.test(name)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)) {
    throw new Error(`${BIN_NAME}: invalid desktop profile name ${JSON.stringify(name)}`)
  }
  resolveProfileDir(name, '/')
}

/** Validate a manifest bundle list without trusting arbitrary JSON values. */
function manifestBundles(manifest: ReturnType<typeof readProfileManifest>): string[] {
  const value = (manifest.dsh?.profile as { bundles?: unknown } | undefined)?.bundles
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(bundle => typeof bundle !== 'string')) {
    throw new Error('dsh.profile.bundles must be an array of package names')
  }
  return [...value] as string[]
}

/** Describe an existing manifest while retaining its failure as list metadata. */
function existingProfile(name: string, home: string): DesktopProfileSummary {
  const dir = resolveProfileDir(name, home)
  try {
    const bundles = manifestBundles(readProfileManifest(BIN_NAME, dir))
    const desktopBundleIndex = bundles.indexOf(DESKTOP_BUNDLE_NAME)
    const problem = name !== DEFAULT_PROFILE_NAME && desktopBundleIndex !== -1
      ? `${DESKTOP_BUNDLE_NAME} is launcher-owned and must not appear in dsh.profile.bundles`
      : undefined
    const baseBundleIndex = bundles.indexOf(BASE_BUNDLE_NAME)
    const webBundleIndex = bundles.indexOf(WEB_BUNDLE_NAME)
    return {
      name,
      dir,
      exists: true,
      bundles,
      webCapable: problem === undefined && (name === DEFAULT_PROFILE_NAME
        || baseBundleIndex !== -1 && webBundleIndex > baseBundleIndex),
      ...(problem === undefined ? {} : { problem }),
    }
  } catch (cause) {
    return {
      name,
      dir,
      exists: true,
      bundles: [],
      webCapable: false,
      problem: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/** Describe one profile that upstream app-boot will lazily initialize. */
function virtualProfile(name: typeof DEFAULT_PROFILE_NAME | typeof WEB_PROFILE_NAME, home: string): DesktopProfileSummary {
  const bundles = PROFILE_TEMPLATES.web
  if (bundles === undefined) {
    throw new Error(`${BIN_NAME}: installed dsh-app-boot has no web profile template`)
  }
  return {
    name,
    dir: resolveProfileDir(name, home),
    exists: false,
    bundles: [...bundles],
    webCapable: true,
  }
}

/**
 * Create a safe Web profile using only the shipped template.
 *
 * The profile is initialized in a sibling staging directory and published with
 * one rename, so a failed initialization never leaves a partially initialized
 * target visible to discovery.
 */
export function createDesktopWebProfile(home: string, name: string): DesktopProfileSummary {
  assertDesktopProfileName(name)
  const template = PROFILE_TEMPLATES.web
  if (template === undefined) {
    throw new Error(`${BIN_NAME}: installed dsh-app-boot has no web profile template`)
  }
  const target = resolveProfileDir(name, home)
  const profilesDir = dirname(target)
  mkdirSync(profilesDir, { recursive: true })
  try {
    lstatSync(target)
    throw new Error(`${BIN_NAME}: profile ${JSON.stringify(name)} already exists`)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }

  const staging = join(profilesDir, `.${basename(target)}.creating-${process.pid}-${randomUUID()}`)
  try {
    initProfile(staging, [...template])
    const manifest = readProfileManifest(BIN_NAME, staging)
    writeProfileManifest(staging, { ...manifest, name: `dsh-profile-${name}` })
    // The target is checked again immediately before publication. `renameSync`
    // is atomic on the same filesystem; an existing target is never replaced.
    try {
      lstatSync(target)
      throw new Error(`${BIN_NAME}: profile ${JSON.stringify(name)} already exists`)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    renameSync(staging, target)
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true })
    throw cause
  }
  return existingProfile(name, home)
}

/** Deterministic profile order with the product defaults first. */
function compareProfiles(left: DesktopProfileSummary, right: DesktopProfileSummary): number {
  const priority = (name: string): number => name === DEFAULT_PROFILE_NAME ? 0 : name === WEB_PROFILE_NAME ? 1 : 2
  const difference = priority(left.name) - priority(right.name)
  if (difference !== 0) return difference
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/**
 * List profile manifests without initializing or modifying any profile.
 * @param home - Harness home containing the shared profile directory.
 * @returns existing profiles plus lazy desktop and Web defaults.
 */
export function listDesktopProfiles(home: string): DesktopProfileSummary[] {
  const profilesDir = join(home, 'profiles')
  const summaries = new Map<string, DesktopProfileSummary>()
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || (!entry.isDirectory() && !entry.isSymbolicLink())) continue
      try {
        assertDesktopProfileName(entry.name)
      } catch {
        continue
      }
      const dir = resolveProfileDir(entry.name, home)
      if (!existsSync(join(dir, PROFILE_MANIFEST_FILENAME))) continue
      summaries.set(entry.name, existingProfile(entry.name, home))
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  for (const name of [DEFAULT_PROFILE_NAME, WEB_PROFILE_NAME] as const) {
    if (!summaries.has(name)) summaries.set(name, virtualProfile(name, home))
  }
  return [...summaries.values()].sort(compareProfiles)
}

/** Validate one selected profile against the exact discovery result. */
function selectableProfile(home: string, name: string): DesktopProfileSummary {
  assertDesktopProfileName(name)
  const summary = listDesktopProfiles(home).find(profile => profile.name === name)
  if (summary === undefined) {
    throw new Error(`${BIN_NAME}: profile ${JSON.stringify(name)} does not exist`)
  }
  if (summary.problem !== undefined) {
    throw new Error(`${BIN_NAME}: profile ${JSON.stringify(name)} cannot be selected: ${summary.problem}`)
  }
  if (!summary.webCapable) {
    throw new Error(
      `${BIN_NAME}: profile ${JSON.stringify(name)} must directly include ${BASE_BUNDLE_NAME} before ${WEB_BUNDLE_NAME}`,
    )
  }
  return summary
}

function deletionTarget(options: DesktopProfileDeletionOptions, name: string): string {
  assertDesktopProfileName(name)
  if (name === options.currentProfileName) {
    throw new Error(`${BIN_NAME}: current profile ${JSON.stringify(name)} cannot be deleted`)
  }
  const target = resolveProfileDir(name, options.home)
  let item
  try {
    item = lstatSync(target)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${BIN_NAME}: profile ${JSON.stringify(name)} does not exist`)
    }
    throw cause
  }
  if (!item.isDirectory() || item.isSymbolicLink()) {
    throw new Error(`${BIN_NAME}: profile ${JSON.stringify(name)} is not a real directory`)
  }
  let manifest
  try {
    manifest = lstatSync(join(target, PROFILE_MANIFEST_FILENAME))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${BIN_NAME}: profile ${JSON.stringify(name)} does not exist`)
    }
    throw cause
  }
  if (!manifest.isFile() || manifest.isSymbolicLink()) {
    throw new Error(`${BIN_NAME}: profile ${JSON.stringify(name)} has an unsafe manifest`)
  }
  return target
}

/** Return whether a profile is eligible for deletion using current selection state. */
export function canDeleteDesktopProfile(options: DesktopProfileDeletionOptions, name: string): boolean {
  try {
    deletionTarget(options, name)
    return true
  } catch {
    return false
  }
}

/**
 * Remove one inactive user profile through a same-filesystem staging rename.
 * Selection and filesystem checks are repeated immediately before the rename;
 * an install recovery transaction for the target profile always wins over a
 * deletion request.
 */
export async function deleteDesktopProfile(
  options: DesktopProfileDeletionOptions,
  name: string,
): Promise<void> {
  const target = deletionTarget(options, name)
  const transaction = await options.installRecovery?.read()
  if (transaction?.profileName === name) {
    throw new Error(`${BIN_NAME}: profile ${JSON.stringify(name)} has a pending install recovery transaction`)
  }
  // Re-read selection state after the asynchronous recovery check to close the
  // most important stale-selection window before the atomic rename.
  const confirmedTarget = deletionTarget(options, name)
  if (confirmedTarget !== target) {
    throw new Error(`${BIN_NAME}: profile deletion target changed during validation`)
  }
  const parent = dirname(target)
  const parentInfo = lstatSync(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error(`${BIN_NAME}: profile directory parent is not a real directory`)
  }
  const staging = join(parent, `.${basename(target)}.deleting-${process.pid}-${randomUUID()}`)
  renameSync(target, staging)
  try {
    await options.clearDisabledState?.()
    await options.clearCheckpoint?.()
    const stagedInfo = lstatSync(staging)
    if (!stagedInfo.isDirectory() || stagedInfo.isSymbolicLink()) {
      throw new Error(`${BIN_NAME}: profile deletion staging entry is unsafe`)
    }
    rmSync(staging, { recursive: true, force: false })
  } catch (cause) {
    // A failed cleanup or final removal leaves the user's profile recoverable.
    try { renameSync(staging, target) } catch { /* preserve the original failure */ }
    throw cause
  }
}

/** Parse the complete state document and reject unknown format versions. */
function parseState(text: string): DesktopProfileStateV1 {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('selection state must be a JSON object')
  }
  const state = value as Record<string, unknown>
  if (state.version !== STATE_VERSION) throw new Error(`selection state version must be ${STATE_VERSION}`)
  if (typeof state.active !== 'string') throw new Error('selection state active profile must be a string')
  if (typeof state.lastKnownGood !== 'string') {
    throw new Error('selection state last-known-good profile must be a string')
  }
  if (state.pending !== undefined && typeof state.pending !== 'string') {
    throw new Error('selection state pending profile must be a string')
  }
  assertDesktopProfileName(state.active)
  assertDesktopProfileName(state.lastKnownGood)
  if (state.pending !== undefined) assertDesktopProfileName(state.pending)
  return {
    version: STATE_VERSION,
    active: state.active,
    ...(state.pending === undefined ? {} : { pending: state.pending }),
    lastKnownGood: state.lastKnownGood,
  }
}

/** Read at most the private state format's maximum encoded size. */
function readStateText(statePath: string): string {
  const descriptor = openSync(statePath, 'r')
  try {
    const size = fstatSync(descriptor).size
    if (size > MAX_STATE_BYTES) {
      throw new InvalidDesktopProfileStateError(`selection state exceeds ${MAX_STATE_BYTES} bytes`)
    }
    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

/** Read state with enough metadata for startup recovery. */
function loadState(statePath: string): LoadedDesktopProfileState {
  let text: string
  try {
    if (lstatSync(statePath).isSymbolicLink()) {
      return { state: defaultState(), recovered: true }
    }
    text = readStateText(statePath)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: defaultState(), recovered: false }
    }
    if (cause instanceof InvalidDesktopProfileStateError) {
      return { state: defaultState(), recovered: true }
    }
    throw cause
  }
  try {
    return { state: parseState(text), recovered: false }
  } catch {
    return { state: defaultState(), recovered: true }
  }
}

/** Remove an uncommitted sibling without hiding unexpected filesystem failures. */
function unlinkTemporary(filename: string): void {
  try {
    unlinkSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}

/** Atomically persist desktop-private state without following a target symlink. */
function writeState(statePath: string, state: DesktopProfileStateV1): void {
  const stateDir = dirname(statePath)
  mkdirSync(stateDir, { recursive: true, mode: STATE_DIRECTORY_MODE })
  const directoryStat = lstatSync(stateDir)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`${BIN_NAME}: profile selection state directory is not private: ${stateDir}`)
  }
  chmodSync(stateDir, STATE_DIRECTORY_MODE)
  const temporary = join(stateDir, `.${basename(statePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(state, undefined, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: STATE_FILE_MODE,
    })
    chmodSync(temporary, STATE_FILE_MODE)
    renameSync(temporary, statePath)
  } finally {
    unlinkTemporary(temporary)
  }
}

/**
 * Read the selected profile, recovering malformed desktop-private state to desktop.
 * @param statePath - desktop-owned state file outside the Harness profile tree.
 * @returns validated selection state.
 */
export function readDesktopProfileState(statePath: string): DesktopProfileStateV1 {
  return loadState(statePath).state
}

/**
 * Request a compatible profile for the next application restart.
 * @param statePath - desktop-owned state file outside the Harness profile tree.
 * @param home - Harness home used only for read-only profile discovery.
 * @param name - profile selected by the user.
 * @returns persisted state containing the pending selection.
 */
export function selectDesktopProfile(statePath: string, home: string, name: string): DesktopProfileStateV1 {
  selectableProfile(home, name)
  const current = loadState(statePath).state
  const next: DesktopProfileStateV1 = current.active === name && current.lastKnownGood === name
    ? { version: STATE_VERSION, active: name, lastKnownGood: name }
    : {
        version: STATE_VERSION,
        active: current.active,
        pending: name,
        lastKnownGood: current.lastKnownGood,
      }
  writeState(statePath, next)
  return next
}

/** Return whether one saved name still identifies a selectable profile. */
function isSelectable(home: string, name: string): boolean {
  try {
    selectableProfile(home, name)
    return true
  } catch {
    return false
  }
}

/**
 * Consume a pending selection or roll back an unconfirmed prior startup.
 * @param statePath - desktop-owned state file outside the Harness profile tree.
 * @param home - Harness home used only for read-only profile discovery.
 * @returns profile decision persisted before profile preparation starts.
 */
export function beginDesktopProfileStartup(statePath: string, home: string): DesktopProfileStartup {
  const loaded = loadState(statePath)
  const current = loaded.state
  let profileName = current.active
  let rolledBackFrom: string | undefined
  let recoveredState = loaded.recovered

  if (current.pending !== undefined) {
    if (isSelectable(home, current.pending)) {
      profileName = current.pending
    } else {
      rolledBackFrom = current.pending
      profileName = isSelectable(home, current.lastKnownGood) ? current.lastKnownGood : DEFAULT_PROFILE_NAME
      recoveredState = true
    }
  } else if (current.active !== current.lastKnownGood) {
    rolledBackFrom = current.active
    profileName = isSelectable(home, current.lastKnownGood) ? current.lastKnownGood : DEFAULT_PROFILE_NAME
    recoveredState = true
  } else if (!isSelectable(home, current.active)) {
    rolledBackFrom = current.active
    profileName = DEFAULT_PROFILE_NAME
    recoveredState = true
  }

  const next: DesktopProfileStateV1 = {
    version: STATE_VERSION,
    active: profileName,
    lastKnownGood: isSelectable(home, current.lastKnownGood)
      ? current.lastKnownGood
      : DEFAULT_PROFILE_NAME,
  }
  writeState(statePath, next)
  return {
    profileName,
    state: next,
    recoveredState,
    ...(rolledBackFrom === undefined ? {} : { rolledBackFrom }),
  }
}

/**
 * Confirm that one prepared profile mounted its native shell successfully.
 * @param statePath - desktop-owned state file outside the Harness profile tree.
 * @param name - profile mounted by the current generation.
 * @returns state with the active profile promoted to last-known-good.
 */
export function markDesktopProfileHealthy(statePath: string, name: string): DesktopProfileStateV1 {
  assertDesktopProfileName(name)
  const current = loadState(statePath).state
  if (current.active !== name || current.pending !== undefined) {
    throw new Error(`${BIN_NAME}: cannot confirm inactive profile ${JSON.stringify(name)}`)
  }
  const next: DesktopProfileStateV1 = {
    version: STATE_VERSION,
    active: name,
    lastKnownGood: name,
  }
  writeState(statePath, next)
  return next
}

/**
 * Roll one failed startup back to the last confirmed profile.
 * @param statePath - desktop-owned state file outside the Harness profile tree.
 * @param name - profile whose startup failed.
 * @returns state prepared for a safe relaunch.
 */
export function markDesktopProfileFailed(statePath: string, name: string): DesktopProfileStateV1 {
  assertDesktopProfileName(name)
  const current = loadState(statePath).state
  if (current.active !== name) {
    throw new Error(`${BIN_NAME}: cannot fail inactive profile ${JSON.stringify(name)}`)
  }
  const next: DesktopProfileStateV1 = {
    version: STATE_VERSION,
    active: current.lastKnownGood,
    lastKnownGood: current.lastKnownGood,
  }
  writeState(statePath, next)
  return next
}
