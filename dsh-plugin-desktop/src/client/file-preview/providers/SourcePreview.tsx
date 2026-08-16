/**
 * Source-file preview provider (design §8.1, §16.8). Below the syntax-highlight
 * ceiling it renders DSH's `ReadBlock` with every line shown; above it a single
 * plain `<pre>` text node avoids building per-line DOM. A wrap toggle changes
 * only the display; copy always writes the original text. The provider carries
 * no branch over formats — the registry decides whether it matches.
 * @module dsh-plugin-desktop/client/file-preview/providers/source-preview
 */

import { useCallback, useMemo, useState } from 'react'
import { ReadBlock, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReadBlockLine } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilePreviewProvider, FilePreviewRendererProps } from '../registry.ts'

/** Text size caps: above the syntax-highlight ceiling Source degrades to plain text. */
const HIGHLIGHT_MAX_BYTES = 512 * 1024
/** Line-count cap that also forces the plain-text fallback. */
const HIGHLIGHT_MAX_LINES = 10_000

/** Number of UTF-8 bytes a JS string occupies, matching the Host's byte gate. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Split source text into `ReadBlockLine`s with 1-based file line numbers. */
function toLines(text: string): ReadBlockLine[] {
  const parts = text.split('\n')
  return parts.map((textPart, index) => ({ number: index + 1, text: textPart }))
}

/**
 * Render source text with syntax highlighting when the payload is small enough;
 * larger payloads fall back to a single read-only text node.
 * @param props - descriptor plus loaded text content.
 * @returns the source view.
 */
export function SourceView({ descriptor, content }: FilePreviewRendererProps): React.ReactElement {
  if (content.kind !== 'text') {
    throw new Error('source provider requires text content')
  }
  const [wrapped, setWrapped] = useState(false)
  const [copied, setCopied] = useState(false)
  const canHighlight = useMemo(
    () => byteLength(content.text) <= HIGHLIGHT_MAX_BYTES && content.text.split('\n').length <= HIGHLIGHT_MAX_LINES,
    [content.text],
  )
  const lines = useMemo(() => (canHighlight ? toLines(content.text) : []), [canHighlight, content.text])
  const onCopy = useCallback(() => {
    void writeClipboard(content.text).then((ok) => {
      if (ok) setCopied(true)
    })
  }, [content.text])

  return (
    <div className="dshDesktopSourceView">
      <div className="dshDesktopSourceToolbar">
        <button
          type="button"
          className="dshDesktopSourceToggle"
          onClick={() => { setWrapped(value => !value) }}
          aria-pressed={wrapped}
        >
          {wrapped ? '不换行' : '换行'}
        </button>
        {!canHighlight && (
          <button type="button" className="dshDesktopSourceToggle" onClick={onCopy}>
            {copied ? '复制成功' : '复制'}
          </button>
        )}
      </div>
      {canHighlight
        ? (
          <div className={wrapped ? 'dshDesktopSourceWrapped' : 'dshDesktopSourceBody'}>
            <ReadBlock
              label={descriptor.name}
              lang={descriptor.language}
              lines={lines}
              totalLines={lines.length}
              maxLines={lines.length}
            />
          </div>
        )
        : (
          <pre className="dshDesktopSourcePlain" data-wrapped={wrapped ? 'true' : undefined}>
            {content.text}
          </pre>
        )}
    </div>
  )
}

/** Register the source provider (generic text fallback, priority 100). */
export function registerSourceProvider(registry: { register(provider: FilePreviewProvider): () => void }): () => void {
  return registry.register({
    id: 'desktop.source',
    priority: 100,
    loadMode: 'text',
    supports: descriptor => descriptor.contentKind === 'text',
    Component: SourceView,
  })
}
