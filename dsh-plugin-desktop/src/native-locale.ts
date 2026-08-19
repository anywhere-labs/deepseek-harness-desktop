/** Desktop-owned native dialog and notification copy for every shipped locale. */

import type { DesktopLocale, DesktopNotification } from './runtime.ts'

interface WorkspaceVolumeCopy {
  readonly removableTitle: string
  readonly removableMessage: string
  readonly removableDetail: (path: string) => string
  readonly useFolder: string
  readonly chooseAnotherFolder: string
  readonly unsupportedTitle: string
  readonly unsupportedMessage: (fileSystem: string | undefined) => string
  readonly unsupportedDetail: (path: string) => string
}

interface PluginRecoveryCopy {
  readonly title: string
  readonly message: string
  readonly unknownPlugin: string
  readonly unknownError: string
  readonly detail: (plugins: string, error: string) => string
  readonly openTerminal: string
  readonly restart: string
  readonly dismiss: string
}

interface UpdateCopy {
  readonly availableTitle: string
  readonly availableMessage: (version: string) => string
  readonly downloadPrompt: string
  readonly download: string
  readonly later: string
  readonly checkFailedTitle: string
  readonly checkFailedMessage: string
  readonly tryAgainLater: string
  readonly upToDateTitle: string
  readonly upToDateMessage: string
  readonly installedVersion: (version: string) => string
  readonly downloadUnavailable: string
  readonly ok: string
  readonly downloadedTitle: string
  readonly readyToInstall: (version: string) => string
  readonly macInstallDetail: string
  readonly windowsInstallDetail: string
  readonly restartAndInstall: string
  readonly saveInstallerTitle: string
  readonly saveAndDownload: string
  readonly diskImage: string
  readonly windowsInstaller: string
  readonly removeInstallerTitle: string
  readonly installedMessage: (version: string) => string
  readonly removeInstallerDetail: (path: string) => string
  readonly deleteInstaller: string
  readonly keepInstaller: string
}

export interface DesktopNativeCopy {
  readonly directoryPickerTitle: string
  readonly workspaceVolume: WorkspaceVolumeCopy
  readonly pluginRecovery: PluginRecoveryCopy
  readonly updates: UpdateCopy
  readonly terminalErrorTitle: string
  readonly diagnosticsErrorTitle: string
}

