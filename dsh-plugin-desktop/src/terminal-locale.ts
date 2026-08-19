/** Desktop terminal welcome copy kept separate from shell commands and identifiers. */

import type { DesktopLocale } from './runtime.ts'

export interface DesktopTerminalCopy {
  readonly title: (version: string) => string
  readonly profile: (name: string) => string
  readonly profileDirectory: (path: string) => string
  readonly harnessHome: (path: string) => string
  readonly profileMutationNotice: (name: string) => string
  readonly commands: string
  readonly restartNotice: string
}

const COPY: Record<DesktopLocale, DesktopTerminalCopy> = {
  en: {
    title: version => `DSH Desktop ${version} terminal`,
    profile: name => `Profile: ${name}`,
    profileDirectory: path => `Profile directory: ${path}`,
    harnessHome: path => `Harness home: ${path}`,
    profileMutationNotice: name => `Plugin commands without --profile modify the ${name} profile.`,
    commands: 'Commands:',
    restartNotice: 'Restart DSH Desktop after plugin changes.',
  },
  zh: {
    title: version => `DSH Desktop ${version} 终端`,
    profile: name => `配置文件：${name}`,
    profileDirectory: path => `配置目录：${path}`,
    harnessHome: path => `Harness 主目录：${path}`,
    profileMutationNotice: name => `未指定 --profile 的插件命令会修改 ${name} 配置。`,
    commands: '命令：',
    restartNotice: '更改插件后请重新启动 DSH Desktop。',
  },
  ru: {
    title: version => `Терминал DSH Desktop ${version}`,
    profile: name => `Профиль: ${name}`,
    profileDirectory: path => `Папка профиля: ${path}`,
    harnessHome: path => `Домашний каталог Harness: ${path}`,
    profileMutationNotice: name => `Команды управления плагинами без параметра --profile изменяют профиль «${name}».`,
    commands: 'Команды:',
    restartNotice: 'После изменений в составе плагинов перезапустите DSH Desktop.',
  },
}

/** Return localized explanatory copy without translating executable commands. */
export function desktopTerminalCopy(locale: DesktopLocale): DesktopTerminalCopy {
  return COPY[locale]
}
