// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import { AdvancedFrame, type AdvancedFrameProps } from '../src/client/AdvancedFrame.tsx'
import { ExtendedFrame } from '../src/client/ExtendedFrame.tsx'
import { DesktopLayoutState } from '../src/client/layout-state.ts'

// Desktop replaces the upstream Web frame, so `@deepseek-ai/dsh-client-ui-layout`
// is absent from the client boot graph and its `<hash>_sidebarCol` column class
// never exists. This is the selector third-party plugins use to find the sidebar;
// when it resolves to nothing they mount nothing, silently.
const PLUGIN_SIDEBAR_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"]'

const SPEC_DIR = dirname(fileURLToPath(import.meta.url))
const readClientSource = (file: string): string =>
  readFileSync(join(SPEC_DIR, '..', 'src', 'client', file), 'utf8')

function renderFrame(Frame: typeof AdvancedFrame): HTMLElement {
  const layout = new DesktopLayoutState()
  const props = {
    layout,
    platform: 'win32',
    renderSlot: vi.fn((name: string) => createElement('span', { 'data-slot': name })),
    usePanelInfo: (select: (info: PanelInfo) => unknown) => select(layout.getPanelInfo()),
  } as unknown as AdvancedFrameProps
  document.body.innerHTML = renderToStaticMarkup(createElement(Frame, props))
  return document.body
}

describe('desktop sidebar DOM anchor', () => {
  it.each([
    ['advanced', AdvancedFrame],
    ['extended', ExtendedFrame],
  ] as const)('resolves the Web sidebar-column selector in %s mode', (_mode, Frame) => {
    const body = renderFrame(Frame)

    const column = body.querySelector(PLUGIN_SIDEBAR_SELECTOR)
    expect(column).not.toBeNull()
    // The anchor belongs on the element that directly wraps the sidebar slot —
    // the structural peer of the upstream column, not the outer desktop chrome.
    expect(column?.querySelector('[data-slot="sidebar"]')).not.toBeNull()
    expect(column?.className).toContain('dshDesktopUpstreamSidebar')
  })

  it.each([
    ['advanced', AdvancedFrame],
    ['extended', ExtendedFrame],
  ] as const)('points both anchors at one element in %s mode', (_mode, Frame) => {
    const body = renderFrame(Frame)

    expect(body.querySelectorAll('[data-pane="sidebar"]')).toHaveLength(1)
    expect(body.querySelectorAll('[class*="sidebarCol"]')).toHaveLength(1)
    expect(body.querySelector('[data-pane="sidebar"]'))
      .toBe(body.querySelector('[class*="sidebarCol"]'))
  })

  it('keeps the compatibility class spelled the way attribute selectors match', () => {
    // `class` attribute matching is case-sensitive in standards mode, so the
    // upstream substring has to survive verbatim.
    const source = renderFrame(AdvancedFrame).innerHTML
    expect(source).toContain('sidebarCol')
    expect(source).not.toContain('sidebarcol')
  })

  // #1006: Desktop must not shadow the theme-owned sidebar-fill token, or every
  // third-party skin loses control of the sidebar fill. The upstream sidebar
  // root consumes `background: var(--dsw-specific-sidebar-fill)`; nearby
  // Desktop-owned stylesheets may only paint their own `background` rects.
  it.each([
    ['desktop-owned layout', 'styles.ts'],
    ['extended shell', 'extended-styles.ts'],
  ])('leaves --dsw-specific-sidebar-fill to the theme in %s', (_label, file) => {
    expect(readClientSource(file)).not.toMatch(/--dsw-specific-sidebar-fill\s*:/)
  })

  // #1006: with the token untouched, the visible fill still behaves across the
  // material × mode matrix: material on keeps a transparent Desktop surface so
  // the upstream sidebar fill shows through; material off falls back to the
  // opaque layer-1 background in extended/advanced modes.
  it.each([
    ['advanced', AdvancedFrame],
    ['extended', ExtendedFrame],
  ] as const)('keeps the Desktop surface background-only in %s mode', (_mode, _Frame) => {
    const owned = readClientSource('styles.ts')
    const extended = readClientSource('extended-styles.ts')
    expect(owned).toMatch(/\.dshDesktopSidebarSurface\s*\{[^}]*background:\s*transparent;/)
    expect(owned).toMatch(/\[data-dsh-desktop-material="off"\] \.dshDesktopSidebarSurface \{[^}]*background: var\(--dsw-alias-bg-layer-1\);/)
    expect(extended).toMatch(/body\[data-dsh-desktop-mode="extended"\] \.dshDesktopSidebarSurface \{[^}]*background: transparent !important;/)
  })
})
