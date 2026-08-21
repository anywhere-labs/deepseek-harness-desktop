/** Machine-level Desktop Market provider selection and fail-safe state. */

import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs'
import { isAbsolute, basename, dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const BIN_NAME = 'dsh-plugin-desktop'
const STATE_VERSION = 1
const STATE_DIRECTORY_NAME = 'desktop-market'
const STATE_FILENAME = 'state.json'
const STATE_DIRECTORY_MODE = 0o700
const STATE_FILE_MODE = 0o600
const MAX_STATE_BYTES = 4 * 1024

/** Market implementation selected for the next Desktop generation. */
export type DesktopMarketProvider = 'disabled' | 'community-market' | 'dsh-market'

/** Canonical Loader identities owned by the Desktop provider switch. */
export const DESKTOP_MARKET_IDENTITIES = Object.freeze({
  community: Object.freeze({
    provider: 'community-market' as const,
    rowId: 'community-market',
    packageName: 'dsh-community-market',
  }),
  dshMarket: Object.freeze({
    provider: 'dsh-market' as const,
    rowId: 'dsh-market',
    packageName: 'dshmarket',
  }),
})

/** Persisted machine-level provider selection. Effective state is derived at boot. */
export interface DesktopMarketStateV1 {
  readonly version: 1
  readonly requested: DesktopMarketProvider
  readonly legacyDefaulted: false
}

/** Immutable startup view. `effective` is initially the requested provider. */
export interface DesktopMarketSnapshot {
  readonly requested: DesktopMarketProvider
  readonly effective: DesktopMarketProvider
  readonly legacyDefaulted: boolean
}

const DEFAULT_SNAPSHOT: DesktopMarketSnapshot = Object.freeze({
  requested: 'disabled',
  effective: 'disabled',
  legacyDefaulted: true,
})

function snapshot(
  requested: DesktopMarketProvider,
  legacyDefaulted: boolean,
): DesktopMarketSnapshot {
  return Object.freeze({
    requested,
    effective: requested,
    legacyDefaulted,
  })
}

/** Preserve the explicit request while projecting a generation-local effective provider. */
export function desktopMarketSnapshotWithEffective(
  current: DesktopMarketSnapshot,
  effective: DesktopMarketProvider,
): DesktopMarketSnapshot {
  if (!isProvider(current.requested) || !isProvider(current.effective)
    || typeof current.legacyDefaulted !== 'boolean' || !isProvider(effective)) {
    throw new TypeError(`${BIN_NAME}: invalid Desktop Market snapshot`)
  }
  return Object.freeze({
    requested: current.requested,
    effective,
    legacyDefaulted: current.legacyDefaulted,
  })
}

function isProvider(value: unknown): value is DesktopMarketProvider {
  return value === 'disabled' || value === 'community-market' || value === 'dsh-market'
}

function invalidState(message: string): Error {
  return new Error(`${BIN_NAME}: invalid Desktop Market state: ${message}`)
}

/** Validate a user-data directory and return its fixed machine-level state path. */
export function desktopMarketStatePath(userDataDir: string): string {
  if (typeof userDataDir !== 'string' || !isAbsolute(userDataDir)
    || userDataDir.includes('\0') || userDataDir.length === 0) {
    throw new TypeError(`${BIN_NAME}: Desktop Market user-data directory must be an absolute path without NUL`)
  }
  return join(userDataDir, STATE_DIRECTORY_NAME, STATE_FILENAME)
}

/** Validate an exact state path before reading or writing it. */
export function assertDesktopMarketStatePath(statePath: string): void {
  if (typeof statePath !== 'string' || !isAbsolute(statePath)
    || statePath.includes('\0') || basename(statePath) !== STATE_FILENAME
    || basename(dirname(statePath)) !== STATE_DIRECTORY_NAME) {
    throw new TypeError(`${BIN_NAME}: Desktop Market state path must be <userData>/${STATE_DIRECTORY_NAME}/${STATE_FILENAME}`)
  }
}

/** Parse the strict version-one persisted state document. */
export function parseDesktopMarketState(value: unknown): DesktopMarketStateV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidState('root must be an object')
  }
  const object = value as Record<string, unknown>
  const keys = Object.keys(object).sort()
  if (keys.length !== 3 || keys[0] !== 'legacyDefaulted' || keys[1] !== 'requested' || keys[2] !== 'version') {
    throw invalidState('unexpected fields')
  }
  if (object.version !== STATE_VERSION) throw invalidState('unsupported version')
  if (!isProvider(object.requested)) throw invalidState('requested provider is invalid')
  if (object.legacyDefaulted !== false) throw invalidState('legacyDefaulted must be false')
  return Object.freeze({
    version: 1,
    requested: object.requested,
    legacyDefaulted: false,
  })
}

