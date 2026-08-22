import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelSelection, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { VisionAttachments } from './VisionAttachments.tsx'
import {
  VisionModelSelect,
  type DesktopModelDirectoryState,
  type VisionModelSelectInjected,
} from './VisionModelSelect.tsx'
import { en, zh, type VisionLocaleKey } from './vision-locales.ts'
import { installVisionStyles } from './vision-styles.ts'

export const VISION_LOCALE_NAMESPACE = 'desktop.vision'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'desktop.vision': VisionLocaleKey
  }
}

interface DirectoryPort {
  store: SnapshotStore<DesktopModelDirectoryState>
  load(): Promise<unknown>
  select(selection: ModelSelection): Promise<void>
}

interface DirectoryResolverPort {
  directoryFor(sessionId: SessionId): DirectoryPort
}

/** Register desktop-owned Vision presentation surfaces. */
export function applyVisionExperience(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(VISION_LOCALE_NAMESPACE, { zh, en }),
    'dsh-plugin-desktop: Vision dictionaries',
  )
  ctx.effect(
    () => installVisionStyles(),
    'dsh-plugin-desktop: Vision styles',
  )

  ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({
    name: 'conversation.input.attachments',
    priority: -100,
    locale: VISION_LOCALE_NAMESPACE,
    registrant: 'dsh-plugin-desktop/vision',
  }, VisionAttachments))

  ctx.inject(['modelDirectories'], (scope: ClientContext) => {
    const models = (scope as unknown as { modelDirectories: DirectoryResolverPort }).modelDirectories
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model',
      priority: -100,
      locale: VISION_LOCALE_NAMESPACE,
      registrant: 'dsh-plugin-desktop/vision',
      inject: (sessionId): VisionModelSelectInjected => {
        const directory = models.directoryFor(sessionId)
        const available = scope.sessions.subagentAddress(sessionId) === undefined
        return {
          available,
          directory: directory.store,
          load: () => {
            if (available) directory.load().catch(() => undefined)
          },
          select: selection => available
            ? directory.select(selection).then(() => true, () => false)
            : Promise.resolve(false),
        }
      },
    }, VisionModelSelect))
  })
}
