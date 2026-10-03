import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { installRendererAccessHeader } from '../src/renderer-authentication.ts'
import { DESKTOP_RENDERER_ACCESS_HEADER } from '../src/desktop-browser-access.ts'

describe('multi-window renderer authentication', () => {
  it('keeps one listener and authenticates only registered top-level renderers', () => {
    const onBeforeSendHeaders = vi.fn()
    const session = { webRequest: { onBeforeSendHeaders } }
    const renderer = (id: number) => ({ id, session }) as unknown as WebContents
    const header = { name: DESKTOP_RENDERER_ACCESS_HEADER, value: 'local-capability' } as const
    const closeMain = installRendererAccessHeader(renderer(1), 'http://localhost:1234', header)
    const closeChild = installRendererAccessHeader(renderer(2), 'http://localhost:1234', header)
    expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1)
    const listener = onBeforeSendHeaders.mock.calls[0]![1] as (details: object, callback: (result: { requestHeaders: Record<string, string> }) => void) => void
    const request = (id: number, url = 'http://localhost:1234/api') => {
      const callback = vi.fn()
      listener({ webContentsId: id, url, resourceType: 'mainFrame', requestHeaders: { [header.name]: 'spoof' } }, callback)
      return callback.mock.calls[0]![0].requestHeaders
    }
    expect(request(1)[header.name]).toBe(header.value)
    expect(request(2)[header.name]).toBe(header.value)
    expect(request(3)[header.name]).toBeUndefined()
    expect(request(2, 'https://example.com')[header.name]).toBeUndefined()
    closeMain()
    expect(request(1)[header.name]).toBeUndefined()
    expect(request(2)[header.name]).toBe(header.value)
    expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1)
    closeChild()
    expect(onBeforeSendHeaders).toHaveBeenLastCalledWith(null)
  })
})
