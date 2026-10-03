import { readFileSync } from 'node:fs'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import { apply } from '../src/client/index.ts'
import { AdvancedFrame, type AdvancedFrameProps } from '../src/client/AdvancedFrame.tsx'
import { applyAdvancedShell } from '../src/client/advanced-shell.ts'
import { installDesktopLayout } from '../src/client/layout-service.ts'
import { parseDesktopClientEnvironment } from '../src/client/environment.ts'
import { ExtendedFrame } from '../src/client/ExtendedFrame.tsx'
import { applyExtendedShell, applyFramedShell } from '../src/client/extended-shell.ts'
import { installExtendedStyles } from '../src/client/extended-styles.ts'
import {
  collapsedSidebarWidth, computeDesktopColumns, DesktopLayoutState, MACOS_SIDEBAR_COLLAPSED, SIDEBAR_COLLAPSED,
} from '../src/client/layout-state.ts'
import { installSidebarFooterStyles } from '../src/client/sidebar-footer-styles.ts'
import { installDesktopOwnedStyles } from '../src/client/styles.ts'
import { desktopWindowService, provideDesktopWindow } from '../src/client/window-service.ts'
import {
  ADVANCED_MACOS_CONTENT_INSET,
  ADVANCED_MACOS_DRAG_LAYER_Z_INDEX,
  ADVANCED_MACOS_DRAG_REGION_HEIGHT,
  ADVANCED_WINDOWS_TITLEBAR_HEIGHT,
  DESKTOP_FRAME_HEIGHT,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
  WINDOWS_CAPTION_CONTROLS_WIDTH,
} from '../src/window-chrome.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Switch: () => null }))