const COPY: Record<DesktopLocale, DesktopNativeCopy> = {
  en: {
    directoryPickerTitle: 'Select Workspace Directory',
    workspaceVolume: {
      removableTitle: 'Removable Workspace',
      removableMessage: 'This workspace is on a removable NTFS/ReFS drive.',
      removableDetail: path => `Disconnecting the drive while DSH Desktop is running can break commands or plugin operations. Keep it connected.\n\n${path}`,
      useFolder: 'Use This Folder',
      chooseAnotherFolder: 'Choose Another Folder',
      unsupportedTitle: 'Unsupported Workspace Storage',
      unsupportedMessage: fileSystem => `${fileSystem ?? 'This filesystem'} cannot safely host a DSH Desktop workspace.`,
      unsupportedDetail: path => `Choose a folder on a local NTFS or ReFS volume. exFAT, FAT32, network drives, and uninspectable volumes are not persisted as workspaces.\n\n${path}`,
    },
    pluginRecovery: {
      title: 'Plugin Recovery',
      message: 'DSH Desktop could not load all plugins.',
      unknownPlugin: 'Unknown client plugin',
      unknownError: 'The client Loader did not provide an error message.',
      detail: (plugins, error) => `Failed plugins:\n${plugins}\n\n${error}\n\nOpen DSH Terminal to update or remove the failing third-party plugin, then restart DSH Desktop.`,
      openTerminal: 'Open DSH Terminal',
      restart: 'Restart DSH Desktop',
      dismiss: 'Dismiss',
    },
    updates: {
      availableTitle: 'DSH Desktop Update Available',
      availableMessage: version => `DSH Desktop ${version} is available.`,
      downloadPrompt: 'Download this update now?',
      download: 'Download',
      later: 'Later',
      checkFailedTitle: 'Unable to Check for Updates',
      checkFailedMessage: 'DSH Desktop could not check for updates.',
      tryAgainLater: 'Please try again later.',
      upToDateTitle: 'DSH Desktop Is Up to Date',
      upToDateMessage: 'No newer version of DSH Desktop is available.',
      installedVersion: version => `Installed version: ${version}`,
      downloadUnavailable: 'Installer downloads are unavailable in this build.',
      ok: 'OK',
      downloadedTitle: 'DSH Desktop Update Downloaded',
      readyToInstall: version => `DSH Desktop ${version} is ready to install.`,
      macInstallDetail: 'The disk image has opened. Replace DSH Desktop in Applications, then reopen it.',
      windowsInstallDetail: 'Restart DSH Desktop and run the installer now?',
      restartAndInstall: 'Restart and Install',
      saveInstallerTitle: 'Save Update Installer',
      saveAndDownload: 'Save and Download',
      diskImage: 'Disk Image',
      windowsInstaller: 'Windows Installer',
      removeInstallerTitle: 'Remove Update Installer',
      installedMessage: version => `DSH Desktop ${version} has been installed.`,
      removeInstallerDetail: path => `Delete the downloaded installer to free disk space?\n\n${path}`,
      deleteInstaller: 'Delete Installer',
      keepInstaller: 'Keep Installer',
    },
    terminalErrorTitle: 'Unable to Open DSH Terminal',
    diagnosticsErrorTitle: 'Unable to Export Diagnostics',
  },
  zh: {
    directoryPickerTitle: '选择工作区目录',
    workspaceVolume: {
      removableTitle: '外接工作区',
      removableMessage: '这个工作区位于可移除的 NTFS/ReFS 磁盘上。',
      removableDetail: path => `使用过程中拔出磁盘会导致命令或插件操作失败。请保持磁盘连接。\n\n${path}`,
      useFolder: '使用此文件夹',
      chooseAnotherFolder: '选择其他文件夹',
      unsupportedTitle: '不支持的工作区存储',
      unsupportedMessage: fileSystem => `${fileSystem ?? '当前文件系统'} 不能安全用作 DSH Desktop 工作区。`,
      unsupportedDetail: path => `请选择本地 NTFS 或 ReFS 磁盘上的文件夹。exFAT、FAT32、网络盘和无法检测的磁盘不会被保存为工作区。\n\n${path}`,
    },
    pluginRecovery: {
      title: '插件恢复',
      message: 'DSH Desktop 无法加载全部插件。',
      unknownPlugin: '未知客户端插件',
      unknownError: '客户端 Loader 未提供错误信息。',
      detail: (plugins, error) => `加载失败的插件：\n${plugins}\n\n${error}\n\n请打开 DSH 终端，更新或移除有问题的第三方插件，然后重新启动 DSH Desktop。`,
      openTerminal: '打开 DSH 终端',
      restart: '重新启动 DSH Desktop',
      dismiss: '关闭',
    },
    updates: {
      availableTitle: 'DSH Desktop 有可用更新',
      availableMessage: version => `DSH Desktop ${version} 已发布。`,
      downloadPrompt: '现在下载此更新吗？',
      download: '下载',
      later: '稍后',
      checkFailedTitle: '无法检查更新',
      checkFailedMessage: 'DSH Desktop 无法检查更新。',
      tryAgainLater: '请稍后重试。',
      upToDateTitle: 'DSH Desktop 已是最新版本',
      upToDateMessage: '目前没有更新版本的 DSH Desktop。',
      installedVersion: version => `已安装版本：${version}`,
      downloadUnavailable: '此构建版本不支持下载安装程序。',
      ok: '确定',
      downloadedTitle: 'DSH Desktop 更新已下载',
      readyToInstall: version => `DSH Desktop ${version} 已准备好安装。`,
      macInstallDetail: '磁盘映像已打开。请替换“应用程序”中的 DSH Desktop，然后重新打开。',
      windowsInstallDetail: '现在重新启动 DSH Desktop 并运行安装程序吗？',
      restartAndInstall: '重新启动并安装',
      saveInstallerTitle: '保存更新安装包',
      saveAndDownload: '保存并下载',
      diskImage: '磁盘映像',
      windowsInstaller: 'Windows 安装程序',
      removeInstallerTitle: '删除更新安装包',
      installedMessage: version => `DSH Desktop ${version} 已安装。`,
      removeInstallerDetail: path => `是否删除下载的安装包以释放磁盘空间？\n\n${path}`,
      deleteInstaller: '删除安装包',
      keepInstaller: '保留安装包',
    },
    terminalErrorTitle: '无法打开 DSH 终端',
    diagnosticsErrorTitle: '无法导出诊断信息',
  },
  ru: {
    directoryPickerTitle: 'Выберите папку рабочей области',
    workspaceVolume: {
      removableTitle: 'Рабочая область на съёмном диске',
      removableMessage: 'Эта рабочая область находится на съёмном диске с файловой системой NTFS/ReFS.',
      removableDetail: path => `Если отключить диск во время работы DSH Desktop, выполнение команд и операции с плагинами могут завершиться с ошибкой. Не отключайте диск.\n\n${path}`,
      useFolder: 'Использовать эту папку',
      chooseAnotherFolder: 'Выбрать другую папку',
      unsupportedTitle: 'Неподдерживаемое хранилище рабочей области',
      unsupportedMessage: fileSystem => fileSystem === undefined
        ? 'На этой файловой системе нельзя безопасно хранить рабочую область DSH Desktop.'
        : `На файловой системе «${fileSystem}» нельзя безопасно хранить рабочую область DSH Desktop.`,
      unsupportedDetail: path => `Выберите папку на локальном диске с файловой системой NTFS или ReFS. Папки на дисках с exFAT или FAT32, на сетевых дисках и на дисках, которые не удалось проверить, нельзя использовать как рабочие области DSH Desktop.\n\n${path}`,
    },
    pluginRecovery: {
      title: 'Восстановление загрузки плагинов',
      message: 'Не все плагины удалось загрузить.',
      unknownPlugin: 'Неизвестный плагин интерфейса',
      unknownError: 'Загрузчик интерфейса не предоставил сообщение об ошибке.',
      detail: (plugins, error) => `Не удалось загрузить плагины:\n${plugins}\n\n${error}\n\nОткройте терминал DSH, обновите или удалите проблемный сторонний плагин, затем перезапустите DSH Desktop.`,
      openTerminal: 'Открыть терминал DSH',
      restart: 'Перезапустить DSH Desktop',
      dismiss: 'Закрыть',
    },
    updates: {
      availableTitle: 'Доступно обновление DSH Desktop',
      availableMessage: version => `Доступна версия DSH Desktop ${version}.`,
      downloadPrompt: 'Загрузить обновление сейчас?',
      download: 'Загрузить',
      later: 'Позже',
      checkFailedTitle: 'Не удалось проверить обновления',
      checkFailedMessage: 'Не удалось проверить наличие обновлений DSH Desktop.',
      tryAgainLater: 'Повторите попытку позже.',
      upToDateTitle: 'Установлена последняя версия DSH Desktop',
      upToDateMessage: 'Более новых версий DSH Desktop нет.',
      installedVersion: version => `Установленная версия: ${version}`,
      downloadUnavailable: 'В этой сборке загрузка установщика недоступна.',
      ok: 'ОК',
      downloadedTitle: 'Обновление DSH Desktop загружено',
      readyToInstall: version => `Версия DSH Desktop ${version} готова к установке.`,
      macInstallDetail: 'Образ диска открыт. Замените DSH Desktop в папке «Программы», затем снова запустите приложение.',
      windowsInstallDetail: 'Перезапустить DSH Desktop и сразу запустить установщик?',
      restartAndInstall: 'Перезапустить и установить',
      saveInstallerTitle: 'Сохранить установщик обновления',
      saveAndDownload: 'Сохранить и загрузить',
      diskImage: 'Образ диска',
      windowsInstaller: 'Установщик Windows',
      removeInstallerTitle: 'Удаление установщика обновления',
      installedMessage: version => `Версия DSH Desktop ${version} установлена.`,
      removeInstallerDetail: path => `Удалить загруженный установщик, чтобы освободить место на диске?\n\n${path}`,
      deleteInstaller: 'Удалить установщик',
      keepInstaller: 'Оставить установщик',
    },
    terminalErrorTitle: 'Не удалось открыть терминал DSH',
    diagnosticsErrorTitle: 'Не удалось экспортировать данные диагностики',
  },
}

