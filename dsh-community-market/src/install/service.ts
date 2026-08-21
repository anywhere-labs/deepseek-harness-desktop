import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { prerelease, satisfies, valid } from 'semver'
import { parse as parseYaml } from 'yaml'
import type { MarketInstallableResponse, MarketInstallReceipt } from '../api-types.js'
import type { CatalogFullIndex } from '../catalog/service.js'
import type { MarketSettingsDocument } from '../catalog/source-store.js'
import { normalizeRepositoryIdentity } from '../contracts/identity.js'
import type { CatalogHttpClient, NormalizedRepositoryIdentity } from '../contracts/types.js'
import type { CatalogSnapshot } from '../contracts/index.js'
import { manualInstallHints } from './manual.js'

const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const NPM_REGISTRY = `${NPM_REGISTRY_ORIGIN}/`
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024
const INSTALL_INTENT_TTL_MS = 5 * 60 * 1000
const CANDIDATE_TTL_MS = 30 * 60 * 1000
const MAX_INTENTS = 256
const MAX_CANDIDATES = 10_000
const MAX_RECEIPTS = 512
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const
const BLOCKED_PRODUCT_PACKAGES = new Set(['dsh-plugin-desktop', 'dsh-community-market'])
const DSH_RUNTIME_VERSION = '0.1.1-rc.2'
const CORDIS_RUNTIME_VERSION = '4.0.1'
const NODE_RUNTIME_VERSION = '24.18.1'

export type { MarketInstallReceipt } from '../api-types.js'

export interface MarketDesktopProfile {
  readonly name: string
  readonly dir: string
}

export interface MarketDesktopPnpmOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

export interface MarketDesktopPnpmHandle {
  readonly stdout: Readable
  readonly stderr: Readable
  readonly done: Promise<MarketDesktopPnpmOutcome>
  cancel(): void
}

export interface MarketDesktopPnpm {
  runPlugin(
    args: readonly string[],
    invokingDir: string,
    signal?: AbortSignal,
  ): MarketDesktopPnpmHandle
  installPlugin(request: {
    readonly pnpmOptions?: readonly string[]
    readonly invokingDir: string
    readonly recovery: {
      readonly packageName: string
      readonly packageVersion: string
      readonly receiptId: string
    }
    readonly signal?: AbortSignal
  }): Promise<MarketDesktopPnpmHandle>
  recoveredInstallReceiptIds(): Promise<readonly string[]>
  acknowledgeRecoveredInstall(receiptId: string): Promise<void>
  rollbackPluginInstall(receiptId: string): Promise<boolean>
}

export interface MarketInstallPreview {
  readonly intent: string
  readonly action: 'install'
  readonly profileName: string
  readonly packageName: string
  readonly version: string
  readonly displayName: string
  readonly expiresAt: string
}

export interface MarketUninstallPreview {
  readonly intent: string
  readonly action: 'uninstall'
  readonly profileName: string
  readonly packageName: string
  readonly version: string
  readonly displayName: string
  readonly expiresAt: string
}

export interface MarketInstallResult {
  readonly receipt: MarketInstallReceipt
}

export interface MarketUninstallResult {
  readonly receiptId: string
  readonly packageName: string
}

export type MarketOperationResult =
  | ({ readonly action: 'install'; readonly restartToken: string } & MarketInstallResult)
  | ({ readonly action: 'uninstall'; readonly restartToken: string } & MarketUninstallResult)

export type MarketInstallErrorCode =
  | 'invalid-request'
  | 'not-available'
  | 'conflict'
  | 'intent-expired'
  | 'verification-failed'
  | 'operation-failed'
  | 'persistence-failed'

/** Error whose message is safe to return through the loopback API. */
export class MarketInstallError extends Error {
  constructor(readonly code: MarketInstallErrorCode, message: string) {
    super(message)
    this.name = 'MarketInstallError'
  }
}

interface InstallCandidate {
  readonly key: string
  readonly sourceRecordId: string
  readonly providerId: string
  readonly itemId: string
  readonly displayName: string
  readonly packageName: string
  readonly version: string
  readonly repository: NormalizedRepositoryIdentity
  readonly savedAt: number
}

interface InstallIntent {
  readonly kind: 'install'
  readonly candidate: InstallCandidate
  readonly verification: MarketNpmPackageVerification
  readonly profile: MarketDesktopProfile
  readonly expiresAt: number
}

interface UninstallIntent {
  readonly kind: 'uninstall'
  readonly receipt: MarketInstallReceipt
  readonly profile: MarketDesktopProfile
  readonly expiresAt: number
}

type MarketIntent = InstallIntent | UninstallIntent

interface RestartIntent {
  readonly profile: MarketDesktopProfile
  readonly expiresAt: number
}

export interface MarketNpmPackageVerifier {
  verify(
    candidate: Pick<InstallCandidate, 'packageName' | 'version' | 'repository'>,
    signal: AbortSignal,
  ): Promise<MarketNpmPackageVerification>
}

export interface MarketNpmPackageVerification {
  readonly integrity: string
  readonly bundlePatch: string
  readonly tarball: string
}

export interface MarketInstallServiceOptions {
  readonly now?: () => number
  readonly intentTtlMs?: number
  readonly candidateTtlMs?: number
  readonly maxIntents?: number
  readonly maxCandidates?: number
  /** Host-owned policy state; Renderer values must never reach this callback. */
  readonly disabledPackageNames?: () => readonly string[]
}

function stableExactVersion(value: unknown): value is string {
  return typeof value === 'string'
    && valid(value, { loose: false }) === value
    && prerelease(value, { loose: false }) === null
}

