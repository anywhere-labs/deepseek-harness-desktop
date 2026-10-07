import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { prerelease, valid } from 'semver'
import type {
  MarketCatalogMetadata,
  MarketInstallableResponse,
  MarketSourceView,
} from '../api-types.js'
import type { CatalogHttpClient } from '../contracts/types.js'
import {
  normalizeGitHubInstallSource,
  type CatalogSnapshot,
  type NormalizedGitHubInstallSource,
} from '../contracts/index.js'
import {
  createGitHubPackageVerifier,
  githubPackageTarget,
  type GitHubPackageVerification,
} from './github.js'
import { manualInstallHints } from './manual.js'

const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const NPM_REGISTRY = `${NPM_REGISTRY_ORIGIN}/`
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const MAX_MANIFEST_BYTES = 1024 * 1024
const INSTALL_INTENT_TTL_MS = 5 * 60 * 1000
const CANDIDATE_TTL_MS = 30 * 60 * 1000
const MAX_INTENTS = 256
const MAX_CANDIDATES = 10_000
const MAX_PNPM_STREAM_OUTPUT_BYTES = 32 * 1024
const MAX_FAILURE_CAUSE_LENGTH = 4 * 1024
const BLOCKED_PRODUCT_PACKAGES = new Set([
  'dsh-plugin-desktop',
  'dsh-plugin-desktop-beta',
  'dsh-desktop-next',
  'dsh-community-market',
])

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
  run(argv: readonly string[], signal?: AbortSignal): MarketDesktopPnpmHandle
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
  readonly version?: string
  readonly displayName: string
  readonly expiresAt: string
}

export interface MarketInstallResult {
  readonly packageName: string
  readonly version: string
}

export interface MarketUninstallResult {
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
  constructor(
    readonly code: MarketInstallErrorCode,
    message: string,
    readonly details?: string,
  ) {
    super(message)
    this.name = 'MarketInstallError'
  }
}

interface BoundedOutputCapture {
  read(): string
  stop(): void
}

function captureBoundedOutput(stream: Readable): BoundedOutputCapture {
  let output: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let truncated = false
  const onData = (chunk: string | Buffer) => {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (next.byteLength >= MAX_PNPM_STREAM_OUTPUT_BYTES) {
      output = next.subarray(next.byteLength - MAX_PNPM_STREAM_OUTPUT_BYTES)
      truncated = true
      return
    }
    if (output.byteLength + next.byteLength > MAX_PNPM_STREAM_OUTPUT_BYTES) {
      output = Buffer.concat([output, next]).subarray(-MAX_PNPM_STREAM_OUTPUT_BYTES)
      truncated = true
      return
    }
    output = Buffer.concat([output, next])
  }
  stream.on('data', onData)
  stream.resume()
  return {
    read() {
      const value = output.toString('utf8').trimEnd()
      if (!truncated) return value
      return `[earlier output truncated]\n${value}`
    },
    stop() { stream.off('data', onData) },
  }
}

function failureCause(cause: unknown): string | undefined {
  const value = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
  if (value.trim().length === 0) return undefined
  return value.length <= MAX_FAILURE_CAUSE_LENGTH
    ? value
    : `${value.slice(0, MAX_FAILURE_CAUSE_LENGTH)}\n[cause truncated]`
}

function packageManagerDetails(
  args: readonly string[],
  stdout: string,
  stderr: string,
  outcome?: MarketDesktopPnpmOutcome,
  cause?: unknown,
): string {
  const causeText = failureCause(cause)
  const sections = [
    `pnpm ${args.join(' ')}`,
    ...(outcome === undefined ? [] : [
      `exitCode: ${outcome.exitCode === null ? 'null' : outcome.exitCode}\nsignal: ${outcome.signal ?? 'none'}`,
    ]),
    ...(causeText === undefined ? [] : [`cause:\n${causeText}`]),
    ...(stdout === '' ? [] : [`stdout:\n${stdout}`]),
    ...(stderr === '' ? [] : [`stderr:\n${stderr}`]),
  ]
  return sections.join('\n\n')
}

interface InstallCandidate {
  readonly key: string
  readonly sourceRecordId: string
  readonly providerId: string
  readonly itemId: string
  readonly displayName: string
  readonly packageName?: string
  readonly source?: NormalizedGitHubInstallSource
  readonly savedAt: number
}

interface InstallIntent {
  readonly kind: 'install'
  readonly candidate: InstallCandidate
  readonly verification: MarketPackageVerification
  readonly profile: MarketDesktopProfile
  readonly expiresAt: number
}

interface UninstallIntent {
  readonly kind: 'uninstall'
  readonly packageName: string
  readonly displayName: string
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
    candidate: Pick<InstallCandidate, 'packageName'>,
    signal: AbortSignal,
  ): Promise<MarketNpmPackageVerification>
}

