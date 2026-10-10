/** Profile-relative package resolution for Electron's restricted Node runtime. */

import Module, {
  createRequire,
  isBuiltin,
  registerHooks,
  type ModuleHooks,
  type ResolveHookSync,
} from 'node:module'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  findOverlayPackage,
  packageNameFromSpecifier,
  PackageOverlayNotFoundError,
  type PackageOverlayCandidate,
} from './package-overlay.ts'
import { retainAsarModuleResolver } from './asar-module-resolver-state.ts'

const LOADER_ENTRY_URL = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
// Keep installation resolution in Electron's logical ASAR tree. Native
// payloads are redirected by Electron Builder, while ordinary modules avoid a
// second physical node_modules tree and its Windows antivirus I/O cost.
const DESKTOP_ENTRY_URL = pathToFileURL(fileURLToPath(new URL('../lib/index.js', import.meta.url))).href
const DESKTOP_PACKAGE_URL = pathToFileURL(fileURLToPath(new URL('../package.json', import.meta.url))).href
const DESKTOP_REQUIRE = createRequire(DESKTOP_ENTRY_URL)
const PROCESS_RESOLVER = Symbol.for('dsh-plugin-desktop.profile-package-resolver.v1')

type ModuleSource = 'install' | 'profile'

interface ProfileResolverRegistration {
  readonly profileBaseUrl: string
  readonly profileDirectory: string
  readonly sharedFallbackDirectory: string
  readonly moduleSources: Map<string, ModuleSource>
  readonly canonicalPaths: Map<string, string>
  readonly canonicalModuleKeys: Map<string, string>
  readonly overlayCandidates: Map<string, PackageOverlayCandidate>
  readonly activeSequences: Set<number>
  readonly profileRequire: NodeJS.Require
  references: number
  sequence: number
}

interface ParentRegistration {
  readonly registration: ProfileResolverRegistration
  readonly boundary: boolean
  readonly source?: ModuleSource
}

interface ProcessResolverState {
  readonly registrations: Map<string, ProfileResolverRegistration>
  readonly hooks: ModuleHooks
  readonly commonJsModule: CommonJsModuleResolver
  readonly previousResolveFilename: CommonJsModuleResolver['_resolveFilename']
  readonly overlayResolveFilename: CommonJsModuleResolver['_resolveFilename']
  bypassDepth: number
  nextSequence: number
  resolve: ResolveHookSync
  resolveFilename: CommonJsModuleResolver['_resolveFilename']
}

interface CommonJsModuleResolver {
  _resolveFilename(
    request: string,
    parent: { filename?: string } | null | undefined,
    isMain: boolean | undefined,
    options?: unknown,
  ): string
}

type ProcessState = Record<PropertyKey, unknown>

function processState(): ProcessState {
  return globalThis as unknown as ProcessState
}

function currentResolverState(): ProcessResolverState | undefined {
  return processState()[PROCESS_RESOLVER] as ProcessResolverState | undefined
}

function setResolverState(state: ProcessResolverState | undefined): void {
  if (state === undefined) delete processState()[PROCESS_RESOLVER]
  else processState()[PROCESS_RESOLVER] = state
}

