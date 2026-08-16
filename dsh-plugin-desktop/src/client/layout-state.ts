/** Advanced-shell panel state shared by the root slot and layout-service adapter. */
export interface DesktopLayoutSnapshot {
  /** Preferred sidebar width; zero means the compact rail. */
  sidebar: number
  /** Which right-hand surface is currently selected. */
  rightSurface: 'closed' | 'details' | 'file'
  /** Preferred details width; only meaningful while details is selected. */
  detailsWidth: number
  /** Preferred file surface width; only meaningful while the file surface is selected. */
  fileWidth: number
  /** Whether the current viewport is below the automatic-collapse breakpoint. */
  narrow: boolean
  /** Manual narrow-screen override that temporarily expands the rail. */
  narrowExpanded: boolean
}

/** Column geometry after preserving the center surface. */
export interface DesktopColumns {
  /** Rendered sidebar width. */
  sidebar: number
  /** Rendered center width. */
  center: number
  /** Rendered right-surface width (details or file); zero when no surface is open. */
  details: number
}

/** Compatibility-mode compact rail used by the upstream Windows sidebar. */
export const SIDEBAR_COLLAPSED = 56
/** Wider compact rail reserved for the desktop-owned macOS sidebar. */
export const MACOS_SIDEBAR_COLLAPSED = 90
export const SIDEBAR_DEFAULT = 280
export const SIDEBAR_MIN = 264
export const SIDEBAR_MAX = 420
export const SIDEBAR_AUTO_COLLAPSE = 1024
export const DETAILS_DEFAULT = 360
export const DETAILS_MIN = 300
export const DETAILS_MAX = 520
export const CENTER_MIN = 640
export const FILE_DEFAULT = 640
export const FILE_MIN = 360
export const FILE_MAX = 900
export const FILE_CENTER_MIN = 480

/**
 * Resolve three desktop columns without allowing the surface to squeeze the
 * conversation below its floor. The details surface keeps the historical
 * shrink-then-close rules; the file surface always keeps at least {@link FILE_MIN}
 * and the chosen file surface must never silently collapse to zero.
 * @param viewport - available frame width.
 * @param sidebar - sidebar preference, where zero selects the compact rail.
 * @param surface - which right-hand surface is selected (details/file).
 * @param width - the surface's width preference.
 * @param collapsedWidth - the compact rail width for the current platform.
 * @returns rendered column widths.
 */
