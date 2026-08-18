import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconPaperclipOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { DESKTOP_ATTACHMENT_ACCEPT, validateSelection } from './attachment-validation.ts'

export { DESKTOP_ATTACHMENT_ACCEPT, validateSelection } from './attachment-validation.ts'

/** Operations retained by the upstream conversation controller. */
export interface AttachmentPickerInjected {
  /** Register selected files in the upstream draft registry. */
  createDraftImages(files: readonly File[]): readonly ComposerAttachment[]
  /** Resolve existing draft images for aggregate-size validation. */
  draftImages(ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[]
  /** Release draft objects when the input machine rejects their ids. */
  releaseDraftImages(attachments: readonly ComposerAttachment[]): void
}

/** Full props for the Desktop attachment control in the conversation input row. */
export type AttachmentPickerProps = PropsRuntime<'conversation.input.left'> & AttachmentPickerInjected

/** Render a click-to-select image control backed by the upstream draft and send path. */
export function AttachmentPicker({
  input,
  inputActions,
  useProjection,
  createDraftImages,
  draftImages,
  releaseDraftImages,
}: AttachmentPickerProps) {
  const picker = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const imageLimits = useProjection('imageLimits')
  const busy = input.phase === 'adjudicating' || input.phase === 'submitting'

  const select = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = [...(event.currentTarget.files ?? [])]
    event.currentTarget.value = ''
    if (files.length === 0) return
    const rejection = validateSelection(files, draftImages(input.imageIds), imageLimits)
    if (rejection !== null) {
      setError(rejection)
      return
    }
    try {
      const attachments = createDraftImages(files)
      if (!inputActions.addImages(attachments.map(attachment => attachment.id))) {
        releaseDraftImages(attachments)
        setError('当前无法添加图片，请稍后再试')
        return
      }
      setError(null)
    } catch {
      setError('图片读取失败，请重新选择 PNG、JPG、WebP 或 GIF 图片')
    }
  }

  return (
    <>
      <Tooltip label="添加图片" side="top" delayMs={500}>
        <button
          type="button"
          className="dshDesktopAttachmentButton"
          aria-label="添加图片"
          disabled={busy}
          onClick={() => { picker.current?.click() }}
        >
          <IconPaperclipOutline16 size={16} />
        </button>
      </Tooltip>
      <input
        ref={picker}
        className="dshDesktopAttachmentInput"
        type="file"
        accept={DESKTOP_ATTACHMENT_ACCEPT}
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={select}
      />
      {error !== null && <span className="dshDesktopAttachmentError" role="status">{error}</span>}
    </>
  )
}
