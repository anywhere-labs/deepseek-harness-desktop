/** Integrity-checked package bundle used to provision the managed WSL Host. */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const BIN_NAME = 'dsh-plugin-desktop'
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const SOURCE_PATTERN = /^sources\/[a-z0-9@._+-]+\.tgz$/u
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

export const WSL_RUNTIME_BUNDLE_SCHEMA_VERSION = 1
export const WSL_RUNTIME_BUNDLE_DIRECTORY = 'wsl-runtime'
export const WSL_RUNTIME_BUNDLE_MANIFEST = 'manifest.json'
export const WSL_RUNTIME_PACKAGE_NAME = 'dsh-desktop-wsl-runtime'

export interface WslRuntimeBundleFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface WslRuntimeBundleManifest {
  readonly schemaVersion: typeof WSL_RUNTIME_BUNDLE_SCHEMA_VERSION
  readonly productVersion: string
  readonly packageCount: number
  readonly files: readonly WslRuntimeBundleFile[]
}

export interface WslRuntimeBundle {
  readonly root: string
  readonly manifest: WslRuntimeBundleManifest
  readonly manifestSha256: string
  readonly packageJsonPath: string
  readonly lockfilePath: string
}

function fail(message: string): never {
  throw new Error(`${BIN_NAME}: invalid WSL runtime bundle: ${message}`)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function fileStat(path: string, label: string): Stats {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not a regular file`)
    return stat
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith(`${BIN_NAME}:`)) throw cause
    fail(`${label} is unavailable`)
  }
}

function contained(root: string, child: string): boolean {
  const path = relative(root, child)
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function version(value: unknown, label: string): string {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) fail(`${label} is invalid`)
  return value
}

function parseFile(value: unknown): WslRuntimeBundleFile {
  const record = object(value, 'file record')
  const path = record.path
  const bytes = record.bytes
  const hash = record.sha256
  if (typeof path !== 'string'
    || (path !== 'package.json' && path !== 'package-lock.json' && !SOURCE_PATTERN.test(path))
    || path.includes('\\')) fail('file path is invalid')
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 1) fail(`file size is invalid for ${path}`)
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) fail(`file hash is invalid for ${path}`)
  return Object.freeze({ path, bytes: bytes as number, sha256: hash })
}

function parseManifest(value: unknown): WslRuntimeBundleManifest {
  const record = object(value, 'manifest')
  if (record.schemaVersion !== WSL_RUNTIME_BUNDLE_SCHEMA_VERSION) fail('manifest schema is unsupported')
  const productVersion = version(record.productVersion, 'product version')
  if (!Number.isSafeInteger(record.packageCount) || (record.packageCount as number) < 3) {
    fail('package count is invalid')
  }
  if (!Array.isArray(record.files) || record.files.length < 3 || record.files.length > 4096) {
    fail('file list is invalid')
  }
  const files = Object.freeze(record.files.map(parseFile))
  const paths = files.map(file => file.path)
  if (new Set(paths).size !== paths.length) fail('file paths are duplicated')
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort((left, right) => left.localeCompare(right, 'en')))) {
    fail('file paths are not sorted')
  }
  if (!paths.includes('package.json') || !paths.includes('package-lock.json')) {
    fail('package metadata is incomplete')
  }
  return Object.freeze({
    schemaVersion: WSL_RUNTIME_BUNDLE_SCHEMA_VERSION,
    productVersion,
    packageCount: record.packageCount as number,
    files,
  })
}

function validatePackageMetadata(
  packageJson: Buffer,
  lockfile: Buffer,
  manifest: WslRuntimeBundleManifest,
): void {
  let packageValue: unknown
  let lockValue: unknown
  try {
    packageValue = JSON.parse(packageJson.toString('utf8'))
    lockValue = JSON.parse(lockfile.toString('utf8'))
  } catch {
    fail('package metadata is not valid JSON')
  }
  const packageRecord = object(packageValue, 'package.json')
  const dependencies = object(packageRecord.dependencies, 'package dependencies')
  if (packageRecord.name !== WSL_RUNTIME_PACKAGE_NAME
    || packageRecord.version !== manifest.productVersion
    || packageRecord.private !== true) fail('package identity does not match the manifest')
  if (Object.keys(dependencies).length !== manifest.packageCount) fail('package count does not match package.json')
  const sources = new Set(manifest.files
    .map(file => file.path)
    .filter(path => path.startsWith('sources/')))
  const referencedSources = new Set<string>()
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (typeof specifier !== 'string' || specifier.length === 0) fail(`dependency specifier is invalid: ${name}`)
    if (specifier.startsWith('file:./')) {
      const source = specifier.slice('file:./'.length)
      if (!sources.has(source)) fail(`dependency source is not sealed by the manifest: ${name}`)
      referencedSources.add(source)
    }
  }
  if (referencedSources.size !== sources.size) fail('manifest contains an unreferenced package source')
  for (const required of ['dsh-plugin-desktop', 'dsh-community-market']) {
    const specifier = dependencies[required]
    if (typeof specifier !== 'string' || !specifier.startsWith('file:./sources/')) {
      fail(`${required} is not a bundled source`)
    }
  }
  const lockRecord = object(lockValue, 'package-lock.json')
  if (lockRecord.name !== WSL_RUNTIME_PACKAGE_NAME
    || lockRecord.version !== manifest.productVersion
    || !Number.isSafeInteger(lockRecord.lockfileVersion)
    || (lockRecord.lockfileVersion as number) < 3) fail('lockfile identity is invalid')
  const lockPackages = object(lockRecord.packages, 'lockfile packages')
  const lockRoot = object(lockPackages[''], 'lockfile root')
  const lockDependencies = object(lockRoot.dependencies, 'lockfile root dependencies')
  const sorted = (value: Record<string, unknown>): [string, unknown][] => Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
  if (JSON.stringify(sorted(lockDependencies)) !== JSON.stringify(sorted(dependencies))) {
    fail('lockfile dependencies do not match package.json')
  }
}

/** Hash one regular bundle file for manifest generation. */
export function describeWslRuntimeBundleFile(root: string, path: string): WslRuntimeBundleFile {
  const absoluteRoot = resolve(root)
  const absolutePath = resolve(absoluteRoot, path)
  if (!contained(absoluteRoot, absolutePath)) fail(`file escapes its root: ${path}`)
  const stat = fileStat(absolutePath, `bundle file ${path}`)
  if (stat.size < 1) fail(`file is empty: ${path}`)
  return Object.freeze({ path, bytes: stat.size, sha256: sha256(readFileSync(absolutePath)) })
}

/** Validate every byte named by a packaged WSL runtime manifest. */
export function verifyWslRuntimeBundle(root: string, expectedVersion?: string): WslRuntimeBundle {
  const absoluteRoot = resolve(root)
  const manifestPath = join(absoluteRoot, WSL_RUNTIME_BUNDLE_MANIFEST)
  const stat = fileStat(manifestPath, 'manifest')
  if (stat.size < 1 || stat.size > MAX_MANIFEST_BYTES) fail('manifest is not bounded')
  const manifestBytes = readFileSync(manifestPath)
  let value: unknown
  try {
    value = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    fail('manifest is not valid JSON')
  }
  const manifest = parseManifest(value)
  if (expectedVersion !== undefined && manifest.productVersion !== version(expectedVersion, 'expected version')) {
    fail(`product version ${manifest.productVersion} does not match ${expectedVersion}`)
  }
  const contents = new Map<string, Buffer>()
  for (const expected of manifest.files) {
    const absolutePath = resolve(absoluteRoot, expected.path)
    if (!contained(absoluteRoot, absolutePath)) fail(`file escapes its root: ${expected.path}`)
    const stat = fileStat(absolutePath, `bundle file ${expected.path}`)
    if (stat.size !== expected.bytes) fail(`file size changed: ${expected.path}`)
    const bytes = readFileSync(absolutePath)
    if (sha256(bytes) !== expected.sha256) fail(`file hash changed: ${expected.path}`)
    contents.set(expected.path, bytes)
  }
  const packageJson = contents.get('package.json')
  const lockfile = contents.get('package-lock.json')
  if (packageJson === undefined || lockfile === undefined) fail('package metadata is missing')
  validatePackageMetadata(packageJson, lockfile, manifest)
  return Object.freeze({
    root: absoluteRoot,
    manifest,
    manifestSha256: sha256(manifestBytes),
    packageJsonPath: join(absoluteRoot, 'package.json'),
    lockfilePath: join(absoluteRoot, 'package-lock.json'),
  })
}
