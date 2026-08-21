import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { macApplicationMenuTemplate, nativeMenuLocale } from '../src/native-menu.ts'

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  if (!Array.isArray(item.submenu)) throw new Error('expected an array submenu')
  return item.submenu
}

describe('native macOS application menu', () => {
  it('uses the first supported macOS preferred language', () => {
    expect(nativeMenuLocale(['zh-Hans-CN', 'en-CN'])).toBe('zh-CN')
    expect(nativeMenuLocale(['zh_CN', 'en-CN'])).toBe('zh-CN')
    expect(nativeMenuLocale(['zh-Hant-TW', 'en-US'])).toBe('en')
    expect(nativeMenuLocale(['fr-FR', 'en-US', 'zh-Hans'])).toBe('en')
    expect(nativeMenuLocale(['fr-FR'])).toBe('en')
  })

  it('localizes the complete Simplified Chinese menu while retaining native roles', () => {
    const template = macApplicationMenuTemplate('AI Buddy', 'zh-CN')

    expect(template.map(item => item.label)).toEqual([
      'AI Buddy', '文件', '编辑', '显示', '窗口',
    ])
    expect(submenu(template[0]!).map(item => item.label).filter(Boolean)).toEqual([
      '关于 AI Buddy', '服务', '隐藏 AI Buddy', '隐藏其他', '全部显示', '退出 AI Buddy',
    ])
    expect(submenu(template[1]!)).toEqual([
      expect.objectContaining({ label: '关闭窗口', role: 'close' }),
    ])
    expect(submenu(template[2]!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '拷贝', role: 'copy' }),
      expect.objectContaining({ label: '粘贴', role: 'paste' }),
      expect.objectContaining({ label: '全选', role: 'selectAll' }),
    ]))
    expect(submenu(template[3]!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '实际大小', role: 'resetZoom' }),
      expect.objectContaining({ label: '放大', role: 'zoomIn' }),
      expect.objectContaining({ label: '缩小', role: 'zoomOut' }),
    ]))
  })

  it('keeps the English fallback complete', () => {
    const template = macApplicationMenuTemplate('AI Buddy', 'en')

    expect(template.map(item => item.label)).toEqual([
      'AI Buddy', 'File', 'Edit', 'View', 'Window',
    ])
    expect(submenu(template[0]!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'About AI Buddy', role: 'about' }),
      expect.objectContaining({ label: 'Quit AI Buddy', role: 'quit' }),
    ]))
  })
})
