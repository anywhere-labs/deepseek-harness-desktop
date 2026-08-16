/**
 * Image preview provider (design §8.4, §16.8). Renders the short-lived relative
 * token URL only when the payload kind is image, in a stable-size container so a
 * load or decode failure never changes the column width. A toolbar toggles fit
 * window / raw size / bounded zoom steps. A load failure shows a provider-local
 * error that preserves the explicit system-open action.
 * @module dsh-plugin-desktop/client/file-preview/providers/image-preview
 */

import { useState } from 'react'
import {
  IconFullscreenOutline16,
  IconPlusOutline16,
  IconRightUpOutline16,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilePreviewProvider, FilePreviewRendererProps } from '../registry.ts'

/** Raw-size scale in units of natural size. */
const RAW_SCALE = 1
/** Lowest zoom scale. */
const MIN_SCALE = 0.5
/** Highest zoom scale. */
const MAX_SCALE = 3
/** Bounded zoom step applied by 缩小/放大. */
const ZOOM_STEP = 0.25

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale * 100) / 100))
}

/**
 * Image toolbar controls with the bounded zoom step.
 * @param fit - whether the image is currently fit to the window.
 * @param scale - the current raw-scale zoom factor.
 * @param onFit - fit to the container.
 * @param onRaw - show at the original pixel size.
 * @param onZoomIn - step the zoom up.
 * @param onZoomOut - step the zoom down.
 * @returns the toolbar.
 */
function Toolbar(
  { fit, scale, onFit, onRaw, onZoomIn, onZoomOut }: {
    fit: boolean
    scale: number
    onFit: () => void
    onRaw: () => void
    onZoomIn: () => void
    onZoomOut: () => void
  },
): React.ReactElement {
  return (
    <div className="dshDesktopImageToolbar" role="toolbar" aria-label="图片缩放">
      <button type="button" className={fit ? 'dshDesktopImageAction active' : 'dshDesktopImageAction'} onClick={onFit}>
        <IconFullscreenOutline16 />
        <span>适应窗口</span>
      </button>
      <button type="button" className={!fit && scale === RAW_SCALE ? 'dshDesktopImageAction active' : 'dshDesktopImageAction'} onClick={onRaw}>
        <IconRightUpOutline16 />
        <span>原始比例</span>
      </button>
      <button type="button" className="dshDesktopImageAction" onClick={onZoomOut} aria-label="缩小">
        <IconSearchOutline16 />
      </button>
      <button type="button" className="dshDesktopImageAction" onClick={onZoomIn} aria-label="放大">
        <IconPlusOutline16 />
      </button>
      <span className="dshDesktopImageScaleLabel">×{scale.toFixed(2)}</span>
    </div>
  )
}

/**
 * Render an image resource with fit/zoom controls. The container keeps a stable
 * footprint; a load error swaps the pixels for a local notice plus the system-open.
 * @param props - descriptor plus binary-url content.
 * @returns the image view.
 */
export function ImageView({ descriptor, content, onOpenExternally }: FilePreviewRendererProps): React.ReactElement {
  if (content.kind !== 'binary-url' || descriptor.contentKind !== 'image') {
    throw new Error('image provider requires a binary-url image payload')
  }
  const [fit, setFit] = useState(true)
  const [scale, setScale] = useState<number>(RAW_SCALE)
  const [loadFailed, setLoadFailed] = useState(false)

  const style: React.CSSProperties = fit
    ? { objectFit: 'contain', width: '100%', height: '100%' }
    : { objectFit: 'none', width: 'auto', height: 'auto', transform: `scale(${scale})`, transformOrigin: 'top left' }

  return (
    <div className="dshDesktopImageSurface">
      <Toolbar
        fit={fit}
        scale={scale}
        onFit={() => { setFit(true) }}
        onRaw={() => { setFit(false); setScale(RAW_SCALE) }}
        onZoomIn={() => { setFit(false); setScale(current => clampScale(current + ZOOM_STEP)) }}
        onZoomOut={() => { setFit(false); setScale(current => clampScale(current - ZOOM_STEP)) }}
      />
      <div className="dshDesktopImageCanvas">
        {loadFailed
          ? (
            <div className="dshDesktopImageError">
              <div className="dshDesktopNotice" role="status">图片加载失败</div>
              <button type="button" className="dshDesktopActionButton" onClick={() => { void onOpenExternally() }}>
                系统打开
              </button>
            </div>
          )
          : (
            <img
              src={content.url}
              alt={descriptor.name}
              style={style}
              onError={() => { setLoadFailed(true) }}
            />
          )}
      </div>
    </div>
  )
}

/** Register the image provider (contentKind `image`, priority 300). */
export function registerImageProvider(registry: { register(provider: FilePreviewProvider): () => void }): () => void {
  return registry.register({
    id: 'desktop.image',
    priority: 300,
    loadMode: 'binary-url',
    supports: descriptor => descriptor.contentKind === 'image',
    Component: ImageView,
  })
}
