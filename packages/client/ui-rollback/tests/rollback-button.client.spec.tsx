// @vitest-environment jsdom
// RollbackButton behavior: confirmation dialog with the optional code
// checkbox, the rollback call through the injected verb, and result toasts —
// driven purely through props, no wire.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
// Type-only: activates the LocaleNamespaceMap merge for the 'rollback' seat
// (the apply entry owns the declaration; the component test consumes it).
import type {} from '../src/client/index.ts'
import { RollbackButton } from '../src/client/RollbackButton.tsx'
import type { RollbackButtonProps } from '../src/client/slots.ts'
import type { RollbackOutcome } from '../src/client/slots.ts'
import { zh } from '../src/client/locales.ts'

const t: RollbackButtonProps['t'] = makeTranslate(zh, commonZh)

function makeProps(over: Partial<RollbackButtonProps> = {}) {
  const rollback = vi.fn<RollbackButtonProps['rollback']>(async () => ({
    ok: true,
    cutSeq: 12,
    codeReverted: 0,
    codeFailures: [],
  }))
  return {
    messageId: 'msg-1' as RollbackButtonProps['messageId'],
    seq: 40,
    sessionId: 's1' as RollbackButtonProps['sessionId'],
    useSession: (() => undefined) as RollbackButtonProps['useSession'],
    useProjection: (() => undefined) as RollbackButtonProps['useProjection'],
    useSessions: (() => undefined) as RollbackButtonProps['useSessions'],
    useWorkspaces: (() => undefined) as RollbackButtonProps['useWorkspaces'],
    useInput: (() => undefined) as RollbackButtonProps['useInput'],
    inputActions: {} as RollbackButtonProps['inputActions'],
    rollback,
    t,
    ...over,
  }
}

/** The rollback button by its stable aria-label. */
function button(): HTMLButtonElement {
  return screen.getByRole('button', { name: '回退到此消息' }) as HTMLButtonElement
}

afterEach(cleanup)

describe('RollbackButton', () => {
  it('opens the confirmation dialog with the code checkbox unchecked by default', async () => {
    render(<RollbackButton {...makeProps()} />)
    fireEvent.click(button())
    expect(await screen.findByText('将删除此消息及其后的所有内容，恢复此前的会话上下文。')).toBeTruthy()
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
  })

  it('rolls back without code when confirmed with the checkbox unchecked', async () => {
    const props = makeProps()
    render(<RollbackButton {...props} />)
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('button', { name: '回退' }))
    await waitFor(() => {
      expect(props.rollback).toHaveBeenCalledWith(40, false)
    })
  })

  it('rolls back with code when the checkbox is checked', async () => {
    const props = makeProps()
    render(<RollbackButton {...props} />)
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '回退' }))
    await waitFor(() => {
      expect(props.rollback).toHaveBeenCalledWith(40, true)
    })
  })

  it('announces success through the toast', async () => {
    render(<RollbackButton {...makeProps()} />)
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('button', { name: '回退' }))
    expect(await screen.findByText('已回退，会话恢复到更早状态')).toBeTruthy()
  })

  it('appends code-revert counts to the success toast', async () => {
    const props = makeProps({
      rollback: vi.fn<RollbackButtonProps['rollback']>(async () => ({
        ok: true,
        cutSeq: 12,
        codeReverted: 2,
        codeFailures: [{ path: 'a.txt', reason: 'hunk text not found' }],
      })),
    })
    render(<RollbackButton {...props} />)
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('button', { name: '回退' }))
    const toast = await screen.findByText(/已撤销 2 处代码改动/)
    expect(toast.textContent).toContain('1 处代码改动未能回退')
  })

  it('announces a business failure through the toast', async () => {
    const props = makeProps({
      rollback: vi.fn<RollbackButtonProps['rollback']>(async () => ({
        ok: false,
        code: 'no-turn',
        message: 'no-turn',
      })),
    })
    render(<RollbackButton {...props} />)
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('button', { name: '回退' }))
    expect(await screen.findByText('无法定位此消息所在的回合')).toBeTruthy()
  })

  it('announces a rewind failure with its message through the toast', async () => {
    const props = makeProps({
      rollback: vi.fn<RollbackButtonProps['rollback']>(async () => ({
        ok: false,
        code: 'rewind-failed',
        message: 'boom',
      })),
    })
    render(<RollbackButton {...props} />)
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('button', { name: '回退' }))
    expect(await screen.findByText('回退失败：boom')).toBeTruthy()
  })

  it('announces an unknown failure code through the raw toast', async () => {
    const props = makeProps({
      rollback: vi.fn<RollbackButtonProps['rollback']>(async () => ({
        ok: false,
        code: 'weird-code',
        message: 'boom',
      })),
    })
    render(<RollbackButton {...props} />)
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('button', { name: '回退' }))
    expect(await screen.findByText('weird-code: boom')).toBeTruthy()
  })

  it('closes the dialog on Escape without calling rollback', async () => {
    const props = makeProps()
    render(<RollbackButton {...props} />)
    fireEvent.click(button())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.rollback).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('dismisses the toast after the hold', async () => {
    vi.useFakeTimers()
    try {
      render(<RollbackButton {...makeProps()} />)
      fireEvent.click(button())
      fireEvent.click(screen.getByRole('button', { name: '回退' }))
      await act(async () => {})
      expect(screen.getByRole('alert')).toBeTruthy()
      act(() => { vi.advanceTimersByTime(4000) })
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('single-flights while a rollback is in flight', async () => {
    let resolveRollback!: (outcome: RollbackOutcome) => void
    const props = makeProps({
      rollback: vi.fn<RollbackButtonProps['rollback']>(() => new Promise((resolve) => { resolveRollback = resolve })),
    })
    render(<RollbackButton {...props} />)
    fireEvent.click(button())
    const confirm = screen.getByRole('button', { name: '回退' })
    act(() => {
      confirm.click()
      confirm.click()
    })
    expect(props.rollback).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveRollback({ ok: true, cutSeq: 12, codeReverted: 0, codeFailures: [] })
    })
    expect(props.rollback).toHaveBeenCalledTimes(1)
  })

  it('cancelling the dialog does not call rollback', async () => {
    const props = makeProps()
    render(<RollbackButton {...props} />)
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(props.rollback).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
