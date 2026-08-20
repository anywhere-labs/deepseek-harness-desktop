import { beforeEach, describe, expect, it, vi } from 'vitest'
import { electronPlatformStrategy } from '../src/electron-platform.ts'

const electron = vi.hoisted(() => {
  const previousApplicationMenu = { name: 'previous application menu' }
  let applicationMenu: unknown = previousApplicationMenu
  const menuTemplates: unknown[][] = []
  return {
    app: {
      dock: {
        setIcon: vi.fn(),
      },
    },
    Menu: {
      buildFromTemplate: vi.fn((template: unknown[]) => {
        menuTemplates.push(template)
        return { template }
      }),
      getApplicationMenu: vi.fn(() => applicationMenu),
      setApplicationMenu: vi.fn((menu: unknown) => { applicationMenu = menu }),
    },
    menuTemplates,
    previousApplicationMenu,
    replaceApplicationMenu(menu: unknown) { applicationMenu = menu },
    resetApplicationMenu() {
      applicationMenu = previousApplicationMenu
      menuTemplates.length = 0
    },
    currentApplicationMenu: () => applicationMenu,
  }
})

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
    electron.resetApplicationMenu()
    vi.clearAllMocks()
  })

  it('selects the Windows adapter and configures native window chrome', () => {
    const strategy = electronPlatformStrategy('win32')
    const window = createWindow()
    const icon = {} as Parameters<typeof strategy.configureApplication>[0]

    expect(strategy.platform).toBe('win32')
    expect(strategy.updateDownloadPlatform).toBe('win32')
    expect(strategy.canPickDirectory).toBe(true)
    expect(strategy.canToggleShellMode).toBe(true)

    strategy.configureApplication(icon)
    strategy.configureWindow(window as never)
    const disposeMenu = strategy.installApplicationMenu({
      productName: 'DSH Desktop',
      openDesktopLabel: 'Open DSH Desktop',
      showDesktop: vi.fn(),
    })
    strategy.refreshThemeMaterial(window as never)
    disposeMenu()

    expect(electron.app.dock.setIcon).not.toHaveBeenCalled()
    expect(electron.Menu.setApplicationMenu).not.toHaveBeenCalled()
    expect(window.removeMenu).toHaveBeenCalledTimes(1)
    expect(window.setBackgroundMaterial).toHaveBeenCalledWith('mica')
  })

  it('selects the macOS adapter and installs a recoverable application menu', () => {
    const strategy = electronPlatformStrategy('darwin')
    const window = createWindow()
    const icon = {} as Parameters<typeof strategy.configureApplication>[0]
    const showDesktop = vi.fn()

    expect(strategy.platform).toBe('darwin')
    expect(strategy.updateDownloadPlatform).toBe('darwin')
    expect(strategy.canPickDirectory).toBe(false)
    expect(strategy.canToggleShellMode).toBe(true)

    strategy.configureApplication(icon)
    strategy.configureWindow(window as never)
    const disposeMenu = strategy.installApplicationMenu({
      productName: 'DSH Desktop',
      openDesktopLabel: 'Open DSH Desktop',
      showDesktop,
    })
    strategy.refreshThemeMaterial(window as never)

    expect(electron.app.dock.setIcon).toHaveBeenCalledWith(icon)
    expect(window.removeMenu).not.toHaveBeenCalled()
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled()
    expect(electron.Menu.setApplicationMenu).toHaveBeenCalledOnce()

    const applicationMenu = electron.menuTemplates[0]?.[0] as {
      label?: string
      submenu?: Array<{ label?: string, role?: string, type?: string, click?: () => void }>
    }
    expect(applicationMenu.label).toBe('DSH Desktop')
    expect(applicationMenu.submenu).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'about' }),
      expect.objectContaining({ label: 'Open DSH Desktop' }),
      expect.objectContaining({ role: 'services' }),
      expect.objectContaining({ role: 'hide' }),
      expect.objectContaining({ role: 'quit' }),
    ]))
    expect(electron.menuTemplates[0]?.slice(1)).toEqual([
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ])

    applicationMenu.submenu?.find(item => item.label === 'Open DSH Desktop')?.click?.()
    expect(showDesktop).toHaveBeenCalledOnce()

    disposeMenu()
    expect(electron.currentApplicationMenu()).toBe(electron.previousApplicationMenu)
  })

  it('does not overwrite an application menu that replaced the macOS generation menu', () => {
    const strategy = electronPlatformStrategy('darwin')
    const disposeMenu = strategy.installApplicationMenu({
      productName: 'DSH Desktop',
      openDesktopLabel: 'Open DSH Desktop',
      showDesktop: vi.fn(),
    })
    const replacementMenu = { name: 'replacement application menu' }
    electron.replaceApplicationMenu(replacementMenu)

    disposeMenu()

    expect(electron.currentApplicationMenu()).toBe(replacementMenu)
    expect(electron.Menu.setApplicationMenu).toHaveBeenCalledOnce()
  })

  it('selects the Linux adapter without desktop chrome tweaks', () => {
    const strategy = electronPlatformStrategy('linux')
    const window = createWindow()

    expect(strategy.platform).toBe('linux')
    expect(strategy.updateDownloadPlatform).toBeUndefined()
    expect(strategy.canPickDirectory).toBe(false)
    expect(strategy.canToggleShellMode).toBe(false)

    strategy.configureApplication({} as never)
    strategy.configureWindow(window as never)
    const disposeMenu = strategy.installApplicationMenu({
      productName: 'DSH Desktop',
      openDesktopLabel: 'Open DSH Desktop',
      showDesktop: vi.fn(),
    })
    strategy.refreshThemeMaterial(window as never)
    disposeMenu()

    expect(electron.app.dock.setIcon).not.toHaveBeenCalled()
    expect(electron.Menu.setApplicationMenu).not.toHaveBeenCalled()
    expect(window.removeMenu).not.toHaveBeenCalled()
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled()
  })

  it('rejects unsupported platforms', () => {
    expect(() => electronPlatformStrategy('aix')).toThrow('unsupported Electron platform aix')
  })
})
