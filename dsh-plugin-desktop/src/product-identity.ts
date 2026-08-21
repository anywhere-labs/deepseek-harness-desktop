/** User-facing product identity for the AI Buddy desktop shell. */

/** OS-visible application name used by Electron, installers, and dialogs. */
export const PRODUCT_NAME = 'AI Buddy'

/** BrowserWindow title. Kept independent of the OS application name. */
export const PRODUCT_WINDOW_TITLE = 'AI Buddy'

/** Electron / Windows AppUserModelID. Changing this starts a new user-data root. */
export const PRODUCT_APP_ID = 'app.ai-buddy.desktop'

/** Stem for installer and update-save filenames. */
export const PRODUCT_ARTIFACT_STEM = 'AI-Buddy'

/** Directory name under the platform user-data parent. Must match `app.setName`. */
export const PRODUCT_USER_DATA_DIRECTORY_NAME = PRODUCT_NAME
