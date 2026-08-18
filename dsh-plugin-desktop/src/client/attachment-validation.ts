import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { ComposerAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Browser image formats accepted by the durable rc.6 attachment service. */
export const DESKTOP_ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

const ACCEPTED_MEDIA_TYPES = new Set(DESKTOP_ATTACHMENT_ACCEPT.split(','))

/** Validate one picker batch before creating browser object URLs. */
export function validateSelection(
  files: readonly File[],
  existing: readonly ComposerAttachment[],
  limits: ImageAttachmentLimits | undefined,
): string | null {
  if (files.some(file => !ACCEPTED_MEDIA_TYPES.has(file.type))) {
    return '仅支持 PNG、JPG、WebP、GIF 格式的图片'
  }
  if (limits === undefined) return null
  if (existing.length + files.length > limits.maxImagesPerMessage) {
    return `一条消息最多添加 ${limits.maxImagesPerMessage} 张图片`
  }
  if (files.some(file => file.size > limits.maxImageBytes)) {
    return `单张图片不能超过 ${formatBytes(limits.maxImageBytes)}`
  }
  const total = existing.reduce((sum, attachment) => sum + attachment.file.size, 0)
    + files.reduce((sum, file) => sum + file.size, 0)
  if (total > limits.maxMessageImageBytes) {
    return `图片总大小不能超过 ${formatBytes(limits.maxMessageImageBytes)}`
  }
  return null
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`
}
