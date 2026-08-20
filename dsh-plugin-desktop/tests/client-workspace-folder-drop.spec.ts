import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import {
  adoptWorkspaceFolder,
  hasFilePayload,
  singleDroppedDirectory,
  type WorkspaceFolderDropActions,
} from '../src/client/workspace-folder-drop.ts'

function transfer(items: Array<{ directory: boolean; file?: File | null }>, types: string[] = ['Files']): DataTransfer {
  return {
    items: items.map(item => ({
      kind: 'file',
      getAsFile: () => item.file ?? ({ name: 'folder' } as File),
      webkitGetAsEntry: () => ({ isDirectory: item.directory }),
    })),
    types,
  } as unknown as DataTransfer
}

describe('desktop workspace folder drop', () => {
  it('distinguishes one operating-system directory from files, multiple items, and row drags', () => {
    const directory = transfer([{ directory: true }])
    expect(hasFilePayload(directory)).toBe(true)
    expect(singleDroppedDirectory(directory)).toBeDefined()
    expect(singleDroppedDirectory(transfer([{ directory: false }]))).toBeUndefined()
    expect(singleDroppedDirectory(transfer([{ directory: true }, { directory: true }]))).toBeUndefined()
    expect(hasFilePayload(transfer([], []))).toBe(false)
  })

  it('resolves, creates, and opens through the existing Workspace service', async () => {
    const file = { name: 'repo' } as File
    const workspace = { workspaceId: 'workspace-1' as WorkspaceId } as WorkspaceView
    const actions: WorkspaceFolderDropActions = {
      create: vi.fn(async () => workspace),
      startSession: vi.fn(),
    }
    const bridge = { getPathForFile: vi.fn(() => '  C:\\Work\\repo  ') }

    await adoptWorkspaceFolder(file, bridge, actions)

    expect(bridge.getPathForFile).toHaveBeenCalledWith(file)
    expect(actions.create).toHaveBeenCalledWith({ path: 'C:\\Work\\repo' })
    expect(actions.startSession).toHaveBeenCalledWith(workspace.workspaceId)
  })

  it('rejects an empty native path before creating a workspace', async () => {
    const actions: WorkspaceFolderDropActions = {
      create: vi.fn(),
      startSession: vi.fn(),
    }

    await expect(adoptWorkspaceFolder({} as File, { getPathForFile: () => '' }, actions))
      .rejects.toThrow('could not read this folder path')
    expect(actions.create).not.toHaveBeenCalled()
  })

  it('rejects a workspace when desktop validation denies its volume', async () => {
    const actions: WorkspaceFolderDropActions = {
      create: vi.fn(),
      startSession: vi.fn(),
      validateDirectory: vi.fn(async () => false),
    }

    await expect(adoptWorkspaceFolder(
      { name: 'repo' } as File,
      { getPathForFile: () => 'E:\\repo' },
      actions,
    )).rejects.toThrow('DSH Desktop rejected this workspace location')
    expect(actions.validateDirectory).toHaveBeenCalledWith('E:\\repo')
    expect(actions.create).not.toHaveBeenCalled()
  })
})
