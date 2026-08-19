// @vitest-environment jsdom

import type { ClientContext, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ProducedFilesProps } from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopArtifactContextMenuBridge } from '../src/artifact-context-menu-contract.ts'
import {
  DesktopProducedFiles,
  installCompatibilityArtifactContextMenu,
  registerDesktopArtifactContextMenu,
} from '../src/client/artifact-context-menu.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-deliverables/client', async () => {
  const React = await import('react')
  return {
    ProducedFiles: ({ matched, openFile }: ProducedFilesProps) => React.createElement(
      'section',
      null,
      React.createElement(
        'div',
        { 'data-produced-files-row': true },
        matched.map(path => React.createElement(
          'button',
          { key: path, title: path, type: 'button', onClick: () => { openFile(path) } },
          React.createElement('span', null, path),
        )),
      ),
      React.createElement('button', { title: 'unrelated', type: 'button' }, 'unrelated'),
    ),
    producedForClosing: (
      data: { produced: readonly { path: string; seq: number }[] } | undefined,
      seq = Number.POSITIVE_INFINITY,
    ) => data?.produced.filter(item => item.seq <= seq).map(item => item.path) ?? [],
  }
})

afterEach(() => { cleanup() })

describe('desktop produced-file context menu', () => {
  it('adds the native action to compatibility mode without replacing the upstream row', async () => {
    const show = vi.fn(async () => {})
    const sessionId = 'session-1' as SessionId
    const dispose = installCompatibilityArtifactContextMenu({
      getSnapshot: () => ({
        current: sessionId,
        byId: { [sessionId]: { cwd: '/workspace' } },
      } as unknown as SessionListState),
    }, { show })
    render(<section>
      <div data-produced-files-row>
        <button title="reports/result.md" type="button"><span>result.md</span></button>
      </div>
      <button title="unrelated" type="button">unrelated</button>
    </section>)

    const chipText = screen.getByText('result.md')
    const menuEvent = createEvent.contextMenu(chipText)
    fireEvent(chipText, menuEvent)
    expect(menuEvent.defaultPrevented).toBe(true)
    await waitFor(() => {
      expect(show).toHaveBeenCalledWith({ cwd: '/workspace', path: 'reports/result.md' })
    })

    fireEvent.contextMenu(screen.getByTitle('unrelated'))
    expect(show).toHaveBeenCalledTimes(1)
    dispose()
    fireEvent.contextMenu(chipText)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('keeps left-click behavior and opens the native menu for a real chip', async () => {
    const show = vi.fn(async () => {})
    const openFile = vi.fn()
    const sessionId = 'session-1' as SessionId
    const useSessions = ((selector: (state: SessionListState) => unknown) => selector({
      byId: { [sessionId]: { cwd: '/workspace' } },
    } as unknown as SessionListState)) as SnapshotSelectorHook<SessionListState>
    render(<DesktopProducedFiles
      artifactContextMenu={{ show }}
      isLoopback
      matched={['reports/result.md']}
      openFile={openFile}
      sessionId={sessionId}
      t={((key: string) => key) as ProducedFilesProps['t']}
      useHostDescription={(() => true) as ProducedFilesProps['useHostDescription']}
      useSessions={useSessions}
    />)

    const chip = screen.getByTitle('reports/result.md')
    const chipText = chip.querySelector('span')
    expect(chipText).not.toBeNull()
    fireEvent.click(chipText as HTMLSpanElement)
    expect(openFile).toHaveBeenCalledWith('reports/result.md')

    const menuEvent = createEvent.contextMenu(chipText as HTMLSpanElement)
    fireEvent(chipText as HTMLSpanElement, menuEvent)
    expect(menuEvent.defaultPrevented).toBe(true)
    await waitFor(() => {
      expect(show).toHaveBeenCalledWith({ cwd: '/workspace', path: 'reports/result.md' })
    })
  })

  it('supports a focused chip context-menu event and ignores unrelated controls', async () => {
    const show = vi.fn(async () => {})
    const sessionId = 'session-1' as SessionId
    const useSessions = ((selector: (state: SessionListState) => unknown) => selector({
      byId: { [sessionId]: {} },
    } as unknown as SessionListState)) as SnapshotSelectorHook<SessionListState>
    render(<DesktopProducedFiles
      artifactContextMenu={{ show }}
      isLoopback
      matched={['result.md']}
      openFile={() => {}}
      sessionId={sessionId}
      t={((key: string) => key) as ProducedFilesProps['t']}
      useHostDescription={(() => true) as ProducedFilesProps['useHostDescription']}
      useSessions={useSessions}
    />)

    const unrelated = screen.getByTitle('unrelated')
    const unrelatedEvent = createEvent.contextMenu(unrelated)
    fireEvent(unrelated, unrelatedEvent)
    expect(unrelatedEvent.defaultPrevented).toBe(false)
    expect(show).not.toHaveBeenCalled()

    const chip = screen.getByTitle('result.md')
    chip.focus()
    expect(document.activeElement).toBe(chip)
    fireEvent.contextMenu(chip)
    await waitFor(() => { expect(show).toHaveBeenCalledWith({ path: 'result.md' }) })
  })

  it('registers the higher-priority replacement only for supported advanced shells', () => {
    const register = vi.fn(() => () => {})
    const inject = vi.fn((_name: string, callback: () => unknown) => callback())
    const bridge: DesktopArtifactContextMenuBridge = { show: vi.fn(async () => {}) }
    const ctx = {
      get: vi.fn(() => ({
        isLoopback: true,
        hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
      })),
      slots: { inject, register },
    } as unknown as ClientContext

    registerDesktopArtifactContextMenu(ctx, { mode: 'compatibility', platform: 'darwin' }, {
      __DSH_DESKTOP_ARTIFACT_CONTEXT_MENU__: bridge,
    })
    registerDesktopArtifactContextMenu(ctx, { mode: 'advanced', platform: 'linux' }, {
      __DSH_DESKTOP_ARTIFACT_CONTEXT_MENU__: bridge,
    })
    expect(inject).not.toHaveBeenCalled()

    registerDesktopArtifactContextMenu(ctx, { mode: 'advanced', platform: 'win32' }, {
      __DSH_DESKTOP_ARTIFACT_CONTEXT_MENU__: bridge,
    })
    expect(inject).toHaveBeenCalledWith('conversation.chat.turnTail', expect.any(Function))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.chat.turnTail',
      priority: -100,
      locale: 'deliverables',
    }), DesktopProducedFiles)
  })
})
