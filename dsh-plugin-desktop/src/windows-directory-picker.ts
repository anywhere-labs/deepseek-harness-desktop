/** Electron main-process adapter for the upstream Windows native directory picker. */

import { DirectoryPicker, type DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { pickNativeDirectory } from '@deepseek-ai/dsh-host-directory-picker-native'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

/** Native picker function boundary used by focused tests. */
export type NativePicker = (signal: AbortSignal) => Promise<string | null>

/**
 * Start the official picker while Electron's executable behaves as Node for
 * the dialog worker spawn. The upstream picker creates that child before its
 * first asynchronous boundary, so the main process environment is restored
 * before this function returns its promise.
 */
export function pickWindowsDirectoryFromElectron(
  signal: AbortSignal,
  pick: NativePicker = pickNativeDirectory,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const previous = env[RUN_AS_NODE]
  env[RUN_AS_NODE] = '1'
  try {
    return pick(signal)
  } finally {
    if (previous === undefined) delete env[RUN_AS_NODE]
    else env[RUN_AS_NODE] = previous
  }
}

/** Desktop-owned provider that preserves the ordinary directoryPicker seam. */
export default class DesktopWindowsDirectoryPicker extends DirectoryPicker {
  private readonly nativeCapability: DirectoryPickerCapability = {
    kind: 'native',
    pick: signal => pickWindowsDirectoryFromElectron(signal),
  }

  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}