function safePackageName(value: unknown): value is string {
  return typeof value === 'string' && PACKAGE_NAME_PATTERN.test(value)
}

function marketManagedPackage(value: string): boolean {
  return !BLOCKED_PRODUCT_PACKAGES.has(value)
}

function candidateKey(sourceRecordId: string, itemId: string): string {
  return `${sourceRecordId}\0${itemId}`
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

function own(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function sha512Integrity(value: unknown): value is string {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false
  const encoded = value.slice('sha512-'.length)
  const digest = Buffer.from(encoded, 'base64')
  return digest.byteLength === 64 && digest.toString('base64') === encoded
}

function safeBundlePatch(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) return false
  const path = value.startsWith('./') ? value.slice(2) : value
  return path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'))
}

function npmRepository(value: unknown): NormalizedRepositoryIdentity | undefined {
  const repository = typeof value === 'string'
    ? { url: value }
    : value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  if (repository === undefined || typeof repository.url !== 'string') return undefined
  const rawUrl = repository.url.startsWith('git+') ? repository.url.slice(4) : repository.url
  if (!rawUrl.startsWith('https://')) return undefined
  try {
    return normalizeRepositoryIdentity({
      url: rawUrl,
      ...(typeof repository.directory === 'string' ? { subdirectory: repository.directory } : {}),
    })
  } catch {
    return undefined
  }
}

function assertRuntimeCompatibility(manifest: Record<string, unknown>): void {
  const accepts = (version: string, range: unknown): boolean => {
    if (typeof range !== 'string') return false
    try { return satisfies(version, range, { includePrerelease: true }) }
    catch { return false }
  }
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const dependencies = manifest[field]
    if (dependencies === undefined) continue
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new MarketInstallError('verification-failed', 'The npm package dependency metadata was invalid.')
    }
    for (const [name, range] of Object.entries(dependencies)) {
      if (name === 'cordis') {
        throw new MarketInstallError(
          'verification-failed',
          'The plugin package depends on the legacy Cordis runtime and is not compatible with DSH Desktop.',
        )
      }
      const runtimeVersion = name === '@deepseek-ai/cordis'
        ? CORDIS_RUNTIME_VERSION
        : name.startsWith('@deepseek-ai/dsh')
          ? DSH_RUNTIME_VERSION
          : undefined
      if (runtimeVersion === undefined) continue
      if (!accepts(runtimeVersion, range)) {
        throw new MarketInstallError(
          'verification-failed',
          'The plugin package is not compatible with this DSH Desktop runtime.',
        )
      }
    }
  }
  const engines = manifest.engines
  if (engines === undefined) return
  if (engines === null || typeof engines !== 'object' || Array.isArray(engines)) {
    throw new MarketInstallError('verification-failed', 'The npm package engine metadata was invalid.')
  }
  const nodeRange = (engines as Record<string, unknown>).node
  if (nodeRange !== undefined && !accepts(NODE_RUNTIME_VERSION, nodeRange)) {
    throw new MarketInstallError(
      'verification-failed',
      'The plugin package does not support the Node.js runtime bundled with DSH Desktop.',
    )
  }
}

function officialNpmTarball(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.origin === NPM_REGISTRY_ORIGIN
      && url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.hash
      && url.pathname.endsWith('.tgz')
  } catch {
    return false
  }
}

/** Build the exact-version npm registry verifier used by the Host preview and execution paths. */
export function createNpmRegistryVerifier(http: CatalogHttpClient): MarketNpmPackageVerifier {
  return {
    async verify(candidate, signal) {
      if (
        !safePackageName(candidate.packageName)
        || !marketManagedPackage(candidate.packageName)
        || !stableExactVersion(candidate.version)
      ) {
        throw new MarketInstallError('verification-failed', 'The plugin package target is invalid.')
      }
      const url = `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(candidate.packageName)}/${encodeURIComponent(candidate.version)}`
      let response
      try {
        response = await http.getJson(url, signal, { allowedOrigin: NPM_REGISTRY_ORIGIN })
      } catch {
        throw new MarketInstallError('verification-failed', 'The plugin package could not be verified with npm.')
      }
      let finalOrigin: string
      try { finalOrigin = new URL(response.finalUrl).origin }
      catch { throw new MarketInstallError('verification-failed', 'The npm verification response was invalid.') }
      const metadata = response.value
      if (
        finalOrigin !== NPM_REGISTRY_ORIGIN
        || metadata === null
        || typeof metadata !== 'object'
        || Array.isArray(metadata)
      ) {
        throw new MarketInstallError('verification-failed', 'The npm verification response was invalid.')
      }
      const manifest = metadata as Record<string, unknown>
      if (manifest.name !== candidate.packageName || manifest.version !== candidate.version) {
        throw new MarketInstallError('verification-failed', 'The npm package identity did not match the catalog.')
      }
      assertRuntimeCompatibility(manifest)
      if (own(manifest, 'deprecated')) {
        throw new MarketInstallError('verification-failed', 'Deprecated plugin packages cannot be installed from the market.')
      }
      const scripts = manifest.scripts
      if (scripts !== undefined && (
        scripts === null
        || typeof scripts !== 'object'
        || Array.isArray(scripts)
        || LIFECYCLE_SCRIPTS.some(script => own(scripts, script))
      )) {
        throw new MarketInstallError('verification-failed', 'Plugin packages with install lifecycle scripts are not supported.')
      }
      const repository = npmRepository(manifest.repository)
      if (
        repository === undefined
        || repository.url !== candidate.repository.url
        || repository.subdirectory !== candidate.repository.subdirectory
      ) {
        throw new MarketInstallError('verification-failed', 'The npm package repository did not match the catalog.')
      }
      const dist = manifest.dist
      const dsh = manifest.dsh
      const bundle = dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh)
        ? (dsh as Record<string, unknown>).bundle
        : undefined
      const patch = bundle !== null && typeof bundle === 'object' && !Array.isArray(bundle)
        ? (bundle as Record<string, unknown>).patch
        : undefined
      const integrity = dist !== null && typeof dist === 'object' && !Array.isArray(dist)
        ? (dist as Record<string, unknown>).integrity
        : undefined
      const tarball = dist !== null && typeof dist === 'object' && !Array.isArray(dist)
        ? (dist as Record<string, unknown>).tarball
        : undefined
      if (!sha512Integrity(integrity) || !officialNpmTarball(tarball) || !safeBundlePatch(patch)) {
        throw new MarketInstallError('verification-failed', 'The npm package is missing a verifiable DSH bundle artifact.')
      }
      return { integrity, bundlePatch: patch, tarball }
    },
  }
}

