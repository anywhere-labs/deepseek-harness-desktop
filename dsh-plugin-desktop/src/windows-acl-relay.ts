/** Internal environment protocol for the Windows ACL ConPTY relay. */

import { Buffer } from 'node:buffer'
import { win32 } from 'node:path'

export const WINDOWS_ACL_RELAY_PAYLOAD = 'DSH_DESKTOP_ACL_RELAY_V1'
export const WINDOWS_ACL_RELAY_ELECTRON = 'DSH_DESKTOP_ACL_ELECTRON'
export const WINDOWS_ACL_RELAY_TRAMPOLINE = 'DSH_DESKTOP_ACL_TRAMPOLINE'

const RELAY_KEYS = new Set([
  WINDOWS_ACL_RELAY_PAYLOAD,
  WINDOWS_ACL_RELAY_ELECTRON,
  WINDOWS_ACL_RELAY_TRAMPOLINE,
])
const BASE64URL = /^[A-Za-z0-9_-]+$/u
const FORBIDDEN_PATH_CHARACTERS = /[\0"\r\n]/u

/** Versioned argv payload passed outside cmd.exe's command text. */
export interface WindowsAclRelayPayload {
  version: 1
  runner: string
  args: string[]
}

function assertArg(value: unknown, label: string, allowEmpty = true): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.includes('\0')) {
    throw new Error(`desktop ACL relay ${label} must be ${allowEmpty ? 'a NUL-free string' : 'a non-empty NUL-free string'}`)
  }
}

/** Validate one executable path before exposing it to cmd.exe expansion. */
export function quotedWindowsRelayPath(path: string, label: string): string {
  if (!win32.isAbsolute(path) || FORBIDDEN_PATH_CHARACTERS.test(path)) {
    throw new Error(`desktop ACL relay ${label} must be an absolute Windows path without quotes or control characters`)
  }
  return `"${path}"`
}

/** Encode the exact upstream runner argv as canonical Base64URL JSON. */
export function encodeWindowsAclRelay(runner: string, args: readonly string[]): string {
  assertArg(runner, 'runner', false)
  args.forEach((arg, index) => { assertArg(arg, `argument ${index}`) })
  const payload: WindowsAclRelayPayload = { version: 1, runner, args: [...args] }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Decode and fail closed on any non-canonical or unexpected relay shape. */
export function decodeWindowsAclRelay(encoded: string): WindowsAclRelayPayload {
  if (encoded.length === 0 || !BASE64URL.test(encoded)) {
    throw new Error('desktop ACL relay payload is not canonical Base64URL')
  }
  const bytes = Buffer.from(encoded, 'base64url')
  if (bytes.toString('base64url') !== encoded) {
    throw new Error('desktop ACL relay payload is not canonical Base64URL')
  }
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('desktop ACL relay payload is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('desktop ACL relay payload must be an object')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'args,runner,version'
    || record.version !== 1
    || !Array.isArray(record.args)) {
    throw new Error('desktop ACL relay payload has an unsupported shape or version')
  }
  assertArg(record.runner, 'runner', false)
  record.args.forEach((arg, index) => { assertArg(arg, `argument ${index}`) })
  return { version: 1, runner: record.runner, args: [...record.args] }
}

/** Read one relay value with Windows' case-insensitive environment semantics. */
export function windowsAclRelayEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const normalized = name.toUpperCase()
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalized)?.[1]
}

/** Remove all relay-only values before importing the upstream runner. */
export function removeWindowsAclRelayEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (RELAY_KEYS.has(key.toUpperCase())) delete env[key]
  }
}
