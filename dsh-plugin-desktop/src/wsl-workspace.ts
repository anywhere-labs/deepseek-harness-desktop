/** Windows chooser plus Linux validation for one selected WSL distribution. */

import { isAbsolute } from 'node:path/posix'
import type { DesktopCommandCapture } from './wsl.ts'
import { captureDesktopCommand, wslExecArguments } from './wsl.ts'
import { windowsUncToWslPath, wslPathToWindowsUnc } from './wsl-path.ts'

export interface WslOpenDialogResult {
  readonly canceled: boolean
  readonly filePaths: readonly string[]
}

export interface WslWorkspaceAdapterOptions {
  readonly distribution: string
  readonly homeDir: string
  readonly capture?: DesktopCommandCapture
  showOpenDialog(options: {
    readonly title: string
    readonly defaultPath: string
    readonly properties: readonly ['openDirectory', 'createDirectory']
  }): Promise<WslOpenDialogResult>
  reportOutsideDistribution(path: string): void | Promise<void>
}

/** Prevent Windows paths from crossing into a Linux Host as invalid workspaces. */
export class WslWorkspaceAdapter {
  private readonly capture: DesktopCommandCapture

  constructor(private readonly options: WslWorkspaceAdapterOptions) {
    this.capture = options.capture ?? captureDesktopCommand
  }

  async pickDirectory(): Promise<string | null> {
    const result = await this.options.showOpenDialog({
      title: 'Select WSL Workspace Folder',
      defaultPath: wslPathToWindowsUnc(this.options.distribution, this.options.homeDir),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths[0] === undefined) return null
    const path = windowsUncToWslPath(this.options.distribution, result.filePaths[0])
    if (path === undefined) {
      await this.options.reportOutsideDistribution(result.filePaths[0])
      return null
    }
    return await this.validateDirectory(path) ? path : null
  }

  async validateDirectory(path: string): Promise<boolean> {
    if (!isAbsolute(path) || path.includes('\0') || /[\r\n]/u.test(path)) return false
    const result = await this.capture('wsl.exe', wslExecArguments(
      this.options.distribution,
      ['/usr/bin/test', '-d', path],
    ))
    return result.exitCode === 0 && result.signal === null
  }
}
