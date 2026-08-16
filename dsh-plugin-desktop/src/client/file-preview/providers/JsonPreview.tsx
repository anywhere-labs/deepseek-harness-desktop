/**
 * JSON preview provider (design §8.3, §16.8). Parses only within a byte budget;
 * when the value is an object/array within an iterative node budget it offers a
 * 树/源码 segmented control (default tree via DSH `JsonTree`); larger content,
 * JSON scalars, JSONC, and parse failures fall back to the source view. A parse
 * failure shows a non-blocking notice and never becomes a controller error.
 * @module dsh-plugin-desktop/client/file-preview/providers/json-preview
 */

import { useEffect, useMemo, useState } from 'react'
import { JsonTree } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilePreviewProvider, FilePreviewRendererProps } from '../registry.ts'

/** JSON builds a tree only within this byte budget. */
export const JSON_PARSE_MAX_BYTES = 256 * 1024
/** Maximum tree nodes the JSON view renders; the counter stops iterating early. */
export const JSON_NODE_BUDGET = 5_000

/** UTF-8 byte length of a JS string. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Iteratively count the nodes of a parsed JSON value, stopping as soon as the
 * budget is exceeded without copying or recursively cloning the whole graph.
 * @param value - the parsed JSON value.
 * @returns true when the node count stays within the budget.
 */
function withinNodeBudget(value: unknown): boolean {
  let remaining = JSON_NODE_BUDGET
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const current = stack.pop()
    if (remaining <= 0) return false
    remaining -= 1
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
    } else if (current !== null && typeof current === 'object') {
      for (const key of Object.keys(current)) stack.push((current as Record<string, unknown>)[key])
    }
  }
  return remaining >= 0
}

type ViewMode = 'tree' | 'source'

/**
 * Segmented 树/源码 control following the tablist keyboard contract.
 * @param mode - the active view.
 * @param onChange - switch to the requested view.
 * @returns the tablist control.
 */
function ModeTabs({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  const select = (target: ViewMode) => {
    if (target !== mode) onChange(target)
  }
  return (
    <div className="dshDesktopSegmentedControl" role="tablist" aria-label="JSON 视图">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'tree'}
        tabIndex={mode === 'tree' ? 0 : -1}
        onClick={() => { select('tree') }}
      >
        树
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
 * Render a JSON file as a tree or readable source. A parse failure or an
 * unrenderable payload keeps the source view and shows a non-blocking notice.
 * @param props - descriptor plus loaded text content.
 * @returns the JSON view.
 */
export function JsonView({ descriptor, content }: FilePreviewRendererProps): React.ReactElement {
  if (content.kind !== 'text') {
    throw new Error('json provider requires text content')
  }
  const [mode, setMode] = useState<ViewMode>('tree')
  const resourceKey = descriptor.availability === 'available' ? String(descriptor.resourceId) : descriptor.displayPath
  useEffect(() => { setMode('tree') }, [resourceKey])

  const { parseError, parsed, treeable } = useMemo(() => {
    if (byteLength(content.text) > JSON_PARSE_MAX_BYTES) {
      return { parseError: false, parsed: undefined, treeable: false }
    }
    try {
      const value: unknown = JSON.parse(content.text)
      const isContainer = value !== null && typeof value === 'object'
      const withinBudget = isContainer && withinNodeBudget(value)
      return { parseError: false, parsed: value, treeable: isContainer && withinBudget }
    } catch {
      return { parseError: true, parsed: undefined, treeable: false }
    }
  }, [content.text])

  const effective: ViewMode = treeable ? mode : 'source'

  return (
    <div className="dshDesktopJsonView">
      {treeable ? <ModeTabs mode={effective} onChange={setMode} /> : null}
      {parseError && (
        <div className="dshDesktopNotice" role="status">JSON 解析失败，已显示源码</div>
      )}
      {effective === 'tree' && parsed !== undefined && (
        <div className="dshDesktopScrollSurface">
          <JsonTree data={parsed as object | unknown[]} expandTopLevel />
        </div>
      )}
      {effective === 'source' && (
        <pre className="dshDesktopSourcePlain">{content.text}</pre>
      )}
    </div>
  )
}

/** Register the JSON provider (`application/json`, extension `.json`). */
export function registerJsonProvider(registry: { register(provider: FilePreviewProvider): () => void }): () => void {
  return registry.register({
    id: 'desktop.json',
    priority: 400,
    loadMode: 'text',
    supports: descriptor => descriptor.extension === '.json' && descriptor.contentKind === 'text',
    Component: JsonView,
  })
}