export function computeDesktopColumns(
  viewport: number,
  sidebar: number,
  surface: 'closed' | 'details' | 'file',
  width: number,
  collapsedWidth: number = SIDEBAR_COLLAPSED,
): DesktopColumns {
  const sidebarWidth = sidebar === 0 ? collapsedWidth : clamp(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  if (surface === 'details') {
    const preferredDetails = clamp(width, DETAILS_MIN, DETAILS_MAX)
    if (sidebarWidth + preferredDetails + CENTER_MIN <= viewport) {
      return { sidebar: sidebarWidth, center: viewport - sidebarWidth - preferredDetails, details: preferredDetails }
    }
    const reducedDetails = Math.max(DETAILS_MIN, viewport - sidebarWidth - CENTER_MIN)
    if (sidebarWidth + reducedDetails + CENTER_MIN <= viewport) {
      return { sidebar: sidebarWidth, center: CENTER_MIN, details: reducedDetails }
    }
    return { sidebar: sidebarWidth, center: Math.max(0, viewport - sidebarWidth), details: 0 }
  }
  if (surface === 'file') {
    const preferred = clamp(width, FILE_MIN, FILE_MAX)
    if (sidebarWidth + preferred + FILE_CENTER_MIN <= viewport) {
      return { sidebar: sidebarWidth, center: viewport - sidebarWidth - preferred, details: preferred }
    }
    // Shrink toward the minimum; once at FILE_MIN the center may fall below its
    // 480px floor but the chosen file surface must never silently become zero.
    const reduced = Math.max(FILE_MIN, viewport - sidebarWidth - FILE_CENTER_MIN)
    return { sidebar: sidebarWidth, center: Math.max(0, viewport - sidebarWidth - reduced), details: reduced }
  }
  return { sidebar: sidebarWidth, center: viewport - sidebarWidth, details: 0 }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Small observable panel controller used by the advanced root registration. */
export class DesktopLayoutState {
  private snapshot: DesktopLayoutSnapshot = Object.freeze({
    sidebar: SIDEBAR_DEFAULT,
    rightSurface: 'closed',
    detailsWidth: DETAILS_DEFAULT,
    fileWidth: FILE_DEFAULT,
    narrow: false,
    narrowExpanded: false,
  })
  private readonly listeners = new Set<() => void>()
  private readonly detailsIntentListeners = new Set<() => void>()

  /** @returns the immutable current panel snapshot. */
  getSnapshot(): DesktopLayoutSnapshot {
    return this.snapshot
  }

  /** @param listener - callback notified after a snapshot replacement. @returns its disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Toggle the wide sidebar and the platform-selected compact rail. */
  toggleSidebar(): void {
    if (this.snapshot.narrow) {
      this.publish({ ...this.snapshot, narrowExpanded: !this.snapshot.narrowExpanded })
      return
    }
    this.publish({ ...this.snapshot, sidebar: this.snapshot.sidebar === 0 ? SIDEBAR_DEFAULT : 0 })
  }

  /** @param narrow - whether the frame is below the automatic-collapse breakpoint. */
  setNarrow(narrow: boolean): void {
    if (this.snapshot.narrow === narrow) return
    this.publish({ ...this.snapshot, narrow, narrowExpanded: false })
  }

  /**
   * Notify internal details-intent listeners (before every details selection,
   * including when details is already selected) and then select the details
   * surface. `onDetailsIntent` connects the controller's `suspend()` so an
   * early file probe/read can never grab the column back after details wins.
   */
  openDetails(): void {
    for (const listener of this.detailsIntentListeners) listener()
    if (this.snapshot.rightSurface !== 'details') {
      this.publish({ ...this.snapshot, rightSurface: 'details' })
    }
  }

  /**
   * Desktop-internal subscription for "the user just chose details". Deliberately
   * NOT part of the layout snapshot or the public layout service; only the
   * advanced-shell assembly wires it to the preview controller.
   * @param listener - callback fired before each details selection.
   * @returns its disposer.
   */
  onDetailsIntent(listener: () => void): () => void {
    this.detailsIntentListeners.add(listener)
    return () => { this.detailsIntentListeners.delete(listener) }
  }

  /** Close the details surface only; never a file surface. */
  closeDetails(): void {
    if (this.snapshot.rightSurface !== 'details') return
    this.publish({ ...this.snapshot, rightSurface: 'closed' })
  }

  /** Select the file surface at its preferred (or default when closed) width. */
  openFile(): void {
    if (this.snapshot.rightSurface !== 'file') {
      this.publish({ ...this.snapshot, rightSurface: 'file' })
    }
  }

  /** Close the file surface only; never auto-reopening a previously hidden details surface. */
  closeFile(): void {
    if (this.snapshot.rightSurface !== 'file') return
    this.publish({ ...this.snapshot, rightSurface: 'closed' })
  }

  /** @param width - requested sidebar width from a resize gesture. */
  setSidebar(width: number): void {
    this.publish({ ...this.snapshot, sidebar: clamp(width, SIDEBAR_MIN, SIDEBAR_MAX) })
  }

  /**
   * Set the right-surface resize preference, clamped by the current surface's
   * min/max (details vs file). A no-op when no surface is open.
   * @param width - requested width from a resize gesture.
   */
  setRightWidth(width: number): void {
    if (this.snapshot.rightSurface === 'details') {
      this.publish({ ...this.snapshot, detailsWidth: clamp(width, DETAILS_MIN, DETAILS_MAX) })
      return
    }
    if (this.snapshot.rightSurface === 'file') {
      this.publish({ ...this.snapshot, fileWidth: clamp(width, FILE_MIN, FILE_MAX) })
    }
  }

  private publish(next: DesktopLayoutSnapshot): void {
    this.snapshot = Object.freeze(next)
    for (const listener of this.listeners) listener()
  }
}