describe('desktop client environment', () => {
  it.each(['darwin', 'win32', 'linux'])('keeps compatibility chrome out of the %s client slot tree', platform => {
    vi.stubGlobal('window', { location: {
      search: `?dsh-desktop-platform=${platform}&dsh-desktop-mode=compatibility&dsh-desktop-version=2.0.3&dsh-desktop-material=off`,
    } })
    const effect = vi.fn()
    const inject = vi.fn()
    const ctx = {
      effect,
      inject: vi.fn(),
      slots: { inject },
      locale: { bind: () => (key: string) => key },
      configForms: { get: () => ({}) },
    } as unknown as ClientContext
    try {
      apply(ctx)
      expect(inject.mock.calls.map(([name]) => name)).toEqual([
        'settings.models.provider-card', 'settings.section', 'settings.action', 'plugins.bundle.hidden',
      ])
      expect(effect.mock.calls.map(([, label]) => label)).not.toContain('desktop: independent compatibility frame styles')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not activate desktop effects for an ordinary browser URL', () => {
    vi.stubGlobal('window', { location: { search: '' } })
    const effect = vi.fn()

    try {
      expect(parseDesktopClientEnvironment('')).toBeUndefined()
      apply({ effect } as unknown as ClientContext)
      expect(effect).not.toHaveBeenCalled()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('accepts the Electron-owned kebab query markers', () => {
    expect(parseDesktopClientEnvironment('?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin&dsh-desktop-version=2.0.3&dsh-desktop-material=transparent'))
      .toEqual({ version: '2.0.3', mode: 'advanced', platform: 'darwin', material: 'transparent' })
    expect(parseDesktopClientEnvironment('?dsh-desktop-platform=win32&dsh-desktop-mode=compatibility&dsh-desktop-version=2.0.3&dsh-desktop-material=off'))
      .toEqual({ version: '2.0.3', mode: 'compatibility', platform: 'win32', material: 'off' })
    expect(parseDesktopClientEnvironment('?dsh-desktop-mode=compatibility&dsh-desktop-platform=linux&dsh-desktop-version=2.0.3&dsh-desktop-material=off'))
      .toEqual({ version: '2.0.3', mode: 'compatibility', platform: 'linux', material: 'off' })
  })

  it('renders removed Windows materials from an older Host as opaque', () => {
    // Older Hosts emitted Mica with a dsh-desktop-mica capability marker, and
    // Acrylic before that. Both resolve to off; the capability marker is ignored.
    for (const search of [
      '?dsh-desktop-mode=extended&dsh-desktop-platform=win32&dsh-desktop-version=2.0.3&dsh-desktop-material=mica&dsh-desktop-mica=1',
      '?dsh-desktop-mode=advanced&dsh-desktop-platform=win32&dsh-desktop-version=2.0.3&dsh-desktop-material=mica&dsh-desktop-mica=0',
      '?dsh-desktop-mode=extended&dsh-desktop-platform=win32&dsh-desktop-version=2.0.3&dsh-desktop-material=acrylic&dsh-desktop-mica=0',
      '?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32&dsh-desktop-version=2.0.3&dsh-desktop-material=off&dsh-desktop-mica=1',
    ]) {
      expect(parseDesktopClientEnvironment(search)).toMatchObject({ platform: 'win32', material: 'off' })
      expect(parseDesktopClientEnvironment(search)).not.toHaveProperty('micaSupported')
    }
  })

  it.each([
    ['?dsh-desktop-mode=glass&dsh-desktop-platform=darwin', 'dsh-desktop-mode'],
    ['?dsh-desktop-mode=advanced', 'dsh-desktop-platform'],
    ['?dsh-desktop-platform=darwin', 'dsh-desktop-mode'],
    ['?dsh-desktop-mode=advanced&dsh-desktop-platform=android', 'dsh-desktop-platform'],
    ['?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin', 'dsh-desktop-material'],
    ['?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin&dsh-desktop-material=off', 'dsh-desktop-version'],
    ['?dsh-desktop-mode=advanced&dsh-desktop-platform=win32&dsh-desktop-version=2.0.3&dsh-desktop-material=transparent', 'incompatible'],
    ['?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin&dsh-desktop-version=2.0.3&dsh-desktop-material=mica', 'incompatible'],
    ['?dsh-desktop-mode=compatibility&dsh-desktop-platform=linux&dsh-desktop-version=2.0.3&dsh-desktop-material=mica', 'incompatible'],
    ['?dsh-desktop-mode=compatibility&dsh-desktop-platform=linux&dsh-desktop-version=2.0.3&dsh-desktop-material=transparent', 'incompatible'],
  ])('fails loud for malformed marker %s', (search, field) => {
    expect(() => parseDesktopClientEnvironment(search)).toThrow(field)
  })
})

describe('advanced desktop layout', () => {
  it.each([['advanced', AdvancedFrame], ['extended', ExtendedFrame]] as const)(
    'passes right Sidebar geometry and preserves its track beneath fullscreen in %s mode', (_mode, Frame) => {
      vi.stubGlobal('window', { innerWidth: 1440 })
      const layout = new DesktopLayoutState()
      const renderSlot = vi.fn((name: string) => createElement('span', { 'data-slot': name }))
      const props = {
        layout, platform: 'darwin', renderSlot,
        usePanelInfo: (select: (info: PanelInfo) => unknown) => select(layout.getPanelInfo()),
        SessionProvider: ({ children }: { children: ReactNode }) => children,
      } as unknown as AdvancedFrameProps
      try {
        layout.setRightbar(510, 1440)
        layout.openRightbar(true, false)
        const normal = renderToStaticMarkup(createElement(Frame, props))
        expect(renderSlot).toHaveBeenCalledWith('rightbar', { width: 510, viewportWidth: 1440, canShow: true })
        expect(normal).toContain('grid-template-columns:280px minmax(0, 1fr) 510px')
        expect(normal).toContain('data-side="rightbar"')
        layout.openRightbar(true, true)
        const fullscreen = renderToStaticMarkup(createElement(Frame, props))
        expect(fullscreen).toContain('data-rightbar-fullscreen="true"')
        expect(fullscreen).toContain('grid-template-columns:280px minmax(0, 1fr) 510px')
        expect(fullscreen).not.toContain('data-side="rightbar"')
        layout.closeRightbar()
        expect(renderToStaticMarkup(createElement(Frame, props)))
          .toContain('grid-template-columns:280px minmax(0, 1fr) 0px')
      } finally { vi.unstubAllGlobals() }
    },
  )

  it.each([
    ['advanced', AdvancedFrame],
    ['extended', ExtendedFrame],
  ] as const)('renders global main and rightbar panels without a Session in %s mode', (_mode, Frame) => {
    vi.stubGlobal('window', { innerWidth: 1440 })
    const layout = new DesktopLayoutState(id => id === 'files')
    const renderSlot = vi.fn((name: string) => createElement('span', { 'data-slot': name }))
    const props = {
      layout,
      platform: 'darwin',
      usePanelInfo: (select: (info: PanelInfo) => unknown) => select(layout.getPanelInfo()),
      renderSlot,
      SessionProvider: ({ children }: { children: ReactNode }) =>
        createElement('section', { 'data-session-provider': '' }, children),
    } as unknown as AdvancedFrameProps

    try {
      const markup = renderToStaticMarkup(createElement(Frame, props))
      expect(markup).toContain('<span data-slot="rightbar"></span>')
      expect(markup).not.toContain('data-session-provider')
      expect(renderSlot).toHaveBeenCalledWith('main', {}, { entryKey: 'conversation' })
      layout.selectPanel('files' as MainPanelId)
      renderToStaticMarkup(createElement(Frame, props))
      expect(renderSlot).toHaveBeenLastCalledWith('main', {}, { entryKey: 'files' })
      layout.selectPanel(null)
      renderToStaticMarkup(createElement(Frame, props))
      expect(renderSlot).toHaveBeenLastCalledWith('main', {}, { entryKey: 'conversation' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('orders the Windows drag region after scrollable content and before overlays', () => {
    const frame = readFileSync(new URL('../src/client/AdvancedFrame.tsx', import.meta.url), 'utf8')
    const conversation = frame.indexOf('className="dshDesktopConversationSurface"')
    const rightbar = frame.indexOf('className="dshDesktopRightbarSurface"')
    const caption = frame.indexOf('className="dshDesktopWindowsCaptionRow"')
    const overlay = frame.indexOf('className="dshDesktopOverlay"')

    expect([conversation, rightbar, caption, overlay]).not.toContain(-1)
    expect(caption).toBeGreaterThan(conversation)
    expect(caption).toBeGreaterThan(rightbar)
    expect(caption).toBeLessThan(overlay)
  })

  it('owns native caption geometry with one fixed macOS drag strip above page content', () => {
    expect(ADVANCED_MACOS_CONTENT_INSET).toBe(20)
    expect(ADVANCED_MACOS_DRAG_REGION_HEIGHT).toBe(32)
    expect(ADVANCED_MACOS_DRAG_LAYER_Z_INDEX).toBe(20)
    expect(ADVANCED_MACOS_DRAG_LAYER_Z_INDEX).toBeLessThan(25)
    expect(ADVANCED_MACOS_DRAG_REGION_HEIGHT).toBeGreaterThan(ADVANCED_MACOS_CONTENT_INSET)
    expect(ADVANCED_WINDOWS_TITLEBAR_HEIGHT).toBe(32)
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
      const dispose = installDesktopOwnedStyles()
      expect(css).toContain('body:is([data-dsh-desktop-mode="extended"], [data-dsh-desktop-mode="advanced"])[data-dsh-desktop-platform="darwin"][data-dsh-desktop-material="transparent"] {\n  --dsw-menu-surface-fill: var(--dsw-alias-bg-layer-2);\n}')
      expect(css).toMatch(/\.dshDesktopFrame \{[^}]*transition: grid-template-columns var\(--ds-transition-duration-slow\) var\(--ds-ease-in-out\);/)
      expect(css).toMatch(/\.dshDesktopFrame\[data-dragging\] \{ transition: none; \}/)
      expect(css).toContain('min-height: 0; overflow: visible;')
      expect(css).toMatch(/\.dshDesktopResizeHandle \{[^}]*transition: left var\(--ds-transition-duration-slow\) var\(--ds-ease-in-out\);/)
      expect(css).toMatch(/\.dshDesktopFrame\[data-dragging\] \.dshDesktopResizeHandle \{ transition: none; \}/)
      expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.dshDesktopFrame,[\s\S]*\.dshDesktopResizeHandle \{ transition: none !important; \}/)
      expect(css).toMatch(/\.dshDesktopSidebarSurface\s*\{[^}]*--dsw-specific-sidebar-fill:\s*transparent;/)
      expect(css).toMatch(/data-desktop-mode="advanced"\]\[data-desktop-platform="darwin"\]\[data-sidebar-collapsed\][^{]*\.dshDesktopUpstreamSidebar \{[^}]*width:\s*56px;[^}]*margin:\s*0 auto;/)
      expect(css).not.toMatch(/data-desktop-mode="extended"[^{}]*data-sidebar-collapsed[^{}]*\.dshDesktopUpstreamSidebar/)
      expect(css).toMatch(new RegExp(`data-desktop-mode="advanced"\\]\\[data-desktop-platform="darwin"\\] \\.dshDesktopUpstreamSidebar \\{[^}]*padding-top: ${ADVANCED_MACOS_CONTENT_INSET}px;`))
      expect(css).not.toMatch(/\.dshDesktopUpstreamSidebar \{[^}]*-webkit-app-region: no-drag;/)
      expect(css).toContain(`grid-template-rows: ${ADVANCED_MACOS_DRAG_REGION_HEIGHT}px minmax(0, 1fr)`)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-mode="advanced"\]\[data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface \{[^}]*grid-row: 1 \/ -1;/)
      expect(css).not.toMatch(/data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface \{[^}]*-webkit-app-region: no-drag;/)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-mode="advanced"\]\[data-desktop-platform="darwin"\] \.dshDesktopConversationSurface,\s*\.dshDesktopFrame\[data-desktop-mode="advanced"\]\[data-desktop-platform="darwin"\] \.dshDesktopRightbarSurface \{ grid-row: 2; \}/)
      expect(css).toMatch(new RegExp(`data-desktop-platform="darwin"\\] \\.dshDesktopSidebarSurface::before \\{[^}]*z-index: ${ADVANCED_MACOS_DRAG_LAYER_Z_INDEX};[^}]*left: ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH}px;[^}]*height: ${ADVANCED_MACOS_DRAG_REGION_HEIGHT}px;[^}]*-webkit-app-region: drag;`))
      expect(css).toMatch(new RegExp(`\\.dshDesktopMacCaptionRow \\{[^}]*position: absolute;[^}]*z-index: ${ADVANCED_MACOS_DRAG_LAYER_Z_INDEX};[^}]*grid-column: 2 / -1;[^}]*grid-row: 1;[^}]*left: 0;[^}]*height: ${ADVANCED_MACOS_DRAG_REGION_HEIGHT}px;[^}]*background: var\\(--dsw-alias-bg-base\\);[^}]*-webkit-app-region: drag;`))
      expect(css).not.toContain('.dshDesktopMacCaptionRow::before')
      expect(css).not.toMatch(/data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface \{[^}]*-webkit-app-region:\s*drag;/)
      expect(css).not.toContain('[data-slot="conversation.session.header"]')
      expect(css).not.toContain('[data-phase')
      expect(css).toMatch(/\.dshDesktopNoDrag, button, input, textarea, select, label, summary, a,[^{}]*\{ -webkit-app-region: no-drag !important; \}/)
      expect(css).toContain('[contenteditable="true"]')
      expect(css).toContain('[role="switch"]')
      expect(css).not.toMatch(/html:has\(\[aria-modal="true"\]\) \.dshDesktopMacCaptionRow/)
      expect(css).not.toMatch(/html:has\(\[aria-modal="true"\]\) \.dshDesktopSidebarSurface/)
      expect(css).toContain(`grid-template-rows: ${ADVANCED_WINDOWS_TITLEBAR_HEIGHT}px minmax(0, 1fr)`)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-mode="advanced"\]\[data-desktop-platform="win32"\] \.dshDesktopSidebarSurface \{ grid-row: 1 \/ -1; \}/)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-mode="advanced"\]\[data-desktop-platform="win32"\] \.dshDesktopConversationSurface,\s*\.dshDesktopFrame\[data-desktop-mode="advanced"\]\[data-desktop-platform="win32"\] \.dshDesktopRightbarSurface \{ grid-row: 2; \}/)
      expect(css).toMatch(/\.dshDesktopWindowsCaptionRow \{[^}]*grid-column: 2 \/ -1;[^}]*grid-row: 1;/)
      expect(css).toMatch(new RegExp(`\\.dshDesktopWindowsCaptionRow::before \\{[^}]*inset: 0 ${WINDOWS_CAPTION_CONTROLS_WIDTH}px 0 0;[^}]*-webkit-app-region: drag;`))
      expect(css).toContain('html:has([aria-modal="true"]) .dshDesktopWindowsCaptionRow::before { -webkit-app-region: no-drag !important; }')
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
    let uninstall: unknown
    const ctx = {
      inject: vi.fn(),
      slots: { provideRoot: () => () => {}, subscribe: () => () => {} },
      reflect: {
        get: () => undefined,
        provide: (name: string, value: unknown) => {
          expect(name).toBe('layout')
          expect(value).toBeInstanceOf(DesktopLayoutState)
          return () => { disposed = true }
        },
      },
      // Cordis runs the factory eagerly and registers its result as the
      // fiber-owned uninstaller; capture that result the same way.
      effect: (factory: () => unknown) => { uninstall = factory() },
    } as unknown as ClientContext

    const layout = new DesktopLayoutState()
    installDesktopLayout(ctx, layout)
    const navigation = layout.beginNavigation()
    expect(disposed).toBe(false)
    expect(typeof uninstall).toBe('function')
    ;(uninstall as () => void)()
    expect(disposed).toBe(true)
    expect(navigation.aborted).toBe(true)
  })

  it('cancels superseded navigation and falls back when a selected panel unloads', () => {
    const registered = new Set(['files', 'settings'])
    const layout = new DesktopLayoutState(id => registered.has(id))
    const changed = vi.fn()
    const off = layout.subscribe(changed)
    const first = layout.beginNavigation()
    const second = layout.beginNavigation()
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
    layout.selectPanel('files' as MainPanelId)
    expect(second.aborted).toBe(true)
    const geometry = layout.getSnapshot()
    const pending = layout.beginNavigation()
    expect(() => layout.selectPanel('missing' as MainPanelId)).toThrow('not registered')
    expect(layout.getPanelInfo().activePanelId).toBe('files')
    expect(pending.aborted).toBe(false)
    registered.delete('files')
    layout.retainMainPanels()
    expect(layout.getPanelInfo().activePanelId).toBeNull()
    expect(layout.getSnapshot()).toBe(geometry)
    expect(pending.aborted).toBe(true)
    expect(changed).toHaveBeenCalledTimes(2)
    off()
    layout.selectPanel('settings' as MainPanelId)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('keeps the enhanced root registration independent from the extended frame', () => {
    const registrations: Array<Record<string, unknown>> = []
    const occupants: unknown[] = []
    const disposers: Array<() => void> = []
    const dataset: Record<string, string> = {}
    vi.stubGlobal('document', {
      body: {
        dataset,
        removeAttribute: vi.fn(),
        setAttribute: vi.fn(),
        style: { setProperty: vi.fn(), removeProperty: vi.fn() },
      },
      documentElement: { style: { colorScheme: '', removeProperty: vi.fn() } },
      createElement: vi.fn(() => ({
        content: '',
        dataset: {},
        isConnected: false,
        name: '',
        remove: vi.fn(),
        style: { setProperty: vi.fn(), removeProperty: vi.fn() },
        textContent: '',
      })),
      head: { appendChild: vi.fn() },
    })
    vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: 'rgb(0, 0, 0)' }))
    const ctx = {
      effect: vi.fn((mount: () => void | (() => void)) => {
        const dispose = mount()
        if (typeof dispose === 'function') disposers.push(dispose)
      }),
      inject: vi.fn(),
      reflect: { get: vi.fn(), provide: vi.fn(() => () => {}) },
      theme: {
        getTheme: vi.fn(() => ({ active: { colorScheme: 'dark', tokens: {} } })),
      },
      on: vi.fn(() => () => {}),
      slots: {
        provideRoot: vi.fn(() => () => {}),
        subscribe: vi.fn(() => () => {}),
        register: vi.fn((options: Record<string, unknown>, occupant: unknown) => {
          registrations.push(options)
          occupants.push(occupant)
          return () => {}
        }),
      },
    } as unknown as ClientContext

    try {
      applyAdvancedShell(ctx, {
        version: '2.0.3',
        mode: 'advanced',
        platform: 'darwin',
        material: 'transparent',
      })
      expect(registrations).toHaveLength(1)
      expect(occupants).toEqual([AdvancedFrame])
      const rootInject = (registrations[0]?.inject as () => Record<string, unknown>)()
      expect(rootInject).toMatchObject({ platform: 'darwin' })
      expect(rootInject).not.toHaveProperty('mode')
      expect(dataset).toMatchObject({
        dshDesktopMode: 'advanced',
        dshDesktopPlatform: 'darwin',
        dshDesktopMaterial: 'transparent',
      })
      disposers.forEach(dispose => { dispose() })
      expect(dataset).toEqual({})
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports generation-stable safe areas and drag geometry to client plugins', () => {
    expect(desktopWindowService({
      version: '2.0.3', mode: 'compatibility', platform: 'darwin', material: 'off',
    })).toEqual({
      version: '2.0.3',
      mode: 'compatibility',
      platform: 'darwin',
      material: 'off',
      availableMaterials: ['off', 'transparent'],
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      dragRegion: {
        height: 0,
        leftInset: 0,
        rightInset: 0,
      },
    })
    const mac = desktopWindowService({
      version: '2.0.3', mode: 'advanced', platform: 'darwin', material: 'transparent',
    })
    expect(mac).toEqual({
      version: '2.0.3',
      mode: 'advanced',
      platform: 'darwin',
      material: 'transparent',
      availableMaterials: ['off', 'transparent'],
      safeAreaInsets: { top: ADVANCED_MACOS_DRAG_REGION_HEIGHT, right: 0, bottom: 0, left: 0 },
      dragRegion: {
        height: ADVANCED_MACOS_DRAG_REGION_HEIGHT,
        leftInset: MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
        rightInset: 0,
      },
    })
    expect(Object.isFrozen(mac)).toBe(true)
    expect(Object.isFrozen(mac.safeAreaInsets)).toBe(true)
    expect(Object.isFrozen(mac.dragRegion)).toBe(true)
    expect(desktopWindowService({
      version: '2.0.3', mode: 'advanced', platform: 'win32', material: 'off',
    })).toEqual({
      version: '2.0.3',
      mode: 'advanced',
      platform: 'win32',
      material: 'off',
      availableMaterials: ['off'],
      safeAreaInsets: { top: ADVANCED_WINDOWS_TITLEBAR_HEIGHT, right: 0, bottom: 0, left: 0 },
      dragRegion: {
        height: ADVANCED_WINDOWS_TITLEBAR_HEIGHT,
        leftInset: 0,
        rightInset: WINDOWS_CAPTION_CONTROLS_WIDTH,
      },
    })
    expect(desktopWindowService({
      version: '2.0.3', mode: 'extended', platform: 'win32', material: 'off',
    })).toEqual({
      version: '2.0.3',
      mode: 'extended',
      platform: 'win32',
      material: 'off',
      availableMaterials: ['off'],
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      dragRegion: {
        height: 0,
        leftInset: 0,
        rightInset: 0,
      },
    })

    let disposed = false
    const ctx = {
      reflect: {
        provide: (name: string, value: unknown) => {
          expect(name).toBe('desktopWindow')
          expect(value).toBe(mac)
          return () => { disposed = true }
        },
      },
    } as unknown as ClientContext
    const dispose = provideDesktopWindow(ctx, mac)
    expect(disposed).toBe(false)
    dispose()
    expect(disposed).toBe(true)
  })

  it('keeps the wider macOS rail in enhanced mode and the upstream width in extended mode', () => {
    expect(computeDesktopColumns(1440, 0, 0)).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1384, rightbar: 0 })
    expect(computeDesktopColumns(1440, 0, 0, MACOS_SIDEBAR_COLLAPSED))
      .toEqual({ sidebar: MACOS_SIDEBAR_COLLAPSED, center: 1350, rightbar: 0 })
    expect(SIDEBAR_COLLAPSED).toBe(56)
    expect(collapsedSidebarWidth('advanced', 'darwin')).toBe(MACOS_SIDEBAR_COLLAPSED)
    expect(collapsedSidebarWidth('extended', 'darwin')).toBe(SIDEBAR_COLLAPSED)
    expect(collapsedSidebarWidth('extended', 'win32')).toBe(SIDEBAR_COLLAPSED)
    expect(MACOS_SIDEBAR_COLLAPSED).toBe(90)
  })

  it('reports right Sidebar presentation and preserves width across close and fullscreen', () => {
    const layout = new DesktopLayoutState()
    layout.setRightbar(510, 1440)
    layout.openRightbar(true, false)
    expect(layout.getSnapshot()).toMatchObject({ rightbar: 510, rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false })
    layout.openRightbar(true, true)
    expect(layout.getSnapshot()).toMatchObject({ rightbar: 510, rightbarTrack: true, rightbarFullscreen: true })
    layout.closeRightbar()
    expect(layout.getSnapshot()).toMatchObject({ rightbar: 510, rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false })
    layout.setNarrow(true)
    layout.toggleSidebar()
    layout.openRightbar(false, true)
    expect(layout.getSnapshot()).toMatchObject({ narrowExpanded: false, rightbarTrack: false, rightbarFullscreen: true })
  })

  it('concedes the right track only when the upstream minimum panel and conversation cannot fit', () => {
    expect(computeDesktopColumns(1000, 0, 450)).toEqual({ sidebar: 56, center: 494, rightbar: 450 })
    expect(computeDesktopColumns(800, 0, 450)).toEqual({ sidebar: 56, center: 400, rightbar: 344 })
    expect(computeDesktopColumns(700, 0, 450)).toEqual({ sidebar: 56, center: 644, rightbar: 0 })
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

describe('independent Desktop frame', () => {
  it('fills the native content viewport for both framed modes and limits the inverted-L surface to extended mode', () => {
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
      const dispose = installExtendedStyles()
      expect(css).toContain(`--dsh-desktop-frame-height: 0px`)
      expect(DESKTOP_FRAME_HEIGHT).toBe(36)
      expect(css).toMatch(/#root \{[^}]*position: fixed;[^}]*right: 0;[^}]*bottom: 0;[^}]*left: 0;[^}]*padding-top: 0;[^}]*transform: translateZ\(0\);/)
      expect(css).toMatch(/\[data-shell-overlay\] \{[^}]*overflow: hidden;[^}]*transform: translateZ\(0\);/)
      expect(css).toMatch(/\[role="presentation"\]:has\(> \[aria-modal="true"\]\),[\s\S]*> \[aria-modal="true"\] \{[\s\S]*top: var\(--dsh-desktop-frame-height\) !important;/)
      expect(css).not.toContain('#root > :has(> [data-shell-overlay])')
      expect(css).toMatch(/body\[data-dsh-desktop-mode="extended"\] \.dshDesktopSidebarSurface \{[^}]*--dsw-specific-sidebar-fill: transparent;[^}]*border-right-color: transparent;[^}]*background: transparent !important;/)
      expect(css).toMatch(/body\[data-dsh-desktop-mode="extended"\] \.dshDesktopFrame \{[^}]*background: var\(--dsh-desktop-frame-fill\);/)
      expect(css).toMatch(/body\[data-dsh-desktop-mode="extended"\] \.dshDesktopConversationSurface \{[^}]*border-top: 1px solid var\(--dsw-alias-border-l1\);[^}]*border-left: 1px solid var\(--dsw-alias-border-l1\);[^}]*border-top-left-radius: 10px;/)
      expect(css).toContain('body:is([data-dsh-desktop-mode="compatibility"], [data-dsh-desktop-mode="extended"]) #root')
      expect(css).toMatch(/\.dshDesktopFrameTitlebar \{[^}]*-webkit-app-region: drag;/)
      expect(css).toMatch(/\.dshDesktopFrameTitlebar \{[^}]*z-index: 2147483647;/)
      expect(css).toMatch(/\.dshDesktopFrameIdentity \{[^}]*left: 50%;[^}]*transform: translateX\(-50%\);/)
      expect(css).toMatch(/\.dshDesktopFrameActions \{[^}]*-webkit-app-region: no-drag;/)
      expect(css).toContain('[data-platform="darwin"] .dshDesktopFrameActions { margin-left: auto; }')
      expect(css).toContain('[data-platform="win32"] .dshDesktopFrameActions { margin-right: auto; }')
      expect(css).toMatch(/\.dshDesktopTitlebarIconButton \{[^}]*-webkit-app-region: no-drag;/)
      expect(css).toMatch(/\.dshDesktopTitlebarIconButton \{[^}]*width: 26px;[^}]*height: 26px;[^}]*border-radius: 7px;/)
      expect(css).toMatch(/\.dshDesktopTitlebarIconButton svg,[^}]*width: 14px;[^}]*height: 14px;/)
      expect(css).toContain('.dshDesktopActionMenu')
      expect(css).toContain(`padding: 0 ${WINDOWS_CAPTION_CONTROLS_WIDTH + 8}px 0 8px`)
      expect(css).toContain(`padding: 0 8px 0 ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH + 8}px`)
      expect(appendChild).toHaveBeenCalledWith(style)
      dispose()
      expect(remove).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('owns the extended root and keeps its native frame actions private', () => {
    const registrations: Array<Record<string, unknown>> = []
    const occupants: unknown[] = []
    const disposers: Array<() => void> = []
    const dataset: Record<string, string> = {}
    const rootDataset: Record<string, string> = {}
    const bodyStyle = { setProperty: vi.fn(), removeProperty: vi.fn() }
    const documentElementStyle = { colorScheme: '', removeProperty: vi.fn() }
    const createElement = vi.fn(() => ({
      content: '',
      dataset: {},
      id: '',
      isConnected: false,
      name: '',
      remove: vi.fn(),
      style: { setProperty: vi.fn(), removeProperty: vi.fn() },
      textContent: '',
    }))
    vi.stubGlobal('document', {
      body: {
        dataset,
        removeAttribute: vi.fn(),
        setAttribute: vi.fn(),
        style: bodyStyle,
      },
      documentElement: { style: documentElementStyle },
      getElementById: (id: string) => id === 'root' ? { dataset: rootDataset } : null,
      createElement,
      head: { appendChild: vi.fn() },
    })
    vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: 'rgb(0, 0, 0)' }))
    const ctx = {
      effect: vi.fn((mount: () => void | (() => void)) => {
        const dispose = mount()
        if (typeof dispose === 'function') disposers.push(dispose)
      }),
      inject: vi.fn(),
      reflect: { get: vi.fn(), provide: vi.fn(() => () => {}) },
      theme: {
        getTheme: vi.fn(() => ({ active: { colorScheme: 'dark', tokens: {} } })),
      },
      on: vi.fn(() => () => {}),
      slots: {
        provideRoot: vi.fn(() => () => {}),
        subscribe: vi.fn(() => () => {}),
        inject: vi.fn((_name: string, mount: () => unknown) => mount()),
        register: vi.fn((options: Record<string, unknown>, occupant: unknown) => {
          registrations.push(options)
          occupants.push(occupant)
          return () => {}
        }),
      },
    } as unknown as ClientContext

    try {
      applyExtendedShell(ctx, {
        version: '2.0.3',
        mode: 'extended',
        platform: 'win32',
        material: 'off',
      })
      expect(registrations[0]).toMatchObject({
        name: 'root',
        children: {
          sidebar: { kind: 'single', scope: 'root' },
          main: { kind: 'keyed', scope: 'root' },
          rightbar: { kind: 'single', scope: 'root' },
          'shell.overlay': { kind: 'list', scope: 'root' },
        },
      })
      expect(registrations[0]?.inject).toBeTypeOf('function')
      const rootInject = (registrations[0]?.inject as () => Record<string, unknown>)()
      expect(rootInject).toMatchObject({
        platform: 'win32',
      })
      expect(rootInject).not.toHaveProperty('mode')
      expect(occupants[0]).toBe(ExtendedFrame)
      expect(registrations).toHaveLength(1)
      expect(ctx.slots.inject).not.toHaveBeenCalled()
      expect(dataset).toMatchObject({
        dshDesktopMode: 'extended',
        dshDesktopPlatform: 'win32',
        dshDesktopMaterial: 'off',
      })
      expect(rootDataset).toEqual({ dshDesktopContentViewport: '' })
      disposers.forEach(dispose => { dispose() })
      expect(dataset).toEqual({})
      expect(rootDataset).toEqual({})
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not expose a plugin action seat in compatibility mode', () => {
    const registrations: Array<Record<string, unknown>> = []
    const injectedSlots: string[] = []
    const disposers: Array<() => void> = []
    const dataset: Record<string, string> = {}
    const rootDataset: Record<string, string> = {}
    vi.stubGlobal('document', {
      body: { dataset },
      getElementById: (id: string) => id === 'root' ? { dataset: rootDataset } : null,
      createElement: () => ({ dataset: {}, id: '', remove: vi.fn(), textContent: '' }),
      head: { appendChild: vi.fn() },
    })
    const ctx = {
      effect: vi.fn((mount: () => void | (() => void)) => {
        const dispose = mount()
        if (typeof dispose === 'function') disposers.push(dispose)
      }),
      slots: {
        inject: vi.fn((name: string, mount: () => unknown) => {
          injectedSlots.push(name)
          return mount()
        }),
        register: vi.fn((options: Record<string, unknown>) => {
          registrations.push(options)
          return () => {}
        }),
      },
    } as unknown as ClientContext

    try {
      applyFramedShell(ctx, {
        version: '2.0.3',
        mode: 'compatibility',
        platform: 'darwin',
        material: 'transparent',
      })
      expect(injectedSlots).toEqual([])
      expect(registrations).toHaveLength(0)
      expect(JSON.stringify(registrations)).not.toContain('desktop.titlebar.action')
      expect(dataset).toMatchObject({
        dshDesktopMode: 'compatibility',
        dshDesktopPlatform: 'darwin',
        dshDesktopMaterial: 'transparent',
      })
      disposers.forEach(dispose => { dispose() })
      expect(dataset).toEqual({})
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('sidebar footer stacking', () => {
  it.each(['compatibility', 'extended', 'advanced'])('owns the footer seat in %s mode', mode => {
    vi.stubGlobal('window', { location: {
      search: `?dsh-desktop-platform=darwin&dsh-desktop-mode=${mode}&dsh-desktop-version=2.0.3&dsh-desktop-material=off`,
    } })
    const effect = vi.fn()
    const ctx = {
      effect,
      inject: vi.fn(),
      on: vi.fn(() => () => {}),
      reflect: { get: vi.fn(() => undefined), provide: vi.fn(() => () => {}) },
      theme: { getTheme: vi.fn(() => ({ active: { colorScheme: 'dark', tokens: {} } })) },
      slots: {
        entries: vi.fn(() => []),
        inject: vi.fn((_name: string, mount: () => unknown) => mount()),
        provideRoot: vi.fn(() => () => {}),
        register: vi.fn(() => () => {}),
        subscribe: vi.fn(() => () => {}),
      },
      locale: { bind: () => (key: string) => key },
      configForms: { get: () => ({}) },
    } as unknown as ClientContext

    try {
      apply(ctx)
      expect(effect.mock.calls.map(([, label]) => label))
        .toContain('dsh-plugin-desktop: sidebar footer stacking styles')
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('stacks launchers in one bounded seat without shaving their rounded corners', () => {
    let css = ''
    const remove = vi.fn()
    const style = {
      dataset: {},
      id: '',
      get textContent() { return css },
      set textContent(value: string) { css = value },
      remove,
    }
    const appendChild = vi.fn()
    vi.stubGlobal('document', {
      getElementById: () => null,
      createElement: () => style,
      head: { appendChild },
    })

    try {
      const dispose = installSidebarFooterStyles()
      expect(css).toMatch(/body \[data-slot="sidebar\.footer\.action"\] \{[^}]*display: flex !important;[^}]*flex-direction: column;[^}]*max-height: min\(40vh, 240px\);[^}]*padding: 0 4px;[^}]*overflow-y: auto;/)
      // Grow the anchor 4px per side and pay 4px back as padding: the content
      // box keeps the slot's own width, so launchers that follow upstream's
      // footer row convention (`.triggerRow`: `width: calc(100% + 4px);
      // margin: 4px -2px`) land flush with the Settings row while the extra
      // border-box width keeps the scroll container's clip edge off their
      // rounded corners.
      expect(css).toMatch(/body \[data-slot="sidebar\.footer\.action"\] \{[^}]*width: calc\(100% \+ 8px\);[^}]*margin-inline: -4px;/)
      expect(css).toMatch(/body \[data-slot="sidebar\.footer\.action"\] > \* \{\s*flex: none;\s*min-width: 0;\s*\}/)
      // Forcing a width on the children also hits the Tooltip bubbles React
      // renders inside this anchor, stretching them to the viewport.
      expect(css).not.toMatch(/> \* \{[^}]*\swidth:/)
      // A reserved gutter shrank the seat asymmetrically; horizontal clipping
      // sliced the corners off launchers that bleed past their content box.
      expect(css).not.toContain('scrollbar-gutter')
      expect(css).not.toContain('overflow-x: hidden')
      // The seat must not depend on a mode marker: compatibility mode sets none.
      expect(css).not.toContain('data-dsh-desktop-mode')
      expect(appendChild).toHaveBeenCalledWith(style)
      dispose()
      expect(remove).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