function filePath(url: string | undefined): string | undefined {
  if (url === undefined || !url.startsWith('file:')) return undefined
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

function resolvedRealPath(candidate: string): string | undefined {
  try {
    return realpathSync.native(candidate)
  } catch {
    return undefined
  }
}

function isAsarPath(candidate: string): boolean {
  return /(^|[\\/])app\.asar(?:\.unpacked)?([\\/]|$)/iu.test(candidate)
}

function canonicalPath(registration: ProfileResolverRegistration, candidate: string): string {
  // Electron already gives logical ASAR paths a stable identity. Calling
  // realpathSync on every archived module crosses its virtual filesystem and
  // made Host boot proportional to the complete module graph on Windows.
  if (isAsarPath(candidate)) return candidate
  const cached = registration.canonicalPaths.get(candidate)
  if (cached !== undefined) return cached
  const canonical = resolvedRealPath(candidate)
  // Do not cache ENOENT. Generated modules and retargeted Profile symlinks can
  // become valid later in the same process.
  if (canonical !== undefined) registration.canonicalPaths.set(candidate, canonical)
  return canonical ?? candidate
}

function refreshCanonicalProfilePath(registration: ProfileResolverRegistration): void {
  registration.canonicalPaths.clear()
  registration.canonicalModuleKeys.clear()
  const canonical = resolvedRealPath(registration.profileDirectory)
  if (canonical !== undefined) {
    registration.canonicalPaths.set(registration.profileDirectory, canonical)
  }
}

/** Package presence and symlink targets may have changed; already loaded modules keep their URLs. */
function invalidatePackageSelections(registration: ProfileResolverRegistration): void {
  registration.overlayCandidates.clear()
  refreshCanonicalProfilePath(registration)
}

function canonicalModuleKey(registration: ProfileResolverRegistration, url: string): string {
  const cached = registration.canonicalModuleKeys.get(url)
  if (cached !== undefined) return cached
  const candidate = filePath(url)
  if (candidate === undefined) return url
  const parsed = new URL(url)
  const normalized = pathToFileURL(canonicalPath(registration, candidate))
  normalized.search = parsed.search
  normalized.hash = parsed.hash
  const key = normalized.href
  // Cache only successful filesystem identities, never a missing generated
  // module. Keep query/hash in the key and invalidate alongside paths on HMR.
  if (registration.canonicalPaths.has(candidate)) registration.canonicalModuleKeys.set(url, key)
  return key
}

function isLexicallyWithin(directory: string, candidate: string): boolean {
  const offset = relative(directory, candidate)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

function isWithin(
  registration: ProfileResolverRegistration,
  directory: string,
  candidate: string,
): boolean {
  return isLexicallyWithin(directory, candidate)
    || isLexicallyWithin(
      canonicalPath(registration, directory),
      canonicalPath(registration, candidate),
    )
}

function isLexicalProfileBoundary(
  registration: ProfileResolverRegistration,
  url: string | undefined,
): boolean {
  if (url === registration.profileBaseUrl) return true
  const candidate = filePath(url)
  if (candidate === undefined) return false
  const offset = relative(registration.profileDirectory, candidate)
  // The native Loader has used the directory URL, package.json, and cordis
  // config files as its parentURL across supported Node releases. Restrict the
  // bridge to that directory and its direct files, never another Profile.
  return offset === '' || (!offset.includes(sep) && offset !== '..' && !isAbsolute(offset))
}

function isCanonicalProfileBoundary(
  registration: ProfileResolverRegistration,
  canonicalUrl: string,
): boolean {
  const candidate = filePath(canonicalUrl)
  if (candidate === undefined) return false
  const offset = relative(canonicalPath(registration, registration.profileDirectory), candidate)
  return offset === '' || (!offset.includes(sep) && offset !== '..' && !isAbsolute(offset))
}

function isSharedFallbackPath(registration: ProfileResolverRegistration, candidate: string): boolean {
  return isWithin(registration, registration.sharedFallbackDirectory, candidate)
}

function isSharedFallbackUrl(registration: ProfileResolverRegistration, url: string): boolean {
  const candidate = filePath(url)
  return candidate !== undefined && isSharedFallbackPath(registration, candidate)
}

function isLegacyDesktopInstallUrl(url: string): boolean {
  const candidate = filePath(url)
  return candidate !== undefined && isAsarPath(candidate)
}

function isObsoleteProfileFallbackUrl(
  registration: ProfileResolverRegistration,
  url: string,
): boolean {
  return isLegacyDesktopInstallUrl(url) || isSharedFallbackUrl(registration, url)
}

function isObsoleteProfileFallbackPath(
  registration: ProfileResolverRegistration,
  candidate: string,
): boolean {
  return isAsarPath(candidate) || isSharedFallbackPath(registration, candidate)
}

function isLinkedProfileModule(
  registration: ProfileResolverRegistration,
  parentURL: string | undefined,
): boolean {
  const candidate = filePath(parentURL)
  return candidate !== undefined
    && !isWithin(registration, registration.profileDirectory, candidate)
}

function canUseProfileSharedDependency(
  registration: ProfileResolverRegistration,
  parentURL: string | undefined,
  candidate: string,
): boolean {
  // A linked Profile plugin may keep dependencies in the Profile-level
  // node_modules directory. That location is obsolete only when selected as
  // an overlay root, not when it is a dependency of a linked plugin.
  return isLinkedProfileModule(registration, parentURL)
    && isSharedFallbackPath(registration, candidate)
}

function canUseProfileSharedDependencyUrl(
  registration: ProfileResolverRegistration,
  parentURL: string | undefined,
  candidate: string,
): boolean {
  const path = filePath(candidate)
  return path !== undefined && canUseProfileSharedDependency(registration, parentURL, path)
}

function isPackageLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('\\')
    || specifier.startsWith('#')
    || URL.canParse(specifier)
}

function isBarePackageSpecifier(specifier: string): boolean {
  return !isBuiltin(specifier) && !isPackageLocalSpecifier(specifier)
    && packageNameFromSpecifier(specifier) !== undefined
}

function resolvablePackageName(specifier: string): string | undefined {
  return isBuiltin(specifier) || isPackageLocalSpecifier(specifier)
    ? undefined
    : packageNameFromSpecifier(specifier)
}

function isMissingModule(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
}

function newestRegistration(
  state: ProcessResolverState,
  predicate: (registration: ProfileResolverRegistration) => boolean,
): ProfileResolverRegistration | undefined {
  let selected: ProfileResolverRegistration | undefined
  for (const registration of state.registrations.values()) {
    if (predicate(registration) && (selected === undefined || registration.sequence > selected.sequence)) {
      selected = registration
    }
  }
  return selected
}

function registrationForParent(
  state: ProcessResolverState,
  parentURL: string | undefined,
): ParentRegistration | undefined {
  if (parentURL === LOADER_ENTRY_URL) {
    const registration = newestRegistration(state, () => true)
    return registration === undefined ? undefined : { registration, boundary: true }
  }

  if (parentURL === undefined) return undefined
  const exact = state.registrations.get(parentURL)
  if (exact !== undefined) {
    return { registration: exact, boundary: true, source: 'profile' }
  }

  const boundary = newestRegistration(
    state,
    registration => isLexicalProfileBoundary(registration, parentURL),
  )
  if (boundary !== undefined) {
    return { registration: boundary, boundary: true, source: 'profile' }
  }

  const graph = newestRegistration(state, registration => registration.moduleSources.has(parentURL))
  if (graph !== undefined) {
    return {
      registration: graph,
      boundary: false,
      source: graph.moduleSources.get(parentURL)!,
    }
  }

  // An untracked installation module must not gain access to Profile packages.
  // More importantly, never realpath a logical ASAR URL: Electron has already
  // supplied the stable identity and the archive lookup is the hot boot path.
  if (isLegacyDesktopInstallUrl(parentURL)) return undefined

  // Symlinked development Profiles need a canonical fallback, but it remains
  // a cold path. Successful lookups are cached and promoted into the raw graph
  // by track(); logical ASAR paths never reach this branch.
  const canonicalParents = new Map<ProfileResolverRegistration, string>()
  const canonicalParent = (registration: ProfileResolverRegistration): string => {
    let key = canonicalParents.get(registration)
    if (key === undefined) {
      key = canonicalModuleKey(registration, parentURL)
      canonicalParents.set(registration, key)
    }
    return key
  }
  const canonicalBoundary = newestRegistration(
    state,
    registration => isCanonicalProfileBoundary(registration, canonicalParent(registration)),
  )
  if (canonicalBoundary !== undefined) {
    return { registration: canonicalBoundary, boundary: true, source: 'profile' }
  }
  const canonicalGraph = newestRegistration(
    state,
    registration => registration.moduleSources.has(canonicalParent(registration)),
  )
  if (canonicalGraph !== undefined) {
    return {
      registration: canonicalGraph,
      boundary: false,
      source: canonicalGraph.moduleSources.get(canonicalParent(canonicalGraph))!,
    }
  }

  // The public Loader fallback evaluates a bare dynamic import from its own
  // module. One DSH process owns one active Profile; during an HMR hand-over,
  // the most recently retained registration is authoritative.
  return undefined
}

function selectedOverlayCandidate(
  registration: ProfileResolverRegistration,
  packageName: string,
): PackageOverlayCandidate {
  const cached = registration.overlayCandidates.get(packageName)
  if (cached !== undefined) return cached
  const overlay = findOverlayPackage(packageName, {
    installPackageUrl: DESKTOP_PACKAGE_URL,
    profilePackageUrl: registration.profileBaseUrl,
  })
  // Missing packages are intentionally not cached: Market/HMR can publish one
  // while this process is alive.
  if (overlay === undefined) throw new PackageOverlayNotFoundError(packageName)
  let selected = overlay.selected
  if (overlay.selected.source === 'profile'
    && !isLexicallyWithin(join(registration.profileDirectory, 'node_modules'), overlay.selected.manifestPath)) {
    // findPackageJSON follows Node's ordinary ancestor walk. Only the exact
    // active Profile node_modules tree is an overlay candidate; accepting a
    // package from $DSH_HOME/node_modules would let unrelated/stale state
    // override the sealed Desktop installation. Keep this check lexical so a
    // Profile-owned node_modules symlink into .dsh-module-fallback remains
    // valid while packages above the Profile boundary do not.
    if (overlay.install !== undefined) selected = overlay.install
    else throw new PackageOverlayNotFoundError(packageName)
  }
  if (selected.source === 'profile'
    && (isAsarPath(selected.manifestPath)
      || isSharedFallbackPath(registration, selected.manifestPath))) {
    // Older Desktop releases populated profiles/node_modules with an
    // installation-wide proxy/link tree. It is not an active Profile candidate:
    // using it can resurrect a dangling path or a previous app generation.
    if (overlay.install !== undefined) selected = overlay.install
    else throw new PackageOverlayNotFoundError(packageName)
  }
  registration.overlayCandidates.set(packageName, selected)
  return selected
}

function track(
  registration: ProfileResolverRegistration,
  url: string,
  source: ModuleSource,
): void {
  registration.moduleSources.set(url, source)
  const candidate = filePath(url)
  if (candidate === undefined || isAsarPath(candidate)) return
  const canonical = canonicalModuleKey(registration, url)
  registration.moduleSources.set(canonical, source)
}

function resolveFromAnchor(
  state: ProcessResolverState,
  registration: ProfileResolverRegistration,
  specifier: string,
  source: ModuleSource,
  context: Parameters<ResolveHookSync>[1],
  nextResolve: Parameters<ResolveHookSync>[2],
): ReturnType<ResolveHookSync> {
  if (!context.conditions?.includes('require')) {
    return nextResolve(specifier, {
      ...context,
      parentURL: source === 'profile' ? registration.profileBaseUrl : DESKTOP_ENTRY_URL,
    })
  }
  // Node's synchronous hook observes require/createRequire, but its CJS
  // default resolver intentionally keeps the original CJS parent even when a
  // hook changes context.parentURL. Resolve that branch with Node's official
  // createRequire API and short-circuit only this request. The bypass prevents
  // the nested require.resolve call from re-entering our own policy.
  state.bypassDepth += 1
  try {
    const require = source === 'profile' ? registration.profileRequire : DESKTOP_REQUIRE
    return {
      url: pathToFileURL(require.resolve(specifier)).href,
      shortCircuit: true,
    }
  } finally {
    state.bypassDepth -= 1
  }
}

function resolveCommonJsFromAnchor(
  state: ProcessResolverState,
  registration: ProfileResolverRegistration,
  request: string,
  source: ModuleSource,
): string {
  state.bypassDepth += 1
  try {
    const require = source === 'profile' ? registration.profileRequire : DESKTOP_REQUIRE
    return require.resolve(request)
  } finally {
    state.bypassDepth -= 1
  }
}

function resolveCommonJsNormally(
  state: ProcessResolverState,
  thisArg: CommonJsModuleResolver,
  request: string,
  parent: { filename?: string } | null | undefined,
  isMain: boolean | undefined,
  options?: unknown,
): string {
  // Node's synchronous hooks also observe CommonJS resolution. Keep the ESM
  // hook in pass-through mode while the explicit CJS policy calls Node's
  // original resolver, otherwise one require is classified twice.
  state.bypassDepth += 1
  try {
    return state.previousResolveFilename.call(thisArg, request, parent, isMain, options)
  } finally {
    state.bypassDepth -= 1
  }
}

function resolveFilenameWithState(
  state: ProcessResolverState,
  thisArg: CommonJsModuleResolver,
  request: string,
  parent: { filename?: string } | null | undefined,
  isMain: boolean | undefined,
  options?: unknown,
): string {
  if (state.bypassDepth > 0 || isBuiltin(request)) {
    return state.previousResolveFilename.call(thisArg, request, parent, isMain, options)
  }
  const parentURL = parent?.filename === undefined ? undefined : pathToFileURL(parent.filename).href
  const parentRegistration = registrationForParent(state, parentURL)
  const packageName = resolvablePackageName(request)
  if (parentRegistration === undefined) {
    return resolveCommonJsNormally(state, thisArg, request, parent, isMain, options)
  }
  const { registration, boundary, source: parentSource } = parentRegistration
  if (packageName === undefined) {
    const resolved = resolveCommonJsNormally(state, thisArg, request, parent, isMain, options)
    if (parentSource !== undefined && isAbsolute(resolved)) {
      track(registration, pathToFileURL(resolved).href, parentSource)
    }
    return resolved
  }
  if (boundary) {
    const selected = selectedOverlayCandidate(registration, packageName)
    const resolved = resolveCommonJsFromAnchor(state, registration, request, selected.source)
    if (selected.source === 'profile' && isObsoleteProfileFallbackPath(registration, resolved)) {
      throw new PackageOverlayNotFoundError(packageName)
    }
    track(registration, pathToFileURL(resolved).href, selected.source)
    return resolved
  }
  if (parentSource === undefined) {
    return resolveCommonJsNormally(state, thisArg, request, parent, isMain, options)
  }
  try {
    const resolved = resolveCommonJsNormally(state, thisArg, request, parent, isMain, options)
    if (parentSource === 'install'
      || !isObsoleteProfileFallbackPath(registration, resolved)
      || (parentSource === 'profile'
        && canUseProfileSharedDependency(registration, parentURL, resolved))) {
      track(registration, pathToFileURL(resolved).href, parentSource)
      return resolved
    }
  } catch (cause) {
    if (!isMissingModule(cause)) throw cause
  }
  try {
    const resolved = resolveCommonJsFromAnchor(state, registration, request, 'profile')
    if (!isObsoleteProfileFallbackPath(registration, resolved)
      || (parentSource === 'profile'
        && canUseProfileSharedDependency(registration, parentURL, resolved))) {
      track(registration, pathToFileURL(resolved).href, 'profile')
      return resolved
    }
  } catch (cause) {
    if (!isMissingModule(cause)) throw cause
  }
  const resolved = resolveCommonJsFromAnchor(state, registration, request, 'install')
  track(registration, pathToFileURL(resolved).href, 'install')
  return resolved
}

function resolveForRegistration(
  state: ProcessResolverState,
  parentRegistration: ParentRegistration,
  specifier: string,
  context: Parameters<ResolveHookSync>[1],
  nextResolve: Parameters<ResolveHookSync>[2],
): ReturnType<ResolveHookSync> {
  const { registration, boundary, source: parentSource } = parentRegistration
  // Node may mutate the hook context while delegating to its default resolver;
  // retain the original module owner for Profile shared-dependency policy.
  const parentURL = context.parentURL
  const packageName = boundary ? resolvablePackageName(specifier) : undefined
  if (packageName !== undefined) {
    const selected = selectedOverlayCandidate(registration, packageName)
    const source = selected.source
    const resolved = resolveFromAnchor(state, registration, specifier, source, context, nextResolve)
    if (source === 'profile' && isObsoleteProfileFallbackUrl(registration, resolved.url)) {
      throw new PackageOverlayNotFoundError(packageName)
    }
    track(registration, resolved.url, source)
    return resolved
  }

  if (parentSource === undefined) return nextResolve(specifier, context)

  // Relative paths, package imports, absolute URLs and builtins belong to the
  // selected package. Do not reinterpret them through another package anchor.
  if (isPackageLocalSpecifier(specifier) || !isBarePackageSpecifier(specifier)) {
    const resolved = nextResolve(specifier, context)
    if (resolved.url.startsWith('file:')) track(registration, resolved.url, parentSource)
    return resolved
  }

  try {
    const resolved = nextResolve(specifier, context)
    if (parentSource === 'install'
      || !isObsoleteProfileFallbackUrl(registration, resolved.url)
      || (parentSource === 'profile'
        && canUseProfileSharedDependencyUrl(registration, parentURL, resolved.url))) {
      track(registration, resolved.url, parentSource)
      return resolved
    }
  } catch (cause) {
    if (!isMissingModule(cause)) throw cause
  }

  try {
    const resolved = resolveFromAnchor(state, registration, specifier, 'profile', context, nextResolve)
    if (!isObsoleteProfileFallbackUrl(registration, resolved.url)
      || (parentSource === 'profile'
        && canUseProfileSharedDependencyUrl(registration, parentURL, resolved.url))) {
      track(registration, resolved.url, 'profile')
      return resolved
    }
  } catch (cause) {
    if (!isMissingModule(cause)) throw cause
  }

  // Delegating the original context preserves Node's import/require
  // conditions, wildcard and exact exports, package.json exports, and CJS
  // callable identity. Only the parent anchor changes.
  const resolved = resolveFromAnchor(state, registration, specifier, 'install', context, nextResolve)
  track(registration, resolved.url, 'install')
  return resolved
}

function resolveWithState(
  state: ProcessResolverState,
  specifier: string,
  context: Parameters<ResolveHookSync>[1],
  nextResolve: Parameters<ResolveHookSync>[2],
): ReturnType<ResolveHookSync> {
  // Builtins cannot be overlaid by a Profile and have no filesystem owner.
  if (state.bypassDepth > 0 || isBuiltin(specifier)) return nextResolve(specifier, context)
  const parentRegistration = registrationForParent(state, context.parentURL)
  return parentRegistration === undefined
    ? nextResolve(specifier, context)
    : resolveForRegistration(state, parentRegistration, specifier, context, nextResolve)
}

function migrateResolverState(state: ProcessResolverState): void {
  let latestSequence = Number.isFinite(state.nextSequence) ? state.nextSequence : 0
  for (const registration of state.registrations.values()) {
    const mutable = registration as unknown as {
      activeSequences?: Set<number>
      canonicalPaths?: Map<string, string>
      canonicalModuleKeys?: Map<string, string>
      overlayCandidates?: Map<string, PackageOverlayCandidate>
    }
    // v1 is intentionally retained as the process symbol because an earlier
    // HMR generation already owns the live Node hooks. Upgrade its objects in
    // place instead of registering a second resolver stack.
    mutable.canonicalPaths = new Map()
    mutable.canonicalModuleKeys = new Map()
    mutable.overlayCandidates = new Map()
    if (!(mutable.activeSequences instanceof Set)) {
      mutable.activeSequences = new Set(
        registration.references > 0 ? [registration.sequence] : [],
      )
    }
    latestSequence = Math.max(latestSequence, registration.sequence)
  }
  state.nextSequence = latestSequence
}

function ensureResolverState(): ProcessResolverState {
  const existing = currentResolverState()
  if (existing !== undefined) {
    migrateResolverState(existing)
    // A hook registered by an earlier HMR generation delegates through this
    // mutable function, so it immediately adopts the current implementation.
    existing.resolve = (specifier, context, nextResolve) => (
      resolveWithState(existing, specifier, context, nextResolve)
    )
    existing.resolveFilename = function (this: CommonJsModuleResolver, request, parent, isMain, options) {
      return resolveFilenameWithState(existing, this, request, parent, isMain, options)
    }
    return existing
  }
  const commonJsModule = Module as unknown as CommonJsModuleResolver
  const previousResolveFilename = commonJsModule._resolveFilename
  const state = {
    registrations: new Map<string, ProfileResolverRegistration>(),
    bypassDepth: 0,
    nextSequence: 0,
    resolve: ((specifier, context, nextResolve) => nextResolve(specifier, context)) as ResolveHookSync,
    resolveFilename: previousResolveFilename,
  } as ProcessResolverState
  const hooks = registerHooks({
    resolve: (specifier, context, nextResolve) => state.resolve(specifier, context, nextResolve),
  })
  Object.defineProperty(state, 'hooks', { value: hooks, enumerable: true })
  const overlayResolveFilename: CommonJsModuleResolver['_resolveFilename'] = function (
    this: CommonJsModuleResolver,
    request,
    parent,
    isMain,
    options,
  ) {
    return state.resolveFilename.call(this, request, parent, isMain, options)
  }
  Object.defineProperties(state, {
    commonJsModule: { value: commonJsModule, enumerable: true },
    previousResolveFilename: { value: previousResolveFilename, enumerable: true },
    overlayResolveFilename: { value: overlayResolveFilename, enumerable: true },
  })
  state.resolve = (specifier, context, nextResolve) => (
    resolveWithState(state, specifier, context, nextResolve)
  )
  state.resolveFilename = function (this: CommonJsModuleResolver, request, parent, isMain, options) {
    return resolveFilenameWithState(state, this, request, parent, isMain, options)
  }
  commonJsModule._resolveFilename = overlayResolveFilename
  setResolverState(state)
  return state
}

/**
 * Resolve Cordis Loader imports from one selected persistent Profile.
 * The process owns one multiplexed Node hook; repeated/HMR registrations are
 * reference-counted and may be released in any order.
 * @param profileBaseUrl - file URL for the Profile package.json.
 * @returns an idempotent registration disposer.
 */
export function installProfilePackageResolver(profileBaseUrl: string): () => void {
  const parsed = new URL(profileBaseUrl)
  if (parsed.protocol !== 'file:' || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('dsh-plugin-desktop: Profile package resolver requires a plain file URL')
  }
  const profileManifestPath = fileURLToPath(parsed)
  if (basename(profileManifestPath) !== 'package.json') {
    throw new Error('dsh-plugin-desktop: Profile package resolver requires a package.json anchor')
  }
  const normalizedBaseUrl = pathToFileURL(profileManifestPath).href
  const profileDirectory = dirname(profileManifestPath)
  const state = ensureResolverState()
  let registration = state.registrations.get(normalizedBaseUrl)
  if (registration === undefined) {
    registration = {
      profileBaseUrl: normalizedBaseUrl,
      profileDirectory,
      sharedFallbackDirectory: join(dirname(profileDirectory), 'node_modules'),
      moduleSources: new Map(),
      canonicalPaths: new Map(),
      canonicalModuleKeys: new Map(),
      overlayCandidates: new Map(),
      activeSequences: new Set(),
      profileRequire: createRequire(normalizedBaseUrl),
      references: 0,
      sequence: 0,
    }
    state.registrations.set(normalizedBaseUrl, registration)
    refreshCanonicalProfilePath(registration)
  } else {
    // A retain denotes a new Loader/HMR generation.
    invalidatePackageSelections(registration)
  }
  const retainSequence = ++state.nextSequence
  registration.references += 1
  registration.activeSequences.add(retainSequence)
  registration.sequence = retainSequence
  const releaseMarker = retainAsarModuleResolver()
  let active = true
  return () => {
    if (!active) return
    active = false
    releaseMarker()
    registration!.references -= 1
    registration!.activeSequences.delete(retainSequence)
    if (registration!.references === 0) {
      state.registrations.delete(normalizedBaseUrl)
    } else {
      let latestSequence = 0
      for (const sequence of registration!.activeSequences) {
        latestSequence = Math.max(latestSequence, sequence)
      }
      registration!.sequence = latestSequence
    }
    if (state.registrations.size > 0) return
    state.hooks.deregister()
    if (state.commonJsModule._resolveFilename === state.overlayResolveFilename) {
      state.commonJsModule._resolveFilename = state.previousResolveFilename
    }
    if (currentResolverState() === state) setResolverState(undefined)
  }
}

/**
 * Report the package a bare import from `parentURL` loads, without requiring package exports.
 * @param specifier - module specifier naming the package, including any subpath.
 * @param parentURL - resolution base of the request.
 * @returns the selected package; `null` when an active Profile boundary owns the request but neither the
 * installation nor the Profile provides the package; `undefined` when no active registration owns `parentURL`
 * as a Profile boundary, so Node's own lookup from that parent applies.
 */
export function selectProfilePackage(
  specifier: string,
  parentURL: string,
): PackageOverlayCandidate | null | undefined {
  const state = currentResolverState()
  if (state === undefined) return undefined
  const parent = registrationForParent(state, parentURL)
  const packageName = parent?.boundary === true ? resolvablePackageName(specifier) : undefined
  if (parent === undefined || packageName === undefined) return undefined
  try {
    return selectedOverlayCandidate(parent.registration, packageName)
  } catch (cause) {
    if (cause instanceof PackageOverlayNotFoundError) return null
    throw cause
  }
}

/** Re-select packages for later imports after a package operation; loaded modules are not reloaded. */
export function refreshProfilePackageSelections(): void {
  for (const registration of currentResolverState()?.registrations.values() ?? []) {
    invalidatePackageSelections(registration)
  }
}
