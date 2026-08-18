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
}

export interface DesktopAttentionCopy {
  readonly title: string
  readonly body: string
}

const completedJobCopy: Record<DesktopLocale, DesktopAttentionCopy> = {
  en: {
    title: 'Background Job Completed',
    body: 'A background job has finished.',
  },
  zh: {
    title: '后台任务已完成',
    body: '有一个后台任务已结束。',
  },
}

const failedJobCopy: Record<DesktopLocale, DesktopAttentionCopy> = {
  en: {
    title: 'Background Job Failed',
    body: 'A background job needs attention.',
  },
  zh: {
    title: '后台任务失败',
    body: '有一个后台任务需要处理。',
  },
}

const completedTurnCopy: Record<DesktopLocale, DesktopAttentionCopy> = {
  en: {
    title: 'Turn Completed',
    body: 'A direct user turn has finished.',
  },
  zh: {
    title: '用户回合已完成',
    body: '有一个用户回合已结束。',
  },
}

const failedTurnCopy: Record<DesktopLocale, DesktopAttentionCopy> = {
  en: {
    title: 'User Turn Failed',
    body: 'A direct user turn needs attention.',
  },
  zh: {
    title: '用户回合失败',
    body: '有一个用户回合需要处理。',
  },
}

/** Resolve DSH's zh/en locale from an Electron or browser language tag. */
export function desktopLocaleFromLanguageTag(languageTag: string): DesktopLocale {
  return /^zh(?:[-_]|$)/i.test(languageTag) ? 'zh' : 'en'
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

/** Resolve the privacy-safe native copy shown for background-job attention. */
export function desktopJobNotificationCopy(
  locale: DesktopLocale,
  status: 'completed' | 'failed',
): DesktopAttentionCopy {
  return status === 'completed' ? completedJobCopy[locale] : failedJobCopy[locale]
}

/** Resolve the privacy-safe native copy shown for direct-user turn attention. */
export function desktopTurnNotificationCopy(
  locale: DesktopLocale,
  status: 'completed' | 'failed',
): DesktopAttentionCopy {
  return status === 'completed' ? completedTurnCopy[locale] : failedTurnCopy[locale]
}
