/** Same-origin endpoint used by the Windows browse panel's native-picker shortcut. */
export const DESKTOP_DIRECTORY_PICKER_PATH = '/_dsh/desktop/pick-directory'

/** Successful native directory-picker response. */
export interface DesktopDirectoryPickerResponse {
  /** Absolute selected path, or null when the chooser was cancelled. */
  path: string | null
}