interface JsonManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dependencies?: unknown
  readonly dsh?: unknown
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

async function readManifest(path: string): Promise<JsonManifest> {
  const body = await readFile(path)
  if (body.byteLength > MAX_MANIFEST_BYTES) throw new Error('manifest too large')
  const value = JSON.parse(body.toString('utf8')) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid manifest')
  return value as JsonManifest
}

function profileDependency(manifest: JsonManifest, packageName: string): string | undefined {
  if (manifest.dependencies === null || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) {
    return undefined
  }
  const value = (manifest.dependencies as Record<string, unknown>)[packageName]
  return typeof value === 'string' ? value : undefined
}

function profileBundles(manifest: JsonManifest): readonly string[] {
  if (manifest.dsh === null || typeof manifest.dsh !== 'object' || Array.isArray(manifest.dsh)) return []
  const profile = (manifest.dsh as Record<string, unknown>).profile
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return []
  const bundles = (profile as Record<string, unknown>).bundles
  return Array.isArray(bundles) && bundles.every(value => typeof value === 'string') ? bundles : []
}

function profileReferencesPlugin(manifest: JsonManifest, packageName: string): boolean {
  return profileDependency(manifest, packageName) !== undefined || profileBundles(manifest).includes(packageName)
}

async function profileHasPluginReference(profile: MarketDesktopProfile, packageName: string): Promise<boolean> {
  return profileReferencesPlugin(await readManifest(join(profile.dir, 'package.json')), packageName)
}

function bundlePatch(manifest: JsonManifest): string | undefined {
  if (manifest.dsh === null || typeof manifest.dsh !== 'object' || Array.isArray(manifest.dsh)) return undefined
  const bundle = (manifest.dsh as Record<string, unknown>).bundle
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) return undefined
  const patch = (bundle as Record<string, unknown>).patch
  return typeof patch === 'string' && patch.length > 0 ? patch : undefined
}

function packageSegments(packageName: string): readonly string[] {
  return packageName.startsWith('@') ? packageName.split('/') : [packageName]
}

function containedPath(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path)
}

function supportedLockfileVersion(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false
  const match = /^(\d+)(?:\.\d+)?$/u.exec(String(value))
  return match !== null && (match[1] === '9' || match[1] === '11')
}

function exactLockResolution(value: unknown, version: string): value is string {
  return typeof value === 'string' && (value === version || value.startsWith(`${version}(`))
}

function lockEntry(recordValue: UnknownRecord, keys: readonly string[]): UnknownRecord | undefined {
  for (const key of keys) {
    if (!own(recordValue, key)) continue
    return record(recordValue[key])
  }
  return undefined
}

async function readProfileLock(profile: MarketDesktopProfile): Promise<UnknownRecord> {
  const body = await readFile(join(profile.dir, 'pnpm-lock.yaml'))
  if (body.byteLength > MAX_LOCKFILE_BYTES) throw new Error('lockfile too large')
  const lockfile = record(parseYaml(body.toString('utf8')))
  if (lockfile === undefined || !supportedLockfileVersion(lockfile.lockfileVersion)) {
    throw new Error('unsupported lockfile')
  }
  return lockfile
}

function assertProfileLockRecord(
  lockfile: UnknownRecord,
  packageName: string,
  version: string,
  expectedIntegrity: string,
): void {
  const importer = record(record(lockfile.importers)?.['.'])
  const dependencies = record(importer?.dependencies)
  const dependency = dependencies !== undefined && own(dependencies, packageName)
    ? record(dependencies[packageName])
    : undefined
  if (dependency?.specifier !== version || !exactLockResolution(dependency.version, version)) {
    throw new Error('lockfile dependency mismatch')
  }

  const resolvedVersion = dependency.version
  const baseKey = `${packageName}@${version}`
  const resolvedKey = `${packageName}@${resolvedVersion}`
  const packageKeys = [...new Set([baseKey, `/${baseKey}`, resolvedKey, `/${resolvedKey}`])]
  const packageSnapshot = lockEntry(record(lockfile.packages) ?? {}, packageKeys)
  const resolution = record(packageSnapshot?.resolution)
  if (resolution?.integrity !== expectedIntegrity) throw new Error('lockfile integrity mismatch')

  const snapshot = lockEntry(record(lockfile.snapshots) ?? {}, [resolvedKey, `/${resolvedKey}`])
  if (snapshot === undefined) throw new Error('lockfile snapshot missing')
}

