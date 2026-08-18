import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type convergence only: locale/theme declarations expose settings slot rows.
// The desktop client does not load or register a settings surface.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConversationController } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { AttachmentPicker, type AttachmentPickerInjected } from './AttachmentPicker.tsx'
import { applyAdvancedShell } from './advanced-shell.ts'
import { startRendererBootReporter } from './boot-health.ts'
import { parseDesktopClientEnvironment } from './environment.ts'
import { installAttachmentStyles } from './styles.ts'

export { applyAdvancedShell } from './advanced-shell.ts'
export {
  RENDERER_BOOT_REPORT_PATH,
  rendererBootReport,
  sendRendererBootReport,
  startRendererBootReporter,
} from './boot-health.ts'
export type { RendererBootLoader, RendererBootReport } from './boot-health.ts'
export { parseDesktopClientEnvironment } from './environment.ts'
export type { DesktopClientEnvironment, DesktopClientMode, DesktopClientPlatform } from './environment.ts'

/** Services required by advanced presentation. */
export const inject = [
  'slots',
  'sessions',
  'theme',
]

/** Resolve the concrete upstream controller used only for its established draft-image operations. */
function conversationController(ctx: ClientContext): ConversationController {
  const conversation = ctx.get('conversation')
  if (conversation === undefined) throw new Error('dsh-plugin-desktop: conversation service unavailable')
  return conversation as ConversationController
}

/** Register desktop-owned client surfaces for the current BrowserWindow mode. @param ctx - browser Cordis context. */
export function apply(ctx: ClientContext): void {
  const environment = parseDesktopClientEnvironment(window.location.search)
  if (!environment) return
  ctx.effect(
    () => startRendererBootReporter(ctx.loader),
    'dsh-plugin-desktop: renderer boot health report',
  )
  if (environment.mode === 'advanced') applyAdvancedShell(ctx, environment)
  else ctx.effect(() => installAttachmentStyles(), 'desktop: attachment picker styles')

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'desktop-attachment-picker',
    order: -10,
    inject: (): AttachmentPickerInjected => {
      const conversation = conversationController(ctx)
      return {
        createDraftImages: files => conversation.createDraftImages(files),
        draftImages: ids => conversation.draftImages(ids),
        releaseDraftImages: attachments => { conversation.releaseDraftImages(attachments) },
      }
    },
  }, AttachmentPicker))
}
