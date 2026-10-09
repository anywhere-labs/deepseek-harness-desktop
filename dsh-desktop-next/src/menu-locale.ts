/** Built-in Desktop languages and the native-menu copy. */
const en = { application: 'Application', edit: 'Edit', menuBar: 'Application menu',
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', delete: 'Delete', selectAll: 'Select All' }
const zh: typeof en = { application: '应用', edit: '编辑', menuBar: '应用菜单',
  undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', delete: '删除', selectAll: '全选' }
const zhTW: typeof en = { application: '應用', edit: '編輯', menuBar: '應用程式選單',
  undo: '還原', redo: '重做', cut: '剪下', copy: '拷貝', paste: '貼上', delete: '刪除', selectAll: '全選' }

/** Languages owned by the Desktop shell: Simplified Chinese, Traditional Chinese and English. */
export type DesktopLocale = 'zh' | 'zh-TW' | 'en'

/** Region or script subtags that make a Chinese tag Traditional (Hant). */
const traditionalSubtags = ['hant', 'tw', 'hk', 'mo']

/**
 * Resolve one BCP 47-style tag to a shell locale, or undefined when the shell ships no copy for it.
 * @param language - an OS or document language tag, with `_` or `-` separators.
 * @returns the matching shell locale, or undefined for an unsupported language.
 */
export function desktopLocaleFromLanguageTag(language: string): DesktopLocale | undefined {
  const subtags = language.toLowerCase().replaceAll('_', '-').split('-')
  if (subtags[0] === 'zh') return subtags.slice(1).some(subtag => traditionalSubtags.includes(subtag)) ? 'zh-TW' : 'zh'
  if (subtags[0] === 'en') return 'en'
  return undefined
}

/** Follow the OS preference order, using the same primary-language match as the official frontend. */
export function preferredDesktopLocale(languages: readonly string[]): DesktopLocale {
  for (const language of languages) {
    const locale = desktopLocaleFromLanguageTag(language)
    if (locale !== undefined) return locale
  }
  return 'en'
}

/** Snap an already-resolved document language back onto complete native-menu copy. */
export function resolveDesktopLocale(language: string): { locale: DesktopLocale, messages: typeof en } {
  const locale = desktopLocaleFromLanguageTag(language) ?? 'en'
  return { locale, messages: locale === 'zh' ? zh : locale === 'zh-TW' ? zhTW : en }
}