export interface DesktopInstallRollbackCopy {
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly confirm: string
}

const INSTALL_ROLLBACK_COPY: Record<DesktopLocale, (packageName: string) => DesktopInstallRollbackCopy> = {
  en: packageName => ({
    title: 'Plugin installation rolled back',
    message: `DSH Desktop restored the configuration from before ${packageName} was installed.`,
    detail: 'The previous startup did not pass its health check. DSH Desktop saved diagnostics locally and restored package.json, pnpm-lock.yaml, and pnpm-workspace.yaml. Diagnostics are not uploaded automatically.',
    confirm: 'OK',
  }),
  zh: packageName => ({
    title: '插件安装已回滚',
    message: `DSH Desktop 已恢复安装 ${packageName} 前的配置。`,
    detail: '上一次启动未能通过健康验证。DSH Desktop 已在本地保存诊断信息，并恢复 package.json、pnpm-lock.yaml 和 pnpm-workspace.yaml；诊断信息不会自动上传。',
    confirm: '知道了',
  }),
  ru: packageName => ({
    title: 'Восстановлена конфигурация до установки плагина',
    message: `DSH Desktop восстановил конфигурацию, которая использовалась до установки плагина «${packageName}».`,
    detail: 'Предыдущий запуск не прошёл проверку работоспособности. DSH Desktop сохранил данные диагностики локально и восстановил package.json, pnpm-lock.yaml и pnpm-workspace.yaml. Данные диагностики не загружаются автоматически.',
    confirm: 'ОК',
  }),
}

