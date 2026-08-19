import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  MessageBoxOptions,
  MessageBoxReturnValue,
} from 'electron'
import type { DesktopLocale, DesktopPlatform } from './runtime.ts'
import { desktopNativeCopy } from './native-locale.ts'
import {
  evaluateWindowsWorkspaceVolume,
  formatWindowsVolumeConcern,
  type WindowsVolumeQuery,
} from './windows-volume-diagnostics.ts'

export interface ElectronWorkspaceAdmissionOptions {
  readonly platform: DesktopPlatform
  readonly canPickDirectory: boolean
  readonly locale: () => DesktopLocale
  readonly showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>
  readonly showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  readonly logError: (message: string) => void
  readonly volumeQuery?: WindowsVolumeQuery
}

/** Own native workspace selection and every Desktop policy decision before persistence. */
export class ElectronWorkspaceAdmission {
  private pickTask: Promise<string | null> | undefined

  constructor(private readonly options: ElectronWorkspaceAdmissionOptions) {}

  /** Select one directory through the native platform adapter, coalescing concurrent requests. */
  async pickDirectory(): Promise<string | null> {
    if (!this.options.canPickDirectory) {
      throw new Error(`dsh-plugin-desktop: native workspace picker is unavailable on ${this.options.platform}`)
    }
    if (this.pickTask !== undefined) return await this.pickTask
    const task = this.showDirectoryPicker()
    this.pickTask = task
    try {
      return await task
    } finally {
      if (this.pickTask === task) this.pickTask = undefined
    }
  }

  /** Apply Desktop-owned storage policy before a selected workspace is persisted. */
  async validateDirectory(path: string): Promise<boolean> {
    const decision = evaluateWindowsWorkspaceVolume(this.options.platform, path, this.options.volumeQuery)
    if (decision.action === 'allow') return true

    this.options.logError(`dsh-plugin-desktop: unsafe workspace volume: ${formatWindowsVolumeConcern(decision.concern)}`)
    const copy = desktopNativeCopy(this.options.locale()).workspaceVolume
    if (decision.action === 'confirm') {
      const result = await this.options.showMessageBox({
        type: 'warning',
        title: copy.removableTitle,
        message: copy.removableMessage,
        detail: copy.removableDetail(path),
        buttons: [copy.useFolder, copy.chooseAnotherFolder],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      const accepted = result.response === 0
      this.options.logError(`dsh-plugin-desktop: workspace volume decision=${accepted ? 'confirmed' : 'cancelled'} path=${path}`)
      return accepted
    }

    await this.options.showMessageBox({
      type: 'error',
      title: copy.unsupportedTitle,
      message: copy.unsupportedMessage(decision.concern.fileSystem),
      detail: copy.unsupportedDetail(path),
      buttons: [copy.chooseAnotherFolder],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    this.options.logError(`dsh-plugin-desktop: workspace volume decision=blocked path=${path}`)
    return false
  }

  private async showDirectoryPicker(): Promise<string | null> {
    const copy = desktopNativeCopy(this.options.locale())
    const result = await this.options.showOpenDialog({
      title: copy.directoryPickerTitle,
      properties: ['openDirectory', 'dontAddToRecent'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  }
}
