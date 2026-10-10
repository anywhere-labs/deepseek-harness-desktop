// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DesktopFileContextMenu } from '../src/client/desktop-file-context-menu.tsx'
import type { SessionWorkspacePathApplication } from '@deepseek-ai/dsh-api-session-controller/types'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const React = await import('react')
  return {
    Menu: ({ open, children }: { readonly open: boolean; readonly children: React.ReactNode }) => open
      ? React.createElement('div', { role: 'menu' }, children)
      : null,
    MenuItemButton: ({ onSelect, children, disabled }: {
      readonly onSelect: () => void
      readonly children: React.ReactNode
      readonly disabled?: boolean
    }) => React.createElement('button', {
      type: 'button',
      role: 'menuitem',
      disabled,
      onClick: onSelect,
    }, children),
    Toast: () => null,
    writeClipboard: async (text: string) => {
      await navigator.clipboard.writeText(text)
      return true
    },
  }
})

const sessionId = 'session-file-menu' as PropsRuntime<'conversation.input.left'>['sessionId']
const insertion = { start: 2, end: 2, draftRev: 4 }
let root: Root | undefined
let host: HTMLDivElement | undefined
let session: HTMLDivElement | undefined
let clipboardDescriptor: PropertyDescriptor | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  session?.remove()
  if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
  else Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  vi.unstubAllGlobals()
  root = undefined
  host = undefined
  session = undefined
  clipboardDescriptor = undefined
})

function menuItem(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find(candidate => candidate.textContent?.trim() === label)
  if (button === undefined) throw new Error(`Missing menu item: ${label}`)
  return button
}

function fileTreeRow(kind: 'file' | 'directory', path: string): HTMLLIElement {
  const row = document.createElement('li')
  row.dataset.filesEntry = kind
  row.dataset.filesPath = path
  return row
}

function openContextMenu(row: HTMLLIElement): MouseEvent {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 120,
    clientY: 80,
  })
  row.dispatchEvent(event)
  return event
}

async function mountMenu() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  host = document.createElement('div')
  session = document.createElement('div')
  session.dataset.sidebarRightSession = String(sessionId)
  const tree = document.createElement('ul')
  tree.dataset.filesRoot = '/workspace/project'
  const file = fileTreeRow('file', '/workspace/project/src/main.ts')
  const folder = fileTreeRow('directory', '/workspace/project/src')
  tree.append(file, folder)
  session.append(host, tree)
  document.body.append(session)
  root = createRoot(host)
  const captureInsertion = vi.fn(() => insertion)
  const insertText = vi.fn(() => true)
  const openWorkspacePath: ComponentProps<typeof DesktopFileContextMenu>['openWorkspacePath'] = vi.fn(async () => ({
    ok: true as const,
    value: { opened: true as const },
  }))
  const unrelatedCodeApp: SessionWorkspacePathApplication = {
    id: '/usr/share/applications/code-editor.desktop',
    name: 'Code',
    default: false,
    icon: null,
  }
  const vscode: SessionWorkspacePathApplication = {
    id: '/usr/share/applications/code.desktop',
    name: 'Visual Studio Code (localized)',
    default: false,
    icon: null,
  }
  const workspacePathApplications: ComponentProps<typeof DesktopFileContextMenu>['workspacePathApplications'] = vi.fn(async () => ({
    ok: true as const,
    value: [unrelatedCodeApp, vscode],
  }))
  const writeText = vi.fn(async () => {})
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  const props: ComponentProps<typeof DesktopFileContextMenu> = {
    sessionId,
    inputActions: {
      captureInsertion,
      insertText,
      setDraft: () => {},
      addAttachments: () => true,
      removeAttachment: () => {},
      pruneAttachments: () => {},
      submit: () => {},
    },
    openWorkspacePath,
    workspacePathApplications,
    t: key => ({
      addToTask: 'Add to task',
      openInEditor: 'Open in VS Code',
      showInFileManager: 'Show in file manager',
      copyAbsolutePath: 'Copy absolute path',
      copyRelativePath: 'Copy relative path',
      addedToTask: 'File reference added to the composer.',
      copiedPath: 'Path copied.',
      referenceUnavailable: 'This path cannot be added as a file reference.',
      insertFailed: 'Could not add the file reference to the composer.',
      vscodeUnavailable: 'VS Code is not registered to open this file.',
      operationFailed: 'Could not complete this file action.',
    })[key],
  }
  await act(async () => root?.render(createElement(DesktopFileContextMenu, props)))
  return {
    file,
    folder,
    captureInsertion,
    insertText,
    openWorkspacePath,
    workspacePathApplications,
    writeText,
  }
}

