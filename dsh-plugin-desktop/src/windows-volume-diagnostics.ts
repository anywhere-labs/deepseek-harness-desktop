import { dirname, parse, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const REMOVABLE_DRIVE = 2
const FIXED_DRIVE = 3
const REMOTE_DRIVE = 4
const SUPPORTED_FILE_SYSTEMS = new Set(['NTFS', 'REFS'])

export interface WindowsVolumePath {
  readonly label: string
  readonly path: string
}

export interface WindowsVolumeInfo {
  readonly root: string
  readonly fileSystem: string
  readonly driveType: number
}

export interface WindowsVolumeConcern extends WindowsVolumePath {
  readonly root: string
  readonly fileSystem?: string
  readonly driveType?: number
  readonly reason: string
}

export type WindowsVolumeQuery = (path: string) => WindowsVolumeInfo

export type WindowsWorkspaceVolumeDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'confirm', readonly concern: WindowsVolumeConcern }
  | { readonly action: 'block', readonly concern: WindowsVolumeConcern }

function existingAncestor(path: string): string {
  let current = resolve(path)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

function volumeRoot(path: string): string {
  const root = parse(existingAncestor(path)).root
  return root.endsWith('\\') || root.endsWith('/') ? root : `${root}\\`
}

function readNullTerminated(value: string): string {
  const end = value.indexOf('\0')
  return (end === -1 ? value : value.slice(0, end)).trim()
}

let cachedQuery: WindowsVolumeQuery | undefined

export function windowsVolumeQuery(): WindowsVolumeQuery {
  cachedQuery ??= (() => {
    const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi').default
    const kernel32 = koffi.load('kernel32.dll')
    const getDriveTypeW = kernel32.func('uint32 __stdcall GetDriveTypeW(str16)')
    const getVolumeInformationW = kernel32.func(
      'int __stdcall GetVolumeInformationW(str16, _Out_ char16_t*, uint32, _Out_ uint32*, _Out_ uint32*, _Out_ uint32*, _Out_ char16_t*, uint32)',
    )
    return (path: string): WindowsVolumeInfo => {
      const root = volumeRoot(path)
      const volumeName = ['\0'.repeat(260)]
      const fileSystemName = ['\0'.repeat(260)]
      const serial = [0]
      const maxComponentLength = [0]
      const flags = [0]
      if (getVolumeInformationW(root, volumeName, 260, serial, maxComponentLength, flags, fileSystemName, 260) === 0) {
        throw new Error(`GetVolumeInformationW failed for ${root}`)
      }
      return {
        root,
        fileSystem: readNullTerminated(fileSystemName[0] as string).toUpperCase(),
        driveType: getDriveTypeW(root),
      }
    }
  })()
  return cachedQuery
}

function concernForPath(
  entry: WindowsVolumePath,
  query: WindowsVolumeQuery,
): WindowsVolumeConcern | undefined {
  let info: WindowsVolumeInfo
  try {
    info = query(entry.path)
  } catch (cause) {
    return {
      ...entry,
      root: volumeRoot(entry.path),
      reason: `could not inspect the Windows volume (${cause instanceof Error ? cause.message : String(cause)})`,
    }
  }

  if (!SUPPORTED_FILE_SYSTEMS.has(info.fileSystem)) {
    return {
      ...entry,
      ...info,
      reason: `${info.fileSystem} does not provide the NTFS-style ACL and junction behavior DSH Desktop relies on`,
    }
  }
  if (info.driveType === REMOVABLE_DRIVE) {
    return {
      ...entry,
      ...info,
      reason: 'removable drives can disconnect or expose limited ACL behavior during sandboxed commands and plugin installs',
    }
  }
  if (info.driveType === REMOTE_DRIVE) {
    return {
      ...entry,
      ...info,
      reason: 'network drives can reject local ACL, junction, or executable runtime operations',
    }
  }
  if (info.driveType !== FIXED_DRIVE) {
    return {
      ...entry,
      ...info,
      reason: `Windows drive type ${String(info.driveType)} is not a fixed local volume`,
    }
  }
  return undefined
}

export function diagnoseWindowsVolumes(
  platform: NodeJS.Platform,
  paths: readonly WindowsVolumePath[],
  query?: WindowsVolumeQuery,
): WindowsVolumeConcern[] {
  if (platform !== 'win32') return []
  const inspect = query ?? windowsVolumeQuery()
  const seen = new Set<string>()
  const concerns: WindowsVolumeConcern[] = []
  for (const entry of paths) {
    const key = `${entry.label}\0${resolve(entry.path).toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const concern = concernForPath(entry, inspect)
    if (concern !== undefined) concerns.push(concern)
  }
  return concerns
}

/** Decide whether one Windows workspace path is safe to persist. */
export function evaluateWindowsWorkspaceVolume(
  platform: NodeJS.Platform,
  path: string,
  query?: WindowsVolumeQuery,
): WindowsWorkspaceVolumeDecision {
  const concern = diagnoseWindowsVolumes(platform, [{ label: 'workspace', path }], query)[0]
  if (concern === undefined) return { action: 'allow' }
  if (
    concern.driveType === REMOVABLE_DRIVE
    && concern.fileSystem !== undefined
    && SUPPORTED_FILE_SYSTEMS.has(concern.fileSystem)
  ) {
    return { action: 'confirm', concern }
  }
  return { action: 'block', concern }
}

export function formatWindowsVolumeConcern(concern: WindowsVolumeConcern): string {
  const details = [
    `path=${concern.path}`,
    `root=${concern.root}`,
    concern.fileSystem === undefined ? undefined : `fs=${concern.fileSystem}`,
    concern.driveType === undefined ? undefined : `driveType=${String(concern.driveType)}`,
  ].filter((part): part is string => part !== undefined).join('; ')
  return `${concern.label}: ${concern.reason} (${details})`
}
