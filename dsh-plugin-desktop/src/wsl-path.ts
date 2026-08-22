/** Lossless path conversion at the selected WSL distribution boundary. */

import { normalize } from 'node:path/posix'
import { assertWslDistributionName } from './host-target.ts'

const BIN_NAME = 'dsh-plugin-desktop'

function uncSafeDistribution(value: string): string {
  const name = assertWslDistributionName(value)
  if (/[\\/:*?"<>|]/u.test(name)) {
    throw new Error(`${BIN_NAME}: WSL distribution cannot be represented as a UNC path`)
  }
  return name
}

/** Convert one absolute Linux path into the selected distribution's stable UNC share. */
export function wslPathToWindowsUnc(distribution: string, path: string): string {
  const name = uncSafeDistribution(distribution)
  if (!path.startsWith('/') || path.includes('\0') || /[\r\n]/u.test(path)) {
    throw new Error(`${BIN_NAME}: WSL path must be absolute`)
  }
  const normalized = normalize(path)
  const suffix = normalized === '/' ? '' : normalized.slice(1).replaceAll('/', '\\')
  return `\\\\wsl.localhost\\${name}${suffix.length === 0 ? '' : `\\${suffix}`}`
}

/**
 * Accept a Windows chooser result only when it belongs to the selected distro.
 * Both current `wsl.localhost` and legacy `wsl$` shares are understood.
 */
export function windowsUncToWslPath(distribution: string, path: string): string | undefined {
  const name = uncSafeDistribution(distribution)
  if (path.includes('\0') || /[\r\n]/u.test(path)) return undefined
  const normalized = path.replaceAll('/', '\\')
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/iu.exec(normalized)
  if (match === null || match[1]?.toLowerCase() !== name.toLowerCase()) return undefined
  const components = (match[2] ?? '').split('\\').filter(component => component.length > 0)
  if (components.some(component => component === '.' || component === '..')) return undefined
  return components.length === 0 ? '/' : `/${components.join('/')}`
}
