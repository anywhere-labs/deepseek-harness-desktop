/** Fail-loud checks required before a signed and notarized macOS desktop release. */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEVELOPER_ID_PREFIX = 'Developer ID Application:'
const P12_DATA_PREFIX = 'data:application/x-pkcs12;base64,'

const RELEASE_VARIABLES = [
  'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_ID',
  'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID', 'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE', 'APPLE_TEAM_ID', 'CSC_IDENTITY_AUTO_DISCOVERY',
  'CSC_FOR_PULL_REQUEST', 'CSC_INSTALLER_KEY_PASSWORD', 'CSC_INSTALLER_LINK',
  'CSC_KEYCHAIN', 'CSC_KEY_PASSWORD', 'CSC_LINK', 'CSC_NAME', 'MACOS_SIGN_IDENTITY',
  'MAC_CERT_P12_BASE64',
] as const

type NotarizationCredentialSource = 'api-key' | 'apple-id' | 'keychain-profile'
type SigningCredentialSource = 'keychain' | 'p12'

/** Injectable process inputs for the macOS release preflight. */
export interface MacReleasePreflightOptions {
  /** Environment inherited by electron-builder. */
  readonly env: NodeJS.ProcessEnv
  /** Platform that will run electron-builder. */
  readonly platform: NodeJS.Platform
  /** Return the valid code-signing identities visible to the build process. */
  readonly listCodeSigningIdentities: () => string
}

/** Safe release facts confirmed by the preflight. */
export interface MacReleasePreflightResult {
  /** Developer ID Application identity that electron-builder may select. */
  readonly identity: string
  /** Credential mechanism that electron-builder will use for notarization. */
  readonly notarization: NotarizationCredentialSource
  /** Credential mechanism that electron-builder will use for signing. */
  readonly signing: SigningCredentialSource
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === '' ? undefined : value
}

function normalizeP12Base64(value: string): string {
  const compact = value.replaceAll(/\s/g, '')
  if (
    compact.length === 0
    || compact.length % 4 !== 0
    || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(compact)
  ) {
    throw new Error('MAC_CERT_P12_BASE64 must contain a valid Base64-encoded PKCS#12 file')
  }
  const decoded = Buffer.from(compact, 'base64')
  if (decoded.length === 0 || decoded[0] !== 0x30) {
    throw new Error('MAC_CERT_P12_BASE64 must contain a Base64-encoded PKCS#12 file')
  }
  return compact
}

function normalizeSigningIdentity(value: string): string {
  return value.replaceAll(/\\([ ()])/g, '$1')
}

function electronBuilderIdentity(identity: string): string {
  return identity.slice(DEVELOPER_ID_PREFIX.length).trim()
}

/**
 * Map the desktop release secret names to Electron Builder's signing variables.
 * @param env - Environment loaded by Node or inherited from the caller.
 * @returns A copy suitable for the Electron Builder subprocess.
 */
export function adaptMacReleaseEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const adapted = { ...env }
  const p12 = environmentValue(env, 'MAC_CERT_P12_BASE64')
  const identityValue = environmentValue(env, 'MACOS_SIGN_IDENTITY')
  const identity = identityValue === undefined ? undefined : normalizeSigningIdentity(identityValue)
  if (p12 === undefined && identity === undefined) return adapted
  if (p12 === undefined) throw new Error('Incomplete macOS signing credentials: missing MAC_CERT_P12_BASE64')
  if (identity === undefined) throw new Error('Incomplete macOS signing credentials: missing MACOS_SIGN_IDENTITY')
  if (environmentValue(env, 'CSC_KEY_PASSWORD') === undefined) {
    throw new Error('Incomplete macOS signing credentials: missing CSC_KEY_PASSWORD')
  }
  if (!identity.startsWith(DEVELOPER_ID_PREFIX)) {
    throw new Error('MACOS_SIGN_IDENTITY must select a Developer ID Application identity')
  }
  if (environmentValue(env, 'CSC_LINK') !== undefined) {
    throw new Error('Set MAC_CERT_P12_BASE64 or CSC_LINK for macOS signing, not both')
  }
  const configuredIdentity = environmentValue(env, 'CSC_NAME')
  const builderIdentity = electronBuilderIdentity(identity)
  if (
    configuredIdentity !== undefined
    && configuredIdentity !== identity
    && configuredIdentity !== builderIdentity
  ) {
    throw new Error('MACOS_SIGN_IDENTITY and CSC_NAME select different signing identities')
  }

  adapted.CSC_LINK = `${P12_DATA_PREFIX}${normalizeP12Base64(p12)}`
  adapted.CSC_NAME = builderIdentity
  delete adapted.MAC_CERT_P12_BASE64
  delete adapted.MACOS_SIGN_IDENTITY
  return adapted
}

