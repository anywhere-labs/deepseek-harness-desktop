/** Minimal context-isolated bridges for desktop-only file interactions. */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  DESKTOP_ARTIFACT_CONTEXT_MENU_BRIDGE,
  DESKTOP_ARTIFACT_CONTEXT_MENU_CHANNEL,
  type DesktopArtifactContextMenuRequest,
} from './artifact-context-menu-contract.ts'
import { DESKTOP_FILE_PATH_BRIDGE } from './file-path-bridge-contract.ts'

contextBridge.exposeInMainWorld(DESKTOP_FILE_PATH_BRIDGE, {
  /** Resolve only genuine disk-backed Web File objects selected by the operator. */
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
})

contextBridge.exposeInMainWorld(DESKTOP_ARTIFACT_CONTEXT_MENU_BRIDGE, {
  /** Ask the current desktop shell generation for one trusted native menu. */
  async show(request: DesktopArtifactContextMenuRequest): Promise<void> {
    await ipcRenderer.invoke(DESKTOP_ARTIFACT_CONTEXT_MENU_CHANNEL, request)
  },
})
