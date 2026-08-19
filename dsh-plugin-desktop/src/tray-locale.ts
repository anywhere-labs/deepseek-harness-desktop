/** Desktop-owned native tray copy for the locales shipped by DSH. */

import type { DesktopLocale } from './runtime.ts'

export type DesktopTrayLabelKey =
  | 'checkForUpdates'
  | 'checkingForUpdates'
  | 'downloadingUpdate'
  | 'exportDiagnostics'
  | 'openDesktop'
  | 'openTerminal'
  | 'profile'
  | 'quit'
  | 'switchToAdvanced'
  | 'switchToCompatibility'
  | 'unavailableForDesktop'
  | 'updateAvailable'

const labels: Record<DesktopLocale, Record<DesktopTrayLabelKey, (value: string) => string>> = {
  en: {
    checkForUpdates: () => 'Check for Updates…',
    checkingForUpdates: () => 'Checking for Updates…',
    downloadingUpdate: version => `Downloading DSH Desktop ${version}…`,
    exportDiagnostics: () => 'Export Diagnostics…',
    openDesktop: productName => `Open ${productName}`,
    openTerminal: () => 'Open DSH Terminal',
    profile: profileName => `Profile: ${profileName}`,
    quit: () => 'Quit',
    switchToAdvanced: () => 'Switch to Advanced Mode',
    switchToCompatibility: () => 'Switch to Compatibility Mode',
    unavailableForDesktop: profileName => `${profileName} (Unavailable for Desktop)`,
    updateAvailable: version => `DSH Desktop ${version} Available`,
  },
  zh: {
    checkForUpdates: () => '检查更新…',
    checkingForUpdates: () => '正在检查更新…',
    downloadingUpdate: version => `正在下载 DSH Desktop ${version}…`,
    exportDiagnostics: () => '导出诊断信息…',
    openDesktop: productName => `打开 ${productName}`,
    openTerminal: () => '打开 DSH 终端',
    profile: profileName => `配置文件：${profileName}`,
    quit: () => '退出',
    switchToAdvanced: () => '切换到高级模式',
    switchToCompatibility: () => '切换到兼容模式',
    unavailableForDesktop: profileName => `${profileName}（不可用于桌面端）`,
    updateAvailable: version => `DSH Desktop ${version} 可用`,
  },
  ru: {
    checkForUpdates: () => 'Проверить обновления…',
    checkingForUpdates: () => 'Проверяем обновления…',
    downloadingUpdate: version => `Загрузка обновления DSH Desktop ${version}…`,
    exportDiagnostics: () => 'Экспортировать данные диагностики…',
    openDesktop: productName => `Открыть ${productName}`,
    openTerminal: () => 'Открыть терминал DSH',
    profile: profileName => `Профиль: ${profileName}`,
    quit: () => 'Выйти',
    switchToAdvanced: () => 'Перейти в расширенный режим',
    switchToCompatibility: () => 'Перейти в режим совместимости',
    unavailableForDesktop: profileName => `${profileName} (недоступен в DSH Desktop)`,
    updateAvailable: version => `Доступна версия DSH Desktop ${version}`,
  },
}

export interface DesktopDiagnosticsPrivacyCopy {
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly confirm: string
  readonly cancel: string
}

const diagnosticsPrivacyCopy: Record<DesktopLocale, DesktopDiagnosticsPrivacyCopy> = {
  en: {
    title: 'Export Diagnostics',
    message: 'Review the diagnostic archive before sharing it.',
    detail: 'The archive contains recent application logs, local crash dumps, and system information. Logs may contain local paths, workspace IDs, and session IDs. Crash dumps may contain fragments of process memory. Authentication credentials are masked in logs when recognized, but you should still review the archive before uploading it publicly.',
    confirm: 'Export',
    cancel: 'Cancel',
  },
  zh: {
    title: '导出诊断信息',
    message: '分享诊断包前请先检查其中的内容。',
    detail: '诊断包包含最近的应用日志、本地崩溃转储和系统信息。日志可能包含本地路径、工作区 ID 和会话 ID，崩溃转储可能包含进程内存片段。系统会对日志中可识别的认证凭据进行脱敏，但公开上传前仍应检查诊断包。',
    confirm: '导出',
    cancel: '取消',
  },
  ru: {
    title: 'Экспорт данных диагностики',
    message: 'Перед отправкой проверьте содержимое архива диагностики.',
    detail: 'Архив содержит последние журналы приложения, локальные дампы сбоев и сведения о системе. В журналах могут быть локальные пути, идентификаторы рабочих областей и сессий, а в дампах — фрагменты памяти процесса. DSH Desktop маскирует распознанные учётные данные в журналах, но перед публикацией архива в открытом доступе всё равно проверьте его содержимое.',
    confirm: 'Экспортировать',
    cancel: 'Отмена',
  },
}

/** Resolve a native desktop locale from an Electron or browser language tag. */
export function desktopLocaleFromLanguageTag(languageTag: string): DesktopLocale {
  if (/^zh(?:[-_]|$)/i.test(languageTag)) return 'zh'
  if (/^ru(?:[-_]|$)/i.test(languageTag)) return 'ru'
  return 'en'
}

/** Resolve one native tray label in the active desktop locale. */
export function desktopTrayLabel(
  locale: DesktopLocale,
  key: DesktopTrayLabelKey,
  value = '',
): string {
  return labels[locale][key](value)
}

/** Resolve the native privacy confirmation shown before diagnostics export. */
export function desktopDiagnosticsPrivacyCopy(locale: DesktopLocale): DesktopDiagnosticsPrivacyCopy {
  return diagnosticsPrivacyCopy[locale]
}
