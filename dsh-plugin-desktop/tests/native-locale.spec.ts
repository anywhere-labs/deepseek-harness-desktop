import { describe, expect, it } from 'vitest'
import {
  desktopInstallRollbackCopy,
  desktopNativeCopy,
  desktopProfileRecoveryNotification,
  desktopSkippedOptionalEntriesNotification,
  desktopWindowsVolumeNotification,
} from '../src/native-locale.ts'
import {
  desktopDiagnosticsPrivacyCopy,
  desktopLocaleFromLanguageTag,
  desktopTrayLabel,
} from '../src/tray-locale.ts'

describe('desktop native locale', () => {
  it.each([
    ['ru', 'ru'],
    ['ru-RU', 'ru'],
    ['ru_RU', 'ru'],
    ['RU-ru', 'ru'],
    ['zh', 'zh'],
    ['zh-Hans-CN', 'zh'],
    ['zh_TW', 'zh'],
    ['en-GB', 'en'],
    ['fr-FR', 'en'],
    ['', 'en'],
  ] as const)('resolves %s to %s', (languageTag, expected) => {
    expect(desktopLocaleFromLanguageTag(languageTag)).toBe(expected)
  })

  it('ships complete Russian tray and diagnostics copy', () => {
    expect(desktopTrayLabel('ru', 'openDesktop', 'DSH Desktop')).toBe('Открыть DSH Desktop')
    expect(desktopTrayLabel('ru', 'downloadingUpdate', '2.1.0')).toBe('Загрузка обновления DSH Desktop 2.1.0…')
    expect(desktopTrayLabel('ru', 'profile', 'desktop')).toBe('Профиль: desktop')
    expect(desktopTrayLabel('ru', 'quit')).toBe('Выйти')

    expect(desktopDiagnosticsPrivacyCopy('ru')).toEqual(expect.objectContaining({
      title: 'Экспорт данных диагностики',
      message: 'Перед отправкой проверьте содержимое архива диагностики.',
      confirm: 'Экспортировать',
      cancel: 'Отмена',
    }))
    expect(desktopDiagnosticsPrivacyCopy('ru').detail).toContain('фрагменты памяти процесса')
  })

  it('preserves dynamic values in Russian native dialogs', () => {
    const copy = desktopNativeCopy('ru')

    expect(copy.workspaceVolume.removableDetail('E:\\Проекты')).toContain('E:\\Проекты')
    expect(copy.workspaceVolume.unsupportedMessage('EXFAT')).toBe(
      'На файловой системе «EXFAT» нельзя безопасно хранить рабочую область DSH Desktop.',
    )
    expect(copy.pluginRecovery.detail('- dsh-vision-router', 'vision_crop failed')).toContain(
      'vision_crop failed',
    )
    expect(copy.updates.availableMessage('2.1.0')).toBe('Доступна версия DSH Desktop 2.1.0.')
    expect(copy.updates.installedVersion('2.0.1')).toBe('Установленная версия: 2.0.1')
    expect(copy.updates.removeInstallerDetail('C:\\Updates\\setup.exe')).toContain(
      'C:\\Updates\\setup.exe',
    )
  })

  it('localizes recovery and storage notifications without inflecting identifiers', () => {
    expect(desktopInstallRollbackCopy('ru', '@scope/example-plugin')).toEqual({
      title: 'Восстановлена конфигурация до установки плагина',
      message: 'DSH Desktop восстановил конфигурацию, которая использовалась до установки плагина «@scope/example-plugin».',
      detail: 'Предыдущий запуск не прошёл проверку работоспособности. DSH Desktop сохранил данные диагностики локально и восстановил package.json, pnpm-lock.yaml и pnpm-workspace.yaml. Данные диагностики не загружаются автоматически.',
      confirm: 'ОК',
    })
    expect(desktopProfileRecoveryNotification('ru', 'my-profile', 'reopening')).toEqual({
      title: 'Не удалось открыть профиль',
      body: 'Открывается последний профиль, который успешно запускался: «my-profile».',
    })
    expect(desktopWindowsVolumeNotification('ru', 'DSH_HOME')).toEqual({
      title: 'Хранилище может быть несовместимо',
      body: 'Путь «DSH_HOME» находится на томе, из-за которого могут возникать сбои при выполнении команд в изолированной среде или установке плагинов.',
    })
  })

  it.each([0, 1, 2, 4, 5, 11, 21, 22, 25, 101])(
    'uses a stable Russian counter for %s additional skipped plugins',
    (additional) => {
      const names = Array.from({ length: additional + 1 }, (_, index) => `plugin-${String(index + 1)}`)
      const notification = desktopSkippedOptionalEntriesNotification('ru', names)

      expect(notification?.body).toContain('Плагин «plugin-1» не установлен в этом профиле.')
      if (additional === 0) expect(notification?.body).not.toContain('Других недоступных плагинов')
      else expect(notification?.body).toContain(`Других недоступных плагинов: ${String(additional)}.`)
    },
  )

  it('keeps empty skipped-plugin input silent', () => {
    expect(desktopSkippedOptionalEntriesNotification('ru', [])).toBeUndefined()
  })
})
