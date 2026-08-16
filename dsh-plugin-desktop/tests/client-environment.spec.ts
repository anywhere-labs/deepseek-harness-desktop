import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { provideDesktopLayout } from '../src/client/layout-service.ts'
import { parseDesktopClientEnvironment } from '../src/client/environment.ts'
import {
  computeDesktopColumns, DesktopLayoutState, DETAILS_DEFAULT, DETAILS_MAX,
  FILE_DEFAULT, FILE_MAX, FILE_MIN, MACOS_SIDEBAR_COLLAPSED, SIDEBAR_COLLAPSED,
} from '../src/client/layout-state.ts'
import { installAdvancedStyles } from '../src/client/styles.ts'
import {
  MACOS_DRAG_REGION_HEIGHT,
  MACOS_TITLEBAR_HEIGHT,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
  WINDOWS_CAPTION_CONTROLS_WIDTH,
  WINDOWS_TITLEBAR_HEIGHT,
} from '../src/window-chrome.ts'

describe('desktop client environment', () => {
  it('accepts the Electron-owned kebab query markers', () => {
    expect(parseDesktopClientEnvironment('?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin'))
      .toEqual({ mode: 'advanced', platform: 'darwin' })
    expect(parseDesktopClientEnvironment('?dsh-desktop-platform=win32&dsh-desktop-mode=compatibility'))
      .toEqual({ mode: 'compatibility', platform: 'win32' })
  })

  it.each([
    ['', 'dsh-desktop-mode'],
    ['?dsh-desktop-mode=glass&dsh-desktop-platform=darwin', 'dsh-desktop-mode'],
    ['?dsh-desktop-mode=advanced', 'dsh-desktop-platform'],
    ['?dsh-desktop-mode=advanced&dsh-desktop-platform=android', 'dsh-desktop-platform'],
  ])('fails loud for malformed marker %s', (search, field) => {
    expect(() => parseDesktopClientEnvironment(search)).toThrow(field)
  })
})

