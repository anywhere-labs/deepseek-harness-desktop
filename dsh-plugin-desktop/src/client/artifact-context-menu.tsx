import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {
  ClientContext,
  SessionId,
  SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  ProducedFiles,
  producedForClosing,
  type ProducedFilesProps,
} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import {
  DESKTOP_ARTIFACT_CONTEXT_MENU_BRIDGE,
  type DesktopArtifactContextMenuBridge,
  type DesktopArtifactContextMenuWindow,
} from '../artifact-context-menu-contract.ts'
import type { DesktopClientEnvironment } from './environment.ts'

/** Desktop wrapper needs only the global session lookup beyond upstream props. */
export interface DesktopProducedFilesProps extends ProducedFilesProps {
  readonly sessionId: SessionId
  readonly useSessions: SnapshotSelectorHook<SessionListState>
  readonly artifactContextMenu: DesktopArtifactContextMenuBridge
}

/** Read-only session list surface used by the compatibility-mode event adapter. */
export interface DesktopArtifactSessionList {
  getSnapshot(): SessionListState
}

/** Resolve only a visible, upstream-produced file chip from an event target. */
export function producedPathFromContextTarget(
  target: EventTarget | null,
  matched: readonly string[],
): string | undefined {
  if (!(target instanceof Element)) return undefined
  const button = target.closest('button[title]')
  const row = button?.closest('[data-produced-files-row]')
  if (button === null || row === null) return undefined
  const path = button.getAttribute('title')
  return path !== null && matched.includes(path) ? path : undefined
}

/** Resolve a visible produced chip without replacing the upstream compatibility presentation. */
export function producedPathFromCompatibilityTarget(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined
  const button = target.closest('button[title]')
  if (button?.closest('[data-produced-files-row]') === null) return undefined
  return button?.getAttribute('title') ?? undefined
}

function reportArtifactContextMenuFailure(cause: unknown): void {
  console.error(
    'dsh-plugin-desktop: failed to open produced-file context menu:',
    cause instanceof Error ? cause.message : String(cause),
  )
}

/** Add the native action to the upstream DOM without registering or replacing a compatibility-mode slot. */
export function installCompatibilityArtifactContextMenu(
  sessions: DesktopArtifactSessionList,
  artifactContextMenu: DesktopArtifactContextMenuBridge,
  target: Document = document,
): () => void {
  const onContextMenu = (event: Event): void => {
    const path = producedPathFromCompatibilityTarget(event.target)
    if (path === undefined) return
    event.preventDefault()
    const snapshot = sessions.getSnapshot()
    const current = snapshot.current
    const cwd = current === undefined ? undefined : snapshot.byId[current]?.cwd
    void artifactContextMenu.show({ path, ...(cwd === undefined ? {} : { cwd }) })
      .catch(reportArtifactContextMenuFailure)
  }
  target.addEventListener('contextmenu', onContextMenu)
  return () => { target.removeEventListener('contextmenu', onContextMenu) }
}

/** Preserve the upstream artifact UI while adding a trusted native context menu. */
export function DesktopProducedFiles(props: DesktopProducedFilesProps): ReactNode {
  const { artifactContextMenu, matched, sessionId, useSessions, ...upstreamProps } = props
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const path = producedPathFromContextTarget(event.target, matched)
    if (path === undefined) return
    event.preventDefault()
    void artifactContextMenu.show({ path, ...(cwd === undefined ? {} : { cwd }) })
      .catch(reportArtifactContextMenuFailure)
  }

  return (
    <div onContextMenu={onContextMenu}>
      <ProducedFiles {...upstreamProps} matched={matched} />
    </div>
  )
}

/** Install the higher-priority turn-tail entry only in native advanced mode. */
export function registerDesktopArtifactContextMenu(
  ctx: ClientContext,
  environment: DesktopClientEnvironment,
  target: DesktopArtifactContextMenuWindow = window as unknown as DesktopArtifactContextMenuWindow,
): void {
  if (environment.mode !== 'advanced' || environment.platform === 'linux') return
  const artifactContextMenu = target[DESKTOP_ARTIFACT_CONTEXT_MENU_BRIDGE]
  if (artifactContextMenu === undefined) return
  const connection = ctx.get('connection') as ConnectionHandle

  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    priority: -100,
    select: (owner: TurnTailOwnerProps) => {
      const paths = producedForClosing(owner.turn.data.get('deliverables'), owner.seq)
      return paths.length === 0 ? null : paths
    },
    locale: 'deliverables',
    inject: () => ({
      artifactContextMenu,
      isLoopback: connection.isLoopback,
      hooks: { hostDescription: connection.hostDescription },
    }),
  }, DesktopProducedFiles))
}
