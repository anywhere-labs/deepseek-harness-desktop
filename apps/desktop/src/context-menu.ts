/** Native edit-menu composition for the desktop renderer. */

import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

/** Renderer state used to decide which native edit actions are available. */
export type DesktopContextMenuParams = Pick<ContextMenuParams, 'editFlags' | 'isEditable' | 'selectionText'>

/**
 * Build the native edit menu for the renderer context under the pointer.
 *
 * @param params - Renderer editability, selection, and action availability.
 * @returns Native menu items, or an empty list when the page has no relevant text action.
 */
export function createDesktopContextMenuTemplate(
  params: DesktopContextMenuParams,
): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    return [
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'delete', enabled: params.editFlags.canDelete },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ]
  }

  const template: MenuItemConstructorOptions[] = []
  if (params.selectionText.length > 0) {
    template.push({ role: 'copy', enabled: params.editFlags.canCopy })
  }
  if (params.editFlags.canSelectAll) {
    if (template.length > 0) template.push({ type: 'separator' })
    template.push({ role: 'selectAll' })
  }
  return template
}
