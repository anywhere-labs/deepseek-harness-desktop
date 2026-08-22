// src/degraded-mode.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const DEGRADED_VERSION = 1
const MAX_DEGRADED_BUNDLES = 1024

interface DegradedState { readonly version: number; readonly bundles: readonly string[] }

function parseDegradedState(text: string): DegradedState {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null) throw new Error('degraded state is not an object')
  const record = value as Record<string, unknown>
  if (record.version !== DEGRADED_VERSION) throw new Error(`unsupported degraded version: ${String(record.version)}`)
  if (!Array.isArray(record.bundles) || record.bundles.length > MAX_DEGRADED_BUNDLES) {
    throw new Error('degraded state bundles are invalid')
  }
  const bundles = record.bundles.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  )
  if (bundles.length !== record.bundles.length) throw new Error('degraded state contains a non-string bundle')
  return { version: DEGRADED_VERSION, bundles }
}

export function readDegradedBundles(statePath: string): readonly string[] {
  try {
    return parseDegradedState(readFileSync(statePath, 'utf8')).bundles
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
}

export function writeDegradedBundles(statePath: string, bundles: readonly string[]): void {
  mkdirSync(dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify({ version: DEGRADED_VERSION, bundles }, undefined, 2)}\n`, { mode: 0o600 })
  renameSync(temporaryPath, statePath)
}
