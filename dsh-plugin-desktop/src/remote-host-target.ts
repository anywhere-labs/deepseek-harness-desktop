/** Validation for launcher Host-target state crossing the WSL control channel. */

import {
  assertWslDistributionName,
  parseDesktopHostTargetSelection,
  type DesktopHostTargetView,
} from './host-target.ts'

const BIN_NAME = 'dsh-plugin-desktop'

export function parseRemoteHostTargetView(value: unknown): DesktopHostTargetView {
  if (value === null || typeof value !== 'object') throw new Error(`${BIN_NAME}: invalid native Host target`)
  const record = value as { current?: unknown, distributions?: unknown, wslSupported?: unknown, problem?: unknown }
  if (!Array.isArray(record.distributions)
    || record.distributions.some(item => typeof item !== 'string' || item.length === 0 || item.length > 128)
    || typeof record.wslSupported !== 'boolean'
    || (record.problem !== undefined && (typeof record.problem !== 'string' || record.problem.length > 4096))) {
    throw new Error(`${BIN_NAME}: invalid native Host target`)
  }
  let distributions: string[]
  try {
    distributions = record.distributions.map(item => assertWslDistributionName(item as string))
  } catch {
    throw new Error(`${BIN_NAME}: invalid native Host target`)
  }
  if (new Set(distributions).size !== distributions.length
    || (!record.wslSupported && distributions.length > 0)) {
    throw new Error(`${BIN_NAME}: invalid native Host target`)
  }
  return Object.freeze({
    current: parseDesktopHostTargetSelection(record.current),
    distributions: Object.freeze(distributions),
    wslSupported: record.wslSupported,
    ...(record.problem === undefined ? {} : { problem: record.problem }),
  })
}
