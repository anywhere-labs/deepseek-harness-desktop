import { describe, expect, it } from 'vitest'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { ComposerAttachment, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DESKTOP_ATTACHMENT_ACCEPT, validateSelection } from '../src/client/attachment-validation.ts'

const limits: ImageAttachmentLimits = {
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 10 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

function image(name: string, size: number, type = 'image/png'): File {
  return new File([new Uint8Array(size)], name, { type })
}

function attachment(file: File, id: string): ComposerAttachment {
  return { kind: 'image', id: id as DraftAttachmentId, file, previewUrl: `blob:${id}` }
}

describe('desktop attachment picker', () => {
  it('advertises exactly the durable image formats', () => {
    expect(DESKTOP_ATTACHMENT_ACCEPT).toBe('image/png,image/jpeg,image/webp,image/gif')
  })

  it('accepts a batch inside the host-projected limits', () => {
    expect(validateSelection(
      [image('next.png', 1024)],
      [attachment(image('held.jpg', 2048, 'image/jpeg'), 'held')],
      limits,
    )).toBeNull()
  })

  it('rejects unsupported formats before count and size checks', () => {
    expect(validateSelection(
      [image('notes.txt', 20 * 1024 * 1024, 'text/plain')],
      Array.from({ length: 4 }, (_, index) => attachment(image(`${index}.png`, 1), String(index))),
      limits,
    )).toBe('仅支持 PNG、JPG、WebP、GIF 格式的图片')
  })

  it('reports count, per-file, and aggregate limits', () => {
    const held = [attachment(image('held.png', 1024), 'held')]
    expect(validateSelection(
      Array.from({ length: 4 }, (_, index) => image(`${index}.png`, 1)),
      held,
      limits,
    )).toBe('一条消息最多添加 4 张图片')
    expect(validateSelection([image('large.png', limits.maxImageBytes + 1)], [], limits))
      .toBe('单张图片不能超过 5MB')
    expect(validateSelection(
      [image('next.png', 6 * 1024 * 1024)],
      [attachment(image('held.png', 5 * 1024 * 1024), 'held')],
      { ...limits, maxImageBytes: 7 * 1024 * 1024 },
    )).toBe('图片总大小不能超过 10MB')
  })
})