/** Return the complete native-dialog dictionary for one desktop locale. */
export function desktopNativeCopy(locale: DesktopLocale): DesktopNativeCopy {
  return COPY[locale]
}

/** Return the post-recovery dialog shown after a protected plugin install rollback. */
export function desktopInstallRollbackCopy(
  locale: DesktopLocale,
  packageName: string,
): DesktopInstallRollbackCopy {
  return INSTALL_ROLLBACK_COPY[locale](packageName)
}

/** Describe a profile fallback without inflecting an arbitrary profile name. */
export function desktopProfileRecoveryNotification(
  locale: DesktopLocale,
  profileName: string,
  state: 'reopened' | 'reopening',
): DesktopNotification {
  if (locale === 'zh') {
    return {
      title: '无法打开配置',
      body: state === 'reopened'
        ? `已重新打开上次可用的配置：${profileName}。`
        : `正在重新打开上次可用的配置：${profileName}。`,
    }
  }
  if (locale === 'ru') {
    return {
      title: 'Не удалось открыть профиль',
      body: state === 'reopened'
        ? `Открыт последний профиль, который успешно запускался: «${profileName}».`
        : `Открывается последний профиль, который успешно запускался: «${profileName}».`,
    }
  }
  return {
    title: 'Unable to Open Profile',
    body: state === 'reopened'
      ? `Reopened last-known-good profile ${profileName}.`
      : `Reopening last-known-good profile ${profileName}.`,
  }
}

/** Describe optional client plugins skipped during a recoverable startup. */
export function desktopSkippedOptionalEntriesNotification(
  locale: DesktopLocale,
  names: readonly string[],
): DesktopNotification | undefined {
  const first = names[0]
  if (first === undefined) return undefined
  const more = names.length - 1
  if (locale === 'zh') {
    return {
      title: '已跳过不可用的界面插件',
      body: `${first} 未安装在当前配置中${more > 0 ? `，另有 ${String(more)} 个插件` : ''}。`,
    }
  }
  if (locale === 'ru') {
    return {
      title: 'Недоступный плагин интерфейса не загружен',
      body: `Плагин «${first}» не установлен в этом профиле.${more > 0 ? ` Других недоступных плагинов: ${String(more)}.` : ''}`,
    }
  }
  return {
    title: 'Skipped Unavailable UI Plugin',
    body: `${first} is not installed in this profile${more > 0 ? ` and ${String(more)} more` : ''}.`,
  }
}

/** Describe the first Windows storage concern surfaced after startup. */
export function desktopWindowsVolumeNotification(
  locale: DesktopLocale,
  label: string | undefined,
): DesktopNotification {
  if (locale === 'zh') {
    return {
      title: '存储位置可能不受支持',
      body: `${label ?? '一个已配置路径'} 所在的卷可能导致沙箱命令或插件安装失败。`,
    }
  }
  if (locale === 'ru') {
    return {
      title: 'Хранилище может быть несовместимо',
      body: label === undefined
        ? 'Один из настроенных путей находится на томе, из-за которого могут возникать сбои при выполнении команд в изолированной среде или установке плагинов.'
        : `Путь «${label}» находится на томе, из-за которого могут возникать сбои при выполнении команд в изолированной среде или установке плагинов.`,
    }
  }
  return {
    title: 'Storage May Be Unsupported',
    body: `${label ?? 'A configured path'} is on a volume that may break sandboxed commands or plugin installs.`,
  }
}
