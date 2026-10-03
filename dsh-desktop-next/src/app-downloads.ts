/** Main-process ownership of downloads from the application's authenticated Host routes. */
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { dialog, type BrowserWindow, type Session } from 'electron'
import { APP_URL } from './ipc.ts'

/**
 * Whether a download targets a Host route behind the application protocol.
 * Chromium sends these downloads (`<a download>`, top-level attachments) around
 * `webRequest`, so the renderer marker never reaches the protocol gate and the
 * item Chromium creates already holds its 403.
 */
export function appDownloadRoute(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh-app:' && url.host === 'app' && !url.username && !url.password && url.pathname.startsWith('/api/')
  } catch { return false }
}

/** Reduce a server or renderer suggestion to one plain file name. */
function plainFilename(value: string | undefined): string | undefined {
  const name = value?.split(/[/\\]/u).pop()?.replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  return name && name !== '.' && name !== '..' ? name : undefined
}

/**
 * Choose the saved file name: the Host's `Content-Disposition` (RFC 6266,
 * `filename*` first), then the name Chromium derived from the download request.
 */
export function downloadFilename(disposition: string | null, fallback: string): string {
  let named: string | undefined
  const extended = disposition && /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/iu.exec(disposition)
  if (extended && /^utf-8$/iu.test(extended[1]!.trim())) {
    try { named = plainFilename(decodeURIComponent(extended[2]!.trim())) } catch { /* malformed escape: try the plain parameter */ }
  }
  const plain = disposition && /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/iu.exec(disposition)
  if (!named && plain) named = plainFilename((plain[1]?.replace(/\\(["\\])/gu, '$1') ?? plain[2])?.trim())
  return named ?? plainFilename(fallback) ?? 'download'
}

/**
 * Take over application-route downloads so they authenticate like the renderer's own fetches.
 * @param session - Session hosting the main application window.
 * @param options.window - The main application window; downloads from any other contents are dropped.
 * @param options.forward - Authenticated Host request for an application URL.
 * @param options.downloads - Default directory offered by the save dialog.
 */
export function installAppDownloads(session: Pick<Session, 'on'>, options: {
  window(): BrowserWindow | undefined
  forward(url: string): Promise<Response>
  downloads(): string
  language(): string
  warn(error: unknown): void
}): void {
  const fail = (owner: BrowserWindow, error: unknown): void => {
    options.warn(error)
    if (owner.isDestroyed()) return
    const zh = options.language().startsWith('zh')
    void dialog.showMessageBox(owner, {
      type: 'error', title: 'DSH NEXT', message: zh ? '下载失败' : 'Download failed',
      detail: error instanceof Error ? error.message : String(error),
    }).catch(options.warn)
  }
  const save = async (owner: BrowserWindow, url: string, fallback: string): Promise<void> => {
    const response = await options.forward(url)
    const body = response.body
    if (!response.ok || !body) {
      // Host route failures are short plain-text explanations ("session not found").
      const reason = body ? (await response.text().catch(() => '')).trim().slice(0, 300) : ''
      throw new Error(`Host responded with HTTP ${response.status}${reason ? `: ${reason}` : ''}`)
    }
    const filename = downloadFilename(response.headers.get('content-disposition'), fallback)
    if (owner.isDestroyed()) { await body.cancel(); return }
    let target: string | undefined
    try {
      const chosen = await dialog.showSaveDialog(owner, { defaultPath: join(options.downloads(), filename) })
      if (!chosen.canceled && chosen.filePath) target = chosen.filePath
    } catch (error) { await body.cancel(); throw error }
    if (target === undefined) { await body.cancel(); return }
    try {
      await pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), createWriteStream(target))
    } catch (error) {
      await rm(target, { force: true }).catch(options.warn)
      throw error
    }
  }
  session.on('will-download', (event, item, contents) => {
    const url = item.getURL()
    if (!appDownloadRoute(url)) return
    // Chromium's item can never succeed: its request bypassed the renderer marker.
    event.preventDefault()
    const owner = options.window()
    if (!owner || owner.isDestroyed() || owner.webContents !== contents || contents.isDestroyed()
      || !contents.getURL().startsWith(APP_URL)) {
      options.warn(new Error('Rejected an application download from outside the main window'))
      return
    }
    save(owner, url, item.getFilename()).catch(error => { fail(owner, error) })
  })
}
