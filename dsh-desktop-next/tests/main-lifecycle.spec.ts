/** Native lifecycle contracts exercised without starting Electron or a Host. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_PREFERENCES } from '../src/desktop-contract.ts'
import type { NextDesktopRuntime } from '../src/desktop-runtime.ts'
import { NextProfiles } from '../src/profiles.ts'
import { NextRecovery } from '../src/recovery.ts'

const fixture = vi.hoisted(() => ({
  windows: [] as any[], trays: [] as any[], handlers: new Map<string, (...args: any[]) => any>(),
  load: vi.fn(), report: vi.fn(), plugin: vi.fn(), pluginDone: vi.fn(), diagnosticAppend: vi.fn(),
  terminalTarget: vi.fn(), openTerminal: vi.fn(),
  stop: vi.fn(async () => {}),
  close: vi.fn(async () => {}), start: vi.fn(async () => {}), preferences: { closeToTray: true },
  phase: 'ready' as 'ready' | 'error',
  needsOnboarding: false, corruptProfile: false, restart: vi.fn(),
  onPermission: undefined as ConstructorParameters<typeof NextDesktopRuntime>[0]['onPermission'],
}))
vi.mock('../src/desktop-runtime.ts', async () => { const { NextProfiles } = await import('../src/profiles.ts'); const { NextRecovery } = await import('../src/recovery.ts'); return { NextDesktopRuntime: class {
  preferences = { ...DEFAULT_PREFERENCES }
  busy = false
  selected = 'desktop'
  safeMode = false
  recoveryMode = false
  backend = { stop: fixture.stop, host: undefined, get state() { return { phase: fixture.phase } } }
  profiles: NextProfiles
  recovery: import('../src/recovery.ts').NextRecovery
  diagnostics = { append: fixture.diagnosticAppend, flush: vi.fn(), hostChunk: vi.fn() }
  constructor(options: ConstructorParameters<typeof NextDesktopRuntime>[0]) {
    fixture.preferences = this.preferences; fixture.onPermission = options.onPermission
    this.profiles = new NextProfiles(options.home)
    this.recovery = new NextRecovery(this.profiles)
    this.profiles.ensure('desktop')
    if (!fixture.needsOnboarding) this.profiles.finishOnboarding('desktop')
    if (fixture.corruptProfile) writeFileSync(join(this.profiles.directory('desktop'), 'package.json'), '{broken')
  }
  initialize() {}
  start = fixture.start
  close = fixture.close
  async restart(change: () => Promise<void>) { await change(); this.recoveryMode = false; await fixture.restart() }
  terminalTarget = fixture.terminalTarget
  browserLinks() { return { localUrl: null, lanUrls: [] } }
  state() { return { selected: 'desktop', profiles: ['desktop'], unavailableProfiles: [], features: fixture.corruptProfile ? { remoteControl: false, market: true } : this.profiles.features(this.selected),
    preferences: this.preferences, phase: this.recoveryMode ? 'recovery' : fixture.phase, busy: this.busy, failure: 'Fixture Host failure', safeMode: this.safeMode,
    home: 'temporary', browserUrl: null, lan: null, checkpoint: null, logs: '' } }
  report = fixture.report
} } })
vi.mock('../src/extensions.ts', async importOriginal => {
  const { EventEmitter } = await import('node:events')
  return { ...await importOriginal<typeof import('../src/extensions.ts')>(), createPackageRunner: () => ({
    runPlugin: (...args: unknown[]) => { fixture.plugin(...args); return { stdout: new EventEmitter(), stderr: new EventEmitter(), done: fixture.pluginDone() } },
    dispose: async () => {},
  }) }
})
vi.mock('../src/desktop-terminal.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/desktop-terminal.ts')>(), openDesktopTerminal: fixture.openTerminal }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const app = Object.assign(new EventEmitter(), {
    setName() {}, setPath() {}, getPath: () => process.env.DSH_DESKTOP_NEXT_HOME, getLocale: () => 'en-US', getPreferredSystemLanguages: () => ['zh-Hans-CN', 'en-US'], isReady: () => true, whenReady: async () => {},
    requestSingleInstanceLock: () => true, exit: vi.fn(), relaunch: vi.fn(), quit: vi.fn(() => app.emit('before-quit', { preventDefault() {} })),
  })
  class BrowserWindow extends EventEmitter {
    visible = false
    loadedUrls: string[] = []
    webContents = Object.assign(new EventEmitter(), { id: fixture.windows.length + 1,
      mainFrame: { url: '' }, getURL: () => this.webContents.mainFrame.url, setWindowOpenHandler() {}, send: vi.fn(), isDestroyed: () => false,
      setIgnoreMenuShortcuts() {}, isFocused: () => true, executeJavaScript: vi.fn(async () => true) })
    constructor(readonly options: any) { super(); fixture.windows.push(this) }
    destroyed = false
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    isFocused() { return false }
    show() { this.visible = true }
    hide() { this.visible = false }
    focus() {}
    setSize() {}
    setResizable() {}
    setMinimumSize() {}
    close() { this.destroy() }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed') }
    setVibrancy() {}
    setBackgroundColor() {}
    setBackgroundMaterial() {}
    async loadURL(url: string) { this.webContents.mainFrame.url = url; this.loadedUrls.push(url); await fixture.load(this, url) }
  }
  class Tray extends EventEmitter {
    destroyed = false
    menu: any
    tooltip = ''
    constructor() { super(); fixture.trays.push(this) }
    isDestroyed() { return this.destroyed }
    setToolTip(value: string) { this.tooltip = value }
    setTitle() {}
    setContextMenu(menu: any) { this.menu = menu }
    destroy() { this.destroyed = true }
  }
  return { app, BrowserWindow, Tray, autoUpdater: Object.assign(new EventEmitter(), { setFeedURL: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn() }), net: { fetch: vi.fn() },
    Notification: class { static isSupported() { return false } },
    clipboard: {}, dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) }, shell: {}, safeStorage: {}, nativeTheme: { shouldUseDarkColors: true, on() {} },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage() {} }) },
    Menu: { buildFromTemplate: (items: any) => items, setApplicationMenu() {} },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    session: { defaultSession: { webRequest: { onBeforeSendHeaders() {} }, setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDisplayMediaRequestHandler() {} } },
    systemPreferences: { getMediaAccessStatus: () => 'not-determined', askForMediaAccess: vi.fn(async () => false), isTrustedAccessibilityClient: () => false },
    desktopCapturer: { getSources: vi.fn(async () => []) },
    ipcMain: { removeHandler: (name: string) => fixture.handlers.delete(name), handle: (name: string, action: (...args: any[]) => any) => fixture.handlers.set(name, action), on: (name: string, action: (...args: any[]) => any) => fixture.handlers.set(name, action) },
  }
})

beforeEach(async () => {
  vi.resetModules()
  fixture.windows.length = 0; fixture.trays.length = 0; fixture.handlers.clear()
  fixture.phase = 'ready'
  fixture.needsOnboarding = false; fixture.corruptProfile = false; fixture.restart.mockReset()
  fixture.plugin.mockReset(); fixture.pluginDone.mockReset().mockResolvedValue({ exitCode: 0 });
  fixture.load.mockReset(); fixture.report.mockReset(); fixture.diagnosticAppend.mockReset();
  fixture.terminalTarget.mockReset(); fixture.openTerminal.mockClear();
  fixture.stop.mockClear(); fixture.start.mockClear(); fixture.close.mockReset().mockResolvedValue(undefined)
  const { app, autoUpdater } = await import('electron')
  autoUpdater.removeAllListeners()
  app.removeAllListeners()
  vi.mocked(app.relaunch).mockClear()
  vi.mocked(app.quit).mockClear()
})

it('captures scoped client errors with either Electron console-message signature without crashing on missing text', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-console-message-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const consoleMessage = fixture.windows[0].webContents
    consoleMessage.emit('console-message', {}, 2, '[next-ui-diagnostic] aa=false')
    consoleMessage.emit('console-message', { message: "slot entry crashed in 'sidebar.footer.action': error" })
    consoleMessage.emit('console-message', {}, 2)
    consoleMessage.emit('console-message', {}, 2, 'unrelated output')
    expect(fixture.diagnosticAppend).toHaveBeenCalledTimes(2)
    expect(fixture.diagnosticAppend).toHaveBeenCalledWith('[next-ui-diagnostic] aa=false', 'warn')
  } finally {
    vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true })
  }
})

it('stages an explicit update before hiding windows, and hands off only after the Host closes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-install-update-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  let stageReady!: () => void
  const stage = vi.fn(() => new Promise<void>(resolve => { stageReady = resolve }))
  const launch = vi.fn(async () => {})
  vi.doMock('../src/update-installer.ts', () => ({ NextUpdateInstaller: class { stage = stage; launch = launch } }))
  vi.doMock('../src/updates.ts', () => ({ NextUpdates: class {
    constructor(private options: { install(): Promise<void> }) {}
    snapshot() { return { phase: 'ready', version: '2.0.15-next.1', installable: true } }
    start() {}
    dispose = async () => {}
    install = () => this.options.install()
  } }))
  let closed!: () => void
  fixture.close.mockImplementationOnce(() => new Promise<void>(resolve => { closed = resolve }))
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const window = fixture.windows[0]; window.visible = true
    const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    await fixture.handlers.get('dsh-next:command')!(sender, { type: 'install-update' })
    expect(stage).toHaveBeenCalledOnce(); expect(fixture.close).not.toHaveBeenCalled(); expect(window.visible).toBe(true)
    stageReady()
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce())
    expect(window.visible).toBe(false); expect(launch).not.toHaveBeenCalled()
    closed()
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
  } finally {
    vi.doUnmock('../src/update-installer.ts'); vi.doUnmock('../src/updates.ts')
    vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true })
  }
})

it('retains the Host when hiding to tray, restores the window, keeps failed-Host controls, validates IPC, and stops on explicit quit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-main-native-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const window = fixture.windows[0]
    const tray = fixture.trays[0]
    expect(tray.menu[0].label).toBe('打开 DSH NEXT')
    expect(tray.menu.at(-1).accelerator).toBe('CmdOrCtrl+Q')
    expect(tray.menu.some((item: any) => item.accelerator === 'CmdOrCtrl+,')).toBe(true)
    const preventDefault = vi.fn()
    window.visible = true
    window.emit('close', { preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(window.visible).toBe(false)
    expect(fixture.close).not.toHaveBeenCalled()
    tray.emit('click')
    expect(window.visible).toBe(true)
    const state = fixture.handlers.get('dsh-next:state')!
    const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    expect(state(sender).phase).toBe('ready')
    expect(() => state({ ...sender, senderFrame: { url: 'dsh-app://app/' } })).toThrow('Rejected')
    expect(() => state({ sender: {}, senderFrame: { url: 'dsh-app://app/' } })).toThrow('Rejected')
    const browserLinks = fixture.handlers.get('dsh-next:browser-links')!
    const permissionQuery = fixture.handlers.get('dsh-next:permission-query')!
    expect(permissionQuery(sender, 'microphone').permission).toBe('microphone')
    expect(() => permissionQuery(sender, 'camera')).toThrow('Unsupported')
    expect(() => permissionQuery({ ...sender, senderFrame: {} }, 'screen')).toThrow('Rejected')
    const permissionRequest = fixture.handlers.get('dsh-next:permission-request')!
    window.webContents.executeJavaScript.mockResolvedValueOnce(false)
    await expect(permissionRequest(sender, 'microphone')).rejects.toThrow('user gesture')
    expect(browserLinks(sender)).toEqual({ localUrl: null, lanUrls: [] })
    expect(() => browserLinks({ ...sender, senderFrame: { url: 'dsh-app://app/' } })).toThrow('Rejected')
    expect(() => browserLinks({ sender: {}, senderFrame: { url: 'dsh-app://app/' } })).toThrow('Rejected')
    await expect(fixture.handlers.get('dsh-next:command')!(sender, { type: ['restart'] })).rejects.toThrow('Invalid Next command')
    await expect(fixture.handlers.get('dsh-next:command')!(sender, { type: 'controls', page: ['general'] })).rejects.toThrow('Invalid controls page')
    await fixture.handlers.get('dsh-next:command')!(sender, { type: 'controls' })
    expect(fixture.windows).toHaveLength(1)
    expect(window.visible).toBe(true)
    expect(window.webContents.send).toHaveBeenCalledWith('dsh-next:settings-open')
    const takeSettings = fixture.handlers.get('dsh-next:settings-take')!
    expect(() => takeSettings({ ...sender, senderFrame: {} })).toThrow('Rejected')
    expect(takeSettings(sender)).toBe('general')
    expect(takeSettings(sender)).toBeUndefined()
    tray.menu.find((item: any) => item.accelerator === 'CmdOrCtrl+,').click()
    expect(takeSettings(sender)).toBe('general')
    window.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: ',', meta: true })
    expect(takeSettings(sender)).toBe('general')
    expect(fixture.windows).toHaveLength(1)
    await fixture.handlers.get('dsh-next:command')!(sender, { type: 'controls', page: 'profiles' })
    expect(fixture.windows).toHaveLength(2)
    const controls = fixture.windows[1]
    expect(controls.webContents.mainFrame.url).toBe(`dsh-app://shell/index.html?locale=zh&platform=${process.platform}&frame=${process.platform !== 'linux'}#profiles`)
    expect(state({ sender: controls.webContents, senderFrame: controls.webContents.mainFrame }).failure).toBe('Fixture Host failure')
    expect(() => takeSettings({ sender: controls.webContents, senderFrame: controls.webContents.mainFrame })).toThrow('Rejected')
    fixture.phase = 'ready'
    fixture.handlers.get('dsh-next:locale')!({ ...sender, senderFrame: {} }, 'en')
    expect(tray.menu[0].label).toBe('打开 DSH NEXT')
    fixture.handlers.get('dsh-next:locale')!(sender, 'en')
    expect(tray.menu[0].label).toBe('Open DSH NEXT')
    const { app, dialog, systemPreferences, desktopCapturer } = await import('electron')
    const previousUrl = controls.webContents.mainFrame.url
    expect((await fixture.onPermission!('query', 'screen')).status).not.toBe('granted')
    expect(controls.webContents.mainFrame.url).toBe(previousUrl)
    expect(takeSettings(sender)).toBeUndefined()
    await fixture.onPermission!('request', 'screen')
    expect(takeSettings(sender)).toBe('permissions')
    await fixture.onPermission!('open-settings', 'microphone')
    expect(takeSettings(sender)).toBe('permissions')
    expect(controls.webContents.mainFrame.url).toBe(previousUrl)
    expect(fixture.windows).toHaveLength(2)
    expect(systemPreferences.askForMediaAccess).not.toHaveBeenCalled()
    expect(desktopCapturer.getSources).not.toHaveBeenCalled()
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await fixture.handlers.get('dsh-next:command')!(sender, { type: 'restart-recovery' })
    expect(fixture.close).not.toHaveBeenCalled()
    let finishClose!: () => void
    fixture.close.mockImplementationOnce(() => {
      expect(fixture.windows.every(window => !window.visible)).toBe(true)
      return new Promise<void>(resolve => { finishClose = resolve })
    })
    await fixture.handlers.get('dsh-next:command')!(sender, { type: 'restart-recovery' })
    expect(fixture.close).toHaveBeenCalledOnce()
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(tray.destroyed).toBe(true)
    window.emit('ready-to-show')
    controls.emit('ready-to-show')
    app.emit('activate')
    expect(fixture.windows.every(window => !window.visible)).toBe(true)
    finishClose()
    await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalledWith({ args: expect.arrayContaining(['--next-recovery']) }))
  } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})


it('boots recovery in the preferred OS language even when the app locale is English, without starting a Host', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-recovery-boot-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  const argv = [...process.argv]
  process.argv.push('--next-recovery')
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const controls = fixture.windows[0]
    expect(controls.webContents.mainFrame.url).toBe(`dsh-app://shell/index.html?locale=zh&platform=${process.platform}&frame=${process.platform !== 'linux'}#recovery`)
    const sender = { sender: controls.webContents, senderFrame: controls.webContents.mainFrame }
    expect(fixture.handlers.get('dsh-next:state')!(sender).phase).toBe('recovery')
    expect(fixture.trays[0].tooltip).toContain('recovery')
    expect(fixture.start).not.toHaveBeenCalled()
    fixture.trays[0].menu[0].click()
    expect(fixture.windows).toHaveLength(1)
    expect(fixture.start).not.toHaveBeenCalled()
    controls.visible = true
    fixture.close.mockImplementationOnce(async () => { expect(controls.visible).toBe(false) })
    await fixture.handlers.get('dsh-next:command')!(sender, { type: 'quit' })
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce())
  } finally { process.argv.splice(0, process.argv.length, ...argv); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})

it('persists a Profile switch and relaunches the app only after hiding windows and closing its Host', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-profile-switch-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const manager = new NextProfiles(home)
    manager.create('work')
    const window = fixture.windows[0]
    const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const command = fixture.handlers.get('dsh-next:command')!
    const { app, dialog } = await import('electron')
    await command(sender, { type: 'switch', name: 'desktop' })
    expect(app.quit).not.toHaveBeenCalled()
    await expect(command(sender, { type: 'switch', name: 'missing' })).rejects.toThrow('unavailable')
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await command(sender, { type: 'switch', name: 'work' })
    expect(manager.active).toBe('desktop')
    expect(app.quit).not.toHaveBeenCalled()
    window.visible = true
    let finishClose!: () => void
    fixture.close.mockImplementationOnce(() => {
      expect(window.visible).toBe(false)
      expect(new NextProfiles(home).active).toBe('work')
      return new Promise<void>(resolve => { finishClose = resolve })
    })
    await command(sender, { type: 'switch', name: 'work' })
    expect(fixture.close).toHaveBeenCalledOnce()
    expect(fixture.restart).not.toHaveBeenCalled()
    expect(fixture.start).toHaveBeenCalledOnce()
    expect(window.loadedUrls).toEqual(['dsh-app://app/'])
    expect(app.relaunch).not.toHaveBeenCalled()
    finishClose()
    await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalledWith({ args: expect.any(Array) }))
    expect(vi.mocked(app.relaunch).mock.calls[0]![0]!.args).not.toContain('--next-recovery')
    expect(vi.mocked(app.relaunch).mock.calls[0]![0]!.args).not.toContain('--next-safe-mode')
  } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})

it.each(['complete', 'skip'] as const)('continues first-run setup in the official app and saves before restarting on %s', async outcome => {
  const home = mkdtempSync(join(tmpdir(), 'next-onboarding-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  fixture.needsOnboarding = true
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const window = fixture.windows[0]
    const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const setup = fixture.handlers.get('dsh-desktop:setup-onboarding')!
    const manager = new NextProfiles(home)
    expect(window.webContents.mainFrame.url).toBe('dsh-app://app/')
    expect(fixture.start).toHaveBeenCalledOnce()
    expect(await setup(sender, { action: 'read' })).toMatchObject({ required: true, edition: 'next', computerUse: false })
    await expect(setup({ ...sender, senderFrame: { url: 'dsh-app://app/' } }, { action: 'read' })).rejects.toThrow()
    await expect(setup(sender, { action: 'finish', profile: 'other' })).rejects.toThrow('unavailable')
    await expect(setup(sender, { action: 'finish', profile: 'desktop', selection: { market: 'invalid', aaEnabled: false, computerUse: false } })).rejects.toThrow('Invalid setup choices')
    expect(manager.onboardingRequired('desktop')).toBe(true)
    fixture.restart.mockImplementationOnce(async () => {
      expect(manager.onboardingRequired('desktop')).toBe(false)
      expect(manager.features('desktop')).toEqual(outcome === 'skip'
        ? { market: false, remoteControl: false } : { market: false, dshMarket: true, remoteControl: true })
      expect(manager.computerUseEnabled('desktop')).toBe(outcome === 'complete')
    })
    await setup(sender, { action: 'finish', profile: 'desktop', ...(outcome === 'complete' ? {
      selection: { market: 'dsh-market', aaEnabled: true, computerUse: true },
    } : {}) })
    expect(fixture.restart).toHaveBeenCalledOnce()
    expect(fixture.windows).toHaveLength(1)
    expect(window.loadedUrls).toEqual(['dsh-app://app/', 'dsh-app://app/'])
    expect(await setup(sender, { action: 'read' })).toMatchObject({ required: false })
    await expect(setup(sender, { action: 'finish', profile: 'desktop' })).rejects.toThrow('unavailable')
  } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})

it('reopens setup through a confirmed relaunch without resetting the Profile or stopping the Host before hiding windows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-onboarding-relaunch-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const window = fixture.windows[0]
    const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const command = fixture.handlers.get('dsh-next:command')!
    const manager = new NextProfiles(home)
    manager.finishOnboarding('desktop', { features: { market: false, dshMarket: true, remoteControl: true }, computerUse: true })
    const { app, dialog } = await import('electron')
    window.visible = true
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await command(sender, { type: 'restart-onboarding' })
    expect(app.quit).not.toHaveBeenCalled()
    expect(window.visible).toBe(true)
    expect(fixture.close).not.toHaveBeenCalled()
    let finishClose!: () => void
    fixture.close.mockImplementationOnce(() => {
      expect(window.visible).toBe(false)
      return new Promise<void>(resolve => { finishClose = resolve })
    })
    await command(sender, { type: 'restart-onboarding' })
    expect(fixture.close).toHaveBeenCalledOnce()
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(manager.onboardingRequired('desktop')).toBe(false)
    expect(manager.features('desktop')).toEqual({ market: false, dshMarket: true, remoteControl: true })
    expect(manager.computerUseEnabled('desktop')).toBe(true)
    finishClose()
    await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalledWith({ args: expect.arrayContaining(['--next-onboarding']) }))
    expect(fixture.start).toHaveBeenCalledOnce()
  } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})

it.each(['complete', 'skip', 'close'] as const)('reopens a completed Profile with its saved choices and handles %s', async outcome => {
  const home = mkdtempSync(join(tmpdir(), 'next-onboarding-reopen-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  const argv = [...process.argv]
  process.argv.push('--next-onboarding')
  try {
    const manager = new NextProfiles(home)
    manager.ensure('desktop')
    const features = { market: false, dshMarket: true, remoteControl: true }
    manager.finishOnboarding('desktop', { features, computerUse: true })
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const window = fixture.windows[0]
    const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const command = fixture.handlers.get('dsh-next:command')!
    expect(window.webContents.mainFrame.url).toBe('dsh-app://app/')
    expect(fixture.start).toHaveBeenCalledOnce()
    expect(fixture.handlers.get('dsh-next:state')!(sender)).toMatchObject({ onboarding: true, onboardingComputerUse: true, features })
    // Reopening is a launch mode, not a deletion of the completion record.
    expect(manager.onboardingRequired('desktop')).toBe(false)
    if (outcome === 'close') {
      window.close()
      expect(fixture.start).toHaveBeenCalledOnce()
    } else {
      await command(sender, outcome === 'skip' ? { type: 'onboarding-skip', profile: 'desktop' }
        : { type: 'onboarding-complete', profile: 'desktop', features: { market: true, remoteControl: false }, computerUse: false })
      expect(fixture.start).toHaveBeenCalledOnce()
      expect(fixture.restart).toHaveBeenCalledOnce()
      expect(window.loadedUrls).toEqual(['dsh-app://app/', 'dsh-app://app/'])
    }
    expect(manager.features('desktop')).toEqual(outcome === 'complete' ? { market: true, remoteControl: false } : features)
    expect(manager.computerUseEnabled('desktop')).toBe(outcome !== 'complete')
    expect(manager.onboardingRequired('desktop')).toBe(false)
    if (outcome !== 'close') {
      const { app } = await import('electron')
      const main = fixture.windows[0]
      await command({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, { type: 'restart-app' })
      await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalled())
      expect(vi.mocked(app.relaunch).mock.calls[0]![0]!.args).not.toContain('--next-onboarding')
    }
  } finally { process.argv.splice(0, process.argv.length, ...argv); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})

it.each(['--next-recovery', '--next-safe-mode'])('keeps %s independent of onboarding and clears its flag when switching Profiles', async mode => {
  const home = mkdtempSync(join(tmpdir(), 'next-onboarding-bypass-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  fixture.needsOnboarding = true
  const argv = [...process.argv]
  process.argv.push(mode, '--next-onboarding')
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const manager = new NextProfiles(home)
    const window = fixture.windows[0]
    const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    expect(window.webContents.mainFrame.url).not.toContain('#onboarding')
    expect(manager.onboardingRequired('desktop')).toBe(true)
    expect(fixture.handlers.get('dsh-next:state')!(sender).onboarding).toBe(false)
    const command = fixture.handlers.get('dsh-next:command')!
    await expect(command(sender, { type: 'onboarding-skip', profile: 'desktop' })).rejects.toThrow('unavailable')
    await expect(command(sender, { type: 'restart-onboarding' })).rejects.toThrow('unavailable')
    manager.create('work')
    await command(sender, { type: 'switch', name: 'work' })
    const { app } = await import('electron')
    await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalled())
    expect(vi.mocked(app.relaunch).mock.calls[0]![0]!.args).not.toContain(mode)
    expect(vi.mocked(app.relaunch).mock.calls[0]![0]!.args).not.toContain('--next-onboarding')
    expect(manager.active).toBe('work')
  } finally { process.argv.splice(0, process.argv.length, ...argv); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})

it('opens recovery instead of onboarding when a Profile manifest is broken', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-onboarding-broken-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  fixture.needsOnboarding = true; fixture.corruptProfile = true
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    expect(fixture.windows[0].webContents.mainFrame.url).toMatch(/#recovery$/)
    expect(fixture.start).not.toHaveBeenCalled()
    expect(fixture.trays).toHaveLength(1)
  } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})

it('does not mark an unfinished flow complete when its window closes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-onboarding-close-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  fixture.needsOnboarding = true
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    fixture.windows[0].close()
    expect(new NextProfiles(home).onboardingRequired('desktop')).toBe(true)
    const { app } = await import('electron')
    app.emit('activate')
    expect(fixture.windows).toHaveLength(2)
    expect(fixture.windows[1].webContents.mainFrame.url).toBe('dsh-app://app/')
    expect(fixture.start).toHaveBeenCalledOnce()
  } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})


it.each([false, true])('only safe mode permits the main window alongside recovery (safe=%s)', async safe => {
  const home = mkdtempSync(join(tmpdir(), 'next-recovery-windows-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  const argv = [...process.argv]
  if (safe) process.argv.push('--next-safe-mode')
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const main = fixture.windows[0]
    const command = fixture.handlers.get('dsh-next:command')!
    await command({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, { type: 'controls', page: 'recovery' })
    const recovery = fixture.windows[1]
    expect(recovery.webContents.mainFrame.url).toMatch(/#recovery$/)
    expect(main.destroyed).toBe(!safe)
    expect(fixture.stop).toHaveBeenCalledTimes(safe ? 0 : 1)
    const { app } = await import('electron')
    app.emit('activate')
    expect(fixture.windows).toHaveLength(2)
    if (!safe) {
      const sender = { sender: recovery.webContents, senderFrame: recovery.webContents.mainFrame }
      expect(fixture.handlers.get('dsh-next:state')!(sender).phase).toBe('recovery')
      await command(sender, { type: 'restart' })
      expect(recovery.destroyed).toBe(true)
      expect(fixture.windows[2].webContents.mainFrame.url).toBe('dsh-app://app/')
      expect(fixture.windows[2].loadedUrls).toEqual(['dsh-app://app/'])
    }
  } finally { process.argv.splice(0, process.argv.length, ...argv); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})


it('routes terminal commands by their authenticated window, ignoring a forged source in the payload', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-terminal-routing-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  const argv = [...process.argv]
  process.argv.push('--next-safe-mode')
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const main = fixture.windows[0]
    const sender = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
    const command = fixture.handlers.get('dsh-next:command')!
    fixture.terminalTarget.mockImplementation(repair => ({ homeDir: repair ? home : join(home, 'safe'),
      profileDir: join(repair ? home : join(home, 'safe'), 'profiles', 'desktop'), profileName: 'desktop', mode: repair ? 'recovery' : 'safe' }))
    await command(sender, { type: 'terminal', source: 'shell' })
    expect(fixture.terminalTarget).toHaveBeenLastCalledWith(false)
    const safe = fixture.openTerminal.mock.calls.at(-1)![0]
    expect(safe).toMatchObject({ homeDir: join(home, 'safe'), mode: 'safe' })
    await command(sender, { type: 'controls', page: 'recovery' })
    const recovery = fixture.windows[1]
    await command({ sender: recovery.webContents, senderFrame: recovery.webContents.mainFrame }, { type: 'terminal', source: 'app' })
    expect(fixture.terminalTarget).toHaveBeenLastCalledWith(true)
    const original = fixture.openTerminal.mock.calls.at(-1)![0]
    expect(original).toMatchObject({ homeDir: home, mode: 'recovery' })
    expect(original.stateDir).not.toBe(safe.stateDir)
  } finally { process.argv.splice(0, process.argv.length, ...argv); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})


it.each(['cancelled', 'retired', 'failed'] as const)('handles %s main-window navigation without confusing it with a Host failure', async kind => {
  const home = mkdtempSync(join(tmpdir(), 'next-navigation-failure-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  let rejectLoad!: (error: Error) => void
  fixture.load.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectLoad = reject }))
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const main = fixture.windows[0]
    if (kind === 'retired') {
      await fixture.handlers.get('dsh-next:command')!({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, { type: 'controls', page: 'recovery' })
      expect(main.destroyed).toBe(true)
    }
    const error = Object.assign(new Error(kind === 'cancelled' ? 'ERR_ABORTED (-3)' : 'ERR_FAILED (-2)'),
      { code: kind === 'cancelled' ? 'ERR_ABORTED' : 'ERR_FAILED', errno: kind === 'cancelled' ? -3 : -2 })
    rejectLoad(error)
    // Flush the loadURL and navigation-handler promise chain.
    await new Promise(resolve => setImmediate(resolve))
    if (kind === 'failed') expect(fixture.report).toHaveBeenCalledWith(error)
    else expect(fixture.report).not.toHaveBeenCalled()
    if (kind === 'retired') {
      main.webContents.emit('did-fail-load', {}, -2, 'retired navigation', 'dsh-app://app/', true)
      expect(fixture.report).not.toHaveBeenCalled()
    }
  } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})


it('loads once when entering safe mode from recovery and reloads the existing window once when leaving', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-recovery-safe-navigation-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  const argv = [...process.argv]
  process.argv.push('--next-recovery')
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const recovery = fixture.windows[0]
    const sender = { sender: recovery.webContents, senderFrame: recovery.webContents.mainFrame }
    const command = fixture.handlers.get('dsh-next:command')!
    await command(sender, { type: 'safe-mode' })
    const main = fixture.windows[1]
    expect(main.loadedUrls).toEqual(['dsh-app://app/'])
    expect(recovery.destroyed).toBe(false)
    await command(sender, { type: 'normal-mode' })
    expect(fixture.windows).toHaveLength(2)
    expect(main.loadedUrls).toEqual(['dsh-app://app/', 'dsh-app://app/'])
    expect(recovery.destroyed).toBe(true)
    expect(fixture.report).not.toHaveBeenCalled()
  } finally { process.argv.splice(0, process.argv.length, ...argv); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})


it.each(['--next-safe-mode', '--next-recovery'])('restarts the whole app in normal mode from the recovery footer after %s', async mode => {
  const home = mkdtempSync(join(tmpdir(), 'next-recovery-footer-restart-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  const argv = [...process.argv]
  process.argv.push(mode, '--next-onboarding')
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const initial = fixture.windows[0]
    const command = fixture.handlers.get('dsh-next:command')!
    await command({ sender: initial.webContents, senderFrame: initial.webContents.mainFrame }, { type: 'controls', page: 'recovery' })
    const recovery = fixture.windows.at(-1)
    const sender = { sender: recovery.webContents, senderFrame: recovery.webContents.mainFrame }
    const { app, dialog } = await import('electron')
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await command(sender, { type: 'recovery-action', action: 'restart' })
    expect(app.quit).not.toHaveBeenCalled()
    let finishClose!: () => void
    fixture.windows.forEach(window => { window.visible = true })
    const navigations = fixture.windows.map(window => [...window.loadedUrls])
    fixture.close.mockImplementationOnce(() => {
      expect(fixture.windows.every(window => !window.visible)).toBe(true)
      return new Promise<void>(resolve => { finishClose = resolve })
    })
    await command(sender, { type: 'recovery-action', action: 'restart' })
    expect(fixture.close).toHaveBeenCalledOnce()
    expect(fixture.restart).not.toHaveBeenCalled()
    expect(fixture.windows.map(window => window.loadedUrls)).toEqual(navigations)
    expect(app.relaunch).not.toHaveBeenCalled()
    finishClose()
    await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalledOnce())
    const args = vi.mocked(app.relaunch).mock.calls[0]![0]!.args!
    expect(args).not.toContain('--next-safe-mode')
    expect(args).not.toContain('--next-recovery')
    expect(args).not.toContain('--next-onboarding')
    expect(new NextProfiles(home).active).toBe('desktop')
  } finally { process.argv.splice(0, process.argv.length, ...argv); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})


it.each(['success', 'cancel', 'failure'] as const)('restores a checkpoint with dependency reconciliation and accurate feedback: %s', async outcome => {
  const home = mkdtempSync(join(tmpdir(), 'next-checkpoint-feedback-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  const argv = [...process.argv]
  process.argv.push('--next-recovery')
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const manager = new NextProfiles(home), recovery = new NextRecovery(manager)
    const patch = join(manager.directory('desktop'), 'cordis.patch.yml')
    writeFileSync(patch, '# saved\n[]\n')
    recovery.checkpoint('desktop')
    const checkpoint = recovery.checkpoints('desktop')[0]!
    writeFileSync(patch, '# modified\n[]\n')
    const window = fixture.windows[0]
    const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const command = fixture.handlers.get('dsh-next:command')!
    const state = () => fixture.handlers.get('dsh-next:state')!(sender)
    const { dialog } = await import('electron')
    if (outcome === 'cancel') vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    let finish!: (value: { exitCode: number }) => void
    fixture.pluginDone.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = command(sender, { type: 'recovery-action', action: 'preview-checkpoint', id: checkpoint.id })
    if (outcome === 'cancel') {
      await pending
      expect(fixture.plugin).not.toHaveBeenCalled()
      expect(readFileSync(patch, 'utf8')).toContain('modified')
      expect(state().recovery.notice).toBeUndefined()
      return
    }
    const failed = outcome === 'failure' ? expect(pending).rejects.toThrow('插件依赖安装失败') : undefined
    await vi.waitFor(() => expect(fixture.plugin).toHaveBeenCalled())
    // Recovery restores configuration without the lockfile, so its reconciling install must never
    // run frozen, which is what pnpm defaults to whenever it treats the environment as CI.
    expect(fixture.plugin.mock.calls[0]![0]).toEqual(['install', '--no-frozen-lockfile'])
    expect(fixture.plugin.mock.calls[0]![1]).toBe(manager.directory('desktop'))
    expect(readFileSync(patch, 'utf8')).toContain('saved')
    expect(state().busy).toBe(true)
    expect(state().recovery.notice).toBeUndefined()
    finish({ exitCode: outcome === 'success' ? 0 : 1 })
    if (failed) await failed
    else await pending
    expect(state().busy).toBe(false)
    if (outcome === 'success') expect(state().recovery.notice).toMatchObject({ tone: 'success', body: expect.stringContaining('退出并重启') })
    else expect(state().recovery.notice).toBeUndefined()
    expect(fixture.start).not.toHaveBeenCalled()
  } finally { process.argv.splice(0, process.argv.length, ...argv); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})


it('disables and re-enables a Profile bundle from recovery without running the package manager', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-bundle-selection-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  const argv = [...process.argv]
  process.argv.push('--next-recovery')
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    const manager = new NextProfiles(home)
    const path = join(manager.directory('desktop'), 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.dsh.profile.bundles.push('my-plugin')
    manifest.dependencies = { ...manifest.dependencies, 'my-plugin': '1.0.0' }
    writeFileSync(path, JSON.stringify(manifest))
    const window = fixture.windows[0]
    const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const command = fixture.handlers.get('dsh-next:command')!
    const state = () => fixture.handlers.get('dsh-next:state')!(sender)
    const { dialog } = await import('electron')

    await command(sender, { type: 'recovery-action', action: 'preview-disable', id: 'my-plugin' })
    // Nothing is installed or removed, so a half-written package directory and a
    // Windows file lock can never block the one action that unblocks startup.
    expect(fixture.plugin).not.toHaveBeenCalled()
    const disabled = JSON.parse(readFileSync(path, 'utf8'))
    expect(disabled.dsh.profile.bundles).not.toContain('my-plugin')
    expect(disabled.dependencies['my-plugin']).toBe('1.0.0')
    expect(state().recovery.bundles.find((item: { packageName: string }) => item.packageName === 'my-plugin'))
      .toMatchObject({ status: 'disabled', toggle: 'enable' })
    expect(state().recovery.notice).toMatchObject({ tone: 'success' })

    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await command(sender, { type: 'recovery-action', action: 'preview-enable', id: 'my-plugin' })
    expect(JSON.parse(readFileSync(path, 'utf8')).dsh.profile.bundles).not.toContain('my-plugin')

    await expect(command(sender, { type: 'recovery-action', action: 'preview-disable', id: 'my-plugin' }))
      .rejects.toThrow('cannot be changed')

    await command(sender, { type: 'recovery-action', action: 'preview-enable', id: 'my-plugin' })
    expect(JSON.parse(readFileSync(path, 'utf8')).dsh.profile.bundles).toContain('my-plugin')
    expect(fixture.plugin).not.toHaveBeenCalled()
  } finally { process.argv.splice(0, process.argv.length, ...argv); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
})

it('recovers login-shell exports into the Host environment before any Host starts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-shell-environment-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  const resolve = vi.fn(async () => ({
    updates: { PATH: '/login-shell/bin:/usr/bin', PNPM_HOME: '/Users/tester/Library/pnpm' },
    source: 'login-shell' as const,
  }))
  vi.doMock('../src/shell-environment.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/shell-environment.ts')>(), resolveDesktopShellEnvironment: resolve }))
  const saved = { PATH: process.env.PATH, PNPM_HOME: process.env.PNPM_HOME }
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    // The Host environment spreads process.env, so the recovered exports must land there
    // before runtime.start() can spawn a Host (a GUI launch otherwise keeps the launchd PATH).
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ environment: process.env, home, platform: process.platform }))
    expect(process.env.PATH).toBe('/login-shell/bin:/usr/bin')
    expect(process.env.PNPM_HOME).toBe('/Users/tester/Library/pnpm')
    expect(fixture.diagnosticAppend).not.toHaveBeenCalledWith(expect.stringContaining('login-shell environment not recovered'), 'info')
  } finally {
    vi.doUnmock('../src/shell-environment.ts')
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true })
  }
})

it('logs an unexpected login-shell capture fallback while keeping the launch environment', async () => {
  const home = mkdtempSync(join(tmpdir(), 'next-shell-environment-fallback-'))
  vi.stubEnv('DSH_DESKTOP_NEXT_HOME', home)
  const resolve = vi.fn(async () => ({ updates: {}, source: 'process' as const, fallbackReason: 'capture-failed' as const }))
  vi.doMock('../src/shell-environment.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/shell-environment.ts')>(), resolveDesktopShellEnvironment: resolve }))
  const savedPath = process.env.PATH
  try {
    await import('../src/main.ts')
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1))
    expect(process.env.PATH).toBe(savedPath)
    expect(fixture.diagnosticAppend).toHaveBeenCalledWith('DSH NEXT: login-shell environment not recovered (capture-failed); keeping the launch environment', 'info')
  } finally {
    vi.doUnmock('../src/shell-environment.ts')
    vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true })
  }
})
