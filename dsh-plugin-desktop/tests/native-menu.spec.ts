import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
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
    const template = macApplicationMenuTemplate('DSH Desktop', 'zh-CN')

    expect(template.map(item => item.label)).toEqual([
      'DSH Desktop', '文件', '编辑', '显示', '窗口',
    ])
    expect(submenu(template[0]!).map(item => item.label).filter(Boolean)).toEqual([
      '关于 DSH Desktop', '服务', '隐藏 DSH Desktop', '隐藏其他', '全部显示', '退出 DSH Desktop',
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
    const template = macApplicationMenuTemplate('DSH Desktop', 'en')

    expect(template.map(item => item.label)).toEqual([
      'DSH Desktop', 'File', 'Edit', 'View', 'Window',
    ])
    expect(submenu(template[0]!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'About DSH Desktop', role: 'about' }),
      expect.objectContaining({ label: 'Quit DSH Desktop', role: 'quit' }),
    ]))
  })

  it('places trusted desktop actions in the application submenu', () => {
    const invokeTerminal = vi.fn()
    const template = macApplicationMenuTemplate('DSH Desktop', 'en', [{
      label: 'Open DSH Terminal',
      click: invokeTerminal,
    }, {
      label: 'Profile: desktop',
      submenu: [{ label: 'web', type: 'radio', checked: false }],
    }])

    expect(submenu(template[0]!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Open DSH Terminal' }),
      expect.objectContaining({
        label: 'Profile: desktop',
        submenu: [expect.objectContaining({ label: 'web', type: 'radio', checked: false })],
      }),
    ]))
    expect(submenu(template[0]!).filter(item => item.type === 'separator')).toHaveLength(4)
  })
})
