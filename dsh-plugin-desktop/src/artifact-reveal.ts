/** Validation, path resolution, and copy for produced-file native reveal. */

import { posix, win32 } from 'node:path'
import type { DesktopArtifactContextMenuRequest } from './artifact-context-menu-contract.ts'
import type { DesktopLocale, DesktopPlatform } from './runtime.ts'

const MAX_PATH_LENGTH = 32_768
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/
const WINDOWS_NAMESPACE_PATH = /^[\\/]{2}[?.][\\/]/
const WINDOWS_UNC_PREFIX = /^[\\/]{2}/
const WINDOWS_UNC_ABSOLUTE = /^[\\/]{2}(?![?.](?:[\\/]|$))[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)/

function pathApi(platform: DesktopPlatform): typeof posix {
  if (platform === 'win32') return win32
  if (platform === 'darwin') return posix
  throw new Error(`artifact reveal is unavailable on ${platform}`)
}

function requiredPath(value: unknown, field: 'cwd' | 'path'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`artifact ${field} must be a non-empty string`)
  }
  if (value.length > MAX_PATH_LENGTH) throw new Error(`artifact ${field} is too long`)
  if (value.includes('\0')) throw new Error(`artifact ${field} contains NUL`)
  return value
}

/** Node treats drive-less rooted Windows paths as absolute even though they still depend on a cwd drive. */
function isFullyQualifiedWindowsPath(value: string): boolean {
  return WINDOWS_DRIVE_ABSOLUTE.test(value) || WINDOWS_UNC_ABSOLUTE.test(value)
}

/**
 * Validate an untrusted IPC payload and resolve its produced path.
 * Absolute produced paths retain their own root; relative ones require the
 * session cwd and use the target platform's path grammar.
 */
export function resolveDesktopArtifactPath(
  value: unknown,
  platform: DesktopPlatform,
): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('artifact menu request must be an object')
  }
  const request = value as Partial<DesktopArtifactContextMenuRequest>
  const api = pathApi(platform)
  const artifactPath = requiredPath(request.path, 'path')
  if (platform === 'darwin' && api.isAbsolute(artifactPath)) return api.normalize(artifactPath)
  if (platform === 'win32') {
    if (WINDOWS_NAMESPACE_PATH.test(artifactPath)) {
      throw new Error('artifact path must not use a Windows device namespace')
    }
    if (isFullyQualifiedWindowsPath(artifactPath)) return api.normalize(artifactPath)
    if (WINDOWS_UNC_PREFIX.test(artifactPath)) {
      throw new Error('artifact path must be a complete UNC path')
    }
  }
  const cwd = requiredPath(request.cwd, 'cwd')
  if (platform === 'win32') {
    if (!isFullyQualifiedWindowsPath(cwd)) {
      throw new Error('artifact cwd must be a fully qualified Windows path')
    }
    if (WINDOWS_DRIVE_RELATIVE.test(artifactPath)) {
      throw new Error('artifact path must not be drive-relative')
    }
  } else if (!api.isAbsolute(cwd)) {
    throw new Error('artifact cwd must be absolute')
  }
  return api.resolve(cwd, artifactPath)
}

/** Native label and failure copy selected inside the trusted main process. */
export function desktopArtifactRevealCopy(
  platform: Extract<DesktopPlatform, 'darwin' | 'win32'>,
  locale: DesktopLocale,
): { label: string; title: string; message: string; confirm: string } {
  if (locale === 'zh') {
    return {
      label: platform === 'darwin' ? '在访达中显示' : '在文件资源管理器中显示',
      title: '无法显示文件',
      message: '文件不存在、已移动，或 DSH Desktop 无法访问它。',
      confirm: '好',
    }
  }
  return {
    label: platform === 'darwin' ? 'Reveal in Finder' : 'Show in File Explorer',
    title: 'Unable to Show File',
    message: 'The file no longer exists, was moved, or cannot be accessed by DSH Desktop.',
    confirm: 'OK',
  }
}
