// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionTrashClient, SessionTrashConfirmation, sessionTrashRequest } from '../src/client/session-trash.tsx'
import { SessionId } from '@deepseek-ai/dsh-session/types'

afterEach(() => { vi.unstubAllGlobals() })
const selection = { sessionId: SessionId('target'), title: 'Target' }
describe('delete confirmation and capability', () => {
  it('requires an available capability and explicit confirmation; cancellation sends nothing', async () => {
    const remove = vi.fn(async () => {}); const client = new SessionTrashClient(remove)
    client.request(selection); await client.confirm(); expect(remove).not.toHaveBeenCalled()
    client.setSupported(true); client.request(selection); client.cancel(); await client.confirm(); expect(remove).not.toHaveBeenCalled()
    client.request(selection); await client.confirm(); expect(remove).toHaveBeenCalledExactlyOnceWith(selection)
    expect(client.getSnapshot().selection).toBeUndefined()
  })
  it('coalesces confirmation and keeps the exact selection on failure', async () => {
    let fail!: (error: Error) => void
    const remove = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    const client = new SessionTrashClient(remove); client.setSupported(true); client.request(selection)
    const pending = client.confirm(); await client.confirm(); client.cancel()
    expect(remove).toHaveBeenCalledOnce(); expect(client.getSnapshot().busy).toBe(true)
    fail(new Error('write denied')); await pending
    expect(client.getSnapshot()).toMatchObject({ selection, busy: false, error: 'failed' })
  })
  it('renders a modal confirmation whose buttons cancel or commit the exact selection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const openDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
    const closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
    const open = vi.fn(); const close = vi.fn()
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: open })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close })
    const remove = vi.fn(async () => {}); const client = new SessionTrashClient(remove); client.setSupported(true)
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
    try {
      await act(async () => { client.request(selection); root.render(createElement(SessionTrashConfirmation, { control: client, t: key => key })) })
      expect(container.querySelector('dialog')?.getAttribute('aria-labelledby')).toBe('dsh-trash-title')
      expect(open).toHaveBeenCalledOnce()
      await act(async () => { container.querySelectorAll('button')[0]!.click() })
      expect(remove).not.toHaveBeenCalled(); expect(container.querySelector('dialog')).toBeNull()
      await act(async () => { client.request(selection) })
      await act(async () => { container.querySelectorAll('button')[1]!.click() })
      expect(remove).toHaveBeenCalledExactlyOnceWith(selection)
      expect(container.querySelector('dialog')).toBeNull()
    } finally { await act(async () => { root.unmount() }); container.remove();
      if (openDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', openDescriptor); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
      if (closeDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'close', closeDescriptor); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close') }
  })
  it('uses authenticated same-origin requests and retains server refusal', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ supported: true, items: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    await sessionTrashRequest('delete', 'target', 'Target')
    expect(fetcher).toHaveBeenCalledWith('/api/desktop/sessions/trash', expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ action: 'delete', sessionId: 'target', title: 'Target' }) }))
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'active', code: 'active' }), { status: 409 }))
    const client = new SessionTrashClient(async () => { await sessionTrashRequest('delete', 'target') })
    client.setSupported(true); client.request(selection); await client.confirm()
    expect(client.getSnapshot()).toMatchObject({ selection, error: 'active' })
  })
})
