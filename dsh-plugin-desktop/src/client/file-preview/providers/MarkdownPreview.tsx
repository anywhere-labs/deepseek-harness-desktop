/**
 * Markdown preview provider (design §8.2, §16.8). Renders a 预览/源码 segmented
 * control; preview uses DSH's `MarkdownText` (safe markup, no raw HTML or
 * external loaders) when the payload is small enough, larger documents default
 * to and only offer the source view. The selected mode resets per file.
 * @module dsh-plugin-desktop/client/file-preview/providers/markdown-preview
 */

import { useEffect, useMemo, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilePreviewProvider, FilePreviewRendererProps } from '../registry.ts'

/** Markdown renders a preview DOM only within this byte budget. */
export const MARKDOWN_PREVIEW_MAX_BYTES = 256 * 1024

/** UTF-8 byte length of a JS string. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

type ViewMode = 'preview' | 'source'

/**
 * Segmented 预览/源码 control following the tablist keyboard contract so it is
 * operable without a pointer.
 * @param mode - the active view.
 * @param onChange - switch to the requested view.
 * @returns the tablist control.
 */
function ModeTabs({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  const select = (target: ViewMode) => {
    if (target !== mode) onChange(target)
  }
  return (
    <div className="dshDesktopSegmentedControl" role="tablist" aria-label="Markdown 视图">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'preview'}
        tabIndex={mode === 'preview' ? 0 : -1}
        onClick={() => { select('preview') }}
      >
        预览
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'source'}
        tabIndex={mode === 'source' ? 0 : -1}
        onClick={() => { select('source') }}
      >
        源码
      </button>
    </div>
  )
}

/**
 * Render a Markdown file as preview or readable source.
 * @param props - descriptor plus loaded text content.
 * @returns the Markdown view.
 */
export function MarkdownView({ descriptor, content }: FilePreviewRendererProps): React.ReactElement {
  if (content.kind !== 'text') {
    throw new Error('markdown provider requires text content')
  }
  // Component-local view mode keyed per file so switching files resets it.
  const [mode, setMode] = useState<ViewMode>('preview')
  const resourceKey = descriptor.availability === 'available' ? String(descriptor.resourceId) : descriptor.displayPath
  useEffect(() => { setMode('preview') }, [resourceKey])

  const previewable = useMemo(() => byteLength(content.text) <= MARKDOWN_PREVIEW_MAX_BYTES, [content.text])
  const effective: ViewMode = previewable ? mode : 'source'

  return (
    <div className="dshDesktopMarkdownView">
      <ModeTabs mode={effective} onChange={setMode} />
      {effective === 'preview'
        ? (
          <div className="dshDesktopScrollSurface">
            <MarkdownText text={content.text} />
          </div>
        )
        : (
          <pre className="dshDesktopSourcePlain">{content.text}</pre>
        )}
    </div>
  )
}

/** Register the Markdown provider (`text/markdown`, extension `.md`). */
export function registerMarkdownProvider(registry: { register(provider: FilePreviewProvider): () => void }): () => void {
  return registry.register({
    id: 'desktop.markdown',
    priority: 350,
    loadMode: 'text',
    supports: descriptor => descriptor.extension === '.md' && descriptor.contentKind === 'text',
    Component: MarkdownView,
  })
}
