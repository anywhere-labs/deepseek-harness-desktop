/** File-tree context actions owned by the Desktop client. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type { SessionOpenWorkspacePathRequest, SessionWorkspacePathApplication } from '@deepseek-ai/dsh-api-session-controller/types'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import { Menu, MenuItemButton, Toast, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import {
  DESKTOP_FILE_MENU_LOCALE_NAMESPACE,
  en,
  zh,
  type DesktopFileMenuLocaleKey,
} from './desktop-file-context-menu-locales.ts'
import { relativeTreePath } from './desktop-file-context-path.ts'

/** Locale namespace owned by the Desktop file-tree menu. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'desktop.files': DesktopFileMenuLocaleKey
  }
}

interface FileTreeTarget {
  readonly x: number
  readonly y: number
  readonly sessionId: string
  readonly path: string
  readonly relativePath: string
  readonly kind: 'file' | 'directory'
  readonly insertion: ReturnType<PropsRuntime<'conversation.input.left'>['inputActions']['captureInsertion']>
}

type SessionPathRemote = Pick<ClientContext['remote']['session'], 'openWorkspacePath' | 'workspacePathApplications'>
type Translate = (key: DesktopFileMenuLocaleKey) => string
type SessionInputProps = Pick<PropsRuntime<'conversation.input.left'>, 'sessionId' | 'inputActions'>
type FileContextMenuProps = SessionInputProps & Pick<
  SessionPathRemote,
  'openWorkspacePath' | 'workspacePathApplications'
> & { readonly t: Translate }

/** Register the menu in every mounted session composer without creating a second React root. */
export function applyDesktopFileContextMenu(ctx: ClientContext): void {
  const t = ctx.locale.bind(DESKTOP_FILE_MENU_LOCALE_NAMESPACE)
  ctx.effect(
    () => ctx.locale.register(DESKTOP_FILE_MENU_LOCALE_NAMESPACE, { zh, en }),
    'dsh-plugin-desktop: file context menu dictionaries',
  )
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'desktop-file-context-menu',
    inject: sessionId => ({
      sessionId,
      openWorkspacePath: (request: SessionOpenWorkspacePathRequest) => ctx.remote.session.openWorkspacePath(request),
      workspacePathApplications: (request: { readonly path: string }) => ctx.remote.session.workspacePathApplications(request),
      t,
    }),
  }, DesktopFileContextMenu))
}

/** Render file-tree actions in the composer instance for the matching Session.
 * @param props - session-scoped input actions, native path callbacks, and translated labels.
 * @returns the session's context menu and any active status toast.
 */
