/** Main-world key for the narrowly scoped Electron file-path bridge. */
export const DESKTOP_FILE_PATH_BRIDGE = '__DSH_DESKTOP_FILE_PATH__'

/** Official conversation client's Desktop path capability. */
export const DESKTOP_HOST_PATH_BRIDGE = '__DSH_HOST_PATHS__'

/** Capability exposed by the context-isolated preload. */
export interface DesktopFilePathBridge {
  /** Resolve a genuine disk-backed Web File to its operating-system path. */
  getPathForFile(file: File): string
}

/** Window shape consumed by desktop-only client code. */
export interface DesktopFilePathBridgeWindow {
  __DSH_DESKTOP_FILE_PATH__?: DesktopFilePathBridge
}
