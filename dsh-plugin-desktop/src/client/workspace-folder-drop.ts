import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { DesktopFilePathBridge, DesktopFilePathBridgeWindow } from '../file-path-bridge-contract.ts'

export const WORKSPACE_DROP_TARGET = '[data-dsh-workspace-drop-target]'

/** Workspace operations used after a desktop folder is resolved. */
export interface WorkspaceFolderDropActions {
  create(input: { path: string }): Promise<WorkspaceView>
  startSession(workspaceId: WorkspaceId): void
  validateDirectory?(path: string): Promise<boolean>
}

type DropState = 'ready' | 'busy' | 'error'

const COPY = {
  en: {
    ready: 'Drop to add workspace',
    busy: 'Adding workspace…',
    invalid: 'Drop exactly one folder',
    unavailable: 'DSH Desktop could not read this folder path',
  },
  zh: {
    ready: '松开以添加工作区',
    busy: '正在添加工作区…',
    invalid: '请只拖入一个文件夹',
    unavailable: 'DSH Desktop 无法读取这个文件夹路径',
  },
} as const

const DROP_STYLES = `
${WORKSPACE_DROP_TARGET} { position: relative; }
${WORKSPACE_DROP_TARGET}[data-dsh-desktop-drop-state] { box-shadow: inset 0 0 0 2px var(--dsw-alias-state-business-primary); }
.dshDesktopWorkspaceDropFeedback { position: absolute; z-index: 40; inset: 4px; box-sizing: border-box; pointer-events: none; display: flex; align-items: center; justify-content: center; padding: 12px; color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 92%, transparent); border: 1px dashed var(--dsw-alias-state-business-primary); border-radius: 10px; text-align: center; font-size: 13px; line-height: 20px; }
${WORKSPACE_DROP_TARGET}[data-dsh-desktop-drop-state="error"] { box-shadow: inset 0 0 0 2px var(--dsw-alias-state-error-primary); }
${WORKSPACE_DROP_TARGET}[data-dsh-desktop-drop-state="error"] > .dshDesktopWorkspaceDropFeedback { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
`

function copy(): typeof COPY.en | typeof COPY.zh {
  const language = document.documentElement.lang || navigator.language
  return language.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en
}

/** Whether this native drag carries operating-system files rather than an internal row reorder. */
export function hasFilePayload(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes('Files')
    || Array.from(transfer.items).some(item => item.kind === 'file')
}

/** Return the one dropped directory File, rejecting ordinary files and multi-selection. */
export function singleDroppedDirectory(transfer: DataTransfer): File | undefined {
  const items = Array.from(transfer.items).filter(item => item.kind === 'file')
  if (items.length !== 1) return undefined
  const item = items[0]
  if (item?.webkitGetAsEntry()?.isDirectory !== true) return undefined
  return item.getAsFile() ?? undefined
}

/** Resolve one disk-backed folder and adopt it through the standard Workspace service. */
export async function adoptWorkspaceFolder(
  file: File,
  bridge: DesktopFilePathBridge,
  actions: WorkspaceFolderDropActions,
): Promise<void> {
  const path = bridge.getPathForFile(file).trim()
  if (path.length === 0) throw new Error('DSH Desktop could not read this folder path')
  if (actions.validateDirectory !== undefined && !await actions.validateDirectory(path)) {
    throw new Error('DSH Desktop rejected this workspace location')
  }
  const workspace = await actions.create({ path })
  actions.startSession(workspace.workspaceId)
}

function workspaceTarget(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined
  const element = target.closest(WORKSPACE_DROP_TARGET)
  return element instanceof HTMLElement ? element : undefined
}

/** Install desktop-only folder adoption on the upstream Workspace browser. */
export function installWorkspaceFolderDrop(
  actions: WorkspaceFolderDropActions,
  bridgeWindow: DesktopFilePathBridgeWindow = window as DesktopFilePathBridgeWindow,
): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/workspace-folder-drop'
  style.textContent = DROP_STYLES
  document.head.appendChild(style)

  let active: HTMLElement | undefined
  let busy = false
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = (): void => {
    if (feedbackTimer !== undefined) clearTimeout(feedbackTimer)
    feedbackTimer = undefined
  }
  const hide = (target: HTMLElement | undefined = active): void => {
    if (target === undefined) return
    delete target.dataset.dshDesktopDropState
    target.querySelector(':scope > .dshDesktopWorkspaceDropFeedback')?.remove()
    if (active === target) active = undefined
  }
  const show = (target: HTMLElement, state: DropState, message: string): void => {
    if (active !== undefined && active !== target) hide(active)
    active = target
    target.dataset.dshDesktopDropState = state
    let feedback = target.querySelector<HTMLElement>(':scope > .dshDesktopWorkspaceDropFeedback')
    if (feedback === null) {
      feedback = document.createElement('div')
      feedback.className = 'dshDesktopWorkspaceDropFeedback'
      target.appendChild(feedback)
    }
    feedback.role = state === 'error' ? 'alert' : 'status'
    feedback.setAttribute('aria-live', state === 'error' ? 'assertive' : 'polite')
    feedback.textContent = target.clientWidth < 120 && state !== 'error' ? '+' : message
  }
  const showTemporaryError = (target: HTMLElement, message: string): void => {
    clearTimer()
    show(target, 'error', message)
    feedbackTimer = setTimeout(() => { hide(target) }, 3_000)
  }

  const onDragOver = (event: DragEvent): void => {
    const transfer = event.dataTransfer
    const target = workspaceTarget(event.target)
    if (transfer === null || target === undefined || !hasFilePayload(transfer)) return
    event.preventDefault()
    const acceptable = !busy && singleDroppedDirectory(transfer) !== undefined
    transfer.dropEffect = acceptable ? 'copy' : 'none'
    if (acceptable) show(target, 'ready', copy().ready)
    else if (!busy) hide(target)
  }
  const onDragLeave = (event: DragEvent): void => {
    const target = workspaceTarget(event.target)
    if (target === undefined || target !== active || busy) return
    if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return
    hide(target)
  }
  const onDrop = (event: DragEvent): void => {
    const transfer = event.dataTransfer
    const target = workspaceTarget(event.target)
    if (transfer === null || target === undefined || !hasFilePayload(transfer)) return
    event.preventDefault()
    event.stopPropagation()
    clearTimer()
    if (busy) return

    const file = singleDroppedDirectory(transfer)
    if (file === undefined) {
      showTemporaryError(target, copy().invalid)
      return
    }
    const bridge = bridgeWindow.__DSH_DESKTOP_FILE_PATH__
    if (bridge === undefined) {
      showTemporaryError(target, copy().unavailable)
      return
    }

    try {
      busy = true
      show(target, 'busy', copy().busy)
      void adoptWorkspaceFolder(file, bridge, actions).then(() => {
        hide(target)
      }, (reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason)
        showTemporaryError(target, message)
      }).finally(() => { busy = false })
    } catch {
      showTemporaryError(target, copy().unavailable)
      busy = false
    }
  }
  const onDragEnd = (): void => { if (!busy) hide() }

  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('dragleave', onDragLeave, true)
  document.addEventListener('drop', onDrop, true)
  document.addEventListener('dragend', onDragEnd, true)
  return () => {
    clearTimer()
    hide()
    style.remove()
    document.removeEventListener('dragover', onDragOver, true)
    document.removeEventListener('dragleave', onDragLeave, true)
    document.removeEventListener('drop', onDrop, true)
    document.removeEventListener('dragend', onDragEnd, true)
  }
}