describe('advanced desktop layout', () => {
  it('owns native caption geometry without targeting feature headers', () => {
    expect(MACOS_TITLEBAR_HEIGHT).toBe(20)
    expect(MACOS_DRAG_REGION_HEIGHT).toBe(32)
    expect(MACOS_DRAG_REGION_HEIGHT).toBeGreaterThan(MACOS_TITLEBAR_HEIGHT)
    expect(WINDOWS_TITLEBAR_HEIGHT).toBe(32)
    let css = ''
    const remove = vi.fn()
    const style = {
      dataset: {},
      get textContent() { return css },
      set textContent(value: string) { css = value },
      remove,
    }
    const appendChild = vi.fn()
    vi.stubGlobal('document', {
      createElement: () => style,
      head: { appendChild },
    })

    try {
      const dispose = installAdvancedStyles()
      expect(css).toMatch(/\.dshDesktopSidebarSurface\s*\{[^}]*--dsw-specific-sidebar-fill:\s*transparent;/)
      expect(css).toMatch(/data-desktop-platform="darwin"\]\[data-sidebar-collapsed\][^{]*\.dshDesktopUpstreamSidebar \{[^}]*width:\s*56px;[^}]*margin:\s*0 auto;/)
      expect(css).toMatch(new RegExp(`data-desktop-platform="darwin"\\] \\.dshDesktopUpstreamSidebar \\{[^}]*padding-top: ${MACOS_TITLEBAR_HEIGHT}px;[^}]*-webkit-app-region: no-drag;`))
      expect(css).toContain(`grid-template-rows: ${MACOS_TITLEBAR_HEIGHT}px minmax(0, 1fr)`)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface \{[^}]*grid-row: 1 \/ -1;[^}]*-webkit-app-region: no-drag;/)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="darwin"\] \.dshDesktopConversationSurface,\s*\.dshDesktopFrame\[data-desktop-platform="darwin"\] \.dshDesktopDetailsSurface \{ grid-row: 2; \}/)
      expect(css).toMatch(new RegExp(`data-desktop-platform="darwin"\\] \\.dshDesktopSidebarSurface::before \\{[^}]*left: ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH}px;[^}]*height: ${MACOS_DRAG_REGION_HEIGHT}px;[^}]*-webkit-app-region: drag;`))
      expect(css).not.toMatch(/data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface::before \{[^}]*z-index:/)
      expect(css).toMatch(/\.dshDesktopMacCaptionRow \{[^}]*position: relative;[^}]*grid-column: 2 \/ -1;[^}]*grid-row: 1;/)
      expect(css).toMatch(new RegExp(`\\.dshDesktopMacCaptionRow::before \\{[^}]*height: ${MACOS_DRAG_REGION_HEIGHT}px;[^}]*-webkit-app-region: drag;`))
      expect(css).not.toMatch(/\.dshDesktopMacCaptionRow::before \{[^}]*z-index:/)
      expect(css).not.toMatch(/data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface \{[^}]*-webkit-app-region:\s*drag;/)
      expect(css).not.toContain('[data-phase')
      expect(css).toMatch(/html:has\(\[aria-modal="true"\]\) \.dshDesktopMacCaptionRow::before,[\s\S]*html:has\(\[aria-modal="true"\]\) \.dshDesktopSidebarSurface::before \{ -webkit-app-region: no-drag !important; \}/)
      expect(css).toContain(`grid-template-rows: ${WINDOWS_TITLEBAR_HEIGHT}px minmax(0, 1fr)`)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="win32"\] \.dshDesktopSidebarSurface \{ grid-row: 1 \/ -1; \}/)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="win32"\] \.dshDesktopConversationSurface,\s*\.dshDesktopFrame\[data-desktop-platform="win32"\] \.dshDesktopDetailsSurface \{ grid-row: 2; \}/)
      expect(css).toMatch(/\.dshDesktopWindowsCaptionRow \{[^}]*grid-column: 2 \/ -1;[^}]*grid-row: 1;/)
      expect(css).toMatch(new RegExp(`\\.dshDesktopWindowsCaptionRow::before \\{[^}]*inset: 0 ${WINDOWS_CAPTION_CONTROLS_WIDTH}px 0 0;[^}]*-webkit-app-region: drag;`))
      expect(css).not.toMatch(/data-desktop-platform="win32"[^{}]*header[^{}]*\{[^}]*padding-right/)
      expect(appendChild).toHaveBeenCalledWith(style)
      dispose()
      expect(remove).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('releases the Cordis layout service with its owning effect', () => {
    let disposed = false
    const ctx = {
      reflect: {
        provide: (name: string, value: unknown) => {
          expect(name).toBe('layout')
          expect(value).toBeInstanceOf(DesktopLayoutState)
          return () => { disposed = true }
        },
      },
    } as unknown as ClientContext

    const dispose = provideDesktopLayout(ctx, new DesktopLayoutState())
    expect(disposed).toBe(false)
    dispose()
    expect(disposed).toBe(true)
  })

  it('uses the compatibility rail on Windows and the wider desktop rail on macOS', () => {
    expect(computeDesktopColumns(1440, 0, 'closed', 0)).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1384, details: 0 })
    expect(computeDesktopColumns(1440, 0, 'closed', 0, MACOS_SIDEBAR_COLLAPSED))
      .toEqual({ sidebar: MACOS_SIDEBAR_COLLAPSED, center: 1350, details: 0 })
    expect(SIDEBAR_COLLAPSED).toBe(56)
    expect(MACOS_SIDEBAR_COLLAPSED).toBe(90)
  })

  it('publishes mirrored right-surface transitions', () => {
    const layout = new DesktopLayoutState()
    const snapshots: object[] = []
    layout.subscribe(() => { snapshots.push(layout.getSnapshot()) })
    layout.toggleSidebar()
    layout.openDetails()
    layout.closeDetails()
    expect(snapshots).toEqual([
      { sidebar: 0, rightSurface: 'closed', detailsWidth: DETAILS_DEFAULT, fileWidth: FILE_DEFAULT, narrow: false, narrowExpanded: false },
      { sidebar: 0, rightSurface: 'details', detailsWidth: DETAILS_DEFAULT, fileWidth: FILE_DEFAULT, narrow: false, narrowExpanded: false },
      { sidebar: 0, rightSurface: 'closed', detailsWidth: DETAILS_DEFAULT, fileWidth: FILE_DEFAULT, narrow: false, narrowExpanded: false },
    ])
  })

  it('details and file surfaces keep independent widths and cannot cross-close', () => {
    const layout = new DesktopLayoutState()
    layout.openDetails()
    expect(layout.getSnapshot()).toMatchObject({ rightSurface: 'details', detailsWidth: DETAILS_DEFAULT })
    // Resizing details clamps to the details range.
    layout.setRightWidth(900)
    expect(layout.getSnapshot().rightSurface).toBe('details')
    expect(layout.getSnapshot().detailsWidth).toBe(DETAILS_MAX)
    // closeDetails only ever closes details.
    layout.closeDetails()
    expect(layout.getSnapshot().rightSurface).toBe('closed')

    layout.openFile()
    expect(layout.getSnapshot()).toMatchObject({ rightSurface: 'file', fileWidth: FILE_DEFAULT })
    // Resizing while file is selected clamps to the file range (and never the details range).
    layout.setRightWidth(1200)
    expect(layout.getSnapshot().fileWidth).toBe(FILE_MAX)
    layout.setRightWidth(100)
    expect(layout.getSnapshot().fileWidth).toBe(FILE_MIN)
    // closeFile does not reopen a previously hidden details surface.
    layout.closeFile()
    expect(layout.getSnapshot().rightSurface).toBe('closed')
  })

  it('setRightWidth clamps per the currently selected surface and is a no-op when closed', () => {
    const layout = new DesktopLayoutState()
    layout.setRightWidth(500)
    expect(layout.getSnapshot()).toMatchObject({ rightSurface: 'closed', detailsWidth: DETAILS_DEFAULT, fileWidth: FILE_DEFAULT })
    layout.openFile()
    layout.setRightWidth(500)
    expect(layout.getSnapshot().fileWidth).toBe(500)
    layout.closeFile()
    layout.openDetails()
    layout.setRightWidth(500)
    expect(layout.getSnapshot().detailsWidth).toBe(500)
  })

  it('openDetails always notifies details-intent listeners even when already on details', () => {
    const layout = new DesktopLayoutState()
    const intents: number[] = []
    layout.onDetailsIntent(() => { intents.push(intents.length + 1) })
    layout.openDetails()
    layout.openDetails()
    layout.openDetails()
    expect(intents).toEqual([1, 2, 3])
  })

  it('keeps the file surface at least FILE_MIN across narrow viewports', () => {
    // Preferred file width fits at 280 + 640 + 480 <= 1440.
    expect(computeDesktopColumns(1440, 280, 'file', FILE_DEFAULT)).toEqual({ sidebar: 280, center: 520, details: FILE_DEFAULT })
    // At 1024 it shrinks toward FILE_MIN and the center falls below the 640 floor.
    expect(computeDesktopColumns(1024, 280, 'file', FILE_DEFAULT))
      .toEqual({ sidebar: 280, center: 384, details: 360 })
    // At 900 (compact rail) the file surface stays at FILE_MIN with a positive (below-floor) center.
    expect(computeDesktopColumns(900, 0, 'file', FILE_DEFAULT)).toEqual({ sidebar: 56, center: 480, details: 364 })
    // An extremely narrow viewport never collapses the chosen file to zero even if center clamps.
    expect(computeDesktopColumns(480, 0, 'file', FILE_DEFAULT)).toEqual({ sidebar: 56, center: 64, details: 360 })
  })

  it('a closed or details surface keeps the historical shrink/close geometry', () => {
    // Preferred details fits at 280 + 360 + 640 <= 1440.
    expect(computeDesktopColumns(1440, 280, 'details', DETAILS_DEFAULT))
      .toEqual({ sidebar: 280, center: 800, details: DETAILS_DEFAULT })
    // Details shrinks toward CENTER_MIN before it would close.
    expect(computeDesktopColumns(1250, 280, 'details', DETAILS_DEFAULT))
      .toEqual({ sidebar: 280, center: 640, details: 330 })
    // Too narrow: details closes (details: 0) rather than squeezing the conversation.
    expect(computeDesktopColumns(1024, 280, 'details', DETAILS_DEFAULT))
      .toEqual({ sidebar: 280, center: 744, details: 0 })
    // The file surface clamps its own width only while selected.
    expect(computeDesktopColumns(1440, 0, 'file', 2000))
      .toEqual({ sidebar: 56, center: 484, details: FILE_MAX })
  })

  it('lets the rail re-expand without losing its wide preference on narrow windows', () => {
    const layout = new DesktopLayoutState()
    layout.setNarrow(true)
    expect(layout.getSnapshot()).toMatchObject({ sidebar: 280, narrow: true, narrowExpanded: false })
    layout.toggleSidebar()
    expect(layout.getSnapshot()).toMatchObject({ sidebar: 280, narrow: true, narrowExpanded: true })
    layout.setNarrow(false)
    expect(layout.getSnapshot()).toMatchObject({ sidebar: 280, narrow: false, narrowExpanded: false })
  })
})
