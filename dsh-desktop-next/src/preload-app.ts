/** Alpha.2 boot and directory-picker contracts; no generic IPC bridge. */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from './ipc.ts'
import { markDocumentPlatform } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'
import { syncWindowsAppearance } from './preload-windows.ts'
import { syncWindowMaterial } from './preload-material.ts'
import { syncNativeLocale } from './preload-locale.ts'
import { permissionBridge } from './preload-permissions.ts'
import { onOpenSettings } from './preload-settings.ts'
import { createDesktopKeyboardBridge } from './preload-keyboard.ts'
import { createDesktopBrowserBridge } from './preload-browser.ts'

if (location.protocol === 'dsh-app:' && location.hostname === 'app') {
  markDocumentPlatform()
  syncNativeTheme()
  syncNativeLocale()
  syncWindowsAppearance()
  syncWindowMaterial()
  contextBridge.exposeInMainWorld('dshOnboarding', {
    setActive: (active: boolean) => { void ipcRenderer.invoke('dsh-desktop:setup-onboarding', { action: 'active', active }).catch(() => {}) },
  })
  contextBridge.exposeInMainWorld('dshDesktopSetup', {
    read: () => ipcRenderer.invoke('dsh-desktop:setup-onboarding', { action: 'read' }),
    dismissAccount: (profile: string) => ipcRenderer.invoke('dsh-desktop:setup-onboarding', { action: 'dismiss-account', profile }),
    finish: (profile: string, selection?: unknown) => ipcRenderer.invoke('dsh-desktop:setup-onboarding', { action: 'finish', profile, selection }),
  })
  contextBridge.exposeInMainWorld('desktopNext', {
    permissions: permissionBridge(),
    onOpenSettings,
    state: () => ipcRenderer.invoke(IPC.state),
    browserLinks: () => ipcRenderer.invoke(IPC.browserLinks),
    command: (command: unknown) => ipcRenderer.invoke(IPC.command, command),
  })
  // dsh 0.1.7 implements the native Sidebar browser itself and reads its transport from this
  // carrier; without `browser` the official plugin silently falls back to the sandboxed iframe.
  contextBridge.exposeInMainWorld('dshDesktop', { protocolVersion: 1, browser: createDesktopBrowserBridge(), ...createDesktopKeyboardBridge() })
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(IPC.boot),
    failed: (message: string) => ipcRenderer.invoke(IPC.failed, message),
  })
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', { pick: () => ipcRenderer.invoke(IPC.directory) })
}
