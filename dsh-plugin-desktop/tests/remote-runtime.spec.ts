import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DesktopControlPeer } from '../src/control-protocol.ts'
import { NativeDesktopControlBridge } from '../src/native-control-bridge.ts'
import { RemoteDesktopRuntime } from '../src/remote-runtime.ts'
import type { DesktopRuntime } from '../src/runtime.ts'

function pair() {
  const hostToNative = new PassThrough()
  const nativeToHost = new PassThrough()
  return {
    host: new DesktopControlPeer(nativeToHost, hostToNative),
    native: new DesktopControlPeer(hostToNative, nativeToHost),
  }
}

describe('remote Desktop runtime', () => {
  it('handshakes, schedules a serializable shell, and dispatches native callbacks', async () => {
    const control = pair()
    control.native.register('native/runtime.describe', () => ({
      platform: 'win32', locale: 'zh',
      updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.2' },
    }))
    const scheduled = vi.fn()
    control.native.register('native/shell.schedule', params => { scheduled(params); return null })
    control.native.register('native/shell.release', () => null)
    const runtime = await RemoteDesktopRuntime.connect(control.host, '/home/alice/state.json')
    const quit = vi.fn()
    const mode = vi.fn(async () => {})
    const release = runtime.schedule({
      url: 'http://127.0.0.1:43120/',
      productName: 'DSH Desktop', windowTitle: 'DSH',
      iconPath: '/wsl/icon.png',
      trayIcons: { templatePath: '/wsl/template.png', bluePath: '/wsl/blue.png' },
      mode: 'advanced', width: 1280, height: 840, minWidth: 900, minHeight: 640,
      readLocalePreference: () => 'zh',
      readThemeSource: () => 'dark',
      requestQuit: quit,
      requestModeChange: mode,
    })
    await runtime.waitUntilScheduled()

    expect(runtime.platform).toBe('win32')
    expect(runtime.locale).toBe('zh')
    expect(runtime.updates.statePath).toBe('/home/alice/state.json')
    expect(scheduled).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://127.0.0.1:43120/', mode: 'advanced', locale: 'zh', theme: 'dark',
    }))
    expect(JSON.stringify(scheduled.mock.calls[0]?.[0])).not.toContain('/wsl/icon')
    await control.native.call('host/shell.mode', { mode: 'compatibility' })
    await control.native.call('host/shell.quit', { code: 0 })
    expect(mode).toHaveBeenCalledWith('compatibility')
    expect(quit).toHaveBeenCalledWith(0)
    await release()
    runtime.dispose()
    control.host.close()
    control.native.close()
  })

  it('projects tray state and invokes the current Host callback by id', async () => {
    const control = pair()
    control.native.register('native/runtime.describe', () => ({
      platform: 'win32', locale: 'en',
      updates: { isPackaged: false, canDownload: false, currentVersion: '2.0.2' },
    }))
    const registration = vi.fn()
    const refresh = vi.fn()
    const dispose = vi.fn()
    control.native.register('native/tray.register', params => { registration(params) })
    control.native.register('native/tray.refresh', params => { refresh(params) })
    control.native.register('native/tray.dispose', params => { dispose(params) })
    const runtime = await RemoteDesktopRuntime.connect(control.host, '/tmp/update.json')
    const invoke = vi.fn(async () => {})
    let label = 'First'
    const item = runtime.registerTrayItem({ group: 'tools', order: 10, label: () => label, invoke })
    await vi.waitFor(() => { expect(registration).toHaveBeenCalledOnce() })
    const id = (registration.mock.calls[0]?.[0] as { id: string }).id
    await control.native.call('host/tray.invoke', { id })
    label = 'Second'
    item.refresh()
    item.dispose()
    await vi.waitFor(() => { expect(dispose).toHaveBeenCalledOnce() })

    expect(invoke).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ id, label: 'Second' }))
    runtime.dispose()
    control.host.close()
    control.native.close()
  })

  it('round-trips Host selection and update contracts through the native bridge', async () => {
    const control = pair()
    const selectHostTarget = vi.fn(async () => {})
    const confirmDownload = vi.fn(async () => true)
    const showManualCheckResult = vi.fn(async () => {})
    const pickDirectory = vi.fn(async () => '/home/alice/project')
    const validateDirectory = vi.fn(async (path: string) => path === '/home/alice/project')
    const nativeRuntime = {
      platform: 'win32',
      locale: 'en',
      hostTarget: {
        current: { mode: 'wsl', distribution: 'Ubuntu-24.04' },
        distributions: ['Ubuntu-24.04'],
        wslSupported: true,
      },
      selectHostTarget,
      updates: {
        isPackaged: true,
        canDownload: true,
        currentVersion: '2.0.2',
        statePath: 'C:\\state.json',
        request: vi.fn(),
        confirmDownload,
        showManualCheckResult,
        downloadAndOpen: vi.fn(async () => {}),
        notify: vi.fn(),
      },
    } as unknown as DesktopRuntime
    const bridge = new NativeDesktopControlBridge(control.native, {
      runtime: nativeRuntime,
      pickDirectory,
      validateDirectory,
      openTerminal: vi.fn(),
    })
    const runtime = await RemoteDesktopRuntime.connect(control.host, '/home/alice/update-state.json')

    await expect(control.host.call('native/shell.schedule', {
      id: 'untrusted-shell',
      url: 'https://example.com/',
      productName: 'DSH Desktop',
      windowTitle: 'DSH',
      mode: 'compatibility',
      theme: 'system',
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 640,
    })).rejects.toThrow('explicit loopback HTTP origin')
    expect(runtime.hostTarget.current).toEqual({ mode: 'wsl', distribution: 'Ubuntu-24.04' })
    await runtime.selectHostTarget({ mode: 'local' })
    expect(selectHostTarget).toHaveBeenCalledWith({ mode: 'local' })
    expect(runtime.hostTarget.current).toEqual({ mode: 'local' })
    await expect(runtime.pickDirectory()).resolves.toBe('/home/alice/project')
    await expect(runtime.validateDirectory('/home/alice/project')).resolves.toBe(true)
    await expect(runtime.updates.confirmDownload('2.1.0')).resolves.toBe(true)
    const result = {
      status: 'update-available' as const,
      currentVersion: '2.0.2',
      latestVersion: '2.1.0',
    }
    await runtime.updates.showManualCheckResult(result)
    expect(showManualCheckResult).toHaveBeenCalledWith(result)

    runtime.dispose()
    await bridge.dispose()
    control.host.close()
    control.native.close()
  })

  it('submits the isolated native Profile creator through its active Host session', async () => {
    const control = pair()
    let nativeSubmit: ((name: string) => void | Promise<void>) | undefined
    const openProfileCreateWindow = vi.fn((options: {
      onSubmit(name: string): void | Promise<void>
    }) => { nativeSubmit = options.onSubmit })
    const nativeRuntime = {
      platform: 'win32',
      locale: 'en',
      updates: {
        isPackaged: true,
        canDownload: false,
        currentVersion: '2.0.2',
      },
      openProfileCreateWindow,
    } as unknown as DesktopRuntime
    const bridge = new NativeDesktopControlBridge(control.native, {
      runtime: nativeRuntime,
      pickDirectory: vi.fn(async () => null),
      validateDirectory: vi.fn(async () => false),
      openTerminal: vi.fn(),
    })
    const runtime = await RemoteDesktopRuntime.connect(control.host, '/home/alice/update-state.json')
    const onSubmit = vi.fn(async (name: string) => {
      if (name === 'occupied') throw new Error('Profile already exists')
    })

    runtime.openProfileCreateWindow({ onSubmit })
    await vi.waitFor(() => { expect(openProfileCreateWindow).toHaveBeenCalledOnce() })
    await expect(nativeSubmit?.('occupied')).rejects.toThrow('Profile already exists')
    await expect(nativeSubmit?.('work')).resolves.toBeUndefined()
    expect(onSubmit).toHaveBeenNthCalledWith(1, 'occupied')
    expect(onSubmit).toHaveBeenNthCalledWith(2, 'work')

    runtime.dispose()
    await bridge.dispose()
    control.host.close()
    control.native.close()
  })

  it('acknowledges a WSL restart before the Windows shutdown promise settles', async () => {
    const control = pair()
    let settleRestart!: () => void
    const pendingRestart = new Promise<void>(resolve => { settleRestart = resolve })
    const requestRestart = vi.fn(() => pendingRestart)
    const nativeRuntime = {
      platform: 'win32',
      locale: 'en',
      updates: {
        isPackaged: true,
        canDownload: false,
        currentVersion: '2.0.2',
      },
      requestRestart,
    } as unknown as DesktopRuntime
    const bridge = new NativeDesktopControlBridge(control.native, {
      runtime: nativeRuntime,
      pickDirectory: vi.fn(async () => null),
      validateDirectory: vi.fn(async () => false),
      openTerminal: vi.fn(),
    })
    const runtime = await RemoteDesktopRuntime.connect(control.host, '/home/alice/update-state.json')

    await expect(runtime.requestRestart()).resolves.toBeUndefined()
    await vi.waitFor(() => { expect(requestRestart).toHaveBeenCalledOnce() })
    settleRestart()

    runtime.dispose()
    await bridge.dispose()
    control.host.close()
    control.native.close()
  })

  it('keeps automatic WSL recovery diagnostics and dialogs on the native side', async () => {
    const control = pair()
    const exportRecoveryDiagnostics = vi.fn(async () => {})
    const showProfileRestoreNotice = vi.fn(async () => {})
    const showRecoveryFailure = vi.fn(async () => 'local' as const)
    const nativeRuntime = {
      platform: 'win32',
      locale: 'zh',
      updates: {
        isPackaged: true,
        canDownload: false,
        currentVersion: '2.0.2',
      },
    } as unknown as DesktopRuntime
    const bridge = new NativeDesktopControlBridge(control.native, {
      runtime: nativeRuntime,
      pickDirectory: vi.fn(async () => null),
      validateDirectory: vi.fn(async () => false),
      openTerminal: vi.fn(),
      exportRecoveryDiagnostics,
      showProfileRestoreNotice,
      showRecoveryFailure,
    })

    await expect(control.host.call('native/recovery.export-diagnostics')).resolves.toBeNull()
    await expect(control.host.call('native/recovery.profile-restored', { profileName: 'work' })).resolves.toBeNull()
    await expect(control.host.call('native/recovery.failed', { message: 'pnpm failed' })).resolves.toBe('local')
    expect(exportRecoveryDiagnostics).toHaveBeenCalledOnce()
    expect(showProfileRestoreNotice).toHaveBeenCalledWith('work')
    expect(showRecoveryFailure).toHaveBeenCalledWith('pnpm failed')

    await bridge.dispose()
    control.host.close()
    control.native.close()
  })
})