function readRawState(statePath: string): unknown {
  const pathInfo = lstatSync(statePath)
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw invalidState('state must be a regular file')
  }
  const descriptor = openSync(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > MAX_STATE_BYTES) {
      throw invalidState('state must be a regular file within the size limit')
    }
    return JSON.parse(readFileSync(descriptor, 'utf8')) as unknown
  } finally {
    closeSync(descriptor)
  }
}

/** Read the state without ever writing a migration or repair marker. */
export function readDesktopMarketState(statePath: string): DesktopMarketSnapshot {
  assertDesktopMarketStatePath(statePath)
  try {
    return snapshot(parseDesktopMarketState(readRawState(statePath)).requested, false)
  } catch {
    return DEFAULT_SNAPSHOT
  }
}

/** Read the state using the Electron user-data directory convention. */
export function readDesktopMarketStateForUserData(userDataDir: string): DesktopMarketSnapshot {
  return readDesktopMarketState(desktopMarketStatePath(userDataDir))
}

function assertRealStateDirectory(statePath: string): void {
  const directory = dirname(statePath)
  try {
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${BIN_NAME}: Desktop Market state directory must be a real directory`)
    }
    chmodSync(directory, STATE_DIRECTORY_MODE)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      mkdirSync(directory, { recursive: true, mode: STATE_DIRECTORY_MODE })
      const info = lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`${BIN_NAME}: Desktop Market state directory must be a real directory`)
      }
      chmodSync(directory, STATE_DIRECTORY_MODE)
      return
    }
    throw cause
  }
}

/** Persist an explicit provider choice with a locked, atomic replacement. */
export async function writeDesktopMarketSelection(
  statePath: string,
  provider: DesktopMarketProvider,
): Promise<DesktopMarketSnapshot> {
  assertDesktopMarketStatePath(statePath)
  if (!isProvider(provider)) throw new TypeError(`${BIN_NAME}: invalid Desktop Market provider`)
  assertRealStateDirectory(statePath)
  const state: DesktopMarketStateV1 = Object.freeze({
    version: 1,
    requested: provider,
    legacyDefaulted: false,
  })
  const rendered = `${JSON.stringify(state)}\n`
  await withFileLock(statePath, async () => {
    assertRealStateDirectory(statePath)
    await writeFileAtomic(statePath, rendered, {
      mode: STATE_FILE_MODE,
      dirMode: STATE_DIRECTORY_MODE,
    })
  })
  return snapshot(provider, false)
}

/** Persist an explicit provider choice using the fixed Electron user-data path. */
export async function selectDesktopMarketProvider(
  userDataDir: string,
  provider: DesktopMarketProvider,
): Promise<DesktopMarketSnapshot> {
  return writeDesktopMarketSelection(desktopMarketStatePath(userDataDir), provider)
}

export const desktopMarketStateConstants = Object.freeze({
  stateVersion: STATE_VERSION,
  stateDirectoryName: STATE_DIRECTORY_NAME,
  stateFilename: STATE_FILENAME,
  stateDirectoryMode: STATE_DIRECTORY_MODE,
  stateFileMode: STATE_FILE_MODE,
})