describe('Desktop file-tree context menu', () => {
  it('inserts file references, reveals files, opens VS Code, and copies both paths', async () => {
    const actions = await mountMenu()
    let event: MouseEvent
    await act(async () => { event = openContextMenu(actions.file) })
    expect(event!.defaultPrevented).toBe(true)
    expect(actions.captureInsertion).toHaveBeenCalledOnce()
    expect(document.body.querySelectorAll('[role="menuitem"]')).toHaveLength(5)

    await act(async () => { menuItem('Add to task').click() })
    expect(actions.insertText).toHaveBeenCalledWith('@src/main.ts', insertion)

    await act(async () => { openContextMenu(actions.file) })
    await act(async () => { menuItem('Show in file manager').click(); await Promise.resolve() })
    expect(actions.openWorkspacePath).toHaveBeenCalledWith({
      path: '/workspace/project/src/main.ts',
      action: 'reveal',
    })

    await act(async () => { openContextMenu(actions.file) })
    await act(async () => { menuItem('Open in VS Code').click(); await Promise.resolve() })
    expect(actions.workspacePathApplications).toHaveBeenCalledWith({ path: '/workspace/project/src/main.ts' })
    expect(actions.openWorkspacePath).toHaveBeenCalledWith({
      path: '/workspace/project/src/main.ts',
      application: '/usr/share/applications/code.desktop',
    })

    await act(async () => { openContextMenu(actions.file) })
    await act(async () => { menuItem('Copy absolute path').click(); await Promise.resolve() })
    expect(actions.writeText).toHaveBeenCalledWith('/workspace/project/src/main.ts')

    await act(async () => { openContextMenu(actions.file) })
    await act(async () => { menuItem('Copy relative path').click(); await Promise.resolve() })
    expect(actions.writeText).toHaveBeenCalledWith('src/main.ts')
  })

  it('inserts directory mentions and omits the file-only editor action', async () => {
    const actions = await mountMenu()
    await act(async () => { openContextMenu(actions.folder) })
    expect(document.body.querySelectorAll('[role="menuitem"]')).toHaveLength(4)
    expect(document.body.textContent).not.toContain('Open in VS Code')
    await act(async () => { menuItem('Add to task').click() })
    expect(actions.insertText).toHaveBeenCalledWith('@src/', insertion)
  })

  it('dismisses a portaled menu when its retained Session is hidden', async () => {
    const actions = await mountMenu()
    await act(async () => { openContextMenu(actions.file) })
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () => {
      session!.hidden = true
      await Promise.resolve()
    })
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })

  it('ignores rows belonging to a different Session', async () => {
    const actions = await mountMenu()
    const otherSession = document.createElement('div')
    otherSession.dataset.sidebarRightSession = 'another-session'
    const tree = document.createElement('ul')
    tree.dataset.filesRoot = '/workspace/project'
    const row = fileTreeRow('file', '/workspace/project/other.ts')
    tree.append(row)
    otherSession.append(tree)
    document.body.append(otherSession)
    let event: MouseEvent
    await act(async () => { event = openContextMenu(row) })
    expect(event!.defaultPrevented).toBe(false)
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    otherSession.remove()
    expect(actions.captureInsertion).not.toHaveBeenCalled()
  })
})