export interface MarketNpmPackageVerification {
  readonly version: string
}

export interface MarketPackageVerification extends MarketNpmPackageVerification {
  readonly packageName?: string
  readonly source?: NormalizedGitHubInstallSource
}

export interface MarketInstallCandidateInput {
  readonly packageName?: string
  readonly source?: NormalizedGitHubInstallSource
}

export interface MarketPackageVerifier {
  verify(candidate: MarketInstallCandidateInput, signal: AbortSignal): Promise<MarketPackageVerification>
}

export interface MarketInstallServiceOptions {
  readonly now?: () => number
  readonly intentTtlMs?: number
  readonly candidateTtlMs?: number
  readonly maxIntents?: number
  readonly maxCandidates?: number
  /** Receives bounded package-manager failures for the Desktop persistent log. */
  readonly logFailure?: (message: string) => void
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

function safeBundlePatch(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) return false
  const path = value.startsWith('./') ? value.slice(2) : value
  return path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'))
}

/** Resolve npm `latest` and confirm only the minimum DSH package shape. */
export function createNpmRegistryVerifier(http: CatalogHttpClient): MarketNpmPackageVerifier {
  return {
    async verify(candidate, signal) {
      if (
        !safePackageName(candidate.packageName)
        || !marketManagedPackage(candidate.packageName)
      ) {
        throw new MarketInstallError('verification-failed', 'The plugin package target is invalid.')
      }
      const url = `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(candidate.packageName)}/latest`
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
      if (manifest.name !== candidate.packageName || !stableExactVersion(manifest.version)) {
        throw new MarketInstallError('verification-failed', 'The npm package identity did not match the catalog.')
      }
      const dsh = manifest.dsh
      const bundle = dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh)
        ? (dsh as Record<string, unknown>).bundle
        : undefined
      const patch = bundle !== null && typeof bundle === 'object' && !Array.isArray(bundle)
        ? (bundle as Record<string, unknown>).patch
        : undefined
      if (!safeBundlePatch(patch)) {
        throw new MarketInstallError('verification-failed', 'The npm package does not declare a valid DSH bundle.')
      }
      return { version: manifest.version }
    },
  }
}

