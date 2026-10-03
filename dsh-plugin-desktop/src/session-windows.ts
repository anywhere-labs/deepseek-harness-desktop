import { BrowserWindow, nativeImage, screen, shell, dialog, type WebContents } from 'electron'
import type { DesktopShellSpec } from './runtime.ts'
import type { ElectronPlatformStrategy } from './electron-platform.ts'
import { desktopWindowOptions } from './window-options.ts'
import { installRendererAccessHeader } from './renderer-authentication.ts'
import { SESSION_WINDOW_CHANNEL, parseSessionWindowRequest, sessionWindowUrl } from './session-window-contract.ts'

interface Options {
  spec: DesktopShellSpec
  platform: ElectronPlatformStrategy
  preloadPath: string
  main: BrowserWindow
  renderer: WebContents
  log(message: string): void
}

/** Auxiliary views share the Host; tray and Host lifetime remain with the main shell. */
export class SessionWindows {
  private readonly windows = new Map<string, BrowserWindow>()
  private readonly ready = new WeakSet<BrowserWindow>()
  private prepared: { id: string; window: BrowserWindow } | undefined
  private disposed = false

  constructor(private readonly options: Options) {
    const { renderer, spec } = options
    const origin = new URL(spec.url).origin
    renderer.ipc.handle(SESSION_WINDOW_CHANNEL, async (event, value: unknown) => {
      if (this.disposed || event.sender !== renderer || event.senderFrame !== renderer.mainFrame
        || event.senderFrame === null || new URL(event.senderFrame.url).origin !== origin) {
        throw new Error('Untrusted session window sender')
      }
      const request = parseSessionWindowRequest(value)
      if (request.source === 'cancel-drag') {
        this.cancelDrag(request.sessionId)
        return
      }
      if (request.source === 'prepare-drag') {
        if (this.prepared?.id !== request.sessionId) this.cancelDrag()
        try { await this.open(request.sessionId, 'drag', true) }
        catch (error) { options.log(`dsh-plugin-desktop: drag preparation failed: ${String(error)}`) }
        return
      }
      try { await this.open(request.sessionId, request.source) }
      catch (error) {
        options.log(`dsh-plugin-desktop: session window failed: ${String(error)}`)
        if (!this.disposed && !options.main.isDestroyed()) {
          void dialog.showMessageBox(options.main, { type: 'error', message: '无法打开会话窗口', detail: String(error) })
        }
        throw error
      }
    })
  }

  private cancelDrag(id?: string): void {
    if (!this.prepared || (id !== undefined && this.prepared.id !== id)) return
    const { window } = this.prepared
    this.prepared = undefined
    if (!window.isDestroyed()) window.destroy()
  }

  async open(sessionId: string, source: 'menu' | 'drag', prepare = false): Promise<void> {
    if (this.disposed) return
    const existing = this.windows.get(sessionId)
    if (existing !== undefined && !existing.isDestroyed()) {
      if (prepare) return
      if (this.prepared?.window === existing) {
        this.prepared = undefined
        const cursor = screen.getCursorScreenPoint()
        const area = screen.getDisplayNearestPoint(cursor).workArea
        const { width, height } = existing.getBounds()
        existing.setBounds({ x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, cursor.x - 80))), y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, cursor.y - 20))) })
      }
      if (!this.ready.has(existing)) return
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }
    const { spec, platform, main, preloadPath } = this.options
    const cursor = screen.getCursorScreenPoint()
    const parent = main.getBounds()
    const area = (source === 'drag' ? screen.getDisplayNearestPoint(cursor) : screen.getDisplayMatching(parent)).workArea
    const width = Math.min(1000, area.width)
    const height = Math.min(800, area.height)
    const base = desktopWindowOptions(spec, nativeImage.createFromPath(spec.iconPath), platform.platform, preloadPath)
    // A normal native title bar supplies move, resize and caption buttons on all platforms.
    const { titleBarStyle: _style, titleBarOverlay: _overlay, trafficLightPosition: _lights,
      transparent: _transparent, vibrancy: _vibrancy, backgroundMaterial: _material, ...rest } = base
    const window = new BrowserWindow({
      ...rest, webPreferences: { ...rest.webPreferences, backgroundThrottling: false }, frame: true, title: spec.productName, width, height,
      minWidth: Math.min(600, area.width), minHeight: Math.min(480, area.height),
      x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, source === 'drag' ? cursor.x - 80 : parent.x + (parent.width - width) / 2))),
      y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, source === 'drag' ? cursor.y - 20 : parent.y + (parent.height - height) / 2))),
    })
    this.windows.set(sessionId, window)
    if (prepare) this.prepared = { id: sessionId, window }
    const renderer = window.webContents
    const origin = new URL(spec.url).origin
    let unregister: (() => void) | undefined
    let loadTimer: ReturnType<typeof setTimeout> | undefined
    const close = (): void => {
      if (this.prepared?.window === window) this.prepared = undefined
      if (loadTimer !== undefined) clearTimeout(loadTimer)
      unregister?.()
      if (this.windows.get(sessionId) === window) this.windows.delete(sessionId)
    }
    window.once('closed', close)
    const allowFrame = (event: Electron.Event, url: string): void => {
      if (new URL(url).origin !== origin) event.preventDefault()
    }
    renderer.on('will-navigate', allowFrame)
    renderer.on('will-redirect', allowFrame)
    renderer.on('will-attach-webview', event => { event.preventDefault() })
    renderer.setWindowOpenHandler(({ url }) => {
      if (/^(https?:|mailto:)/u.test(url)) void shell.openExternal(url).catch(error => this.options.log(String(error)))
      return { action: 'deny' }
    })
    renderer.ipc.on(`${SESSION_WINDOW_CHANNEL}:ready`, (event, title: unknown) => {
      if (event.senderFrame !== renderer.mainFrame || typeof title !== 'string' || this.disposed || window.isDestroyed()) return
      if (loadTimer !== undefined) clearTimeout(loadTimer)
      const firstReady = !this.ready.has(window)
      this.ready.add(window)
      window.setTitle(`${title.slice(0, 200)} — ${spec.productName}`)
      renderer.setBackgroundThrottling(true)
      if (firstReady && this.prepared?.window !== window && !window.isVisible()) window.show()
    })
    renderer.on('page-title-updated', event => { event.preventDefault() })
    renderer.on('render-process-gone', () => {
      if (!window.isDestroyed()) window.destroy()
    })
    try {
      // The child uses the same authenticated Electron session as the main renderer.
      // Re-exchanging through Session.fetch would be stripped by the existing request guard.
      if (this.disposed || window.isDestroyed()) return
      unregister = installRendererAccessHeader(renderer, origin, spec.rendererAccessHeader)
      loadTimer = setTimeout(() => {
        if (!window.isDestroyed()) {
          if (this.prepared?.window !== window && !this.disposed && !main.isDestroyed()) void dialog.showMessageBox(main, { type: 'error', message: '会话窗口加载失败，请重试。' })
          window.destroy()
        }
      }, 30_000)
      loadTimer.unref()
      await renderer.loadURL(sessionWindowUrl(spec.url, sessionId))
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      throw error
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelDrag()
    if (!this.options.renderer.isDestroyed()) this.options.renderer.ipc.removeHandler(SESSION_WINDOW_CHANNEL)
    for (const window of this.windows.values()) if (!window.isDestroyed()) window.destroy()
    this.windows.clear()
  }
}