interface InstalledProfileSnapshot {
  readonly manifest: JsonManifest
  readonly lockfile: UnknownRecord
  readonly nodeModules: string
  readonly resolvedNodeModules: string
}

async function loadInstalledProfileSnapshot(profile: MarketDesktopProfile): Promise<InstalledProfileSnapshot> {
  const nodeModules = resolve(profile.dir, 'node_modules')
  const [manifest, lockfile, resolvedNodeModules] = await Promise.all([
    readManifest(join(profile.dir, 'package.json')),
    readProfileLock(profile),
    realpath(nodeModules),
  ])
  return { manifest, lockfile, nodeModules, resolvedNodeModules }
}

async function assertInstalledBundleFromSnapshot(
  snapshot: InstalledProfileSnapshot,
  packageName: string,
  version: string,
  expectedPatch: string,
  expectedIntegrity: string,
): Promise<void> {
  if (profileDependency(snapshot.manifest, packageName) !== version) throw new Error('dependency mismatch')
  if (!profileBundles(snapshot.manifest).includes(packageName)) throw new Error('bundle missing')
  const packageDir = join(snapshot.nodeModules, ...packageSegments(packageName))
  const resolvedPackageDir = await realpath(packageDir)
  if (!containedPath(snapshot.resolvedNodeModules, resolvedPackageDir)) throw new Error('package escaped profile')
  const manifest = await readManifest(join(resolvedPackageDir, 'package.json'))
  if (manifest.name !== packageName || manifest.version !== version) throw new Error('installed package mismatch')
  const patch = bundlePatch(manifest)
  if (patch === undefined || !safeBundlePatch(patch) || patch !== expectedPatch) {
    throw new Error('bundle patch missing')
  }
  const patchPath = resolve(resolvedPackageDir, patch)
  if (!containedPath(resolvedPackageDir, patchPath)) throw new Error('bundle patch invalid')
  const resolvedPatchPath = await realpath(patchPath)
  if (!containedPath(resolvedPackageDir, resolvedPatchPath) || !(await stat(resolvedPatchPath)).isFile()) {
    throw new Error('bundle patch invalid')
  }
  assertProfileLockRecord(snapshot.lockfile, packageName, version, expectedIntegrity)
}

async function assertInstalledBundle(
  profile: MarketDesktopProfile,
  packageName: string,
  version: string,
  expectedPatch: string,
  expectedIntegrity: string,
): Promise<void> {
  await assertInstalledBundleFromSnapshot(
    await loadInstalledProfileSnapshot(profile),
    packageName,
    version,
    expectedPatch,
    expectedIntegrity,
  )
}

async function assertNotInstalled(profile: MarketDesktopProfile, packageName: string): Promise<void> {
  const profileManifest = await readManifest(join(profile.dir, 'package.json'))
  if (profileReferencesPlugin(profileManifest, packageName)) {
    throw new MarketInstallError('conflict', 'This plugin is already managed by the active profile.')
  }
}

async function assertRemoved(profile: MarketDesktopProfile, packageName: string): Promise<void> {
  const profileManifest = await readManifest(join(profile.dir, 'package.json'))
  if (profileReferencesPlugin(profileManifest, packageName)) {
    throw new Error('plugin remains in profile')
  }
}

function validReceipt(value: unknown): value is MarketInstallReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const receipt = value as Record<string, unknown>
  return typeof receipt.receiptId === 'string' && receipt.receiptId.length >= 16 && receipt.receiptId.length <= 128
    && typeof receipt.profileName === 'string' && receipt.profileName.length >= 1 && receipt.profileName.length <= 120
    && safePackageName(receipt.packageName)
    && marketManagedPackage(receipt.packageName)
    && stableExactVersion(receipt.version)
    && sha512Integrity(receipt.integrity)
    && safeBundlePatch(receipt.bundlePatch)
    && typeof receipt.sourceRecordId === 'string' && receipt.sourceRecordId.length >= 1 && receipt.sourceRecordId.length <= 200
    && typeof receipt.providerId === 'string' && receipt.providerId.length >= 1 && receipt.providerId.length <= 200
    && typeof receipt.itemId === 'string' && receipt.itemId.length >= 1 && receipt.itemId.length <= 200
    && typeof receipt.displayName === 'string' && receipt.displayName.length >= 1 && receipt.displayName.length <= 240
    && typeof receipt.installedAt === 'string' && !Number.isNaN(Date.parse(receipt.installedAt))
}

/** Host-owned install workflow. No provider command or Renderer package spec crosses this boundary. */
export class MarketInstallService {
  private readonly candidates = new Map<string, InstallCandidate>()
  private readonly intents = new Map<string, MarketIntent>()
  private readonly restartIntents = new Map<string, RestartIntent>()
  private readonly now: () => number
  private readonly intentTtlMs: number
  private readonly candidateTtlMs: number
  private readonly maxIntents: number
  private readonly maxCandidates: number
  private readonly disabledPackageNames: () => readonly string[]
  private readonly generation = new AbortController()
  private recoveryReconciliation: Promise<void> | undefined
  private operationActive = false
  private closed = false