/**
 * Remove signing and notarization credentials before running ordinary build checks.
 * @param env - Environment that may contain release credentials.
 * @returns A clone containing no recognized macOS release variables.
 */
export function withoutMacReleaseSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env }
  for (const name of RELEASE_VARIABLES) delete sanitized[name]
  return sanitized
}

function resolveCredentialGroup(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  source: NotarizationCredentialSource,
): NotarizationCredentialSource | undefined {
  const present = names.filter(name => environmentValue(env, name) !== undefined)
  if (present.length === 0) return undefined
  if (present.length !== names.length) {
    const missing = names.filter(name => !present.includes(name))
    throw new Error(`Incomplete macOS notarization credentials: missing ${missing.join(', ')}`)
  }
  return source
}

function resolveNotarizationCredentials(env: NodeJS.ProcessEnv): NotarizationCredentialSource {
  const appleId = resolveCredentialGroup(
    env,
    ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    'apple-id',
  )
  if (appleId !== undefined) return appleId

  const apiKey = resolveCredentialGroup(
    env,
    ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    'api-key',
  )
  if (apiKey !== undefined) return apiKey

  const keychainProfile = environmentValue(env, 'APPLE_KEYCHAIN_PROFILE')
  if (keychainProfile !== undefined) return 'keychain-profile'
  if (environmentValue(env, 'APPLE_KEYCHAIN') !== undefined) {
    throw new Error('Incomplete macOS notarization credentials: missing APPLE_KEYCHAIN_PROFILE')
  }
  throw new Error(
    'macOS notarization credentials are required: set APPLE_KEYCHAIN_PROFILE, the Apple ID trio, or the App Store Connect API key trio',
  )
}

function developerIdApplications(output: string): readonly string[] {
  return [...output.matchAll(/"(Developer ID Application:[^"]+)"/g)].map(match => match[1]!)
}

/**
 * Assert that macOS distribution signing and notarization cannot be skipped.
 * @param options - Process inputs and code-signing identity lookup.
 * @returns The non-secret release selections confirmed by the checks.
 */
export function assertMacReleaseReady(options: MacReleasePreflightOptions): MacReleasePreflightResult {
  if (options.platform !== 'darwin') {
    throw new Error('The signed macOS release must be built on macOS')
  }
  if (environmentValue(options.env, 'CSC_IDENTITY_AUTO_DISCOVERY') === 'false') {
    throw new Error('CSC_IDENTITY_AUTO_DISCOVERY=false would disable macOS release signing')
  }

  const configuredIdentity = environmentValue(options.env, 'CSC_NAME')
  if (configuredIdentity?.startsWith('Apple Development:') === true) {
    throw new Error('CSC_NAME must select a Developer ID Application identity for a macOS release')
  }
  if (configuredIdentity?.startsWith(DEVELOPER_ID_PREFIX) === true) {
    throw new Error('CSC_NAME must omit the Developer ID Application certificate-type prefix')
  }
  const cscLink = environmentValue(options.env, 'CSC_LINK')
  let identity: string
  let signing: SigningCredentialSource
  if (cscLink !== undefined) {
    if (environmentValue(options.env, 'CSC_KEY_PASSWORD') === undefined) {
      throw new Error('CSC_KEY_PASSWORD is required when CSC_LINK supplies a macOS signing certificate')
    }
    if (configuredIdentity === undefined) {
      throw new Error('CSC_NAME is required when CSC_LINK supplies a macOS signing certificate')
    }
    identity = `${DEVELOPER_ID_PREFIX} ${configuredIdentity}`
    signing = 'p12'
  } else {
    const identities = developerIdApplications(options.listCodeSigningIdentities())
    if (identities.length === 0) {
      throw new Error('A valid Developer ID Application certificate with its private key is required in the Keychain')
    }
    const matchedIdentity = configuredIdentity === undefined
      ? identities[0]!
      : identities.find(candidate => electronBuilderIdentity(candidate) === configuredIdentity)
    if (matchedIdentity === undefined) {
      throw new Error(`CSC_NAME does not match a valid Keychain identity: ${configuredIdentity}`)
    }
    identity = matchedIdentity
    signing = 'keychain'
  }

  return {
    identity,
    notarization: resolveNotarizationCredentials(options.env),
    signing,
  }
}

function listCodeSigningIdentities(env: NodeJS.ProcessEnv): string {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
    env,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`security find-identity exited with ${String(result.status)}`)
  }
  return result.stdout
}

function main(): void {
  try {
    const env = adaptMacReleaseEnvironment(process.env)
    const safeEnvironment = withoutMacReleaseSecrets(env)
    const result = assertMacReleaseReady({
      env,
      platform: process.platform,
      listCodeSigningIdentities: () => listCodeSigningIdentities(safeEnvironment),
    })
    console.log(
      `macOS release preflight passed: ${result.identity}; signing via ${result.signing}; notarization via ${result.notarization}`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) main()
