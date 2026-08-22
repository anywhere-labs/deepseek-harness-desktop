import { useEffect, useRef, useState } from 'react'
import type { ComposerAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { attachmentDeliveryState, retryAttachmentDelivery } from './vision-experience.ts'

export type VisionAttachmentsProps =
  PropsRuntime<'conversation.input.attachments'> & PropsLocale<'desktop.vision'>

export function VisionAttachments({
  attachments, canAcceptDrop, onAddImages, onRemoveImage, t, useInput, inputActions, useSession,
}: VisionAttachmentsProps) {
  const phase = useInput(state => state.phase) ?? 'plain'
  const promptError = useSession(state => state.promptError) ?? null
  const delivery = attachmentDeliveryState(phase, promptError?.error ?? null)
  const [preview, setPreview] = useState<ComposerAttachment | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    if (preview !== null && !attachments.some(attachment => attachment.id === preview.id)) setPreview(null)
  }, [attachments, preview])

  useEffect(() => {
    const filesOf = (event: globalThis.DragEvent): FileList | null => {
      const transfer = event.dataTransfer
      return transfer !== null && transfer.types.includes('Files') ? transfer.files : null
    }
    const reset = (): void => {
      dragDepth.current = 0
      setDragActive(false)
    }
    const enter = (event: globalThis.DragEvent): void => {
      if (filesOf(event) === null) return
      event.preventDefault()
      dragDepth.current += 1
      setDragActive(true)
    }
    const over = (event: globalThis.DragEvent): void => {
      if (filesOf(event) === null) return
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = canAcceptDrop ? 'copy' : 'none'
    }
    const leave = (event: globalThis.DragEvent): void => {
      if (filesOf(event) === null) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragActive(false)
    }
    const drop = (event: globalThis.DragEvent): void => {
      const files = filesOf(event)
      if (files === null) return
      event.preventDefault()
      reset()
      if (canAcceptDrop) onAddImages([...files])
    }
    document.addEventListener('dragenter', enter)
    document.addEventListener('dragover', over)
    document.addEventListener('dragleave', leave)
    document.addEventListener('drop', drop)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', enter)
      document.removeEventListener('dragover', over)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('drop', drop)
      window.removeEventListener('dragend', reset)
    }
  }, [canAcceptDrop, onAddImages])

  if (attachments.length === 0 && !dragActive) return null
  const busy = delivery === 'preparing' || delivery === 'sending'

  return (
    <>
      {dragActive && <div className="dshVisionDropOverlay" data-disabled={!canAcceptDrop || undefined}>{t('attachment.drop')}</div>}
      {attachments.length > 0 && (
        <div className="dshVisionAttachments" data-delivery={delivery}>
          <div className="dshVisionAttachmentRail" role="group" aria-label={t('attachment.group')}>
            {attachments.map(attachment => {
              const name = attachment.file.name || t('attachment.group')
              return (
                <div className="dshVisionAttachment" key={attachment.id} data-delivery={delivery}>
                  <button
                    type="button"
                    className="dshVisionAttachmentPreview"
                    aria-label={t('attachment.open', { name })}
                    onClick={() => { setPreview(attachment) }}
                  >
                    <img src={attachment.previewUrl} alt={name} />
                    <span className="dshVisionAttachmentState" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="dshVisionAttachmentRemove"
                    aria-label={t('attachment.remove', { name })}
                    disabled={busy}
                    onClick={() => { onRemoveImage(attachment.id) }}
                  >
                    <IconCloseFill14 size={12} />
                  </button>
                </div>
              )
            })}
          </div>
          <div className="dshVisionDelivery" role="status" aria-live="polite">
            <span className="dshVisionDeliveryDot" aria-hidden="true" />
            <span>{t(`attachment.${delivery}`)}</span>
            {delivery === 'failed' && (
              <button
                type="button"
                className="dshVisionRetry"
                onClick={() => { retryAttachmentDelivery(delivery, phase, inputActions) }}
              >
                {t('attachment.retry')}
              </button>
            )}
          </div>
        </div>
      )}
      {preview !== null && (
        <div className="dshVisionLightbox" role="dialog" aria-modal="true" aria-label={preview.file.name} onClick={() => { setPreview(null) }}>
          <img src={preview.previewUrl} alt={preview.file.name} onClick={event => { event.stopPropagation() }} />
          <button type="button" aria-label={t('attachment.close')} onClick={() => { setPreview(null) }}>
            <IconCloseFill14 />
          </button>
        </div>
      )}
    </>
  )
}
