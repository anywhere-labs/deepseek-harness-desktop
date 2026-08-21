import { beforeEach, describe, expect, it, vi } from 'vitest'
import { electronPlatformStrategy } from '../src/electron-platform.ts'

const electron = vi.hoisted(() => ({
  app: {
    dock: {
      setIcon: vi.fn(),
    },
    getPreferredSystemLanguages: vi.fn(() => ['en-US']),
  },
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => template),
    setApplicationMenu: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  app: electron.app,
  Menu: electron.Menu,
}))

function createWindow(): {
  readonly removeMenu: ReturnType<typeof vi.fn>
  readonly setBackgroundMaterial: ReturnType<typeof vi.fn>
} {
  return {
    removeMenu: vi.fn(),
    setBackgroundMaterial: vi.fn(),
  }
}

describe('electronPlatformStrategy', () => {
  beforeEach(() => {
    electron.app.dock.setIcon.mockClear()
    electron.Menu.buildFromTemplate.mockClear()
    electron.Menu.setApplicationMenu.mockClear()
  })

  it('selects the Windows adapter and configures native window chrome', () => {
    const strategy = electronPlatformStrategy('win32')
    const window = createWindow()
    const icon = {} as Parameters<typeof strategy.configureApplication>[0]

    expect(strategy.platform).toBe('win32')
    expect(strategy.updateDownloadPlatform).toBe('win32')
    expect(strategy.canPickDirectory).toBe(true)
    expect(strategy.canToggleShellMode).toBe(true)

    strategy.configureApplication(icon, 'DSH Desktop')
    strategy.configureWindow(window as never)
    strategy.refreshThemeMaterial(window as never)

    expect(electron.app.dock.setIcon).not.toHaveBeenCalled()
    expect(electron.Menu.setApplicationMenu).not.toHaveBeenCalled()
    expect(window.removeMenu).toHaveBeenCalledTimes(1)
    expect(window.setBackgroundMaterial).toHaveBeenCalledWith('mica')
  })

  it('selects the macOS adapter and configures its native application chrome', () => {
    const strategy = electronPlatformStrategy('darwin')
    const window = createWindow()
    const icon = {} as Parameters<typeof strategy.configureApplication>[0]

    expect(strategy.platform).toBe('darwin')
    expect(strategy.updateDownloadPlatform).toBe('darwin')
    expect(strategy.canPickDirectory).toBe(false)
    expect(strategy.canToggleShellMode).toBe(true)

    strategy.configureApplication(icon, 'DSH Desktop')
    strategy.configureWindow(window as never)
    strategy.refreshThemeMaterial(window as never)

    expect(electron.app.dock.setIcon).toHaveBeenCalledWith(icon)
    expect(electron.Menu.buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(electron.Menu.setApplicationMenu).toHaveBeenCalledTimes(1)
    expect(window.removeMenu).not.toHaveBeenCalled()
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled()
  })

  it('selects the Linux adapter without desktop chrome tweaks', () => {
    const strategy = electronPlatformStrategy('linux')
    const window = createWindow()

    expect(strategy.platform).toBe('linux')
    expect(strategy.updateDownloadPlatform).toBeUndefined()
    expect(strategy.canPickDirectory).toBe(false)
    expect(strategy.canToggleShellMode).toBe(false)

    strategy.configureApplication({} as never, 'DSH Desktop')
    strategy.configureWindow(window as never)
    strategy.refreshThemeMaterial(window as never)

    expect(electron.app.dock.setIcon).not.toHaveBeenCalled()
    expect(electron.Menu.setApplicationMenu).not.toHaveBeenCalled()
    expect(window.removeMenu).not.toHaveBeenCalled()
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled()
  })

  it('rejects unsupported platforms', () => {
    expect(() => electronPlatformStrategy('aix')).toThrow('unsupported Electron platform aix')
  })
})
