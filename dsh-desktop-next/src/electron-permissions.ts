/** Native controls for Computer Use and trusted renderer media access. */
import { desktopCapturer, Menu, shell, systemPreferences, type BrowserWindow, type DesktopCapturerSource, type Session } from 'electron'
import { NativePermissions } from './native-permissions.ts'
import { APP_URL } from './ipc.ts'

export function createNativePermissions(): NativePermissions {
  return new NativePermissions({
    platform: process.platform,
    status: permission => permission === 'accessibility'
      ? process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'unknown'
      : systemPreferences.getMediaAccessStatus(permission),
    microphone: () => systemPreferences.askForMediaAccess('microphone'),
    // Enumeration triggers macOS consent when needed; zero-sized thumbnails avoid capturing images.
    screen: async () => { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }) },
    accessibility: async () => { systemPreferences.isTrustedAccessibilityClient(true) },
    openSettings: url => shell.openExternal(url),
  })
}

/** Use the existing native menu for systems without the macOS screen-sharing picker. */
async function chooseScreen(window: BrowserWindow, language: string): Promise<DesktopCapturerSource | undefined> {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
  if (window.isDestroyed() || sources.length === 0) return undefined
  const zh = language.startsWith('zh')
  return new Promise(resolve => {
    const menu = Menu.buildFromTemplate([
      { label: zh ? '选择共享的屏幕或窗口' : 'Choose a screen or window to share', enabled: false },
      ...sources.map(source => ({ label: source.name, click: () => resolve(source) })),
      { type: 'separator' as const }, { label: zh ? '取消' : 'Cancel', click: () => resolve(undefined) },
    ])
    const closed = (): void => { menu.closePopup(window); resolve(undefined) }
    window.once('closed', closed)
    menu.popup({ window, callback: () => { window.removeListener('closed', closed); resolve(undefined) } })
  })
}

function appOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'dsh-app:' && url.host === 'app' } catch { return false }
}

/** A frame may close while native consent is open; settle its callback at most once. */
function replyOnce<T>(callback: (value: T) => void, warn: (error: unknown) => void): (value: T) => void {
  let replied = false
  return value => {
    if (replied) return
    replied = true
    try { callback(value) } catch (error) { warn(error) }
  }
}

export function installMediaPermissions(session: Session, options: {
  window(): BrowserWindow | undefined
  language(): string
  warn(error: unknown): void
}): void {
  const trusted = (contents: Electron.WebContents | null, url: string, isMainFrame: boolean): boolean => {
    const owner = options.window()
    return !!owner && !owner.isDestroyed() && owner.webContents === contents && !contents.isDestroyed()
      && isMainFrame && appOrigin(url) && contents.getURL().startsWith(APP_URL)
  }
  session.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (!trusted(contents, origin, details.isMainFrame)) return false
    if (permission === 'media') return details.mediaType === 'audio'
    // Keep the existing trusted renderer's non-media behavior; OS media grants remain separate.
    return true
  })
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const reply = replyOnce(callback, options.warn)
    const allowed = (): boolean => trusted(contents, details.requestingUrl, details.isMainFrame)
    if (!allowed()) return reply(false)
    if (permission !== 'media') return reply(true)
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    // Chromium and macOS request recording consent as part of getUserMedia.
    // Voice transcription may await initialization before opening the stream.
    reply(!!mediaTypes?.length && mediaTypes.every(type => type === 'audio'))
  })
  let picking = false
  session.setDisplayMediaRequestHandler((request, callback) => {
    const reply = replyOnce(callback, options.warn)
    const owner = options.window()
    if (picking || !owner || owner.isDestroyed() || request.frame !== owner.webContents.mainFrame
      || !appOrigin(request.securityOrigin) || !owner.webContents.getURL().startsWith(APP_URL)
      || !request.userGesture || !request.videoRequested || !owner.isFocused()) return reply({})
    picking = true
    void chooseScreen(owner, options.language()).then(source => {
      if (!owner.isDestroyed() && request.frame === owner.webContents.mainFrame && owner.webContents.getURL().startsWith(APP_URL)) {
        reply(source ? { video: source } : {})
      } else reply({})
    }).catch(error => { options.warn(error); reply({}) }).finally(() => { picking = false })
  }, { useSystemPicker: true })
}
