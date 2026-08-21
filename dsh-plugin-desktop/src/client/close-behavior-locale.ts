/** Close-behavior settings row copy (zh/en), plus the slot locale merge. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Row copy keys registered into the `settings.desktop` locale namespace. */
export type CloseBehaviorLocaleKey =
  | 'closeBehavior.title'
  | 'closeBehavior.tray'
  | 'closeBehavior.quit'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop close-behavior row copy. */
    'settings.desktop': CloseBehaviorLocaleKey
  }
}

/** zh dictionary. */
export const zh: Record<CloseBehaviorLocaleKey, string> = {
  'closeBehavior.title': '关闭窗口时',
  'closeBehavior.tray': '最小化到托盘',
  'closeBehavior.quit': '退出',
}

/** en dictionary. */
export const en: Record<CloseBehaviorLocaleKey, string> = {
  'closeBehavior.title': 'On window close',
  'closeBehavior.tray': 'Minimize to tray',
  'closeBehavior.quit': 'Quit',
}