/** Combine the stable npm verifier and the pinned GitHub manifest verifier. */
export function createMarketPackageVerifier(
  http: CatalogHttpClient,
): MarketPackageVerifier {
  const npm = createNpmRegistryVerifier(http)
  return {
    async verify(candidate, signal) {
      if (candidate.source !== undefined) {
        try {
          const verification: GitHubPackageVerification = await createGitHubPackageVerifier(http)
            .verify(candidate.source, signal)
          return verification
        } catch (cause) {
          signal.throwIfAborted()
          throw new MarketInstallError(
            'verification-failed',
            cause instanceof Error ? cause.message : 'The GitHub package could not be verified.',
          )
        }
      }
      if (candidate.packageName === undefined) {
        throw new MarketInstallError('verification-failed', 'The plugin install source is incomplete.')
      }
      return await npm.verify({ packageName: candidate.packageName }, signal)
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

/** Atomically update only the Profile bundle list after pnpm changes dependencies. */
async function setProfileBundle(
  profile: MarketDesktopProfile,
  packageName: string,
  present: boolean,
): Promise<void> {
  const manifestPath = join(profile.dir, 'package.json')
  const item = await lstat(manifestPath)
  if (!item.isFile() || item.isSymbolicLink()) throw new Error('unsafe profile manifest')
  const manifest = await readManifest(manifestPath) as UnknownRecord
  const dsh = record(manifest.dsh) ?? {}
  const profileDocument = record(dsh.profile) ?? {}
  const current = profileBundles(manifest)
  const bundles = present
    ? current.includes(packageName) ? [...current] : [...current, packageName]
    : current.filter(bundle => bundle !== packageName)
  const next = {
    ...manifest,
    dsh: {
      ...dsh,
      profile: {
        ...profileDocument,
        bundles,
      },
    },
  }
  const temporary = join(profile.dir, `.package.json.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(next, undefined, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: item.mode & 0o777,
    })
    await rename(temporary, manifestPath)
  } finally {
    await unlink(temporary).catch(cause => {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    })
  }
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

async function directProfilePluginVersion(
  profile: MarketDesktopProfile,
  packageName: string,
): Promise<string> {
  const manifest = await readManifest(join(profile.dir, 'package.json'))
  const version = profileDependency(manifest, packageName)
  if (version === undefined || !profileBundles(manifest).includes(packageName)) {
    throw new MarketInstallError('conflict', 'This plugin is no longer a direct dependency of the active Profile.')
  }
  return version
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
  private readonly logFailure: ((message: string) => void) | undefined
  private readonly generation = new AbortController()
  private operationActive = false
  private closed = false

  constructor(
    private readonly currentProfile: () => MarketDesktopProfile,
    private readonly pnpm: MarketDesktopPnpm,
    private readonly verifier: MarketPackageVerifier,
    options: MarketInstallServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.intentTtlMs = options.intentTtlMs ?? INSTALL_INTENT_TTL_MS
    this.candidateTtlMs = options.candidateTtlMs ?? CANDIDATE_TTL_MS
    this.maxIntents = options.maxIntents ?? MAX_INTENTS
    this.maxCandidates = options.maxCandidates ?? MAX_CANDIDATES
    this.logFailure = options.logFailure
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
      let source: NormalizedGitHubInstallSource | undefined
      if (item.installSource !== undefined) {
        try { source = normalizeGitHubInstallSource(item.repository, item.installSource) }
        catch { continue }
      }
      const packageName = source === undefined && item.package?.registry === 'npm' && safePackageName(item.package.name)
        ? item.package.name
        : undefined
      if (
        item.provenance.sourceRecordId !== snapshot.source.sourceRecordId
        || item.provenance.providerId !== snapshot.source.providerId
        || item.provenance.itemId !== item.id
        || (packageName === undefined && source === undefined)
        || (packageName !== undefined && !marketManagedPackage(packageName))
      ) {
        continue
      }
      const candidate: InstallCandidate = {
        key,
        sourceRecordId: snapshot.source.sourceRecordId,
        providerId: snapshot.source.providerId,
        itemId: item.id,
        displayName: item.displayName,
        ...(packageName === undefined ? {} : { packageName }),
        ...(source === undefined ? {} : { source }),
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

  listInstallablePage(
    source: MarketSourceView,
    snapshot: CatalogSnapshot,
    categories: readonly string[],
    signal: AbortSignal,
    metadata?: MarketCatalogMetadata,
  ): MarketInstallableResponse {
    const operationSignal = this.operationSignal(signal)
    operationSignal.throwIfAborted()
    this.purge()
    this.observeCatalog(snapshot)
    const items = snapshot.items.filter(item => {
      const candidate = this.candidates.get(candidateKey(source.sourceRecordId, item.id))
      return candidate !== undefined
        && candidate.providerId === item.provenance.providerId
    })
    operationSignal.throwIfAborted()
    return {
      source,
      items,
      categories,
      manualInstall: manualInstallHints(items),
      ...(snapshot.page.nextCursor === undefined ? {} : { nextCursor: snapshot.page.nextCursor }),
      ...(metadata === undefined ? {} : { metadata }),
      fetchedAt: new Date(this.now()).toISOString(),
    }
  }

  async previewInstall(
    sourceRecordId: string,
    itemId: string,
    signal: AbortSignal,
  ): Promise<MarketInstallPreview> {
    const operationSignal = this.operationSignal(signal)
    operationSignal.throwIfAborted()
    this.purge()
    const key = candidateKey(sourceRecordId, itemId)
    const candidate = this.candidates.get(key)
    if (candidate === undefined) {
      throw new MarketInstallError('not-available', 'This catalog item has no verified install target. Refresh the active source and try again.')
    }
    const profile = this.profile()
    if (candidate.packageName !== undefined) await assertNotInstalled(profile, candidate.packageName)
    let verification: MarketPackageVerification
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
    const packageName = verification.packageName ?? candidate.packageName
    if (packageName === undefined || !safePackageName(packageName)) {
      throw new MarketInstallError('verification-failed', 'The verified package name is invalid.')
    }
    await assertNotInstalled(profile, packageName)
    return {
      intent: token,
      action: 'install',
      profileName: profile.name,
      packageName,
      version: verification.version,
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
      if (this.candidates.get(candidate.key) !== candidate) {
        throw new MarketInstallError('not-available', 'The verified catalog item is no longer available.')
      }
      const verification = intent.verification
      const packageName = verification.packageName ?? candidate.packageName
      if (packageName === undefined || !safePackageName(packageName)) {
        throw new MarketInstallError('verification-failed', 'The verified package name is invalid.')
      }
      await assertNotInstalled(profile, packageName)
      if (this.candidates.get(candidate.key) !== candidate) {
        throw new MarketInstallError('not-available', 'The catalog source changed before installation.')
      }
      const target = candidate.source === undefined
        ? `${packageName}@${verification.version}`
        : githubPackageTarget(candidate.source)
      await this.runPnpm([
        'add',
        ...(candidate.source === undefined ? this.installOptions(packageName) : ['--save-exact']),
        target,
      ], operationSignal)
      try {
        await setProfileBundle(profile, packageName, true)
        const installedVersion = await directProfilePluginVersion(profile, packageName)
        // Registry installs land an exact semver; GitHub installs land the pinned
        // git spec pnpm saves verbatim (github:owner/repo#commit[&path:/sub]) —
        // comparing that against the repo's semver always threw, reporting every
        // successful GitHub install as operation-failed after the Profile was
        // already mutated.
        const expectedVersion = candidate.source === undefined
          ? verification.version
          : githubPackageTarget(candidate.source)
        if (installedVersion !== expectedVersion) throw new Error('installed version mismatch')
        operationSignal.throwIfAborted()
      } catch {
        throw new MarketInstallError(
          'operation-failed',
          'The package manager changed the Profile, but the plugin bundle could not be validated. Use a Recovery checkpoint if you need to restore the previous Profile state.',
        )
      }
      return { packageName, version: verification.version }
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

  async previewUninstallPackage(packageName: string, signal: AbortSignal): Promise<MarketUninstallPreview> {
    const operationSignal = this.operationSignal(signal)
    operationSignal.throwIfAborted()
    if (!safePackageName(packageName) || !marketManagedPackage(packageName)) {
      throw new MarketInstallError('invalid-request', 'The Profile plugin package name is invalid.')
    }
    const profile = this.profile()
    const version = await directProfilePluginVersion(profile, packageName)
    operationSignal.throwIfAborted()
    const expiresAt = this.now() + this.intentTtlMs
    const token = this.issueIntent({
      kind: 'uninstall',
      packageName,
      displayName: packageName,
      profile,
      expiresAt,
    })
    return {
      intent: token,
      action: 'uninstall',
      profileName: profile.name,
      packageName,
      version,
      displayName: packageName,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  async executeUninstall(token: string, signal: AbortSignal): Promise<MarketUninstallResult> {
    return await this.runExclusive(async () => {
      const operationSignal = this.operationSignal(signal)
      const intent = this.consumeIntent(token, 'uninstall')
      const profile = this.sameProfile(intent.profile)
      await directProfilePluginVersion(profile, intent.packageName)
      operationSignal.throwIfAborted()
      await this.runPnpm(['remove', intent.packageName], operationSignal)
      try { await setProfileBundle(profile, intent.packageName, false) }
      catch {
        throw new MarketInstallError(
          'operation-failed',
          'The package was removed, but the Profile bundle list could not be updated. Use a Recovery checkpoint to restore a consistent Profile state.',
        )
      }
      try { await assertRemoved(profile, intent.packageName) }
      catch { throw new MarketInstallError('operation-failed', 'The package manager finished, but the plugin remains in the active profile.') }
      return { packageName: intent.packageName }
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

  private async runPnpm(args: readonly string[], signal: AbortSignal): Promise<void> {
    const combinedSignal = AbortSignal.any([signal, this.generation.signal])
    combinedSignal.throwIfAborted()
    let handle: MarketDesktopPnpmHandle
    try { handle = this.pnpm.run(args, combinedSignal) }
    catch (cause) {
      const details = packageManagerDetails(args, '', '', undefined, cause)
      throw this.packageManagerError('The desktop package manager could not start.', details)
    }
    const stdout = captureBoundedOutput(handle.stdout)
    const stderr = captureBoundedOutput(handle.stderr)
    const cancel = () => handle.cancel()
    combinedSignal.addEventListener('abort', cancel, { once: true })
    let outcome: MarketDesktopPnpmOutcome
    try {
      try { outcome = await handle.done }
      catch (cause) {
        combinedSignal.throwIfAborted()
        const details = packageManagerDetails(args, stdout.read(), stderr.read(), undefined, cause)
        throw this.packageManagerError('The desktop package manager failed.', details)
      }
      combinedSignal.throwIfAborted()
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        const details = packageManagerDetails(args, stdout.read(), stderr.read(), outcome)
        throw this.packageManagerError('The desktop package manager did not complete successfully.', details)
      }
    } finally {
      combinedSignal.removeEventListener('abort', cancel)
      stdout.stop()
      stderr.stop()
    }
  }

  private packageManagerError(message: string, details: string): MarketInstallError {
    try { this.logFailure?.(`dsh-community-market: ${message}\n${details}`) } catch {}
    return new MarketInstallError('operation-failed', message, details)
  }

  private installOptions(packageName: string): readonly string[] {
    const scope = packageName.startsWith('@') ? packageName.split('/', 1)[0] : undefined
    return [
      '--save-exact',
      `--registry=${NPM_REGISTRY}`,
      ...(scope === undefined ? [] : [`--${scope}:registry=${NPM_REGISTRY}`]),
    ]
  }

}
