import { describe, expect, it } from 'vitest'
import { createWindowOptions } from '../src/window-options.ts'

describe('desktop window options', () => {
  it('gives macOS a frameless hidden-inset window with traffic lights', () => {
    expect(createWindowOptions('darwin', 'DeepSeek Harness')).toMatchObject({
      title: 'DeepSeek Harness',
      frame: false,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      transparent: true,
      backgroundColor: '#00000000',
    })
    expect(createWindowOptions('darwin', 'DeepSeek Harness').titleBarOverlay).toBeUndefined()
  })

  it('keeps Windows caption buttons through the Window Controls Overlay', () => {
    expect(createWindowOptions('win32', 'DeepSeek Harness')).toMatchObject({
      frame: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#7f858f',
        height: 44,
      },
      backgroundMaterial: 'acrylic',
      hasShadow: true,
      roundedCorners: true,
      thickFrame: true,
    })
    expect(createWindowOptions('win32', 'DeepSeek Harness').transparent).toBeUndefined()
  })

  it('uses the standard system title bar and caption buttons on Linux', () => {
    const options = createWindowOptions('linux', 'DeepSeek Harness')
    expect(options.frame).toBe(true)
    expect(options.titleBarStyle).toBeUndefined()
    expect(options.titleBarOverlay).toBeUndefined()
    expect(options.transparent).toBeUndefined()
    expect(options.backgroundColor).toBeUndefined()
  })

  it('hardens the renderer web preferences on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(createWindowOptions(platform, 'DeepSeek Harness').webPreferences).toMatchObject({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      })
    }
  })
})
