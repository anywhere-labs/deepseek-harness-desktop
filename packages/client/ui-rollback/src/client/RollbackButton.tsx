/**
 * RollbackButton: the assistant-message rollback entry, seated at the front of
 * the finalized message's IconActions row (left of copy). The button opens a
 * confirmation dialog that offers an optional "also roll back code" checkbox;
 * confirming rewinds the session to before this message through the rollback
 * Remote over dsh-rollback. Success and failure announce through the shared
 * transient Toast anchored to the button.
 */

import { useCallback, useRef, useState } from 'react'
import {
  Button, IconRollbackOutline16, IconWarningOutline16, Modal, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RollbackButtonProps } from './slots.ts'
import type { RollbackKey } from './locales.ts'
import css from './RollbackButton.module.css'

/** Business failure codes with product copy; unknown codes keep the raw text. */
const KNOWN_FAILURES: Record<string, RollbackKey> = {
  'session-not-found': 'error.session-not-found',
  'message-seq-out-of-range': 'error.message-seq-out-of-range',
  'no-turn': 'error.no-turn',
  'rewind-failed': 'error.rewind-failed',
}

/** Toast payload: stable id, tone, and localized text. */
interface RollbackToast {
  seq: number
  error: boolean
  text: string
}

export function RollbackButton({ seq, rollback, t }: RollbackButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [revertCode, setRevertCode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<RollbackToast | null>(null)
  const toastSeq = useRef(0)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  // Same-render reentry guard: React state cannot disable the button until
  // the next render, so rapid confirms would otherwise fire two rewinds.
  const busyRef = useRef(false)

  const announce = useCallback((error: boolean, text: string): void => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, error, text })
  }, [])

  const onConfirm = useCallback(async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const outcome = await rollback(seq, revertCode)
      if (outcome.ok) {
        const parts = [t('result.ok')]
        if (outcome.codeReverted > 0) parts.push(t('result.codeReverted', { count: outcome.codeReverted }))
        if (outcome.codeFailures.length > 0) parts.push(t('result.codeFailures', { count: outcome.codeFailures.length }))
        announce(false, parts.join('，'))
        setConfirmOpen(false)
      } else {
        const key = KNOWN_FAILURES[outcome.code]
        announce(true, key === undefined
          ? t('error.raw', { code: outcome.code, message: outcome.message })
          : key === 'error.rewind-failed'
            ? t(key, { message: outcome.message })
            : t(key))
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [rollback, seq, revertCode, announce, t])

  return (
    <>
      <Tooltip label={t('action.aria')} side="bottom">
        <button
          ref={anchorRef}
          type="button"
          className={css.action}
          aria-label={t('action.aria')}
          onClick={() => { setConfirmOpen(true) }}
        >
          <IconRollbackOutline16 />
        </button>
      </Tooltip>
      <Modal
        open={confirmOpen}
        onClose={() => { setConfirmOpen(false) }}
        title={t('confirm.title')}
        description={t('confirm.description')}
        closeLabel={t('confirm.close')}
        // The module class is always present; the fallback satisfies the
        // Record<string, string> index return type's undefined arm.
        /* v8 ignore next 2 -- exactOptionalPropertyTypes fallback for a present CSS module class */
        className={css.dialog ?? ''}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} onClick={() => { setConfirmOpen(false) }}>
              {t('confirm.cancel')}
            </Button>
            <Button
              variant="primary"
              className={css.modalAction}
              disabled={busy}
              onClick={() => { void onConfirm() }}
            >
              {t('confirm.accept')}
            </Button>
          </>
        )}
      >
        <label className={css.codeChoice}>
          <input
            type="checkbox"
            checked={revertCode}
            disabled={busy}
            onChange={(event) => { setRevertCode(event.currentTarget.checked) }}
          />
          <span>{t('confirm.code')}</span>
        </label>
      </Modal>
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={toast.error ? <IconWarningOutline16 /> : <IconRollbackOutline16 />}
          anchor={anchorRef.current}
          onDone={() => { setToast(null) }}
        />
      )}
    </>
  )
}
