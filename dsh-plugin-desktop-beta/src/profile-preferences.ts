/** Strict Desktop-owned preferences isolated to one DSH Profile. */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopMarketProvider } from './desktop-market.ts'
import type { DesktopNetworkExposure } from './desktop-network.ts'
import type { DesktopNotificationSettings } from './notifications.ts'
import type { DesktopShellMode } from './runtime.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const STATE_VERSION = 1
const STATE_ROOT_DIRECTORY = 'profile-preferences'
const STATE_FILENAME = 'state.json'
const STATE_DIRECTORY_MODE = 0o700
const STATE_FILE_MODE = 0o600
const MAX_STATE_BYTES = 4 * 1024
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const CHECK_POSIX_MODE = process.platform !== 'win32'

const SELECTION_KEYS = Object.freeze([
  'aaEnabled',
  'market',
  'mode',
  'networkExposure',
  'notifications',
  'openBrowser',
] as const)

const NOTIFICATION_KEYS = Object.freeze([
  'enabled',
  'notifyOnJobCompletion',
  'notifyOnJobFailure',
  'notifyOnScheduleCompletion',
  'notifyOnScheduleFailure',
  'notifyOnTurnCompletion',
  'notifyOnTurnFailure',
] as const)

const STATE_KEYS = Object.freeze([
  'aaEnabled',
  'market',
  'mode',
  'networkExposure',
  'notifications',
  'openBrowser',
  'profileHash',
  'recordedAt',
  'version',
] as const)

/** User choices that belong to one Profile rather than the Desktop installation. */
export interface DesktopProfilePreferences {
  readonly mode: DesktopShellMode
  readonly openBrowser: boolean
  readonly networkExposure: DesktopNetworkExposure
  readonly notifications: Readonly<DesktopNotificationSettings>
  readonly aaEnabled?: boolean
  readonly market: DesktopMarketProvider
}

/** Complete version-one state stored beneath the Electron user-data directory. */
export interface DesktopProfilePreferencesStateV1 extends DesktopProfilePreferences {
  readonly version: 1
  readonly profileHash: string
  readonly recordedAt: string
}

/** Project exactly the first-stage Profile fields from an effective settings view. */
export function desktopProfilePreferencesFromSettings(
  desktop: Pick<DesktopProfilePreferences, 'mode' | 'openBrowser' | 'networkExposure'>,
  notifications: Readonly<DesktopNotificationSettings>,
  market: DesktopMarketProvider,
  aaEnabled = false,
): DesktopProfilePreferences {
  return Object.freeze({
    mode: desktop.mode,
    openBrowser: desktop.openBrowser,
    networkExposure: desktop.networkExposure,
    notifications: Object.freeze({ ...notifications }),
    market,
    aaEnabled,
  })
}

type ErrorFactory = (message: string) => Error

function invalid(message: string): Error {
  return new Error(`${BIN_NAME}: invalid Desktop Profile preferences state: ${message}`)
}

