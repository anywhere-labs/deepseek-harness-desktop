/**
 * File-preview surface chrome (design §9, §16.8, §16.12). The panel is the
 * right work surface: a two-line header (name + truncated path) with refresh,
 * system-open, and close icon actions, over a stable independent scroll
 * container that renders loading, error, oversized-metadata, or provider views.
 * A class error boundary contains provider render crashes so a viewer bug can
 * never take down the conversation. System-open failures surface as a local,
 * non-blocking notice and are never written into the shared snapshot.
 * @module dsh-plugin-desktop/client/file-preview/file-preview-panel
 */

import { Component, type ErrorInfo, type ReactNode, useState } from 'react'
import {
  IconCloseOutline16,
  IconRefreshOutline16,
  IconRightUpOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilePreviewDescriptor } from '../../file-preview-contract.ts'
import type { FilePreviewSnapshot } from './controller.ts'
import type { FilePreviewRegistry } from './registry.ts'

/** Props the advanced frame wires to the panel. */
export interface FilePreviewPanelProps {
  /** The external-store controller snapshot. */
  snapshot: FilePreviewSnapshot
  /** Provider registry used to resolve the render component by id. */
  registry: FilePreviewRegistry
  /** Refresh the current file (re-run preview). */
  onRefresh(): void
  /** Close the file surface. */
  onClose(): void
  /** Open the current file with the system default application. */
  onOpenExternally(): Promise<void>
}

/** Basename of a path using either native separator. */
function baseNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

/** Render the ready-view metadata when a file exceeds its kind's byte limit. */
function OversizedView({ descriptor, onOpenExternally }: { descriptor: FilePreviewDescriptor; onOpenExternally(): void }) {
  const size = `${descriptor.size} 字节`
  const limit = descriptor.availability === 'oversized' ? `${descriptor.limitBytes} 字节` : ''
  return (
    <div className="dshDesktopOversizedView">
      <div className="dshDesktopNotice" role="status">文件过大，超出内置查看限制</div>
      <dl className="dshDesktopMetadataList">
        <div><dt>大小</dt><dd>{size}</dd></div>
        {descriptor.availability === 'oversized' && <div><dt>限制</dt><dd>{limit}</dd></div>}
        <div><dt>类型</dt><dd>{descriptor.mediaType}</dd></div>
      </dl>
      <button type="button" className="dshDesktopActionButton" onClick={onOpenExternally}>系统打开</button>
    </div>
  )
}

/** Error boundary that contains a provider render crash and preserves system-open. */
class ProviderErrorBoundary extends Component<{ onOpenExternally(): void; children?: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    console.error('dsh-plugin-desktop: file preview provider crashed', error)
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="dshDesktopProviderError">
          <div className="dshDesktopNotice" role="status">预览器渲染失败</div>
          <button
            type="button"
            className="dshDesktopActionButton"
            onClick={() => { void this.props.onOpenExternally() }}
          >
            系统打开
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Render the file-preview surface for one controller snapshot.
 * @param props - panel props.
 * @returns the file view panel.
 */
export function FilePreviewPanel({ snapshot, registry, onRefresh, onClose, onOpenExternally }: FilePreviewPanelProps) {
  const [systemOpenFailed, setSystemOpenFailed] = useState(false)

  if (snapshot.status === 'closed') {
    return <div className="dshDesktopFilePreviewPanel" />
  }

  const path = snapshot.path
  const fileName = snapshot.status === 'ready' ? snapshot.descriptor.name : baseNameOf(path)

  const openExternally = (): void => {
    onOpenExternally().catch(() => { setSystemOpenFailed(true) })
  }

  let content: ReactNode
  if (snapshot.status === 'loading') {
    content = <div className="dshDesktopFileStatus"><span className="dshDesktopFileSpinner" aria-hidden />正在读取文件…</div>
  } else if (snapshot.status === 'error') {
    content = (
      <div className="dshDesktopFileStatus error">
        <div role="status">{snapshot.error.message || '文件读取失败'}</div>
        <div className="dshDesktopFileStatusActions">
          {snapshot.retryable && (
            <button type="button" className="dshDesktopActionButton" onClick={onRefresh}>重试</button>
          )}
          <button type="button" className="dshDesktopActionButton" onClick={openExternally}>系统打开</button>
        </div>
      </div>
    )
  } else if (snapshot.descriptor.availability === 'oversized' || snapshot.content.kind === 'metadata-only') {
    content = <OversizedView descriptor={snapshot.descriptor} onOpenExternally={openExternally} />
  } else {
    const provider = registry.list().find(candidate => candidate.id === snapshot.providerId)
    // Key the boundary per file+provider so a new load resets a previous crash
    // without remounting the panel chrome.
    const boundaryKey = `${snapshot.providerId}:${snapshot.path}`
    content = (
      <ProviderErrorBoundary key={boundaryKey} onOpenExternally={openExternally}>
        {provider === undefined
          ? (
            <div className="dshDesktopNotice" role="status">没有可用的预览器</div>
          )
          : (
            <provider.Component
              descriptor={snapshot.descriptor}
              content={snapshot.content}
              onOpenExternally={openExternally}
            />
          )}
      </ProviderErrorBoundary>
    )
  }

  return (
    <div className="dshDesktopFilePreviewPanel">
      <header className="dshDesktopFileHeader">
        <div className="dshDesktopFileTitle">{fileName}</div>
        <div className="dshDesktopFilePath" title={path}>{path}</div>
        <div className="dshDesktopFileActions">
          <Tooltip label="刷新" side="bottom">
            <button type="button" className="dshDesktopIconButton" aria-label="刷新" onClick={onRefresh}>
              <IconRefreshOutline16 />
            </button>
          </Tooltip>
          <Tooltip label="系统打开" side="bottom">
            <button type="button" className="dshDesktopIconButton" aria-label="系统打开" onClick={openExternally}>
              <IconRightUpOutline16 />
            </button>
          </Tooltip>
          <Tooltip label="关闭" side="bottom">
            <button type="button" className="dshDesktopIconButton" aria-label="关闭" onClick={onClose}>
              <IconCloseOutline16 />
            </button>
          </Tooltip>
        </div>
      </header>
      {systemOpenFailed && (
        <div className="dshDesktopNotice" role="status">系统打开失败</div>
      )}
      <div className="dshDesktopFileContent">{content}</div>
    </div>
  )
}
