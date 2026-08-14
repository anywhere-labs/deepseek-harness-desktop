import { describe, expect, it } from 'vitest'
import {
  createDesktopContextMenuTemplate,
  type DesktopContextMenuParams,
} from '../src/context-menu.ts'

function context(
  overrides: Partial<DesktopContextMenuParams> = {},
): DesktopContextMenuParams {
  return {
    isEditable: false,
    selectionText: '',
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: false,
      canEditRichly: false,
    },
    ...overrides,
  }
}

describe('desktop context menu', () => {
  it('exposes native edit roles with renderer-provided availability', () => {
    const template = createDesktopContextMenuTemplate(context({
      isEditable: true,
      editFlags: {
        canUndo: true,
        canRedo: false,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canDelete: true,
        canSelectAll: true,
        canEditRichly: false,
      },
    }))

    expect(template).toEqual([
      { role: 'undo', enabled: true },
      { role: 'redo', enabled: false },
      { type: 'separator' },
      { role: 'cut', enabled: true },
      { role: 'copy', enabled: true },
      { role: 'paste', enabled: true },
      { role: 'delete', enabled: true },
      { type: 'separator' },
      { role: 'selectAll', enabled: true },
    ])
  })

  it('offers copy and select-all for selected read-only text', () => {
    const template = createDesktopContextMenuTemplate(context({
      selectionText: 'selected output',
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: true,
        canPaste: false,
        canDelete: false,
        canSelectAll: true,
        canEditRichly: false,
      },
    }))

    expect(template).toEqual([
      { role: 'copy', enabled: true },
      { type: 'separator' },
      { role: 'selectAll' },
    ])
  })

  it('keeps a read-only copy action disabled when the renderer rejects it', () => {
    const template = createDesktopContextMenuTemplate(context({
      selectionText: 'selected output',
    }))

    expect(template).toEqual([{ role: 'copy', enabled: false }])
  })

  it('offers select-all without a leading separator', () => {
    const template = createDesktopContextMenuTemplate(context({
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: false,
        canPaste: false,
        canDelete: false,
        canSelectAll: true,
        canEditRichly: false,
      },
    }))

    expect(template).toEqual([{ role: 'selectAll' }])
  })

  it('stays silent when read-only content has no text action', () => {
    expect(createDesktopContextMenuTemplate(context())).toEqual([])
  })
})
