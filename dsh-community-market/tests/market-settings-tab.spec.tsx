// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  MarketCatalogResponse,
  MarketInstallReceipt,
  MarketInstallableResponse,
  MarketSourceView,
  MarketStateResponse,
} from '../src/api-types.js'
import type { CatalogSnapshot } from '../src/contracts/generated/catalog-snapshot.js'
import { MarketSettingsTab, type MarketSettingsTabProps } from '../src/client/MarketSettingsTab.js'
import { MarketLauncher, type MarketLauncherProps } from '../src/client/MarketLauncher.js'
import { MarketOverlay, type MarketOverlayProps } from '../src/client/MarketOverlay.js'
import { createMarketViewStore } from '../src/client/market-view-store.js'
import {
  executeMarketOperation,
  mutateMarketSource,
  openMarketTerminal,
  previewMarketOperation,
  readMarketCatalog,
  readMarketInstallable,
  readMarketInstallations,
  readMarketState,
  readMoreMarketCatalog,
  requestMarketRestart,
} from '../src/client/api.js'
import { en, type MarketLocaleKey } from '../src/client/locales.js'

vi.mock('../src/client/api.js', () => ({
  executeMarketOperation: vi.fn(),
  mutateMarketSource: vi.fn(),
  openMarketTerminal: vi.fn(),
  previewMarketOperation: vi.fn(),
  readMarketCatalog: vi.fn(),
  readMarketInstallable: vi.fn(),
  readMarketInstallations: vi.fn(),
  readMoreMarketCatalog: vi.fn(),
  readMarketState: vi.fn(),
  requestMarketRestart: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

const t = ((key: MarketLocaleKey): string => en[key]) as MarketSettingsTabProps['t']
const props = { t, readLocale: () => 'en' } as MarketSettingsTabProps
const desktopActions = { openTerminal: true, requestRestart: true } as const
const emptyState: MarketStateResponse = { sources: [], builtIns: [], desktopActions }

const firstSource: MarketSourceView = {
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'built-in',
  adapterId: 'fixture',
  providerId: 'fixture',
  builtInProviderKey: 'fixture',
  enabled: true,
  order: 0,
  name: 'Fixture catalog',
  endpoint: 'https://catalog.example/v1/plugins',
  attribution: {
    name: 'Fixture provider',
    url: 'https://catalog.example',
    notice: 'Catalog metadata is maintained by Fixture provider.',
  },
  partnership: false,
}

function makeSecondSource(enabled = false): MarketSourceView {
  return {
    ...firstSource,
    sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
    providerId: 'fixture-second',
    builtInProviderKey: 'fixture-second',
    enabled,
    order: 1,
    name: 'Second catalog',
    endpoint: 'https://second.example/v1/plugins',
    attribution: {
      name: 'Second provider',
      url: 'https://second.example',
      notice: 'Catalog metadata is maintained by Second provider.',
    },
  }
}

const enabledState: MarketStateResponse = { sources: [firstSource], builtIns: [], desktopActions }
const availableState: MarketStateResponse = {
  sources: [],
  desktopActions,
  builtIns: [{
    key: 'fixture',
    adapterId: 'fixture',
    providerId: 'fixture',
    name: 'Fixture catalog',
    description: 'Fixture catalog description',
    endpoint: 'https://catalog.example/v1/plugins',
    attribution: {
      name: 'Fixture provider',
      url: 'https://catalog.example',
      notice: 'Built-in catalog attribution notice.',
    },
    partnership: false,
  }],
}

function makeItem(
  source: MarketSourceView,
  id = 'fixture-plugin',
  displayName = 'Fixture Plugin',
  categories: readonly string[] = ['interface'],
): CatalogSnapshot['items'][number] {
  return {
    id,
    name: id,
    displayName,
    summary: 'A plugin used by the settings page test.',
    description: `${displayName} details`,
    categories: [...categories],
    repository: { url: `https://github.com/example/${id}` },
    ...(id === 'fixture-plugin'
      ? {
          media: {
            icon: {
              assetRef: 'mktimg_0123456789abcdefghijklmnopqrstuv',
              role: 'plugin-icon' as const,
              alt: 'Fixture Plugin icon',
            },
          },
        }
      : {}),
    provenance: {
      sourceRecordId: source.sourceRecordId,
      providerId: source.providerId,
      itemId: id,
    },
  }
}

function makeInstallableItem(
  source: MarketSourceView,
  id = 'installable-plugin',
  displayName = 'Installable Plugin',
  packageName = 'dsh-plugin-installable',
  version = '1.2.3',
  categories: readonly string[] = ['tools'],
): CatalogSnapshot['items'][number] {
  const {
    repository,
    package: _package,
    latestVersion: _latestVersion,
    ...item
  } = makeItem(source, id, displayName, categories)
  return {
    ...item,
    ...(repository === undefined ? {} : { repository }),
    latestVersion: version,
    package: { registry: 'npm', name: packageName },
  }
}

function makeReceipt(overrides: Partial<MarketInstallReceipt> = {}): MarketInstallReceipt {
  return {
    receiptId: '018f1f77-a5c4-7b73-a9ae-0242ac120099',
    profileName: 'web',
    packageName: 'dsh-plugin-installed',
    version: '2.3.4',
    integrity: 'sha512-fixture',
    bundlePatch: 'dist/index.js',
    sourceRecordId: firstSource.sourceRecordId,
    providerId: firstSource.providerId,
    itemId: 'installed-plugin',
    displayName: 'Installed Plugin',
    installedAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  }
}

function installableResponse(
  items: readonly CatalogSnapshot['items'][number][],
  source: MarketSourceView = firstSource,
  overrides: Partial<MarketInstallableResponse['metadata']> = {},
): MarketInstallableResponse {
  return {
    source,
    items: [...items],
    manualInstall: [],
    metadata: {
      scannedAt: '2026-08-18T01:00:00.000Z',
      expiresAt: '2026-08-18T01:05:00.000Z',
      providerRevision: 'fixture-revision-7',
      cacheStatus: 'cached',
      ...overrides,
    },
  }
}

function catalogForSource(
  source: MarketSourceView,
  items: readonly CatalogSnapshot['items'][number][] = [makeItem(source)],
  nextCursor?: string,
): MarketCatalogResponse {
  return {
    query: {},
    categories: [...new Set(items.flatMap(item => item.categories ?? []))],
    manualInstall: [],
    fetchedAt: '2026-08-17T00:00:00Z',
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
          fetchedAt: '2026-08-17T00:00:00Z',
          finalUrl: source.endpoint,
          providerRevision: '1',
        },
        items: [...items],
        page: nextCursor === undefined ? {} : { nextCursor },
      },
    }],
  }
}

