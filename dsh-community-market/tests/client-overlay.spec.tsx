// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketStateResponse } from '../src/api-types.js'
import type { MarketCatalogResponse, MarketSourceView } from '../src/api-types.js'
import type {} from '../src/client/index.js'
import { MarketController } from '../src/client/controller.js'
import { MarketOverlay, type MarketOverlayProps } from '../src/client/MarketOverlay.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  const Button = ({
    children,
    icon,
    type = 'button',
    ...props
  }: { children?: ReactNode; icon?: ReactNode; type?: 'button' | 'submit'; [key: string]: unknown }) => (
    <button type={type} {...props}>{icon}{children}</button>
  )
  const Input = ({ icon: _icon, ...props }: { icon?: ReactNode; [key: string]: unknown }) => <input {...props} />
  const Modal = ({
    open,
    title,
    children,
    footer,
  }: { open: boolean; title: string; children?: ReactNode; footer?: ReactNode }) => open
    ? <div role="dialog"><h2>{title}</h2>{children}{footer}</div>
    : null
  const icon = () => null
  return {
    Button,
    Input,
    Modal,
    Tooltip: passthrough,
    IconCheckOutline16: icon,
    IconCloseOutline16: icon,
    IconCordisPluginOutline14: icon,
    IconDataOutline16: icon,
    IconGlobeOutline14: icon,
    IconLoadingOutline16: icon,
    IconPlusOutline16: icon,
    IconRefreshOutline16: icon,
    IconRightUpOutline16: icon,
    IconSearchOutline16: icon,
    IconSettingsOutline16: icon,
    IconTrashOutline16: icon,
    IconWarningOutline16: icon,
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = ((key: string) => key) as PropsLocale<'community-market'>['t']

function props(controller: MarketController): MarketOverlayProps {
  return {
    controller,
    readLocale: () => 'en',
    t,
    useSessions: (() => undefined) as MarketOverlayProps['useSessions'],
    useWorkspaces: (() => undefined) as MarketOverlayProps['useWorkspaces'],
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const source: MarketSourceView = {
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'built-in',
  adapterId: 'market.dsh-1024store-v1',
  providerId: 'com.deepseek1024.catalog',
  builtInProviderKey: 'dsh-1024store',
  enabled: true,
  order: 0,
  name: 'DSH 1024Store',
  endpoint: 'https://api.deepseek1024.com/v1/plugins/search',
  partnership: true,
}

const stateWithSource: MarketStateResponse = {
  sources: [source],
  builtIns: [],
}

const catalogWithItem: MarketCatalogResponse = {
  query: {},
  fetchedAt: '2026-08-18T04:00:00.000Z',
  results: [{
    source,
    stale: false,
    snapshot: {
      schemaVersion: '1.0.0',
      source: {
        sourceRecordId: source.sourceRecordId,
        providerId: source.providerId,
        adapterId: source.adapterId,
        registrationKind: source.registrationKind,
        fetchedAt: '2026-08-18T04:00:00.000Z',
        finalUrl: source.endpoint,
      },
      items: [{
        id: 'example/better-sidebar',
        name: 'dsh-plugin-better-sidebar',
        displayName: 'Better Sidebar',
        summary: 'Adds a configurable sidebar panel.',
        repository: { url: 'https://github.com/example/better-sidebar' },
        provenance: {
          sourceRecordId: source.sourceRecordId,
          providerId: source.providerId,
          itemId: 'example/better-sidebar',
        },
      }],
      page: { total: 1 },
    },
  }],
}

describe('community market overlay', () => {
  it('shows the empty source state without requesting a catalog', async () => {
    const state: MarketStateResponse = { sources: [], builtIns: [] }
    const request = vi.fn<typeof fetch>(async () => response(state))
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()

    expect(await screen.findByRole('heading', { name: 'emptyTitle' })).toBeTruthy()
    expect(request).toHaveBeenCalledTimes(1)
    expect(String(request.mock.calls[0]?.[0])).toContain('/api/community-market/state')
    expect(screen.getByText('emptyBody')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'chooseSources' }))
    await waitFor(() => { expect(screen.getByRole('heading', { name: 'sources' })).toBeTruthy() })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('loads and renders plugin cards when a source is enabled', async () => {
    const request = vi.fn<typeof fetch>(async (input) => (
      String(input).includes('/state') ? response(stateWithSource) : response(catalogWithItem)
    ))
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()

    expect(await screen.findByText('Better Sidebar')).toBeTruthy()
    expect(screen.getByText('Adds a configurable sidebar panel.')).toBeTruthy()
    expect(request).toHaveBeenCalledTimes(2)
    expect(String(request.mock.calls[0]?.[0])).toContain('/api/community-market/state')
    expect(String(request.mock.calls[1]?.[0])).toContain('/api/community-market/catalog')
  })

  it('submits a trimmed search query to the catalog route', async () => {
    const request = vi.fn<typeof fetch>(async (input) => (
      String(input).includes('/state') ? response(stateWithSource) : response(catalogWithItem)
    ))
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()
    await screen.findByText('Better Sidebar')

    fireEvent.change(screen.getByPlaceholderText('search'), { target: { value: '  sidebar  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'searchAction' }))

    await waitFor(() => { expect(request).toHaveBeenCalledTimes(3) })
    const catalogUrl = new URL(String(request.mock.calls[2]?.[0]))
    expect(catalogUrl.searchParams.get('q')).toBe('sidebar')
    expect(catalogUrl.searchParams.get('locale')).toBe('en')
  })

  it('refreshes state and catalog with the current query', async () => {
    const request = vi.fn<typeof fetch>(async (input) => (
      String(input).includes('/state') ? response(stateWithSource) : response(catalogWithItem)
    ))
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()
    await screen.findByText('Better Sidebar')

    fireEvent.change(screen.getByPlaceholderText('search'), { target: { value: 'sidebar' } })
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }))

    await waitFor(() => { expect(request).toHaveBeenCalledTimes(4) })
    expect(String(request.mock.calls[2]?.[0])).toContain('/api/community-market/state')
    const catalogUrl = new URL(String(request.mock.calls[3]?.[0]))
    expect(catalogUrl.searchParams.get('q')).toBe('sidebar')
    expect(catalogUrl.searchParams.get('locale')).toBe('en')
  })

  it('shows a catalog error and retries the failed request', async () => {
    let catalogCalls = 0
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('/state')) return response(stateWithSource)
      catalogCalls += 1
      return catalogCalls === 1
        ? response({ error: 'market offline' }, 503)
        : response(catalogWithItem)
    })
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()

    expect(await screen.findByRole('heading', { name: 'catalogError' })).toBeTruthy()
    expect(screen.getByText('market offline')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))

    expect(await screen.findByText('Better Sidebar')).toBeTruthy()
    expect(request).toHaveBeenCalledTimes(4)
  })

  it('keeps successful cards visible when one catalog source fails', async () => {
    const partialCatalog: MarketCatalogResponse = {
      ...catalogWithItem,
      results: [
        ...catalogWithItem.results,
        { source, stale: false, error: 'source unavailable' },
      ],
    }
    const request = vi.fn<typeof fetch>(async (input) => (
      String(input).includes('/state') ? response(stateWithSource) : response(partialCatalog)
    ))
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()

    expect(await screen.findByText('Better Sidebar')).toBeTruthy()
    expect(screen.getByText('partialFailure')).toBeTruthy()
    expect(screen.getByText('Adds a configurable sidebar panel.')).toBeTruthy()
  })

  it('marks cards backed by a stale catalog snapshot', async () => {
    const staleCatalog: MarketCatalogResponse = {
      ...catalogWithItem,
      results: catalogWithItem.results.map(result => ({ ...result, stale: true })),
    }
    const request = vi.fn<typeof fetch>(async (input) => (
      String(input).includes('/state') ? response(stateWithSource) : response(staleCatalog)
    ))
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()

    expect(await screen.findByText('Better Sidebar')).toBeTruthy()
    expect(screen.getByText('stale')).toBeTruthy()
  })

  it('shows a loading state while the catalog request is pending', async () => {
    let resolveCatalog!: (value: Response) => void
    const pendingCatalog = new Promise<Response>(resolve => { resolveCatalog = resolve })
    const request = vi.fn<typeof fetch>(async (input) => (
      String(input).includes('/state') ? response(stateWithSource) : pendingCatalog
    ))
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()

    expect(await screen.findByText('loading')).toBeTruthy()
    resolveCatalog(response(catalogWithItem))
    expect(await screen.findByText('Better Sidebar')).toBeTruthy()
  })

  it('toggles a source and stops catalog requests when it becomes disabled', async () => {
    const disabledSource = { ...source, enabled: false }
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/state')) return response(stateWithSource)
      if (url.includes('/catalog')) return response(catalogWithItem)
      expect(init?.method).toBe('POST')
      return response({ sources: [disabledSource] })
    })
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()
    await screen.findByText('Better Sidebar')
    fireEvent.click(screen.getByRole('button', { name: 'sources' }))

    fireEvent.click(screen.getByRole('button', { name: 'disable' }))
    expect(await screen.findByText('disabled')).toBeTruthy()
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[2]?.[1]).toMatchObject({ method: 'POST' })
  })

  it('removes a source from the source list', async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/state')) return response(stateWithSource)
      if (url.includes('/catalog')) return response(catalogWithItem)
      expect(init?.method).toBe('POST')
      return response({ sources: [] })
    })
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()
    await screen.findByText('Better Sidebar')
    fireEvent.click(screen.getByRole('button', { name: 'sources' }))
    fireEvent.click(screen.getByRole('button', { name: 'remove' }))

    await waitFor(() => { expect(screen.queryByText(source.name)).toBeNull() })
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('adds a trimmed standard source and closes the dialog on success', async () => {
    const addedSource: MarketSourceView = {
      sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120003',
      registrationKind: 'user-added',
      adapterId: 'market.standard-http-v1',
      providerId: 'com.example.catalog',
      enabled: false,
      order: 1,
      name: 'Example Catalog',
      endpoint: 'https://plugins.example.org/catalog-source.json',
      partnership: false,
    }
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/state')) return response(stateWithSource)
      if (url.includes('/catalog')) return response(catalogWithItem)
      expect(init?.method).toBe('POST')
      return response({ sources: [source, addedSource] })
    })
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()
    await screen.findByText('Better Sidebar')
    fireEvent.click(screen.getByRole('button', { name: 'sources' }))
    fireEvent.click(screen.getByRole('button', { name: 'addStandard' }))
    fireEvent.change(screen.getByLabelText('standardSource'), { target: { value: '  https://plugins.example.org/catalog-source.json  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'confirmAdd' }))

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ action: 'add-standard', manifestUrl: 'https://plugins.example.org/catalog-source.json' }),
    })
    expect(screen.getByText('Example Catalog')).toBeTruthy()
  })

  it('keeps the standard source dialog open when adding fails', async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes('/state')) return response(stateWithSource)
      if (url.includes('/catalog')) return response(catalogWithItem)
      return response({ error: 'source offline' }, 400)
    })
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()
    await screen.findByText('Better Sidebar')
    fireEvent.click(screen.getByRole('button', { name: 'sources' }))
    fireEvent.click(screen.getByRole('button', { name: 'addStandard' }))
    const input = screen.getByLabelText('standardSource')
    fireEvent.change(input, { target: { value: 'https://plugins.example.org/broken.json' } })
    fireEvent.click(screen.getByRole('button', { name: 'confirmAdd' }))

    expect((await screen.findAllByText('source offline')).length).toBe(2)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(input).toHaveProperty('value', 'https://plugins.example.org/broken.json')
  })

  it('opens plugin details and forwards the repository link safely', async () => {
    const request = vi.fn<typeof fetch>(async (input) => (
      String(input).includes('/state') ? response(stateWithSource) : response(catalogWithItem)
    ))
    vi.stubGlobal('fetch', request)
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()
    await screen.findByText('Better Sidebar')
    fireEvent.click(screen.getByText('Better Sidebar').closest('button')!)

    expect(screen.getByRole('complementary', { name: 'details' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'repository' }))
    expect(open).toHaveBeenCalledWith('https://github.com/example/better-sidebar', '_blank', 'noopener,noreferrer')

    const closeButtons = screen.getAllByRole('button', { name: 'close' })
    fireEvent.click(closeButtons[1]!)
    expect(screen.queryByRole('complementary', { name: 'details' })).toBeNull()
    open.mockRestore()
  })

  it('keeps details open on Escape and closes the overlay after details close', async () => {
    const request = vi.fn<typeof fetch>(async (input) => (
      String(input).includes('/state') ? response(stateWithSource) : response(catalogWithItem)
    ))
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()
    await screen.findByText('Better Sidebar')
    fireEvent.click(screen.getByText('Better Sidebar').closest('button')!)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('complementary', { name: 'details' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'close' })[1]!)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'title' })).toBeNull()
    expect(controller.getSnapshot()).toBe(false)
  })
})
