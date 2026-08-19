import type { NativeImage } from 'electron'
import { describe, expect, it } from 'vitest'
import type { DesktopShellSpec } from '../src/runtime.ts'
import {
  advancedWindowOptions,
  compatibilityWindowOptions,
  desktopWindowOptions,
} from '../src/window-options.ts'
import { WINDOWS_TITLEBAR_HEIGHT } from '../src/window-chrome.ts'

const spec: DesktopShellSpec = {
  mode: 'compatibility',
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
  url: 'http://127.0.0.1:43120/',
  productName: 'DSH Desktop',
  windowTitle: 'DeepSeek Harness Desktop',
  iconPath: '/tmp/app-icon.png',
  trayIcons: {
    templatePath: '/tmp/tray-iconTemplate.png',
    bluePath: '/tmp/tray-icon-blue.png',
  },
  readLocalePreference: () => undefined,
  readThemeSource: () => 'system',
  requestQuit: () => {},
  requestModeChange: async () => {},
}

const preload = '/tmp/preload.cjs'

describe('compatibility BrowserWindow options', () => {
  it('preserves the native frame and enables renderer isolation', () => {
    const icon = {} as NativeImage
    const options = compatibilityWindowOptions(spec, icon, 'darwin', preload)

    expect(options).toEqual(expect.objectContaining({
      title: '',
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 640,
      show: false,
      icon,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    }))
    for (const option of [
      'frame',
      'titleBarStyle',
      'titleBarOverlay',
      'trafficLightPosition',
      'transparent',
      'vibrancy',
      'visualEffectState',
      'backgroundMaterial',
      'roundedCorners',
      'thickFrame',
    ]) {
      expect(options).not.toHaveProperty(option)
    }
  })

  it('uses the native Windows caption while hiding the application menu', () => {
    const options = compatibilityWindowOptions(spec, {} as NativeImage, 'win32', preload)

    expect(options.title).toBe('DeepSeek Harness Desktop')
    expect(options.autoHideMenuBar).toBe(true)
  })

  it('rejects an advanced spec before BrowserWindow construction', () => {
    expect(() => compatibilityWindowOptions(
      { ...spec, mode: 'advanced' },
      {} as NativeImage,
      'darwin',
      preload,
    )).toThrow('unsupported compatibility window mode advanced')
  })

  it('uses hidden-inset transparent vibrancy on macOS advanced windows', () => {
    const advanced = { ...spec, mode: 'advanced' as const }
    const options = advancedWindowOptions(advanced, {} as NativeImage, 'darwin', preload)

    expect(options).toEqual(expect.objectContaining({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
    }))
    expect(desktopWindowOptions(advanced, {} as NativeImage, 'darwin', preload)).toEqual(options)
  })

  it('uses native Windows controls, Mica, shadow, and rounded corners in advanced mode', () => {
    const options = advancedWindowOptions(
      { ...spec, mode: 'advanced' },
      {} as NativeImage,
      'win32',
      preload,
    )

    expect(options).toEqual(expect.objectContaining({
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#7f858f',
        height: WINDOWS_TITLEBAR_HEIGHT,
      },
      backgroundMaterial: 'mica',
      hasShadow: true,
      roundedCorners: true,
      thickFrame: true,
    }))
  })

  it('rejects advanced mode on Linux', () => {
    expect(() => advancedWindowOptions(
      { ...spec, mode: 'advanced' },
      {} as NativeImage,
      'linux',
      preload,
    )).toThrow('supported on macOS and Windows')
  })
})
