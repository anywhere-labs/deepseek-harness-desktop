import { describe, expect, it } from 'vitest'
import { desktopDegradedNotice } from '../../src/client/degraded-notice.ts'

describe('desktop degraded notice', () => {
  it('formats a degraded banner only when bundles are present', () => {
    expect(desktopDegradedNotice([], 'zh')).toEqual({
      active: false,
      title: '',
      body: '',
      dismissLabel: '',
      restoreLabel: '',
    })
    expect(desktopDegradedNotice(['plugin-x'], 'zh')).toMatchObject({
      active: true,
      title: '安全降级模式',
    })
  })

  it('carries the exact body copy for zh and en', () => {
    expect(desktopDegradedNotice(['plugin-a', 'plugin-b'], 'zh')).toMatchObject({
      body: '插件 plugin-a, plugin-b 未加载，基础聊天/WebUI 可用，部分功能受限。',
    })
    expect(desktopDegradedNotice(['plugin-a'], 'en')).toEqual({
      active: true,
      title: 'Safe degraded mode',
      body: 'Plugins plugin-a did not load. Core chat/WebUI is available; some features are limited.',
      dismissLabel: 'Dismiss',
      restoreLabel: 'Restore',
    })
  })

  it('labels the dismiss and restore actions per locale', () => {
    expect(desktopDegradedNotice(['plugin-x'], 'zh')).toMatchObject({
      dismissLabel: '忽略',
      restoreLabel: '立即恢复',
    })
    expect(desktopDegradedNotice(['plugin-x'], 'en')).toMatchObject({
      dismissLabel: 'Dismiss',
      restoreLabel: 'Restore',
    })
  })
})
