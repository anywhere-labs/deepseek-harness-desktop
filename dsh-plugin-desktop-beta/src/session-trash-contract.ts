/** Desktop logical deletion; original logs remain available for branch history. */
export const DESKTOP_SESSION_TRASH_PATH = '/api/desktop/sessions/trash'
export interface DesktopTrashedSession { readonly sessionId: string; readonly title: string; readonly updatedAt: string }
export interface DesktopSessionTrashView { readonly supported: boolean; readonly items: readonly DesktopTrashedSession[] }