function invalidUpdate(message: string): TypeError {
  return new TypeError(`${BIN_NAME}: invalid Desktop Profile preferences update: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(expected.includes('aaEnabled') ? { aaEnabled: false, ...value } : value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function assertAbsolutePath(label: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new TypeError(`${BIN_NAME}: ${label} must be an absolute path without NUL`)
  }
  return resolve(value)
}

function assertMode(value: unknown, error: ErrorFactory): DesktopShellMode {
  if (value === 'compatibility' || value === 'extended' || value === 'advanced') return value
  throw error('mode must be compatibility, extended, or advanced')
}

function assertExposure(value: unknown, error: ErrorFactory): DesktopNetworkExposure {
  if (value === 'loopback' || value === 'lan') return value
  throw error('networkExposure must be loopback or lan')
}

function assertMarket(value: unknown, error: ErrorFactory): DesktopMarketProvider {
  if (value === 'disabled' || value === 'community-market' || value === 'dsh-market') return value
  throw error('market must be disabled, community-market, or dsh-market')
}

function assertRecordedAt(value: unknown, error: ErrorFactory): string {
  if (typeof value !== 'string') throw error('recordedAt must be a canonical ISO timestamp')
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw error('recordedAt must be a canonical ISO timestamp')
  }
  return value
}

function normalizedNotifications(
  value: unknown,
  error: ErrorFactory,
): Readonly<DesktopNotificationSettings> {
  if (!isRecord(value) || !(hasExactKeys(value, NOTIFICATION_KEYS)
    || hasExactKeys(value, NOTIFICATION_KEYS.filter(key => key !== 'notifyOnScheduleCompletion' && key !== 'notifyOnScheduleFailure')))) {
    throw error('notifications must contain exactly the supported boolean fields')
  }
  if (NOTIFICATION_KEYS.some(key => value[key] !== undefined && typeof value[key] !== 'boolean')) {
    throw error('notification values must be booleans')
  }
  return Object.freeze({
    enabled: value.enabled as boolean,
    notifyOnTurnCompletion: value.notifyOnTurnCompletion as boolean,
    notifyOnTurnFailure: value.notifyOnTurnFailure as boolean,
    notifyOnJobCompletion: value.notifyOnJobCompletion as boolean,
    notifyOnJobFailure: value.notifyOnJobFailure as boolean,
    notifyOnScheduleCompletion: (value.notifyOnScheduleCompletion ?? true) as boolean,
    notifyOnScheduleFailure: (value.notifyOnScheduleFailure ?? true) as boolean,
  })
}

function normalizedPreferences(
  value: unknown,
  error: ErrorFactory,
): DesktopProfilePreferences {
  if (!isRecord(value) || !hasExactKeys(value, SELECTION_KEYS)) {
    throw error('preferences must contain exactly the supported fields')
  }
  if (value.aaEnabled !== undefined && typeof value.aaEnabled !== 'boolean') throw error('aaEnabled must be a boolean')
  const mode = assertMode(value.mode, error)
  if (typeof value.openBrowser !== 'boolean') throw error('openBrowser must be a boolean')
  const networkExposure = assertExposure(value.networkExposure, error)
  if (value.openBrowser && mode !== 'compatibility') {
    throw error('openBrowser requires compatibility mode')
  }
  if (networkExposure === 'lan' && !value.openBrowser) {
    throw error('LAN exposure requires openBrowser')
  }
  return Object.freeze({
    mode,
    openBrowser: value.openBrowser,
    networkExposure,
    notifications: normalizedNotifications(value.notifications, error),
    aaEnabled: value.aaEnabled === true,
    market: assertMarket(value.market, error),
  })
}

/** Stable Profile identity used only as a private user-data path component. */
export function desktopProfilePreferencesProfileHash(profileDir: string): string {
  const normalized = assertAbsolutePath('Profile preferences Profile directory', profileDir)
  return createHash('sha256').update(normalized).digest('hex')
}

/** Fixed state path for one Profile under one Electron user-data directory. */
export function desktopProfilePreferencesStatePath(userDataDir: string, profileDir: string): string {
  const userData = assertAbsolutePath('Profile preferences user-data directory', userDataDir)
  const profileHash = desktopProfilePreferencesProfileHash(profileDir)
  return join(userData, STATE_ROOT_DIRECTORY, profileHash, STATE_FILENAME)
}

function existingPathInfo(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
}

function assertPrivateDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw invalid(`state directory must be a real directory: ${path}`)
  }
  if (CHECK_POSIX_MODE && (info.mode & 0o777) !== STATE_DIRECTORY_MODE) {
    throw invalid(`state directory permissions must be ${STATE_DIRECTORY_MODE.toString(8)}`)
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: STATE_DIRECTORY_MODE })
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw invalid(`state directory must be a real directory: ${path}`)
  }
  if (CHECK_POSIX_MODE && (info.mode & 0o777) !== STATE_DIRECTORY_MODE) {
    chmodSync(path, STATE_DIRECTORY_MODE)
  }
}

function assertSafeStateTarget(path: string): void {
  const info = existingPathInfo(path)
  if (info === undefined) return
  if (!info.isFile() || info.isSymbolicLink()) throw invalid('state must be a regular file')
  if (info.size > MAX_STATE_BYTES) throw invalid(`state exceeds ${String(MAX_STATE_BYTES)} bytes`)
  if (CHECK_POSIX_MODE && (info.mode & 0o777) !== STATE_FILE_MODE) {
    throw invalid(`state permissions must be ${STATE_FILE_MODE.toString(8)}`)
  }
}

function readStateBytes(path: string): string | undefined {
  const pathInfo = existingPathInfo(path)
  if (pathInfo === undefined) return undefined
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw invalid('state must be a regular file')
  if (pathInfo.size > MAX_STATE_BYTES) throw invalid(`state exceeds ${String(MAX_STATE_BYTES)} bytes`)
  if (CHECK_POSIX_MODE && (pathInfo.mode & 0o777) !== STATE_FILE_MODE) {
    throw invalid(`state permissions must be ${STATE_FILE_MODE.toString(8)}`)
  }

  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const descriptorInfo = fstatSync(descriptor)
    if (!descriptorInfo.isFile() || descriptorInfo.size > MAX_STATE_BYTES) {
      throw invalid(`state must be a regular file within ${String(MAX_STATE_BYTES)} bytes`)
    }
    if (descriptorInfo.dev !== pathInfo.dev || descriptorInfo.ino !== pathInfo.ino) {
      throw invalid('state changed while it was being opened')
    }
    if (CHECK_POSIX_MODE && (descriptorInfo.mode & 0o777) !== STATE_FILE_MODE) {
      throw invalid(`state permissions must be ${STATE_FILE_MODE.toString(8)}`)
    }
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.byteLength) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.byteLength - bytesRead, null)
      if (count === 0) break
      bytesRead += count
    }
    if (bytesRead > MAX_STATE_BYTES) throw invalid(`state exceeds ${String(MAX_STATE_BYTES)} bytes`)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    } catch {
      throw invalid('state must contain valid UTF-8')
    }
  } finally {
    closeSync(descriptor)
  }
}

function parseState(text: string, expectedProfileHash: string): DesktopProfilePreferencesStateV1 {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw invalid('state must contain valid JSON')
  }
  if (!isRecord(value) || !hasExactKeys(value, STATE_KEYS)) {
    throw invalid('state must contain exactly the version-one fields')
  }
  if (value.version !== STATE_VERSION) throw invalid('state has an unsupported version')
  if (typeof value.profileHash !== 'string' || !HASH_PATTERN.test(value.profileHash)
    || value.profileHash !== expectedProfileHash) {
    throw invalid('state Profile identity does not match its path')
  }
  const preferences = normalizedPreferences({
    mode: value.mode,
    openBrowser: value.openBrowser,
    networkExposure: value.networkExposure,
    notifications: value.notifications,
    aaEnabled: value.aaEnabled,
    market: value.market,
  }, invalid)
  return Object.freeze({
    version: STATE_VERSION,
    profileHash: value.profileHash,
    ...preferences,
    recordedAt: assertRecordedAt(value.recordedAt, invalid),
  })
}

/** Read one Profile's preferences; absence is distinct from malformed existing state. */
export function readDesktopProfilePreferences(
  userDataDir: string,
  profileDir: string,
): DesktopProfilePreferencesStateV1 | undefined {
  const path = desktopProfilePreferencesStatePath(userDataDir, profileDir)
  const root = dirname(dirname(path))
  const profileRoot = dirname(path)
  if (existingPathInfo(root) === undefined) return undefined
  assertPrivateDirectory(root)
  if (existingPathInfo(profileRoot) === undefined) return undefined
  assertPrivateDirectory(profileRoot)
  const text = readStateBytes(path)
  if (text === undefined) return undefined
  return parseState(text, desktopProfilePreferencesProfileHash(profileDir))
}

/** Atomically replace one Profile's validated preferences. */
export async function writeDesktopProfilePreferences(
  userDataDir: string,
  profileDir: string,
  value: DesktopProfilePreferences,
  recordedAt: string = new Date().toISOString(),
): Promise<DesktopProfilePreferencesStateV1> {
  const path = desktopProfilePreferencesStatePath(userDataDir, profileDir)
  const profileHash = desktopProfilePreferencesProfileHash(profileDir)
  const preferences = normalizedPreferences(value, invalidUpdate)
  const canonicalRecordedAt = assertRecordedAt(recordedAt, invalidUpdate)
  ensurePrivateDirectory(dirname(dirname(path)))
  ensurePrivateDirectory(dirname(path))
  const state: DesktopProfilePreferencesStateV1 = Object.freeze({
    version: STATE_VERSION,
    profileHash,
    ...preferences,
    recordedAt: canonicalRecordedAt,
  })
  assertSafeStateTarget(path)
  const current = readStateBytes(path)
  if (current !== undefined) parseState(current, profileHash)
  await writeFileAtomic(path, `${JSON.stringify(state, undefined, 2)}\n`, {
    mode: STATE_FILE_MODE,
    dirMode: STATE_DIRECTORY_MODE,
  })
  if (CHECK_POSIX_MODE) chmodSync(path, STATE_FILE_MODE)
  return state
}

/** Clear one Profile's preferences without touching another Profile's state. */
export async function clearDesktopProfilePreferences(
  userDataDir: string,
  profileDir: string,
): Promise<void> {
  const path = desktopProfilePreferencesStatePath(userDataDir, profileDir)
  const root = dirname(dirname(path))
  const profileRoot = dirname(path)
  if (existingPathInfo(root) === undefined) return
  assertPrivateDirectory(root)
  if (existingPathInfo(profileRoot) === undefined) return
  assertPrivateDirectory(profileRoot)
  const info = existingPathInfo(path)
  if (info === undefined) return
  assertSafeStateTarget(path)
  unlinkSync(path)
}

export const desktopProfilePreferencesConstants = Object.freeze({
  version: STATE_VERSION,
  rootDirectory: STATE_ROOT_DIRECTORY,
  filename: STATE_FILENAME,
  maxBytes: MAX_STATE_BYTES,
  directoryMode: STATE_DIRECTORY_MODE,
  fileMode: STATE_FILE_MODE,
})
