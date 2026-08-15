// @vitest-environment jsdom
// PolishButton behavior: the bare 润色/Polish caption, disable rules, the
// polish call replacing the draft, and failure toasts — driven purely through
// props, no wire.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
// Type-only: activates the LocaleNamespaceMap merge for the 'polish' seat
// (the apply entry owns the declaration; the component test consumes it).
import type {} from '../src/client/index.ts'
import { PolishButton, type PolishButtonProps } from '../src/client/PolishButton.tsx'
import type { PolishActions, PolishOutcome } from '../src/client/slots.ts'
import { zh } from '../src/client/locales.ts'

const t: PolishButtonProps['t'] = makeTranslate(zh, commonZh)

function makeProps(over: Partial<PolishButtonProps> = {}) {
  const setDraft = vi.fn<(text: string) => void>()
  const polish = vi.fn<PolishActions['polish']>(async () => ({ ok: true, text: '润色后的文本' }))
  return {
    input: { draft: '你好' },
    inputActions: { setDraft },
    polish,
    t,
    ...over,
  }
}

/** The polish button by its stable aria-label. */
function button(): HTMLButtonElement {
  return screen.getByRole('button', { name: '润色并扩展输入内容' }) as HTMLButtonElement
}

afterEach(cleanup)

describe('PolishButton', () => {
  it('shows the bare 润色 caption', async () => {
    render(<PolishButton {...makeProps()} />)
    expect(button().textContent).toBe('润色')
  })

  it('disables on an empty draft', async () => {
    render(<PolishButton {...makeProps({ input: { draft: '   ' } })} />)
    expect(button().disabled).toBe(true)
  })

  it('replaces the draft with the polished text on success', async () => {
    const props = makeProps()
    render(<PolishButton {...props} />)
    fireEvent.click(button())
    await waitFor(() => {
      expect(props.polish).toHaveBeenCalledWith('你好')
      expect(props.inputActions.setDraft).toHaveBeenCalledWith('润色后的文本')
    })
  })

  it('single-flights while the polish turn is in flight and shows the busy caption', async () => {
    let resolvePolish!: (outcome: PolishOutcome) => void
    const props = makeProps({
      polish: vi.fn<PolishActions['polish']>(() => new Promise((resolve) => { resolvePolish = resolve })),
    })
    render(<PolishButton {...props} />)
    act(() => {
      button().click()
      button().click()
    })
    expect(props.polish).toHaveBeenCalledTimes(1)
    expect(button().disabled).toBe(true)
    expect(button().textContent).toBe('润色中…')

    await act(async () => { resolvePolish({ ok: true, text: '结果' }) })
    expect(props.inputActions.setDraft).toHaveBeenCalledWith('结果')
    expect(button().disabled).toBe(false)
  })

  it('announces a business failure through the toast', async () => {
    const props = makeProps({
      polish: vi.fn<PolishActions['polish']>(async () => ({
        ok: false,
        code: 'no-result',
        message: 'no-result',
      })),
    })
    render(<PolishButton {...props} />)
    fireEvent.click(button())
    expect(await screen.findByText('没有获得润色结果，请重试')).toBeTruthy()
    expect(props.inputActions.setDraft).not.toHaveBeenCalled()
  })

  it('announces a throwaway-session failure with its message through the toast', async () => {
    const props = makeProps({
      polish: vi.fn<PolishActions['polish']>(async () => ({
        ok: false,
        code: 'polish-session-failed',
        message: 'boom',
      })),
    })
    render(<PolishButton {...props} />)
    fireEvent.click(button())
    expect(await screen.findByText('润色失败：boom')).toBeTruthy()
  })

  it('announces an unknown failure code through the raw toast', async () => {
    const props = makeProps({
      polish: vi.fn<PolishActions['polish']>(async () => ({
        ok: false,
        code: 'weird-code',
        message: 'boom',
      })),
    })
    render(<PolishButton {...props} />)
    fireEvent.click(button())
    expect(await screen.findByText('weird-code: boom')).toBeTruthy()
  })

  it('dismisses the failure toast after the hold', async () => {
    // Success replaces the draft without a toast; only failures announce.
    const props = makeProps({
      polish: vi.fn<PolishActions['polish']>(async () => ({
        ok: false,
        code: 'no-result',
        message: 'no-result',
      })),
    })
    vi.useFakeTimers()
    try {
      render(<PolishButton {...props} />)
      fireEvent.click(button())
      await act(async () => {})
      expect(screen.getByRole('alert')).toBeTruthy()
      act(() => { vi.advanceTimersByTime(4000) })
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
