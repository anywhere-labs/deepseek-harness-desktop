/**
 * PolishButton: the composer's polish entry, seated at the right end of the
 * tool row immediately LEFT of the model select. It rewrites and expands the
 * current draft through an isolated throwaway session that mirrors the
 * session's own provider/model selection (dsh-polish), so the visible
 * conversation is never touched. The button disables while a polish turn is in
 * flight, and on success the draft is replaced with the returned text for the
 * user to review before sending. Failures announce through the shared
 * transient Toast anchored to the button.
 */

import { useCallback, useRef, useState } from 'react'
import {
  IconEnhanceOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PolishActions } from './slots.ts'
import type { PolishKey } from './locales.ts'
import css from './PolishButton.module.css'

/** Full button props: live draft surface + injected face + locale seat. */
export interface PolishButtonProps extends PolishActions, PropsLocale<'polish'> {
  /** Live input state from the input-region owner share (draft only). */
  readonly input: { readonly draft: string }
  /** The standard session kit's single draft write path. */
  readonly inputActions: { setDraft: (text: string) => void }
}

/** Business failure codes with product copy; unknown codes keep the raw text. */
const KNOWN_FAILURES: Record<string, PolishKey> = {
  'session-not-found': 'error.session-not-found',
  'message-blank': 'error.message-blank',
  'message-too-long': 'error.message-too-long',
  'no-result': 'error.no-result',
  'polish-session-failed': 'error.polish-session-failed',
}

export function PolishButton({
  input, inputActions, polish, t,
}: PolishButtonProps) {
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  // Same-render reentry guard: React state cannot disable the button until
  // the next render, so rapid clicks would otherwise fire two polish turns.
  const busyRef = useRef(false)

  const draft = input.draft.trim()
  const disabled = busy || draft === ''
  const caption = busy ? t('polishing') : t('polish')

  const announce = useCallback((text: string): void => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }, [])

  const onClick = useCallback(async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const outcome = await polish(input.draft)
      if (outcome.ok) {
        inputActions.setDraft(outcome.text)
      } else {
        const key = KNOWN_FAILURES[outcome.code]
        announce(key === undefined ? t('error.raw', {
          code: outcome.code,
          message: outcome.message,
        }) : key === 'error.polish-session-failed'
          ? t(key, { message: outcome.message })
          : t(key))
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [polish, input.draft, inputActions, announce, t])

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={css.button}
        aria-label={t('polish.aria')}
        title={caption}
        disabled={disabled}
        onClick={() => { void onClick() }}
      >
        <IconEnhanceOutline16 className={css.icon} />
        <span className={css.label}>{caption}</span>
      </button>
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconEnhanceOutline16 />}
          anchor={anchorRef.current}
          onDone={() => { setToast(null) }}
        />
      )}
    </>
  )
}
