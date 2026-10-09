import { expect, it } from 'vitest'
import { preferredDesktopLocale } from '../src/menu-locale.ts'

it.each([
  [['zh-Hans-CN', 'en-US'], 'zh'], [['zh-Hant-TW'], 'zh-TW'], [['zh_CN'], 'zh'], [['zh-TW'], 'zh-TW'], [['zh-HK'], 'zh-TW'], [['zh-Hant'], 'zh-TW'], [['zh-CN'], 'zh'],
  [['en-GB', 'zh-CN'], 'en'], [['ja-JP', 'zh-CN', 'en-US'], 'zh'], [['fr-FR'], 'en'], [[], 'en'],
] as const)('chooses a supported language from %j in preference order', (languages, expected) => {
  expect(preferredDesktopLocale(languages)).toBe(expected)
})
