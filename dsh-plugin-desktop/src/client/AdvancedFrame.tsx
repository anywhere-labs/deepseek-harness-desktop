import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './contracts.ts'
import type { DesktopClientPlatform } from './environment.ts'
import { FilePreviewPanel } from './file-preview/FilePreviewPanel.tsx'
import type { FilePreviewController } from './file-preview/controller.ts'
import type { FilePreviewRegistry } from './file-preview/registry.ts'
import {
  computeDesktopColumns, DesktopLayoutState, MACOS_SIDEBAR_COLLAPSED,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT,
} from './layout-state.ts'

/** Private values assembled by the advanced-shell registration. */
export interface AdvancedFrameInjected {
  /** Desktop-owned panel state exposed through the standard layout service. */
  layout: DesktopLayoutState
  /** Host platform controlling native title-bar spacing. */
  platform: DesktopClientPlatform
  /** File-preview external store driving the right file surface. */
  filePreview: FilePreviewController
  /** Provider registry the file panel resolves renderers through. */
  filePreviewRegistry: FilePreviewRegistry
}

/** Full advanced root slot props. */
export type AdvancedFrameProps = PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.overlay'>
  & AdvancedFrameInjected

/** Desktop-owned transparent frame around the unchanged product surfaces. */
export function AdvancedFrame({ layout, platform, filePreview, filePreviewRegistry, renderSlot, useSessions }: AdvancedFrameProps) {
  const subscribeLayout = useCallback((listener: () => void) => layout.subscribe(listener), [layout])
  const readLayout = useCallback(() => layout.getSnapshot(), [layout])
  const panels = useSyncExternalStore(subscribeLayout, readLayout)
  const subscribeFileView = useCallback((listener: () => void) => filePreview.subscribe(listener), [filePreview])
  const readFileView = useCallback(() => filePreview.getSnapshot(), [filePreview])
  const fileView = useSyncExternalStore(subscribeFileView, readFileView)
  const frameRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const currentSessionId = useSessions((state) => state.current)
  const detailsSession = useSessions((state) => {
    const current = state.current
    return current !== undefined && state.byId[current]?.blank === false ? current : undefined
  })

  useEffect(() => {
    const element = frameRef.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined && entry.contentRect.width > 0) setViewport(entry.contentRect.width)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { layout.setNarrow(narrow) }, [layout, narrow])

  // Session identity drives lifecycle cleanup: leaving a defined session for a
  // different one (or none) closes the file surface and releases its resources.
  const previousIdentity = useRef(currentSessionId)
  useEffect(() => {
    const previous = previousIdentity.current
    if (previous !== undefined && previous !== currentSessionId) {
      filePreview.close()
    }
    previousIdentity.current = currentSessionId
  }, [currentSessionId, filePreview])

  // The renderable details session keeps the historical close-on-switch rule.
  const previousDetails = useRef(detailsSession)
  useEffect(() => {
    if (detailsSession !== undefined && previousDetails.current !== undefined && previousDetails.current !== detailsSession) {
      layout.closeDetails()
    }
    previousDetails.current = detailsSession
  }, [detailsSession, layout])

  const collapsed = panels.narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarPreference = collapsed ? 0 : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  const columns = computeDesktopColumns(
    viewport,
    sidebarPreference,
    panels.rightSurface,
    panels.rightSurface === 'file' ? panels.fileWidth : panels.detailsWidth,
    platform === 'darwin' ? MACOS_SIDEBAR_COLLAPSED : SIDEBAR_COLLAPSED,
  )

  return (
    <div
      ref={frameRef}
      className="dshDesktopFrame"
      data-desktop-platform={platform}
      data-sidebar-collapsed={collapsed || undefined}
      style={{ gridTemplateColumns: `${columns.sidebar}px minmax(0, 1fr) ${columns.details}px` }}
    >
      {platform === 'darwin' && <div className="dshDesktopMacCaptionRow" aria-hidden="true" />}
      {platform === 'win32' && <div className="dshDesktopWindowsCaptionRow" aria-hidden="true" />}
      <aside className="dshDesktopSidebarSurface">
        <div className="dshDesktopUpstreamSidebar">
          {renderSlot('sidebar', { collapsed, width: columns.sidebar })}
        </div>
      </aside>
      <main className="dshDesktopConversationSurface">{renderSlot('conversation', {})}</main>
      <aside className="dshDesktopDetailsSurface">
        <div className="dshDesktopConversationDetailsSurface" hidden={panels.rightSurface !== 'details'} aria-hidden={panels.rightSurface !== 'details'}>
          {renderSlot('details', {})}
        </div>
        <section className="dshDesktopFilePreviewSurface" hidden={panels.rightSurface !== 'file'} aria-hidden={panels.rightSurface !== 'file'}>
          <FilePreviewPanel
            snapshot={fileView}
            registry={filePreviewRegistry}
            onRefresh={() => { void filePreview.refresh() }}
            onClose={() => { filePreview.close() }}
            onOpenExternally={() => filePreview.openExternally()}
          />
        </section>
      </aside>
      <div className="dshDesktopOverlay" data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {!collapsed && (
        <ResizeHandle
          side="sidebar"
          left={columns.sidebar}
          size={columns.sidebar}
          onResize={(width) => { layout.setSidebar(width) }}
        />
      )}
      {columns.details > 0 && (
        <ResizeHandle
          side="details"
          left={viewport - columns.details}
          size={columns.details}
          onResize={(width) => { layout.setRightWidth(width) }}
        />
      )}
    </div>
  )
}

function ResizeHandle(props: { side: 'sidebar' | 'details'; left: number; size: number; onResize: (width: number) => void }) {
  const origin = useRef(0)
  const base = useRef(0)
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    origin.current = event.clientX
    base.current = props.size
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [props.size])
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const delta = event.clientX - origin.current
    props.onResize(base.current + (props.side === 'sidebar' ? delta : -delta))
  }, [props])
  return (
    <div
      className="dshDesktopResizeHandle"
      data-side={props.side}
      style={{ left: props.left }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
    />
  )
}
