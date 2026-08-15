/** Narrow native APIs exposed to the sandboxed Desktop renderer. */

import { contextBridge, webUtils } from 'electron'

contextBridge.exposeInMainWorld('__DSH_DESKTOP__', {
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
})
