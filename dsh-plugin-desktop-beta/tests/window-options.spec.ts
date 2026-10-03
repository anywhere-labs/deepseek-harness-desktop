import type { NativeImage } from 'electron'
import { describe, expect, it } from 'vitest'
import type { DesktopShellSpec } from '../src/runtime.ts'
import {
  advancedWindowOptions,
  compatibilityWindowOptions,
  DESKTOP_RENDERER_SESSION_PARTITION,
  desktopWindowOptions,
  extendedWindowOptions,
} from '../src/window-options.ts'
import {
  ADVANCED_MACOS_TRAFFIC_LIGHT_TOP,
  ADVANCED_WINDOWS_TITLEBAR_HEIGHT,
  DESKTOP_FRAME_HEIGHT,
  DESKTOP_FRAME_MACOS_TRAFFIC_LIGHT_TOP,
} from '../src/window-chrome.ts'

const spec: DesktopShellSpec = {
  mode: 'compatibility',
  macosMaterial: 'transparent',
  windowsMaterial: 'off',
  material: 'off',
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
  url: 'http://127.0.0.1:43120/',
  authenticationUrl: 'http://127.0.0.1:43120/?token=test-token',
  rendererAccessHeader: {
    name: 'x-dsh-desktop-renderer',
    value: Buffer.alloc(32, 8).toString('base64url'),
  },
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
  it('uses an independent 36px macOS frame and enables renderer isolation', () => {
    const icon = {} as NativeImage
    const options = compatibilityWindowOptions(spec, icon, 'darwin', preload)

    expect(options).toEqual(expect.objectContaining({
      title: '',
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 640,
      show: false,
      backgroundColor: '#202124',
      icon,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: DESKTOP_FRAME_MACOS_TRAFFIC_LIGHT_TOP },
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: DESKTOP_RENDERER_SESSION_PARTITION,
      },
    }))
    expect(options).not.toHaveProperty('titleBarOverlay')
    expect(DESKTOP_FRAME_HEIGHT).toBe(36)
  })

  it('uses an independent Windows frame with native controls on the left-side action layout', () => {
    const options = compatibilityWindowOptions(spec, {} as NativeImage, 'win32', preload)

    expect(options.title).toBe('DeepSeek Harness Desktop')
    expect(options.backgroundColor).toBe('#202124')
    expect(options.autoHideMenuBar).toBe(true)
    expect(options.titleBarStyle).toBe('hidden')
    expect(options.titleBarOverlay).toEqual(expect.objectContaining({ height: DESKTOP_FRAME_HEIGHT }))
  })

  it('keeps the ordinary native frame as the Linux compatibility fallback', () => {
    const options = compatibilityWindowOptions(spec, {} as NativeImage, 'linux', preload)

    expect(options).not.toHaveProperty('titleBarStyle')
    expect(options).not.toHaveProperty('titleBarOverlay')
    expect(options).not.toHaveProperty('trafficLightPosition')
  })

  it('reveals transparent material behind the macOS compatibility frame', () => {
    const options = compatibilityWindowOptions(
      { ...spec, material: 'transparent' },
      {} as NativeImage,
      'darwin',
      preload,
    )

    expect(options).toEqual(expect.objectContaining({
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
    }))
  })

  it('rejects an advanced spec before BrowserWindow construction', () => {
    expect(() => compatibilityWindowOptions(
      { ...spec, mode: 'advanced' },
      {} as NativeImage,
      'darwin',
      preload,
    )).toThrow('unsupported compatibility window mode advanced')
  })

  it('uses hidden-inset transparent vibrancy on macOS enhanced windows', () => {
    const advanced = { ...spec, mode: 'advanced' as const, material: 'transparent' as const }
    const options = advancedWindowOptions(advanced, {} as NativeImage, 'darwin', preload)

    expect(options).toEqual(expect.objectContaining({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: ADVANCED_MACOS_TRAFFIC_LIGHT_TOP },
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
    }))
    expect(desktopWindowOptions(advanced, {} as NativeImage, 'darwin', preload)).toEqual(options)
  })

  it('uses native Windows controls, shadow, and rounded corners on an opaque enhanced window', () => {
    const options = advancedWindowOptions(
      { ...spec, mode: 'advanced', material: 'off' },
      {} as NativeImage,
      'win32',
      preload,
    )

    expect(options).toEqual(expect.objectContaining({
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#7f858f',
        height: ADVANCED_WINDOWS_TITLEBAR_HEIGHT,
      },
      backgroundColor: '#202124',
      hasShadow: true,
      roundedCorners: true,
      thickFrame: true,
    }))
    expect(options).not.toHaveProperty('transparent')
    expect(options).not.toHaveProperty('backgroundMaterial')
  })

  it('uses the taller native caption on an opaque extended Windows window', () => {
    const extended = {
      ...spec,
      mode: 'extended' as const,
      material: 'off' as const,
    }
    const options = extendedWindowOptions(extended, {} as NativeImage, 'win32', preload)

    expect(options).toEqual(expect.objectContaining({
      titleBarStyle: 'hidden',
      titleBarOverlay: expect.objectContaining({ height: DESKTOP_FRAME_HEIGHT }),
      backgroundColor: '#202124',
    }))
    expect(options).not.toHaveProperty('transparent')
    expect(options).not.toHaveProperty('backgroundMaterial')
    expect(DESKTOP_FRAME_HEIGHT).toBe(36)
    expect(desktopWindowOptions(extended, {} as NativeImage, 'win32', preload)).toEqual(options)
  })

  it('centers macOS traffic lights in the 36px extended command bar', () => {
    const options = extendedWindowOptions(
      { ...spec, mode: 'extended', material: 'transparent' },
      {} as NativeImage,
      'darwin',
      preload,
    )

    expect(options.trafficLightPosition).toEqual({ x: 16, y: DESKTOP_FRAME_MACOS_TRAFFIC_LIGHT_TOP })
    expect(DESKTOP_FRAME_HEIGHT).toBe(36)
  })

  it('rejects enhanced mode on Linux', () => {
    expect(() => advancedWindowOptions(
      { ...spec, mode: 'advanced' },
      {} as NativeImage,
      'linux',
      preload,
    )).toThrow('supported on macOS and Windows')
  })
})
