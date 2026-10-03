/** Narrow renderer/main contract for opening an existing Session. */
export const SESSION_WINDOW_CHANNEL = 'dsh-desktop:session-window'
export const SESSION_WINDOW_BRIDGE = '__DSH_SESSION_WINDOW_NATIVE__'
export const SESSION_WINDOW_UI = '__DSH_SESSION_WINDOW_UI__'
export const SESSION_WINDOW_TARGET = '__DSH_SESSION_WINDOW_TARGET__'

export interface SessionWindowRequest {
  sessionId: string
  source: 'menu' | 'drag' | 'prepare-drag' | 'cancel-drag'
}

export interface SessionWindowBridge {
  open(request: SessionWindowRequest): Promise<void>
  ready(title: string): void
}

/** Session ids are opaque; reject empty, oversized and control-bearing input. */
export function validSessionWindowId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\s\x00-\x1f\x7f]/u.test(value)
}

export function parseSessionWindowRequest(value: unknown): SessionWindowRequest {
  if (value === null || typeof value !== 'object' || !('sessionId' in value)
    || !validSessionWindowId(value.sessionId) || !('source' in value)
    || (value.source !== 'menu' && value.source !== 'drag' && value.source !== 'prepare-drag' && value.source !== 'cancel-drag')) {
    throw new Error('Invalid session window request')
  }
  return { sessionId: value.sessionId, source: value.source }
}

/** Only the main process builds the local renderer destination. */
export function sessionWindowUrl(base: string, sessionId: string): string {
  if (!validSessionWindowId(sessionId)) throw new Error('Invalid session id')
  const url = new URL(base)
  url.searchParams.set('dsh-desktop-session', sessionId)
  return url.href
}
