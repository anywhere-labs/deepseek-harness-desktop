/** Desktop-owned file-tree context-menu copy. */

export const en = {
  addToTask: 'Add to task',
  openInEditor: 'Open in VS Code',
  showInFileManager: 'Show in file manager',
  copyAbsolutePath: 'Copy absolute path',
  copyRelativePath: 'Copy relative path',
  addedToTask: 'File reference added to the composer.',
  copiedPath: 'Path copied.',
  referenceUnavailable: 'This path cannot be added as a file reference.',
  insertFailed: 'Could not add the file reference to the composer.',
  vscodeUnavailable: 'VS Code is not registered to open this file.',
  operationFailed: 'Could not complete this file action.',
} as const

export const zh: Record<keyof typeof en, string> = {
  addToTask: '添加到任务',
  openInEditor: '在 VS Code 中打开',
  showInFileManager: '在文件管理器中显示',
  copyAbsolutePath: '复制绝对路径',
  copyRelativePath: '复制相对路径',
  addedToTask: '已将文件引用添加到编辑栏。',
  copiedPath: '路径已复制。',
  referenceUnavailable: '此路径无法作为文件引用添加。',
  insertFailed: '未能将文件引用添加到编辑栏。',
  vscodeUnavailable: '此文件没有已注册的 VS Code 打开方式。',
  operationFailed: '未能完成此文件操作。',
}

export type DesktopFileMenuLocaleKey = keyof typeof en
export const DESKTOP_FILE_MENU_LOCALE_NAMESPACE = 'desktop.files'
