import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  MessageBoxOptions,
  MessageBoxReturnValue,
} from 'electron'
import type { DesktopLocale, DesktopPlatform } from './runtime.ts'
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
    const zh = this.options.locale() === 'zh'
    if (decision.action === 'confirm') {
      const result = await this.options.showMessageBox({
        type: 'warning',
        title: zh ? '外接工作区' : 'Removable Workspace',
        message: zh
          ? '这个工作区位于可移除的 NTFS/ReFS 磁盘上。'
          : 'This workspace is on a removable NTFS/ReFS drive.',
        detail: zh
          ? `使用过程中拔出磁盘会导致命令或插件操作失败。请保持磁盘连接。\n\n${path}`
          : `Disconnecting the drive while DSH Desktop is running can break commands or plugin operations. Keep it connected.\n\n${path}`,
        buttons: zh ? ['使用此文件夹', '选择其他文件夹'] : ['Use This Folder', 'Choose Another Folder'],
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
      title: zh ? '不支持的工作区存储' : 'Unsupported Workspace Storage',
      message: zh
        ? `${decision.concern.fileSystem ?? '当前文件系统'} 不能安全用作 DSH Desktop 工作区。`
        : `${decision.concern.fileSystem ?? 'This filesystem'} cannot safely host a DSH Desktop workspace.`,
      detail: zh
        ? `请选择本地 NTFS 或 ReFS 磁盘上的文件夹。exFAT、FAT32、网络盘和无法检测的磁盘不会被保存为工作区。\n\n${path}`
        : `Choose a folder on a local NTFS or ReFS volume. exFAT, FAT32, network drives, and uninspectable volumes are not persisted as workspaces.\n\n${path}`,
      buttons: [zh ? '选择其他文件夹' : 'Choose Another Folder'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    this.options.logError(`dsh-plugin-desktop: workspace volume decision=blocked path=${path}`)
    return false
  }

  private async showDirectoryPicker(): Promise<string | null> {
    const result = await this.options.showOpenDialog({
      title: this.options.locale() === 'zh' ? '选择工作区目录' : 'Select Workspace Directory',
      properties: ['openDirectory', 'dontAddToRecent'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  }
}
