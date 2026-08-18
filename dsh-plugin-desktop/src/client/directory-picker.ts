import {
  DESKTOP_DIRECTORY_PICKER_PATH,
  type DesktopDirectoryPickerResponse,
} from '../directory-picker-contract.ts'

/** Window seam consumed by the patched upstream browse panel. */
export interface DesktopDirectoryPickerWindow {
  __DSH_DESKTOP_PICK_DIRECTORY__?: () => Promise<string | null>
}

type DirectoryPickerRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

function isResponse(value: unknown): value is DesktopDirectoryPickerResponse {
  if (typeof value !== 'object' || value === null || !('path' in value)) return false
  const path = (value as { path?: unknown }).path
  return path === null || typeof path === 'string'
}

/** Ask the desktop Host to open the platform folder chooser. */
export async function requestDesktopDirectory(
  request: DirectoryPickerRequest = window.fetch.bind(window),
): Promise<string | null> {
  const response = await request(DESKTOP_DIRECTORY_PICKER_PATH, {
    method: 'POST',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error('DSH Desktop could not open the system folder picker')
  const value: unknown = await response.json()
  if (!isResponse(value)) throw new Error('DSH Desktop received an invalid response from the system folder picker')
  return value.path
}

/** Publish the Windows-only picker bridge for the browse panel's icon action. */
export function installDesktopDirectoryPickerBridge(
  target: DesktopDirectoryPickerWindow = window as DesktopDirectoryPickerWindow,
  request: DirectoryPickerRequest = window.fetch.bind(window),
): () => void {
  const previous = target.__DSH_DESKTOP_PICK_DIRECTORY__
  const pick = async (): Promise<string | null> => await requestDesktopDirectory(request)
  target.__DSH_DESKTOP_PICK_DIRECTORY__ = pick
  return () => {
    if (target.__DSH_DESKTOP_PICK_DIRECTORY__ !== pick) return
    if (previous === undefined) delete target.__DSH_DESKTOP_PICK_DIRECTORY__
    else target.__DSH_DESKTOP_PICK_DIRECTORY__ = previous
  }
}
