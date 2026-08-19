/** Narrow Renderer-to-main contract for one produced-file native menu. */

/** Main-world key exposed only by the context-isolated desktop preload. */
export const DESKTOP_ARTIFACT_CONTEXT_MENU_BRIDGE = '__DSH_DESKTOP_ARTIFACT_CONTEXT_MENU__'

/** Private IPC channel owned by one supported Electron shell generation. */
export const DESKTOP_ARTIFACT_CONTEXT_MENU_CHANNEL = 'dsh-desktop:artifact-context-menu'

/** One produced path and the workspace root used to resolve relative locations. */
export interface DesktopArtifactContextMenuRequest {
  /** Session workspace root; optional only when `path` is already absolute. */
  cwd?: string
  /** Exact path reported by the successful mutation location. */
  path: string
}

/** Capability exposed to the trusted desktop client plugin. */
export interface DesktopArtifactContextMenuBridge {
  /** Open the platform-native context menu for one produced file. */
  show(request: DesktopArtifactContextMenuRequest): Promise<void>
}

/** Window shape consumed by desktop-only client code. */
export interface DesktopArtifactContextMenuWindow {
  __DSH_DESKTOP_ARTIFACT_CONTEXT_MENU__?: DesktopArtifactContextMenuBridge
}