  constructor(
    private readonly scope: SettingsScope<MarketSettingsDocument>,
    private readonly currentProfile: () => MarketDesktopProfile,
    private readonly pnpm: MarketDesktopPnpm,
    private readonly verifier: MarketNpmPackageVerifier,
    options: MarketInstallServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.intentTtlMs = options.intentTtlMs ?? INSTALL_INTENT_TTL_MS
    this.candidateTtlMs = options.candidateTtlMs ?? CANDIDATE_TTL_MS
    this.maxIntents = options.maxIntents ?? MAX_INTENTS
    this.maxCandidates = options.maxCandidates ?? MAX_CANDIDATES
    this.disabledPackageNames = options.disabledPackageNames ?? (() => [])
    for (const [label, value] of [
      ['intent TTL', this.intentTtlMs],
      ['candidate TTL', this.candidateTtlMs],
      ['intent limit', this.maxIntents],
      ['candidate limit', this.maxCandidates],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid market install ${label}`)
    }
  }

  observeCatalog(snapshot: CatalogSnapshot): void {
    if (this.closed) return
    this.purge()
    for (const item of snapshot.items) {
      const key = candidateKey(snapshot.source.sourceRecordId, item.id)
      this.candidates.delete(key)
      if (
        item.provenance.sourceRecordId !== snapshot.source.sourceRecordId
        || item.provenance.providerId !== snapshot.source.providerId
        || item.provenance.itemId !== item.id
        || item.package?.registry !== 'npm'
        || !safePackageName(item.package.name)
        || !marketManagedPackage(item.package.name)
        || !stableExactVersion(item.latestVersion)
        || item.repository === undefined
      ) {
        continue
      }
      let repository: NormalizedRepositoryIdentity
      try { repository = normalizeRepositoryIdentity(item.repository) }
      catch {
        continue
      }
      const candidate: InstallCandidate = {
        key,
        sourceRecordId: snapshot.source.sourceRecordId,
        providerId: snapshot.source.providerId,
        itemId: item.id,
        displayName: item.displayName,
        packageName: item.package.name,
        version: item.latestVersion,
        repository,
        savedAt: this.now(),
      }
      this.candidates.set(key, candidate)
      this.trim(this.candidates, this.maxCandidates)
    }
  }

  invalidateSource(sourceRecordId: string): void {
    for (const [key, candidate] of this.candidates) {
      if (candidate.sourceRecordId === sourceRecordId) {
        this.candidates.delete(key)
      }
    }
    for (const [token, intent] of this.intents) {
      if (intent.kind === 'install' && intent.candidate.sourceRecordId === sourceRecordId) this.intents.delete(token)
    }
  }

  async listReceipts(): Promise<readonly MarketInstallReceipt[]> {
    this.assertOpen()
    await this.ensureRecoveredInstallReconciled()
    const profile = this.profile()
    return this.receipts().filter(receipt => receipt.profileName === profile.name)
  }

  /** Receipts that still prove one exact installed bundle in the active profile. */
  async listVerifiedReceipts(signal: AbortSignal = this.generation.signal): Promise<readonly MarketInstallReceipt[]> {
    const operationSignal = this.operationSignal(signal)
    await this.ensureRecoveredInstallReconciled()
    operationSignal.throwIfAborted()
    const profile = this.profile()
    const receipts = this.receipts().filter(receipt => receipt.profileName === profile.name)
    if (receipts.length === 0) return []
    let snapshot: InstalledProfileSnapshot
    try { snapshot = await loadInstalledProfileSnapshot(profile) }
    catch {
      operationSignal.throwIfAborted()
      throw new MarketInstallError('operation-failed', 'The active desktop profile could not be verified.')
    }
    const verified: MarketInstallReceipt[] = []
    for (const receipt of receipts) {
      try {
        await assertInstalledBundleFromSnapshot(
          snapshot,
          receipt.packageName,
          receipt.version,
          receipt.bundlePatch,
          receipt.integrity,
        )
        operationSignal.throwIfAborted()
        verified.push(receipt)
      } catch {
        operationSignal.throwIfAborted()
      }
    }
    return verified
  }

  async listInstallable(
    index: CatalogFullIndex,
    signal: AbortSignal,
  ): Promise<MarketInstallableResponse> {
    const operationSignal = this.operationSignal(signal)
    operationSignal.throwIfAborted()
    this.purge()
    const currentKeys = new Set(index.snapshots.flatMap(snapshot => (
      snapshot.items.map(item => candidateKey(index.source.sourceRecordId, item.id))
    )))
    for (const [key, candidate] of this.candidates) {
      if (candidate.sourceRecordId === index.source.sourceRecordId && !currentKeys.has(key)) {
        this.candidates.delete(key)
      }
    }
    for (const snapshot of index.snapshots) this.observeCatalog(snapshot)
    operationSignal.throwIfAborted()
    const items = index.snapshots.flatMap(snapshot => snapshot.items).filter(item => {
      const candidate = this.candidates.get(candidateKey(index.source.sourceRecordId, item.id))
      return candidate !== undefined
        && candidate.providerId === item.provenance.providerId
    })
    return {
      source: index.source,
      items,
      manualInstall: manualInstallHints(items),
      metadata: {
        scannedAt: index.scannedAt,
        expiresAt: index.expiresAt,
        ...(index.providerRevision === undefined ? {} : { providerRevision: index.providerRevision }),
        cacheStatus: index.cacheStatus,
      },
    }
  }

  async previewInstall(
    sourceRecordId: string,
    itemId: string,
    signal: AbortSignal,
  ): Promise<MarketInstallPreview> {
    const operationSignal = this.operationSignal(signal)
    await this.ensureRecoveredInstallReconciled()
    operationSignal.throwIfAborted()
    this.purge()
    const key = candidateKey(sourceRecordId, itemId)
    const candidate = this.candidates.get(key)
    if (candidate === undefined) {
      throw new MarketInstallError('not-available', 'This catalog item has no verified install target. Refresh the active source and try again.')
    }
    if (this.disabledPackages().has(candidate.packageName)) {
      throw new MarketInstallError('conflict', 'This plugin is disabled in the active desktop profile.')
    }
    const profile = this.profile()
    this.assertNoReceipt(profile, candidate.packageName)
    await assertNotInstalled(profile, candidate.packageName)
    let verification: MarketNpmPackageVerification
    try { verification = await this.verifier.verify(candidate, operationSignal) }
    catch (cause) {
      operationSignal.throwIfAborted()
      throw cause
    }
    operationSignal.throwIfAborted()
    this.assertOpen()
    if (this.candidates.get(key) !== candidate) {
      throw new MarketInstallError('not-available', 'The catalog source changed during verification. Refresh it and try again.')
    }
    const token = this.issueIntent({
      kind: 'install',
      candidate,
      verification,
      profile,
      expiresAt: this.now() + this.intentTtlMs,
    })
    return {
      intent: token,
      action: 'install',
      profileName: profile.name,
      packageName: candidate.packageName,
      version: candidate.version,
      displayName: candidate.displayName,
      expiresAt: new Date(this.now() + this.intentTtlMs).toISOString(),
    }
  }

  async executeInstall(token: string, signal: AbortSignal): Promise<MarketInstallResult> {
    return await this.runExclusive(async () => {
      const operationSignal = this.operationSignal(signal)
      const intent = this.consumeIntent(token, 'install')
      const profile = this.sameProfile(intent.profile)
      const candidate = intent.candidate
      const disabledPackages = this.disabledPackages()
      if (disabledPackages.has(candidate.packageName)) {
        throw new MarketInstallError('conflict', 'This plugin is disabled in the active desktop profile.')
      }
      if (this.candidates.get(candidate.key) !== candidate) {
        throw new MarketInstallError('not-available', 'The verified catalog item is no longer available.')
      }
      this.assertNoReceipt(profile, candidate.packageName)
      await assertNotInstalled(profile, candidate.packageName)
      let verification: MarketNpmPackageVerification
      try { verification = await this.verifier.verify(candidate, operationSignal) }
      catch (cause) {
        operationSignal.throwIfAborted()
        throw cause
      }
      operationSignal.throwIfAborted()
      if (
        verification.integrity !== intent.verification.integrity
        || verification.bundlePatch !== intent.verification.bundlePatch
        || verification.tarball !== intent.verification.tarball
      ) {
        throw new MarketInstallError('verification-failed', 'The npm package changed after preview. Preview the install again.')
      }
      await assertNotInstalled(profile, candidate.packageName)
      if (this.candidates.get(candidate.key) !== candidate) {
        throw new MarketInstallError('not-available', 'The catalog source changed before installation.')
      }
      if (disabledPackages.has(candidate.packageName)) {
        throw new MarketInstallError('conflict', 'This plugin is disabled in the active desktop profile.')
      }
      const receipt: MarketInstallReceipt = {
        receiptId: randomUUID(),
        profileName: profile.name,
        packageName: candidate.packageName,
        version: candidate.version,
        integrity: verification.integrity,
        bundlePatch: verification.bundlePatch,
        sourceRecordId: candidate.sourceRecordId,
        providerId: candidate.providerId,
        itemId: candidate.itemId,
        displayName: candidate.displayName,
        installedAt: new Date(this.now()).toISOString(),
      }
      try {
        await this.runPlugin(
          this.installOptions(candidate.packageName),
          profile,
          operationSignal,
          true,
          {
            packageName: receipt.packageName,
            packageVersion: receipt.version,
            receiptId: receipt.receiptId,
          },
        )
      } catch (cause) {
        if (!await this.installMayHaveMutatedProfile(profile, candidate.packageName)) throw cause
        await this.rollbackInstall(profile, candidate.packageName, receipt.receiptId)
        throw new MarketInstallError(
          'operation-failed',
          'The package manager failed after changing the active profile, so the partial installation was rolled back.',
        )
      }
      try {
        await assertInstalledBundle(
          profile,
          candidate.packageName,
          candidate.version,
          verification.bundlePatch,
          verification.integrity,
        )
        operationSignal.throwIfAborted()
      } catch {
        await this.rollbackInstall(profile, candidate.packageName, receipt.receiptId)
        throw new MarketInstallError(
          'operation-failed',
          'The package manager finished, but the plugin bundle was invalid, so the installation was rolled back.',
        )
      }
      try {
        await this.saveReceipts([...this.receipts(), receipt])
      } catch {
        await this.rollbackInstall(profile, candidate.packageName, receipt.receiptId)
        throw new MarketInstallError('persistence-failed', 'The install receipt could not be saved, so the installation was rolled back.')
      }
      return { receipt }
    })
  }

  async executePreview(token: string, signal: AbortSignal): Promise<MarketOperationResult> {
    this.assertOpen()
    this.purge()
    const intent = this.intents.get(token)
    if (intent === undefined) {
      throw new MarketInstallError('intent-expired', 'The confirmation expired or was already used. Preview the operation again.')
    }
    const result: MarketOperationResult = intent.kind === 'install'
      ? { action: 'install', ...await this.executeInstall(token, signal), restartToken: this.issueRestartToken() }
      : { action: 'uninstall', ...await this.executeUninstall(token, signal), restartToken: this.issueRestartToken() }
    return result
  }

  /** Consume one short-lived restart grant issued only after a completed mutation. */
  consumeRestartToken(token: string): void {
    this.assertOpen()
    this.purge()
    const intent = this.restartIntents.get(token)
    if (intent === undefined) {
      throw new MarketInstallError('intent-expired', 'The restart confirmation expired or was already used.')
    }
    this.restartIntents.delete(token)
    this.sameProfile(intent.profile)
  }

  async previewUninstall(receiptId: string, signal: AbortSignal): Promise<MarketUninstallPreview> {
    const operationSignal = this.operationSignal(signal)
    await this.ensureRecoveredInstallReconciled()
    operationSignal.throwIfAborted()
    const profile = this.profile()
    const receipt = this.receipts().find(value => value.receiptId === receiptId && value.profileName === profile.name)
    if (receipt === undefined) {
      throw new MarketInstallError('not-available', 'This plugin is not owned by a market install receipt in the active profile.')
    }
    try {
      await assertInstalledBundle(profile, receipt.packageName, receipt.version, receipt.bundlePatch, receipt.integrity)
      operationSignal.throwIfAborted()
    }
    catch { throw new MarketInstallError('conflict', 'The installed plugin no longer matches its market receipt.') }
    const expiresAt = this.now() + this.intentTtlMs
    const token = this.issueIntent({ kind: 'uninstall', receipt, profile, expiresAt })
    return {
      intent: token,
      action: 'uninstall',
      profileName: profile.name,
      packageName: receipt.packageName,
      version: receipt.version,
      displayName: receipt.displayName,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  async executeUninstall(token: string, signal: AbortSignal): Promise<MarketUninstallResult> {
    return await this.runExclusive(async () => {
      const operationSignal = this.operationSignal(signal)
      const intent = this.consumeIntent(token, 'uninstall')
      const profile = this.sameProfile(intent.profile)
      const currentReceipt = this.receipts().find(receipt => receipt.receiptId === intent.receipt.receiptId)
      if (currentReceipt === undefined || JSON.stringify(currentReceipt) !== JSON.stringify(intent.receipt)) {
        throw new MarketInstallError('conflict', 'The market install receipt changed before uninstall.')
      }
      try {
        await assertInstalledBundle(
          profile,
          currentReceipt.packageName,
          currentReceipt.version,
          currentReceipt.bundlePatch,
          currentReceipt.integrity,
        )
        operationSignal.throwIfAborted()
      }
      catch { throw new MarketInstallError('conflict', 'The installed plugin no longer matches its market receipt.') }
      await this.runPlugin(['remove', currentReceipt.packageName], profile, operationSignal)
      try { await assertRemoved(profile, currentReceipt.packageName) }
      catch { throw new MarketInstallError('operation-failed', 'The package manager finished, but the plugin remains in the active profile.') }
      try {
        await this.saveReceipts(this.receipts().filter(receipt => receipt.receiptId !== currentReceipt.receiptId))
      } catch {
        throw new MarketInstallError('persistence-failed', 'The plugin was removed, but its market receipt could not be updated.')
      }
      return { receiptId: currentReceipt.receiptId, packageName: currentReceipt.packageName }
    })
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.generation.abort(new DOMException('Market install service was disposed', 'AbortError'))
    this.candidates.clear()
    this.intents.clear()
    this.restartIntents.clear()
  }

  private profile(): MarketDesktopProfile {
    const profile = this.currentProfile()
    if (!profile.name || !isAbsolute(profile.dir) || profile.dir.includes('\0')) {
      throw new MarketInstallError('operation-failed', 'The active desktop profile is unavailable.')
    }
    return Object.freeze({ name: profile.name, dir: resolve(profile.dir) })
  }

  private sameProfile(expected: MarketDesktopProfile): MarketDesktopProfile {
    const current = this.profile()
    if (current.name !== expected.name || current.dir !== expected.dir) {
      throw new MarketInstallError('conflict', 'The active desktop profile changed after preview.')
    }
    return current
  }

  private receipts(): readonly MarketInstallReceipt[] {
    const value = this.scope.get().installReceipts ?? []
    if (!Array.isArray(value) || value.length > MAX_RECEIPTS || !value.every(validReceipt)) {
      throw new MarketInstallError('persistence-failed', 'The market install receipt store is invalid.')
    }
    const ids = new Set(value.map(receipt => receipt.receiptId))
    const ownedPackages = new Set(value.map(receipt => `${receipt.profileName}\0${receipt.packageName}`))
    if (ids.size !== value.length || ownedPackages.size !== value.length) {
      throw new MarketInstallError('persistence-failed', 'The market install receipt store is invalid.')
    }
    return value
  }

  private assertNoReceipt(profile: MarketDesktopProfile, packageName: string): void {
    if (this.receipts().some(receipt => receipt.profileName === profile.name && receipt.packageName === packageName)) {
      throw new MarketInstallError('conflict', 'This plugin already has a market install receipt in the active profile.')
    }
  }

  private disabledPackages(): ReadonlySet<string> {
    let names: readonly string[]
    try { names = this.disabledPackageNames() }
    catch (cause) {
      if (cause instanceof MarketInstallError) throw cause
      throw new MarketInstallError('operation-failed', 'Desktop plugin policy state is unavailable.')
    }
    if (!Array.isArray(names) || names.length > 10_000 || !names.every(safePackageName)) {
      throw new MarketInstallError('operation-failed', 'Desktop plugin policy state is invalid.')
    }
    return new Set(names)
  }

  private async saveReceipts(receipts: readonly MarketInstallReceipt[]): Promise<void> {
    if (receipts.length > MAX_RECEIPTS || !receipts.every(validReceipt)) throw new Error('invalid receipts')
    await this.scope.update({ installReceipts: receipts })
  }

  private async ensureRecoveredInstallReconciled(): Promise<void> {
    const existing = this.recoveryReconciliation
    if (existing !== undefined) return await existing
    const operation = this.reconcileRecoveredInstall()
    this.recoveryReconciliation = operation
    try {
      await operation
    } catch (cause) {
      if (this.recoveryReconciliation === operation) this.recoveryReconciliation = undefined
      throw cause
    }
  }

  private async reconcileRecoveredInstall(): Promise<void> {
    const receiptIds = await this.pnpm.recoveredInstallReceiptIds()
    if (receiptIds.length === 0) return
    const uniqueIds = new Set(receiptIds)
    const current = this.receipts()
    const retained = current.filter(receipt => !uniqueIds.has(receipt.receiptId))
    if (retained.length !== current.length) await this.saveReceipts(retained)
    for (const receiptId of uniqueIds) await this.pnpm.acknowledgeRecoveredInstall(receiptId)
  }

  private issueIntent(intent: MarketIntent): string {
    this.assertOpen()
    this.purge()
    let token = opaqueToken()
    while (this.intents.has(token)) token = opaqueToken()
    this.intents.set(token, intent)
    this.trim(this.intents, this.maxIntents)
    return token
  }

  private issueRestartToken(): string {
    this.assertOpen()
    this.purge()
    let token = opaqueToken()
    while (this.restartIntents.has(token)) token = opaqueToken()
    this.restartIntents.set(token, {
      profile: this.profile(),
      expiresAt: this.now() + this.intentTtlMs,
    })
    this.trim(this.restartIntents, this.maxIntents)
    return token
  }

  private consumeIntent<K extends MarketIntent['kind']>(token: string, kind: K): Extract<MarketIntent, { kind: K }> {
    this.purge()
    const intent = this.intents.get(token)
    if (intent === undefined || intent.kind !== kind) {
      throw new MarketInstallError('intent-expired', 'The confirmation expired or was already used. Preview the operation again.')
    }
    this.intents.delete(token)
    return intent as Extract<MarketIntent, { kind: K }>
  }

  private purge(): void {
    const now = this.now()
    for (const [key, candidate] of this.candidates) {
      if (now - candidate.savedAt >= this.candidateTtlMs) {
        this.candidates.delete(key)
      }
    }
    for (const [token, intent] of this.intents) {
      if (now >= intent.expiresAt) this.intents.delete(token)
    }
    for (const [token, intent] of this.restartIntents) {
      if (now >= intent.expiresAt) this.restartIntents.delete(token)
    }
  }

  private trim<T>(map: Map<string, T>, limit: number): void {
    while (map.size > limit) {
      const oldest = map.keys().next().value as string | undefined
      if (oldest === undefined) return
      map.delete(oldest)
    }
  }

  private async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.assertOpen()
    if (this.operationActive) throw new MarketInstallError('conflict', 'Another market package operation is already running.')
    this.operationActive = true
    try {
      return await task()
    } finally {
      this.operationActive = false
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new MarketInstallError('operation-failed', 'The market install service is unavailable.')
  }

  private operationSignal(signal: AbortSignal): AbortSignal {
    signal.throwIfAborted()
    this.assertOpen()
    return AbortSignal.any([signal, this.generation.signal])
  }

  private async installMayHaveMutatedProfile(profile: MarketDesktopProfile, packageName: string): Promise<boolean> {
    try { return await profileHasPluginReference(profile, packageName) }
    catch { return true }
  }

  private async runPlugin(
    args: readonly string[],
    profile: MarketDesktopProfile,
    signal: AbortSignal,
    includeGeneration = true,
    installRecovery?: {
      readonly packageName: string
      readonly packageVersion: string
      readonly receiptId: string
    },
  ): Promise<void> {
    const combinedSignal = includeGeneration ? AbortSignal.any([signal, this.generation.signal]) : signal
    combinedSignal.throwIfAborted()
    let handle: MarketDesktopPnpmHandle
    try {
      handle = installRecovery === undefined
        ? this.pnpm.runPlugin(args, profile.dir, combinedSignal)
        : await this.pnpm.installPlugin({
            pnpmOptions: args,
            invokingDir: profile.dir,
            recovery: installRecovery,
            signal: combinedSignal,
          })
    }
    catch { throw new MarketInstallError('operation-failed', 'The desktop package manager could not start.') }
    handle.stdout.resume()
    handle.stderr.resume()
    const cancel = () => handle.cancel()
    combinedSignal.addEventListener('abort', cancel, { once: true })
    let outcome: MarketDesktopPnpmOutcome
    try { outcome = await handle.done }
    catch {
      combinedSignal.throwIfAborted()
      throw new MarketInstallError('operation-failed', 'The desktop package manager failed.')
    }
    finally { combinedSignal.removeEventListener('abort', cancel) }
    combinedSignal.throwIfAborted()
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      throw new MarketInstallError('operation-failed', 'The desktop package manager did not complete successfully.')
    }
  }

  private installOptions(packageName: string): readonly string[] {
    const scope = packageName.startsWith('@') ? packageName.split('/', 1)[0] : undefined
    return [
      '--save-exact',
      `--registry=${NPM_REGISTRY}`,
      ...(scope === undefined ? [] : [`--${scope}:registry=${NPM_REGISTRY}`]),
    ]
  }

  private async rollbackInstall(
    profile: MarketDesktopProfile,
    packageName: string,
    receiptId: string,
  ): Promise<void> {
    try {
      await this.pnpm.rollbackPluginInstall(receiptId)
      await assertRemoved(profile, packageName)
    } catch {
      throw new MarketInstallError(
        'persistence-failed',
        'The failed installation could not be restored safely. Use the saved recovery state before another plugin change.',
      )
    }
  }
}
