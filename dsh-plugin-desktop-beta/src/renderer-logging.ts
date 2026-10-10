/** Capture only Desktop-owned renderers, with separate error and normal rate limits. */
import type { WebContents } from 'electron'
import { diagnosticLog, diagnosticOperation, developerLoggingEnabled } from './developer-logging.ts'
export function observeDesktopRenderer(contents: WebContents, scope: string): void {
  let started = Date.now()
  let count = 0
  let errors = 0
  contents.on('dom-ready', () => {
    diagnosticLog({ source: 'renderer.boot', event: 'document.ready', fields: { scope, webContentsId: contents.id } })
  })
  contents.on('preload-error', (_event, _path, error) => {
    diagnosticLog({ source: 'renderer.boot', event: 'preload.failed', level: 'error', error, fields: { scope, webContentsId: contents.id } })
  })
  contents.on('console-message', (event, legacyLevel, legacyMessage) => {
    const message = typeof legacyMessage === 'string' ? legacyMessage : event?.message
    if (typeof message !== 'string') return
    const level = typeof event?.level === 'string' ? event.level : legacyLevel
    const failure = level === 'error' || level === 3 || message.includes('[desktop-ui-error]') || message.includes('slot entry crashed') || message.includes('slot factory occurrence crashed')
    if (!failure && !developerLoggingEnabled()) return
    if (Date.now() - started >= 1000) { started = Date.now(); count = 0; errors = 0 }
    const current = failure ? ++errors : ++count
    if (current > 100) {
      if (current === 101) diagnosticLog({ source: 'renderer', event: 'console.rate-limited', level: 'warn', fields: { scope } })
      return
    }
    diagnosticLog({ source: 'renderer', event: 'console', level: failure ? 'error' : level === 'warning' || level === 2 ? 'warn' : level === 'debug' || level === 0 ? 'debug' : 'info',
      message: message.slice(0, 8192), developer: !failure, fields: { scope, webContentsId: contents.id } })
  })
}

/** Keep startup milestones even before the page can enable developer logging. */
export async function traceRendererBootStage<T>(stage: string, run: () => Promise<T>): Promise<T> {
  const finish = diagnosticOperation('renderer.boot', stage, undefined, false)
  try {
    const result = await run()
    finish()
    return result
  } catch (error) {
    finish(error)
    throw error
  }
}
