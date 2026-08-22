/** Persistent launcher selection for the process that owns the DSH Host. */

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

const BIN_NAME = 'dsh-plugin-desktop'
const STATE_VERSION = 1
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

/** Host locations supported by the desktop launcher. */
export type DesktopHostTargetMode = 'local' | 'wsl'

/** Persisted Host selection applied to the next immutable generation. */
export type DesktopHostTargetSelection =
  | Readonly<{ mode: 'local' }>
  | Readonly<{ mode: 'wsl', distribution: string }>

/** Renderer-safe discovery and selection state. */
export interface DesktopHostTargetView {
  /** Target backing the current Host generation. */
  readonly current: DesktopHostTargetSelection
  /** WSL distributions that can be selected for the next generation. */
  readonly distributions: readonly string[]
  /** Whether this native platform can launch a WSL Host. */
  readonly wslSupported: boolean
  /** Sanitized discovery problem, when WSL is not currently usable. */
  readonly problem?: string
}

interface DesktopHostTargetState {
  readonly version: typeof STATE_VERSION
  readonly target: DesktopHostTargetSelection
}

/** Exact request accepted by the private Host-target settings endpoint. */
export type DesktopHostTargetSelectRequest = DesktopHostTargetSelection

/** Resolve the private target-state filename below Electron userData. */
export function desktopHostTargetStatePath(userDataDir: string): string {
  return join(userDataDir, 'host-target', 'state.json')
}

/** Reject names that cannot safely be passed as one `wsl.exe --distribution` argument. */
export function assertWslDistributionName(value: string): string {
  if (
    value.length === 0
    || value.length > 128
    || value.trim() !== value
    || /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${BIN_NAME}: invalid WSL distribution name`)
  }
  return value
}

/** Validate an untrusted persisted or HTTP selection. */
export function parseDesktopHostTargetSelection(value: unknown): DesktopHostTargetSelection {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${BIN_NAME}: invalid desktop Host target`)
  }
  const record = value as { mode?: unknown, distribution?: unknown }
  if (record.mode === 'local' && record.distribution === undefined) {
    return Object.freeze({ mode: 'local' })
  }
  if (record.mode === 'wsl' && typeof record.distribution === 'string') {
    return Object.freeze({
      mode: 'wsl',
      distribution: assertWslDistributionName(record.distribution),
    })
  }
  throw new Error(`${BIN_NAME}: invalid desktop Host target`)
}

function unlinkOptional(filename: string): void {
  try {
    unlinkSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${BIN_NAME}: Host target state directory is not a real directory`)
  }
  chmodSync(directory, PRIVATE_DIRECTORY_MODE)
}

/** Read the persisted target, defaulting fail-safe to the in-process Host. */
export function readDesktopHostTarget(statePath: string): DesktopHostTargetSelection {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(statePath, 'utf8'))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ mode: 'local' })
    throw new Error(`${BIN_NAME}: failed to read desktop Host target`, { cause })
  }
  if (value === null || typeof value !== 'object') {
    throw new Error(`${BIN_NAME}: invalid desktop Host target state`)
  }
  const state = value as { version?: unknown, target?: unknown }
  if (state.version !== STATE_VERSION) {
    throw new Error(`${BIN_NAME}: unsupported desktop Host target state version`)
  }
  return parseDesktopHostTargetSelection(state.target)
}

/** Atomically persist one validated target with owner-only permissions. */
export function writeDesktopHostTarget(
  statePath: string,
  selection: DesktopHostTargetSelection,
): void {
  const target = parseDesktopHostTargetSelection(selection)
  const directory = dirname(statePath)
  ensurePrivateDirectory(directory)
  const temporary = join(directory, `.${basename(statePath)}.${process.pid}.${randomUUID()}.tmp`)
  const state: DesktopHostTargetState = { version: STATE_VERSION, target }
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    })
    chmodSync(temporary, PRIVATE_FILE_MODE)
    renameSync(temporary, statePath)
  } finally {
    unlinkOptional(temporary)
  }
}

/** Validate that a requested WSL target was returned by current discovery. */
export function validateDesktopHostTargetSelection(
  selection: DesktopHostTargetSelection,
  view: Pick<DesktopHostTargetView, 'wslSupported' | 'distributions'>,
): DesktopHostTargetSelection {
  const target = parseDesktopHostTargetSelection(selection)
  if (target.mode === 'local') return target
  if (!view.wslSupported) throw new Error(`${BIN_NAME}: WSL Host targets are unavailable on this platform`)
  if (!view.distributions.includes(target.distribution)) {
    throw new Error(`${BIN_NAME}: WSL distribution is not installed`)
  }
  return target
}