const catalog = catalogForSource(firstSource)

describe('MarketSettingsTab', () => {
  it('loads source state on mount and avoids catalog I/O when none are selected', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    render(<MarketSettingsTab {...props} />)

    expect(await screen.findByRole('heading', { name: en.emptyTitle })).toBeTruthy()
    expect(readMarketState).toHaveBeenCalledOnce()
    expect(readMarketCatalog).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    expect(screen.getByRole('heading', { name: en.sources })).toBeTruthy()
  })

  it('renders catalog metadata, forces an explicit refresh, and opens details in the official modal', async () => {
    const catalogWithMetadata: MarketCatalogResponse = {
      ...catalog,
      metadata: {
        scannedAt: '2026-08-18T03:00:00.000Z',
        expiresAt: '2026-08-18T03:05:00.000Z',
        providerRevision: 'discover-revision-9',
        cacheStatus: 'cached',
      },
    }
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogWithMetadata)
    render(<MarketSettingsTab {...props} />)

    const plugin = await screen.findByRole('button', { name: /Fixture Plugin/u })
    expect(screen.getByText(`${en.currentSource}: ${firstSource.name}`)).toBeTruthy()
    expect(screen.getByText(`${en.source}: Fixture catalog · Fixture provider`)).toBeTruthy()
    expect(screen.getByText(`${en.scannedAt}: ${catalogWithMetadata.metadata!.scannedAt}`)).toBeTruthy()
    expect(screen.getByText(`${en.cacheExpiresAt}: ${catalogWithMetadata.metadata!.expiresAt}`)).toBeTruthy()
    expect(screen.getByText(`${en.providerRevision}: ${catalogWithMetadata.metadata!.providerRevision}`)).toBeTruthy()
    expect(screen.getByText(en.cachedScan)).toBeTruthy()
    expect(plugin.querySelector('img')?.getAttribute('src')).toBe('/api/community-market/assets?ref=mktimg_0123456789abcdefghijklmnopqrstuv')
    expect(readMarketCatalog).toHaveBeenCalledWith(
      firstSource.sourceRecordId,
      '',
      'en',
      [],
      expect.any(AbortSignal),
    )
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await waitFor(() => {
      expect(readMarketCatalog).toHaveBeenNthCalledWith(
        2,
        firstSource.sourceRecordId,
        '',
        'en',
        [],
        expect.any(AbortSignal),
        true,
      )
    })
    fireEvent.click(plugin)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Fixture Plugin' })).toBeTruthy()
    expect(screen.getByText('Fixture Plugin details')).toBeTruthy()
    expect(screen.getAllByText(`${en.source}: Fixture catalog · Fixture provider`)).toHaveLength(2)
  })

  it('keeps the official plugin glyph when a same-origin icon cannot be loaded', async () => {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalog)
    render(<MarketSettingsTab {...props} />)

    const plugin = await screen.findByRole('button', { name: /Fixture Plugin/u })
    const image = plugin.querySelector('img')
    expect(image).not.toBeNull()
    fireEvent.error(image!)
    expect(plugin.querySelector('img')).toBeNull()
    expect(plugin.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })

  it('falls back in the same dialog to a Host-derived manual command and opens DSH Terminal', async () => {
    const item = makeItem(firstSource, 'manual-github-plugin', 'Manual GitHub Plugin', ['tools'])
    const manualCatalog: MarketCatalogResponse = {
      ...catalogForSource(firstSource, [item]),
      manualInstall: [{
        sourceRecordId: firstSource.sourceRecordId,
        providerId: firstSource.providerId,
        itemId: item.id,
        kind: 'github',
        mutable: true,
        desktopVerification: 'not-verified',
        displayCommand: 'dsh plugin add github:example/manual-github-plugin',
      }],
    }
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(manualCatalog)
    vi.mocked(previewMarketOperation).mockRejectedValue(new Error('managed install unavailable'))
    vi.mocked(openMarketTerminal).mockResolvedValue({ ok: true })
    render(<MarketSettingsTab {...props} />)

    const card = await screen.findByRole('button', { name: /Manual GitHub Plugin/u })
    expect(card.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(card)

    expect(await screen.findByText('dsh plugin add github:example/manual-github-plugin')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: item.displayName }).classList.contains('dshMarketWideModal')).toBe(true)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByText(en.manualNotVerified)).toBeTruthy()
    expect(screen.getByText(en.mutableGithubWarning)).toBeTruthy()
    expect(screen.getByText(en.operationWarning)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.openTerminal }))
    await waitFor(() => {
      expect(openMarketTerminal).toHaveBeenCalledWith(expect.any(AbortSignal))
    })
  })

  it('uses a complete verified index with local OR filters, local pages of 50, metadata, and explicit rescans', async () => {
    const availableItem = makeInstallableItem(
      firstSource,
      'available-plugin',
      'Available Plugin',
      'dsh-plugin-available',
      '1.4.0',
      ['tools'],
    )
    const filler = Array.from({ length: 49 }, (_, index) => makeInstallableItem(
      firstSource,
      `filler-${index}`,
      `Filler ${index}`,
      `dsh-plugin-filler-${index}`,
      '1.0.0',
      ['utility'],
    ))
    const secondInstallable = makeInstallableItem(
      firstSource,
      'second-installable',
      'Second Installable',
      'dsh-plugin-second',
      '3.0.0',
      ['interface'],
    )
    const initialIndex = installableResponse([availableItem, ...filler, secondInstallable])
    const freshIndex = installableResponse(initialIndex.items, firstSource, {
      scannedAt: '2026-08-18T02:00:00.000Z',
      cacheStatus: 'fresh',
    })
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [
      makeItem(firstSource, 'browse-only', 'Browse Only', ['interface']),
    ]))
    vi.mocked(readMarketInstallable)
      .mockResolvedValueOnce(initialIndex)
      .mockResolvedValue(freshIndex)
    render(<MarketSettingsTab {...props} />)

    expect(await screen.findByRole('button', { name: /Browse Only/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.discover })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.installable })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.installed })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.sources })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.installable }))
    expect(await screen.findByRole('button', { name: `${en.install}: Available Plugin` })).toBeTruthy()
    expect(screen.queryByRole('button', { name: `${en.install}: Second Installable` })).toBeNull()
    expect(screen.getByText(`${en.scannedAt}: ${initialIndex.metadata.scannedAt}`)).toBeTruthy()
    expect(screen.getByText(`${en.providerRevision}: ${initialIndex.metadata.providerRevision}`)).toBeTruthy()
    expect(screen.getByText(en.cachedScan)).toBeTruthy()
    expect(readMarketInstallable).toHaveBeenCalledWith('en', false, expect.any(AbortSignal))
    expect(readMarketInstallations).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.loadMore }))
    expect(screen.getByRole('button', { name: `${en.install}: Second Installable` })).toBeTruthy()
    expect(readMoreMarketCatalog).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'tools' }))
    expect(screen.getByRole('button', { name: `${en.install}: Available Plugin` })).toBeTruthy()
    expect(screen.queryByRole('button', { name: `${en.install}: Second Installable` })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'interface' }))
    expect(screen.getByRole('button', { name: `${en.install}: Available Plugin` })).toBeTruthy()
    expect(screen.getByRole('button', { name: `${en.install}: Second Installable` })).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(en.search), { target: { value: 'Second' } })
    fireEvent.click(screen.getByRole('button', { name: en.searchAction }))
    expect(screen.queryByRole('button', { name: `${en.install}: Available Plugin` })).toBeNull()
    expect(screen.getByRole('button', { name: `${en.install}: Second Installable` })).toBeTruthy()
    expect(readMarketInstallable).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: en.rescanInstallable }))
    expect(await screen.findByText(en.freshScan)).toBeTruthy()
    expect(readMarketInstallable).toHaveBeenNthCalledWith(2, 'en', true, expect.any(AbortSignal))
  })

  it('previews an exact package and profile before install, executes only its preview id, and prompts for restart', async () => {
    const item = makeInstallableItem(firstSource)
    const installCatalog = catalogForSource(firstSource, [item])
    const receipt = makeReceipt({
      packageName: item.package!.name,
      version: item.latestVersion!,
      itemId: item.id,
      displayName: item.displayName,
    })
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(installCatalog)
    vi.mocked(readMarketInstallable).mockResolvedValue(installableResponse([item]))
    const preview = {
      action: 'install',
      profileName: 'web',
      packageName: receipt.packageName,
      version: receipt.version,
      displayName: receipt.displayName,
      expiresAt: '2026-08-18T00:05:00.000Z',
      previewId: 'opaque-install-preview',
    } as const
    let resolvePreview: ((value: typeof preview) => void) | undefined
    vi.mocked(previewMarketOperation).mockReturnValue(new Promise(resolve => { resolvePreview = resolve }))
    vi.mocked(executeMarketOperation).mockResolvedValue({
      action: 'install',
      receipt,
      restartToken: 'opaque-install-restart',
    })
    vi.mocked(requestMarketRestart).mockResolvedValue({ ok: true })
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('button', { name: /Installable Plugin/u })
    fireEvent.click(screen.getByRole('button', { name: en.installable }))
    fireEvent.click(await screen.findByRole('button', { name: `${en.install}: ${item.displayName}` }))
    expect(screen.getByRole('dialog', { name: item.displayName })).toBeTruthy()
    expect(screen.getByText(en.checkingInstallMethod)).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    await waitFor(() => {
      expect(previewMarketOperation).toHaveBeenCalledWith({
        action: 'install',
        sourceRecordId: firstSource.sourceRecordId,
        itemId: item.id,
      }, expect.any(AbortSignal))
    })
    await act(async () => { resolvePreview?.(preview) })
    expect((await screen.findByRole('dialog', { name: en.confirmInstallTitle })).classList.contains('dshMarketConfirmModal')).toBe(true)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByText(receipt.packageName)).toBeTruthy()
    expect(screen.getByText(receipt.version)).toBeTruthy()
    expect(screen.getByText('web')).toBeTruthy()
    expect(screen.getByText(en.operationWarning)).toBeTruthy()
    const support = screen.getByRole('link', { name: en.contactUs }) as HTMLAnchorElement
    expect(support.parentElement?.textContent).toBe(
      `${en.operationRiskBeforeContact}${en.contactUs}${en.operationRiskAfterContact}`,
    )
    expect(support.href).toBe('https://github.com/anywhere-labs/deepseek-harness-desktop/issues')
    expect(support.target).toBe('_blank')
    expect(support.rel).toContain('noopener')
    expect(screen.getByText(en.restartAfterOperation)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
    await waitFor(() => {
      expect(executeMarketOperation).toHaveBeenCalledWith('opaque-install-preview', expect.any(AbortSignal))
    })
    expect(await screen.findByRole('dialog', { name: en.installComplete })).toBeTruthy()
    expect(screen.getByText(en.restartRequiredBody)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.restartLater })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.restartNow }))
    await waitFor(() => {
      expect(requestMarketRestart).toHaveBeenCalledWith('opaque-install-restart', expect.any(AbortSignal))
    })
    await waitFor(() => {
      expect(readMarketInstallable).toHaveBeenCalledTimes(2)
      expect(readMarketInstallations).not.toHaveBeenCalled()
      expect(readMarketState).toHaveBeenCalledTimes(1)
      expect(readMarketCatalog).toHaveBeenCalledTimes(1)
    })
  })

  it('links failed install verification to the standard-plugin requirements', async () => {
    const item = makeInstallableItem(firstSource)
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [item]))
    vi.mocked(readMarketInstallable).mockResolvedValue(installableResponse([item]))
    vi.mocked(previewMarketOperation).mockRejectedValue(new Error('not a standard plugin'))
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('button', { name: /Installable Plugin/u })
    fireEvent.click(screen.getByRole('button', { name: en.installable }))
    fireEvent.click(await screen.findByRole('button', { name: `${en.install}: ${item.displayName}` }))

    expect(await screen.findByText(en.previewError)).toBeTruthy()
    const details = screen.getByRole('link', { name: en.verificationDetails }) as HTMLAnchorElement
    expect(details.href).toBe(
      'https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/install-and-uninstall.md',
    )
    expect(details.target).toBe('_blank')
    expect(details.rel).toContain('noopener')
  })

  it('uninstalls only from the current profile receipt and executes the Host preview id', async () => {
    const receipt = makeReceipt()
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations)
      .mockResolvedValueOnce({
        installations: [{ kind: 'managed', status: 'active', action: 'uninstall', receipt }],
      })
      .mockResolvedValue({ installations: [] })
    vi.mocked(previewMarketOperation).mockResolvedValue({
      action: 'uninstall',
      profileName: receipt.profileName,
      packageName: receipt.packageName,
      version: receipt.version,
      displayName: receipt.displayName,
      expiresAt: '2026-08-18T00:05:00.000Z',
      previewId: 'opaque-uninstall-preview',
    })
    vi.mocked(executeMarketOperation).mockResolvedValue({
      action: 'uninstall',
      receiptId: receipt.receiptId,
      packageName: receipt.packageName,
      restartToken: 'opaque-uninstall-restart',
    })
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('heading', { name: en.emptyTitle })
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    fireEvent.click(await screen.findByRole('button', { name: `${en.uninstall}: ${receipt.displayName}` }))
    await waitFor(() => {
      expect(previewMarketOperation).toHaveBeenCalledWith(
        { action: 'uninstall', receiptId: receipt.receiptId },
        expect.any(AbortSignal),
      )
    })
    expect((await screen.findByRole('dialog', { name: en.confirmUninstallTitle })).classList.contains('dshMarketConfirmModal')).toBe(true)
    expect(screen.getByText(receipt.version)).toBeTruthy()
    expect(screen.getByText(receipt.profileName)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.confirmUninstall }))
    await waitFor(() => {
      expect(executeMarketOperation).toHaveBeenCalledWith('opaque-uninstall-preview', expect.any(AbortSignal))
    })
    expect(await screen.findByRole('dialog', { name: en.uninstallComplete })).toBeTruthy()
    expect(screen.getByText(en.restartRequiredBody)).toBeTruthy()
    expect(readMarketCatalog).not.toHaveBeenCalled()
  })

  it('disables an external bundle through an exact Host preview without offering uninstall', async () => {
    const external = {
      kind: 'external' as const,
      status: 'active' as const,
      action: 'disable' as const,
      bundleId: 'opaque-bundle-id',
      packageName: 'dsh-plugin-external',
    }
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations)
      .mockResolvedValueOnce({ installations: [external] })
      .mockResolvedValue({
        installations: [{
          kind: 'external',
          status: 'disabled',
          action: 'none',
          packageName: external.packageName,
        }],
      })
    vi.mocked(previewMarketOperation).mockResolvedValue({
      action: 'disable',
      profileName: 'web',
      packageName: external.packageName,
      displayName: external.packageName,
      expiresAt: '2026-08-18T00:05:00.000Z',
      previewId: 'opaque-disable-preview',
    })
    vi.mocked(executeMarketOperation).mockResolvedValue({
      action: 'disable',
      packageName: external.packageName,
      restartToken: 'opaque-disable-restart',
    })
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('heading', { name: en.emptyTitle })
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    const disable = await screen.findByRole('button', { name: `${en.disable}: ${external.packageName}` })
    expect(screen.queryByRole('button', { name: `${en.uninstall}: ${external.packageName}` })).toBeNull()
    fireEvent.click(disable)
    await waitFor(() => {
      expect(previewMarketOperation).toHaveBeenCalledWith(
        { action: 'disable', bundleId: external.bundleId },
        expect.any(AbortSignal),
      )
    })
    expect(await screen.findByRole('dialog', { name: en.confirmDisableTitle })).toBeTruthy()
    expect(screen.getByText(en.disableWarning)).toBeTruthy()
    expect(screen.getByText(en.disableRecoveryWarning)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.confirmDisable }))
    await waitFor(() => {
      expect(executeMarketOperation).toHaveBeenCalledWith('opaque-disable-preview', expect.any(AbortSignal))
    })
    expect(await screen.findByRole('dialog', { name: en.disableComplete })).toBeTruthy()
    expect(screen.getByText(en.restartRequiredBody)).toBeTruthy()
  })

  it('keeps disabled external and immutable bundles read-only while a disabled receipt remains uninstallable', async () => {
    const receipt = makeReceipt({ displayName: 'Disabled managed plugin' })
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations).mockResolvedValue({
      installations: [
        { kind: 'managed', status: 'disabled', action: 'uninstall', receipt },
        { kind: 'external', status: 'disabled', action: 'none', packageName: 'dsh-plugin-disabled-external' },
        { kind: 'immutable', status: 'active', action: 'none', packageName: 'dsh-plugin-desktop' },
      ],
    })
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('heading', { name: en.emptyTitle })
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(await screen.findByRole('button', { name: `${en.uninstall}: ${receipt.displayName}` })).toBeTruthy()
    expect(screen.getAllByText(en.disabledPlugin).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(en.immutablePlugin)).toBeTruthy()
    expect(screen.queryByRole('button', { name: new RegExp(`^${en.disable}:`, 'u') })).toBeNull()
    expect(screen.queryByRole('button', { name: new RegExp(`^${en.uninstall}: dsh-plugin`, 'u') })).toBeNull()
  })

  it('explains that package operations require Desktop when the optional Host capability returns 503', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    vi.mocked(readMarketInstallations).mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }))
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('heading', { name: en.emptyTitle })
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(await screen.findByRole('heading', { name: en.desktopRequiredTitle })).toBeTruthy()
    expect(screen.getByText(en.desktopUnavailable)).toBeTruthy()
    expect(screen.queryByText('unavailable')).toBeNull()
  })

  it('fails closed without offering locally guessed candidates when Host validation fails', async () => {
    const item = makeInstallableItem(firstSource)
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [item]))
    vi.mocked(readMarketInstallable).mockRejectedValue(new Error('private index failure'))
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('button', { name: /Installable Plugin/u })
    fireEvent.click(screen.getByRole('button', { name: en.installable }))
    expect(await screen.findByRole('heading', { name: en.installableError })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
    expect(screen.queryByRole('button', { name: `${en.install}: ${item.displayName}` })).toBeNull()
    expect(screen.queryByText('private index failure')).toBeNull()
  })

  it('shows source attribution, endpoint, adapter type, and last result', async () => {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalog)
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('button', { name: /Fixture Plugin/u })
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    const attribution = screen.getByRole('link', { name: 'Fixture provider' }) as HTMLAnchorElement
    expect(attribution.href).toBe('https://catalog.example/')
    expect(attribution.target).toBe('_blank')
    expect(attribution.rel).toContain('noopener')
    expect(screen.getByText('Catalog metadata is maintained by Fixture provider.')).toBeTruthy()
    expect(screen.getByText('catalog.example')).toBeTruthy()
    expect(screen.getByText(en.builtIn)).toBeTruthy()
    expect(screen.getByText(en.available)).toBeTruthy()
  })

  it('shows attribution text and notice without creating an unsafe external link', async () => {
    const unsafe = {
      sources: [{
        ...firstSource,
        enabled: false,
        attribution: {
          name: 'Unsafe provider claim',
          url: 'javascript:alert(1)',
          notice: 'This notice remains visible.',
        },
      }],
      builtIns: [],
      desktopActions,
    } as MarketStateResponse
    vi.mocked(readMarketState).mockResolvedValue(unsafe)
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('heading', { name: en.emptyTitle })
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    expect(screen.getByText('Unsafe provider claim')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Unsafe provider claim' })).toBeNull()
    expect(screen.getByText('This notice remains visible.')).toBeTruthy()
  })

  it('links source teams to the partnership contact and catalog adapter guide', async () => {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalog)
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('button', { name: /Fixture Plugin/u })
    fireEvent.click(screen.getByRole('button', { name: en.sources }))

    const contact = screen.getByRole('link', { name: en.sourcePartnershipContact }) as HTMLAnchorElement
    expect(contact.href).toBe('https://github.com/anywhere-labs/deepseek-harness-desktop/issues')
    expect(contact.target).toBe('_blank')
    expect(contact.rel).toContain('noopener')
    const guide = screen.getByRole('link', { name: en.sourcePartnershipGuide }) as HTMLAnchorElement
    expect(guide.href).toBe(
      'https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/catalog-adapter-guide.md',
    )
    expect(guide.target).toBe('_blank')
    expect(guide.rel).toContain('noopener')
  })

  it('moves sources in either direction and disables controls at the list boundaries', async () => {
    const first = { ...firstSource, enabled: false, order: 0, name: 'First catalog' }
    const second = { ...makeSecondSource(false), order: 1 }
    const initial = { sources: [first, second], builtIns: [], desktopActions } as MarketStateResponse
    const movedUp = [{ ...second, order: 0 }, { ...first, order: 1 }]
    vi.mocked(readMarketState).mockResolvedValue(initial)
    vi.mocked(mutateMarketSource)
      .mockResolvedValueOnce(movedUp)
      .mockResolvedValueOnce(initial.sources)
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('heading', { name: en.emptyTitle })
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    let up = screen.getAllByRole('button', { name: en.moveUp }) as HTMLButtonElement[]
    let down = screen.getAllByRole('button', { name: en.moveDown }) as HTMLButtonElement[]
    expect(up.map(button => button.disabled)).toEqual([true, false])
    expect(down.map(button => button.disabled)).toEqual([false, true])

    fireEvent.click(up[1]!)
    await waitFor(() => {
      expect(mutateMarketSource).toHaveBeenNthCalledWith(1, {
        action: 'move',
        sourceRecordId: second.sourceRecordId,
        direction: 'up',
      }, expect.any(AbortSignal))
    })
    await waitFor(() => {
      expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent))
        .toEqual(['Second catalog', 'First catalog'])
    })
    up = screen.getAllByRole('button', { name: en.moveUp }) as HTMLButtonElement[]
    down = screen.getAllByRole('button', { name: en.moveDown }) as HTMLButtonElement[]
    expect(up.map(button => button.disabled)).toEqual([true, false])
    expect(down.map(button => button.disabled)).toEqual([false, true])

    fireEvent.click(down[0]!)
    await waitFor(() => {
      expect(mutateMarketSource).toHaveBeenNthCalledWith(2, {
        action: 'move',
        sourceRecordId: second.sourceRecordId,
        direction: 'down',
      }, expect.any(AbortSignal))
    })
  })

  it('selects exactly one source and clears the previous source while the new catalog loads', async () => {
    const second = makeSecondSource(false)
    const initial = { sources: [firstSource, second], builtIns: [], desktopActions } as MarketStateResponse
    const selected = {
      sources: [{ ...firstSource, enabled: false }, { ...second, enabled: true }],
      builtIns: [],
      desktopActions,
    } as MarketStateResponse
    let resolveSecond: ((value: MarketCatalogResponse) => void) | undefined
    const pendingSecond = new Promise<MarketCatalogResponse>(resolve => { resolveSecond = resolve })
    vi.mocked(readMarketState).mockResolvedValue(initial)
    vi.mocked(readMarketCatalog)
      .mockResolvedValueOnce(catalogForSource(firstSource, [makeItem(firstSource, 'first-plugin', 'First Plugin', ['interface'])], 'first-next'))
      .mockReturnValueOnce(pendingSecond)
    vi.mocked(mutateMarketSource).mockResolvedValue(selected.sources)
    render(<MarketSettingsTab {...props} />)

    expect(await screen.findByRole('button', { name: /First Plugin/u })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    const group = screen.getByRole('radiogroup', { name: en.sourceSelection })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map(radio => radio.getAttribute('aria-checked'))).toEqual(['true', 'false'])

    fireEvent.click(radios[0]!)
    expect(mutateMarketSource).not.toHaveBeenCalled()
    fireEvent.click(radios[1]!)
    await waitFor(() => {
      expect(mutateMarketSource).toHaveBeenCalledWith(
        { action: 'select', sourceRecordId: second.sourceRecordId },
        expect.any(AbortSignal),
      )
      expect(readMarketCatalog).toHaveBeenCalledTimes(2)
    })

    fireEvent.click(screen.getByRole('button', { name: en.discover }))
    expect(screen.queryByRole('button', { name: /First Plugin/u })).toBeNull()
    expect(screen.queryByRole('button', { name: 'interface' })).toBeNull()
    expect(screen.getByText(en.loading)).toBeTruthy()

    await act(async () => {
      resolveSecond?.(catalogForSource(second, [makeItem(second, 'second-plugin', 'Second Plugin', ['tools'])]))
      await pendingSecond
    })
    expect(await screen.findByRole('button', { name: /Second Plugin/u })).toBeTruthy()
    expect(screen.getByText(`${en.currentSource}: ${second.name}`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /First Plugin/u })).toBeNull()
    expect(screen.getByRole('button', { name: 'tools' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.loadMore })).toBeNull()
    expect(readMarketCatalog).toHaveBeenNthCalledWith(
      2,
      second.sourceRecordId,
      '',
      'en',
      [],
      expect.any(AbortSignal),
    )
  })

  it('resets a submitted search before fetching a newly selected source', async () => {
    const second = makeSecondSource(false)
    const selectedSources = [{ ...firstSource, enabled: false }, { ...second, enabled: true }]
    vi.mocked(readMarketState).mockResolvedValue({ sources: [firstSource, second], builtIns: [], desktopActions })
    vi.mocked(readMarketCatalog)
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(catalogForSource(firstSource, [makeItem(firstSource, 'matched-plugin', 'Matched Plugin')]))
      .mockResolvedValueOnce(catalogForSource(second, [makeItem(second, 'second-plugin', 'Second Plugin')]))
    vi.mocked(mutateMarketSource).mockResolvedValue(selectedSources)
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('button', { name: /Fixture Plugin/u })
    const search = screen.getByPlaceholderText(en.search) as HTMLInputElement
    fireEvent.change(search, { target: { value: '  matched  ' } })
    fireEvent.click(screen.getByRole('button', { name: en.searchAction }))
    expect(await screen.findByRole('button', { name: /Matched Plugin/u })).toBeTruthy()
    expect(readMarketCatalog).toHaveBeenNthCalledWith(
      2,
      firstSource.sourceRecordId,
      'matched',
      'en',
      [],
      expect.any(AbortSignal),
    )

    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    fireEvent.click(screen.getByRole('radio', { name: en.selectSource }))
    await waitFor(() => {
      expect(readMarketCatalog).toHaveBeenNthCalledWith(
        3,
        second.sourceRecordId,
        '',
        'en',
        [],
        expect.any(AbortSignal),
      )
    })
    fireEvent.click(screen.getByRole('button', { name: en.discover }))
    expect((screen.getByPlaceholderText(en.search) as HTMLInputElement).value).toBe('')
    expect(await screen.findByRole('button', { name: /Second Plugin/u })).toBeTruthy()
  })

  it('adds an available source without fetching it, then fetches only after explicit selection', async () => {
    const added = { ...firstSource, enabled: false }
    vi.mocked(readMarketState).mockResolvedValue(availableState)
    vi.mocked(mutateMarketSource)
      .mockResolvedValueOnce([added])
      .mockResolvedValueOnce([firstSource])
    vi.mocked(readMarketCatalog).mockResolvedValue(catalog)
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('heading', { name: en.emptyTitle })
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    expect(screen.getByRole('link', { name: 'Fixture provider' }).getAttribute('href')).toBe('https://catalog.example/')
    expect(screen.getByText('Built-in catalog attribution notice.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    await waitFor(() => {
      expect(mutateMarketSource).toHaveBeenCalledWith(
        { action: 'add-builtin', key: 'fixture' },
        expect.any(AbortSignal),
      )
    })
    expect(readMarketCatalog).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole('radio', { name: en.selectSource }))
    await waitFor(() => {
      expect(mutateMarketSource).toHaveBeenNthCalledWith(
        2,
        { action: 'select', sourceRecordId: firstSource.sourceRecordId },
        expect.any(AbortSignal),
      )
      expect(readMarketCatalog).toHaveBeenCalledOnce()
    })
    fireEvent.click(screen.getByRole('button', { name: en.discover }))
    expect(await screen.findByRole('button', { name: /Fixture Plugin/u })).toBeTruthy()
  })

  it('loads one more page for the selected source, deduplicates items, and accumulates categories', async () => {
    const firstPage = catalogForSource(firstSource, [makeItem(firstSource, 'fixture-plugin', 'Fixture Plugin', ['interface'])], 'cursor-2')
    const secondPage = catalogForSource(firstSource, [
      makeItem(firstSource, 'fixture-plugin', 'Fixture Plugin', ['interface']),
      makeItem(firstSource, 'second-page-plugin', 'Second Page Plugin', ['tools']),
    ])
    let resolvePage: ((value: MarketCatalogResponse) => void) | undefined
    const pendingPage = new Promise<MarketCatalogResponse>(resolve => { resolvePage = resolve })
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(firstPage)
    vi.mocked(readMoreMarketCatalog).mockReturnValue(pendingPage)
    render(<MarketSettingsTab {...props} />)

    expect(await screen.findByRole('button', { name: /Fixture Plugin/u })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.loadMore }))
    await waitFor(() => {
      expect(readMoreMarketCatalog).toHaveBeenCalledWith(
        firstSource.sourceRecordId,
        'cursor-2',
        '',
        'en',
        [],
        expect.any(AbortSignal),
      )
    })
    expect(screen.getByRole('button', { name: /Fixture Plugin/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.loadingMore })).toBeTruthy()

    await act(async () => {
      resolvePage?.(secondPage)
      await pendingPage
    })
    expect(await screen.findByRole('button', { name: /Second Page Plugin/u })).toBeTruthy()
    expect(screen.getAllByText('Fixture Plugin')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'interface' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'tools' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.loadMore })).toBeNull()
  })

  it('keeps an unsubmitted search draft out of the current pagination request', async () => {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [makeItem(firstSource)], 'cursor-2'))
    vi.mocked(readMoreMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [
      makeItem(firstSource),
      makeItem(firstSource, 'second-page-plugin', 'Second Page Plugin'),
    ]))
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('button', { name: /Fixture Plugin/u })
    fireEvent.change(screen.getByPlaceholderText(en.search), { target: { value: 'draft only' } })
    fireEvent.click(screen.getByRole('button', { name: en.loadMore }))
    await waitFor(() => {
      expect(readMoreMarketCatalog).toHaveBeenCalledWith(
        firstSource.sourceRecordId,
        'cursor-2',
        '',
        'en',
        [],
        expect.any(AbortSignal),
      )
    })
    expect((screen.getByPlaceholderText(en.search) as HTMLInputElement).value).toBe('draft only')
    expect(await screen.findByRole('button', { name: /Second Page Plugin/u })).toBeTruthy()
  })

  it('keeps loaded items and the retry affordance when loading another page fails', async () => {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalogForSource(firstSource, [makeItem(firstSource)], 'cursor-2'))
    vi.mocked(readMoreMarketCatalog).mockRejectedValue(new Error('offline'))
    render(<MarketSettingsTab {...props} />)

    expect(await screen.findByRole('button', { name: /Fixture Plugin/u })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.loadMore }))
    expect(await screen.findByText(en.loadMoreError)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Fixture Plugin/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.loadMore })).toBeTruthy()
  })

  it('uses multi-select category filters with OR query semantics and resets the current page', async () => {
    const initial = catalogForSource(firstSource, [makeItem(firstSource, 'fixture-plugin', 'Fixture Plugin', ['interface', 'tools'])], 'unfiltered-next')
    const interfaceOnly = {
      ...catalogForSource(firstSource, [makeItem(firstSource, 'interface-plugin', 'Interface Plugin', ['interface'])], 'interface-next'),
      categories: ['interface', 'tools'],
    }
    const both = {
      ...catalogForSource(firstSource, [makeItem(firstSource, 'both-plugin', 'Both Categories Plugin', ['tools'])], 'both-next'),
      categories: ['interface', 'tools'],
    }
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(interfaceOnly)
      .mockResolvedValueOnce(both)
      .mockRejectedValueOnce(new Error('offline'))
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('button', { name: /Fixture Plugin/u })
    fireEvent.click(screen.getByRole('button', { name: 'interface' }))
    await waitFor(() => {
      expect(readMarketCatalog).toHaveBeenNthCalledWith(
        2,
        firstSource.sourceRecordId,
        '',
        'en',
        ['interface'],
        expect.any(AbortSignal),
      )
    })
    expect(await screen.findByRole('button', { name: /Interface Plugin/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'interface' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'tools' })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.loadMore })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'tools' }))
    await waitFor(() => {
      expect(readMarketCatalog).toHaveBeenNthCalledWith(
        3,
        firstSource.sourceRecordId,
        '',
        'en',
        ['interface', 'tools'],
        expect.any(AbortSignal),
      )
    })
    expect(await screen.findByRole('button', { name: /Both Categories Plugin/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'interface' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'tools' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: en.loadMore })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'interface' }))
    await waitFor(() => {
      expect(readMarketCatalog).toHaveBeenNthCalledWith(
        4,
        firstSource.sourceRecordId,
        '',
        'en',
        ['tools'],
        expect.any(AbortSignal),
      )
    })
    expect(await screen.findByRole('heading', { name: en.catalogError })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Both Categories Plugin/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'interface' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'tools' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: en.loadMore })).toBeTruthy()
  })

  it('shows a bounded failure, retries, and aborts an unfinished read on unmount', async () => {
    vi.mocked(readMarketState)
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce(emptyState)
    const view = render(<MarketSettingsTab {...props} />)

    expect(await screen.findByRole('heading', { name: en.catalogError })).toBeTruthy()
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(await screen.findByRole('heading', { name: en.emptyTitle })).toBeTruthy()
    expect(readMarketState).toHaveBeenCalledTimes(2)
    view.unmount()

    let signal: AbortSignal | undefined
    vi.mocked(readMarketState).mockImplementationOnce((nextSignal) => {
      signal = nextSignal
      return new Promise<MarketStateResponse>(() => {})
    })
    const pending = render(<MarketSettingsTab {...props} />)
    await waitFor(() => { expect(signal).toBeDefined() })
    await act(async () => { pending.unmount() })
    expect(signal?.aborted).toBe(true)
  })

  it('does not let reads interrupt a pending source selection and aborts it on unmount', async () => {
    const second = makeSecondSource(false)
    vi.mocked(readMarketState).mockResolvedValue({ sources: [firstSource, second], builtIns: [], desktopActions })
    vi.mocked(readMarketCatalog).mockResolvedValue(catalog)
    let signal: AbortSignal | undefined
    vi.mocked(mutateMarketSource).mockImplementation((_mutation, nextSignal) => {
      signal = nextSignal
      return new Promise(() => {})
    })
    const view = render(<MarketSettingsTab {...props} />)
    await screen.findByRole('button', { name: /Fixture Plugin/u })
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    fireEvent.click(screen.getByRole('radio', { name: en.selectSource }))
    await waitFor(() => { expect(signal).toBeDefined() })
    expect(screen.getAllByRole('radio').every(radio => (radio as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.discover }))
    expect((screen.getByRole('button', { name: en.refresh }) as HTMLButtonElement).disabled).toBe(true)
    expect(readMarketState).toHaveBeenCalledOnce()

    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('opens and closes the shared Market surface from the sidebar launcher', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    const instance = createMarketViewStore().create()
    const useStore = <T,>(selector: (state: { open: boolean }) => T): T => useSyncExternalStore(
      instance.subscribe,
      () => selector(instance.getSnapshot()),
    )
    const shared = { actions: instance.actions, useStore }
    const launcherProps = { ...shared, wide: true, t } as unknown as MarketLauncherProps
    const overlayProps = { ...shared, readLocale: () => 'en', t } as unknown as MarketOverlayProps
    render(<>
      <MarketLauncher {...launcherProps} />
      <MarketOverlay {...overlayProps} />
    </>)

    expect(screen.queryByRole('dialog', { name: en.title })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.tab }))
    expect(await screen.findByRole('dialog', { name: en.title })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: en.emptyTitle })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: en.close })[1]!)
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en.title })).toBeNull() })
  })
})