export function DesktopFileContextMenu({
  sessionId,
  inputActions,
  openWorkspacePath,
  workspacePathApplications,
  t,
}: FileContextMenuProps) {
  const [target, setTarget] = useState<FileTreeTarget | null>(null)
  const [notice, setNotice] = useState<{ readonly text: string; readonly sequence: number } | null>(null)
  const noticeSequence = useRef(0)
  const sessionMarker = useRef<HTMLSpanElement>(null)
  const showNotice = (text: string): void => setNotice({ text, sequence: ++noticeSequence.current })

  useEffect(() => {
    const sessionRoot = sessionMarker.current?.closest<HTMLElement>('[data-sidebar-right-session]')
    if (sessionRoot === null || sessionRoot === undefined) return
    const observer = new MutationObserver(() => {
      if (sessionRoot.hidden) setTarget(null)
    })
    observer.observe(sessionRoot, { attributes: true, attributeFilter: ['hidden'] })
    if (sessionRoot.hidden) setTarget(null)
    return () => observer.disconnect()
  }, [sessionId])

  useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return
      const row = event.target.closest<HTMLLIElement>(
        'li[data-files-entry="file"], li[data-files-entry="directory"]',
      )
      if (row === null) return
      const tree = row.closest<HTMLElement>('[data-files-root]')
      const session = row.closest<HTMLElement>('[data-sidebar-right-session]')
      const path = row.dataset.filesPath
      const rootPath = tree?.dataset.filesRoot
      const rowSessionId = session?.dataset.sidebarRightSession
      const kind = row.dataset.filesEntry
      if (path === undefined || rootPath === undefined || rowSessionId !== String(sessionId)
        || (kind !== 'file' && kind !== 'directory')) return
      const relativePath = relativeTreePath(rootPath, path)
      if (relativePath === undefined) return
      event.preventDefault()
      setNotice(null)
      setTarget({
        x: event.clientX,
        y: event.clientY,
        path,
        relativePath,
        sessionId: rowSessionId,
        kind,
        insertion: inputActions.captureInsertion(),
      })
    }
    document.addEventListener('contextmenu', onContextMenu, true)
    return () => document.removeEventListener('contextmenu', onContextMenu, true)
  }, [inputActions, sessionId])

  const close = (): void => setTarget(null)
  const showFailure = (): void => showNotice(t('operationFailed'))
  const mention = target === null ? undefined : formatFileMention(
    { path: target.relativePath, kind: target.kind }, false,
  )

  const addToTask = (): void => {
    if (target === null) return
    if (mention === undefined) {
      close()
      showNotice(t('referenceUnavailable'))
      return
    }
    const inserted = inputActions.insertText(mention, target.insertion)
    close()
    showNotice(inserted ? t('addedToTask') : t('insertFailed'))
  }

  const reveal = async (): Promise<void> => {
    if (target === null) return
    const request: SessionOpenWorkspacePathRequest = { path: target.path, action: 'reveal' }
    const result = await openWorkspacePath(request)
    if (!result.ok) throw new Error('File manager reveal was rejected')
  }

  const openInVSCode = async (): Promise<void> => {
    if (target === null || target.kind !== 'file') return
    const result = await workspacePathApplications({ path: target.path })
    if (!result.ok) throw new Error('File application lookup failed')
    const application = result.value.find(isVSCodeApplication)
    if (application === undefined) {
      close()
      showNotice(t('vscodeUnavailable'))
      return
    }
    const opened = await openWorkspacePath({ path: target.path, application: application.id })
    if (!opened.ok) throw new Error('VS Code open was rejected')
  }

  const copyPath = async (path: string): Promise<void> => {
    if (!await writeClipboard(path)) throw new Error('Clipboard write failed')
    showNotice(t('copiedPath'))
  }

  const run = (operation: () => void | Promise<void>): void => {
    close()
    void Promise.resolve().then(operation).catch(showFailure)
  }

  return (
    <>
      <span ref={sessionMarker} hidden aria-hidden="true" />
      <Menu
        open={target !== null}
        anchor={<span aria-hidden="true" />}
        portal
        autoFocus
        getAnchorRect={() => target === null ? null : new DOMRect(target.x, target.y, 0, 0)}
        onClose={close}
      >
        <MenuItemButton disabled={mention === undefined} onSelect={addToTask}>
          {t('addToTask')}
        </MenuItemButton>
        <MenuItemButton separatorBefore onSelect={() => run(reveal)}>
          {t('showInFileManager')}
        </MenuItemButton>
        {target?.kind === 'file' && (
          <MenuItemButton onSelect={() => run(openInVSCode)}>
            {t('openInEditor')}
          </MenuItemButton>
        )}
        <MenuItemButton separatorBefore onSelect={() => target !== null && run(() => copyPath(target.path))}>
          {t('copyAbsolutePath')}
        </MenuItemButton>
        <MenuItemButton onSelect={() => target !== null && run(() => copyPath(target.relativePath))}>
          {t('copyRelativePath')}
        </MenuItemButton>
      </Menu>
      {notice !== null && (
        <Toast
          key={notice.sequence}
          text={notice.text}
          onDone={() => setNotice(null)}
        />
      )}
    </>
  )
}

function isVSCodeApplication(application: SessionWorkspacePathApplication): boolean {
  const id = application.id.replace(/\\/gu, '/')
  const idName = id.slice(id.lastIndexOf('/') + 1)
  const knownId = /^(?:visual studio code(?: - insiders)?\.app|(?:com\.visualstudio\.code|code(?:-oss|-insiders)?)(?:\.desktop)?|code(?: - insiders)?\.exe|vscode(?:-insiders)?)$/iu
  return knownId.test(idName)
    || /^(?:visual studio code(?:\s+-\s+insiders)?)$/iu.test(application.name.trim())
}
