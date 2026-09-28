import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  MessageBoxOptions,
  MessageBoxReturnValue,
} from 'electron'
import { existsSync } from 'node:fs'
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
  readonly pickWindowsUnicodeDirectory?: (title: string) => Promise<string | null>
  readonly pathExists?: (path: string) => boolean
  readonly showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  readonly logError: (message: string) => void
  readonly volumeQuery?: WindowsVolumeQuery
  readonly inspectPath?: PathInspection
}

/** What one filesystem entry is, as far as workspace admission cares. */
export interface PathInspectionResult {
  /** Whether the entry is a directory. */
  readonly directory: boolean
}

/**
 * Inspect one absolute path.
 * @returns what the entry is, or `undefined` when nothing exists there.
 */
export type PathInspection = (path: string) => PathInspectionResult | undefined

/** Read one entry without turning a missing path into a thrown error. */
function inspectPathOnDisk(path: string): PathInspectionResult | undefined {
  const stats = statSync(path, { throwIfNoEntry: false })
  return stats === undefined ? undefined : { directory: stats.isDirectory() }
}

/** Own native workspace selection and every Desktop policy decision before persistence. */
export class ElectronWorkspaceAdmission {
  private pickTask: Promise<string | null> | undefined
  private preferUnicodeWindowsPicker = false

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

  /**
   * Apply every Desktop policy to a folder named by a launch rather than chosen
   * in the native picker.
   *
   * A launch path is arbitrary text, so existence and kind are established here
   * before the storage policy runs; the picker cannot produce either failure.
   * @param path - absolute folder the launch asked Desktop to open.
   * @returns whether the folder may be registered as a workspace.
   */
  async admitWorkspacePath(path: string): Promise<boolean> {
    const absolute = this.options.platform === 'win32' ? win32.isAbsolute(path) : posix.isAbsolute(path)
    if (!absolute) {
      this.options.logError(`dsh-plugin-desktop: launch workspace path is not absolute: ${path}`)
      return false
    }
    const entry = (this.options.inspectPath ?? inspectPathOnDisk)(path)
    if (entry === undefined || !entry.directory) {
      const missing = entry === undefined
      this.options.logError(`dsh-plugin-desktop: launch workspace path is ${missing ? 'missing' : 'not a directory'}: ${path}`)
      const zh = this.options.locale() === 'zh'
      await this.options.showMessageBox({
        type: 'error',
        title: zh ? '无法打开工作区' : 'Cannot Open Workspace',
        message: missing
          ? (zh ? '找不到这个文件夹。' : 'This folder could not be found.')
          : (zh ? '只能把文件夹注册为工作区。' : 'Only a folder can be registered as a workspace.'),
        detail: missing
          ? (zh
              ? `这个文件夹可能已经被移动、重命名或删除。\n\n${path}`
              : `The folder may have been moved, renamed, or deleted.\n\n${path}`)
          : (zh
              ? `请改为指定一个文件夹。\n\n${path}`
              : `Name a folder instead.\n\n${path}`),
        buttons: [zh ? '好' : 'OK'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      return false
    }
    return await this.validateDirectory(path)
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
    const title = this.options.locale() === 'zh' ? '选择工作区目录' : 'Select Workspace Directory'
    if (this.preferUnicodeWindowsPicker && this.options.pickWindowsUnicodeDirectory !== undefined) {
      return await this.options.pickWindowsUnicodeDirectory(title)
    }
    const result = await this.options.showOpenDialog({
      title,
      properties: ['openDirectory', 'dontAddToRecent'],
    })
    const path = result.canceled ? null : result.filePaths[0] ?? null
    if (this.options.platform !== 'win32'
      || path === null
      || this.options.pickWindowsUnicodeDirectory === undefined
      || !/[^\u0000-\u007f]/u.test(path)
      || (this.options.pathExists ?? existsSync)(path)) {
      return path
    }

    this.options.logError('dsh-plugin-desktop: native workspace picker returned an inaccessible non-ASCII path; retrying with the UTF-16 Windows picker')
    const fallback = await this.options.pickWindowsUnicodeDirectory(title)
    this.preferUnicodeWindowsPicker = true
    return fallback
  }
}
