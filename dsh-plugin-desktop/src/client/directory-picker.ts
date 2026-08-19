import {
  DESKTOP_DIRECTORY_PICKER_PATH,
  DESKTOP_DIRECTORY_VALIDATOR_PATH,
  type DesktopDirectoryPickerResponse,
  type DesktopDirectoryValidationResponse,
} from '../directory-picker-contract.ts'

/** Window seam consumed by the patched upstream browse panel. */
export interface DesktopDirectoryPickerWindow {
  __DSH_DESKTOP_PICK_DIRECTORY__?: () => Promise<string | null>
  __DSH_DESKTOP_VALIDATE_DIRECTORY__?: (path: string) => Promise<boolean>
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

function isValidationResponse(value: unknown): value is DesktopDirectoryValidationResponse {
  return typeof value === 'object'
    && value !== null
    && 'allowed' in value
    && typeof (value as { allowed?: unknown }).allowed === 'boolean'
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

/** Ask the desktop Host whether a workspace path is safe to persist. */
export async function requestDesktopDirectoryValidation(
  path: string,
  request: DirectoryPickerRequest = window.fetch.bind(window),
): Promise<boolean> {
  const response = await request(DESKTOP_DIRECTORY_VALIDATOR_PATH, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ path }),
  })
  if (!response.ok) throw new Error('DSH Desktop could not validate the selected workspace')
  const value: unknown = await response.json()
  if (!isValidationResponse(value)) throw new Error('DSH Desktop received an invalid workspace validation response')
  return value.allowed
}

/** Publish the Windows-only picker bridge for the browse panel's icon action. */
export function installDesktopDirectoryPickerBridge(
  target: DesktopDirectoryPickerWindow = window as DesktopDirectoryPickerWindow,
  request: DirectoryPickerRequest = window.fetch.bind(window),
): () => void {
  const previousPicker = target.__DSH_DESKTOP_PICK_DIRECTORY__
  const previousValidator = target.__DSH_DESKTOP_VALIDATE_DIRECTORY__
  const pick = async (): Promise<string | null> => await requestDesktopDirectory(request)
  const validate = async (path: string): Promise<boolean> => await requestDesktopDirectoryValidation(path, request)
  target.__DSH_DESKTOP_PICK_DIRECTORY__ = pick
  target.__DSH_DESKTOP_VALIDATE_DIRECTORY__ = validate
  return () => {
    if (target.__DSH_DESKTOP_PICK_DIRECTORY__ === pick) {
      if (previousPicker === undefined) delete target.__DSH_DESKTOP_PICK_DIRECTORY__
      else target.__DSH_DESKTOP_PICK_DIRECTORY__ = previousPicker
    }
    if (target.__DSH_DESKTOP_VALIDATE_DIRECTORY__ === validate) {
      if (previousValidator === undefined) delete target.__DSH_DESKTOP_VALIDATE_DIRECTORY__
      else target.__DSH_DESKTOP_VALIDATE_DIRECTORY__ = previousValidator
    }
  }
}
