import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconCordisPluginOutline14,
  IconDataOutline16,
  IconDownloadOutline16,
  IconGlobeOutline14,
  IconPlusOutline16,
  IconPauseOutline16,
  IconPlayOutline16,
  IconRefreshOutline16,
  IconRightUpOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  Input,
  Modal,
  Pill,
  StateDot,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CatalogSnapshot } from '../contracts/generated/catalog-snapshot.js'
import type {
  MarketBuiltInProvider,
  MarketCatalogResponse,
  MarketCatalogSourceResult,
  MarketInstallationView,
  MarketInstallableResponse,
  MarketOperationPreviewRequest,
  MarketOperationPreviewResponse,
  MarketSourceMutation,
  MarketSourceView,
  MarketStateResponse,
} from '../api-types.js'
import { marketMediaAssetUrl } from '../media/ref.js'
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
} from './api.js'

type MarketItem = CatalogSnapshot['items'][number]
export type MarketView = 'discover' | 'installable' | 'installed' | 'sources'
const INSTALLABLE_PAGE_SIZE = 50
const INSTALL_REQUIREMENTS_DOCS = {
  en: 'https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/install-and-uninstall.md',
  zh: 'https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/install-and-uninstall.zh.md',
} as const
const CATALOG_ADAPTER_GUIDE_DOCS = {
  en: 'https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/catalog-adapter-guide.md',
  zh: 'https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/dsh-community-market/docs/catalog-adapter-guide.zh.md',
} as const
const DSH_DESKTOP_ISSUES_URL = 'https://github.com/anywhere-labs/deepseek-harness-desktop/issues'

function installRequirementsUrl(locale: string): string {
  return locale.toLowerCase().startsWith('zh') ? INSTALL_REQUIREMENTS_DOCS.zh : INSTALL_REQUIREMENTS_DOCS.en
}

function catalogAdapterGuideUrl(locale: string): string {
  return locale.toLowerCase().startsWith('zh') ? CATALOG_ADAPTER_GUIDE_DOCS.zh : CATALOG_ADAPTER_GUIDE_DOCS.en
}

interface VisibleItem {
  readonly item: MarketItem
  readonly source: MarketSourceView
  readonly stale: boolean
}

interface CompletedOperation {
  readonly preview: MarketOperationPreviewResponse
  readonly restartToken: string
}

type ManualInstallHint = MarketCatalogResponse['manualInstall'][number]

type InstallationLoadOutcome =
  | { readonly installations: readonly MarketInstallationView[] }
  | { readonly error: string }

function visibleItemKey(value: VisibleItem): string {
  return `${value.source.sourceRecordId}\0${value.source.providerId}\0${value.item.id}\0${value.item.package?.name ?? ''}`
}

function matchingInstallation(
  value: VisibleItem,
  installations: readonly MarketInstallationView[],
): MarketInstallationView | undefined {
  const packageName = value.item.package?.name
  if (packageName === undefined) return undefined
  const managed = installations.filter(installation => installation.kind === 'managed'
    && installation.receipt.sourceRecordId === value.source.sourceRecordId
    && installation.receipt.providerId === value.source.providerId
    && installation.receipt.itemId === value.item.id
    && installation.receipt.packageName === packageName)
  if (managed.length === 1) return managed[0]
  if (managed.length > 1) return undefined
  const external = installations.filter(installation => installation.kind === 'external'
    && installation.packageName === packageName)
  if (external.length === 1) return external[0]
  if (external.length > 1) return undefined
  const immutable = installations.filter(installation => installation.kind === 'immutable'
    && installation.packageName === packageName)
  return immutable.length === 1 ? immutable[0] : undefined
}

function isDesktopUnavailable(cause: unknown): boolean {
  return cause !== null
    && typeof cause === 'object'
    && 'status' in cause
    && (cause as { status?: unknown }).status === 503
}

function operationErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : fallback
}

function catalogFailureMessage(
  cause: unknown,
  source: MarketSourceView,
  t: MarketSettingsTabProps['t'],
): string {
  const code = cause !== null && typeof cause === 'object' && 'code' in cause
    ? (cause as { code?: unknown }).code
    : undefined
  const reason = code === 'catalog-timeout'
    ? t('catalogFailureTimeout')
    : code === 'catalog-invalid-response'
      ? t('catalogFailureInvalidResponse')
      : t('catalogFailureUnavailable')
  return `${t('catalogFailureSource')}: ${source.name}. ${reason}`
}

function PluginIcon({ item, large = false }: { item: MarketItem; large?: boolean }) {
  const icon = item.media?.icon
  return (
    <div className={large ? 'dshMarketGlyph dshMarketGlyphLarge' : 'dshMarketGlyph'}>
      <IconCordisPluginOutline14 size={large ? 28 : 20} />
      {icon !== undefined && (
        <img
          src={marketMediaAssetUrl(icon.assetRef)}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={event => { event.currentTarget.remove() }}
        />
      )}
    </div>
  )
}

export type MarketSettingsTabProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'community-market'>
  & {
    readLocale: () => string
    initialView?: MarketView
  }

export interface MarketSurfaceProps {
  readonly readLocale: () => string
  readonly t: MarketSettingsTabProps['t']
  readonly showHeader?: boolean
  readonly initialView?: MarketView
}

function retainEnabledCatalog(
  catalog: MarketCatalogResponse | undefined,
  sources: readonly MarketSourceView[],
): MarketCatalogResponse | undefined {
  if (catalog === undefined) return undefined
  const selected = [...sources]
    .filter(source => source.enabled)
    .sort((left, right) => left.order - right.order)
    .at(0)
  if (selected === undefined) return undefined
  const result = catalog.results.find(value => value.source.sourceRecordId === selected.sourceRecordId)
  return result === undefined ? undefined : { ...catalog, results: [{ ...result, source: selected }] }
}

function selectedSource(sources: readonly MarketSourceView[]): MarketSourceView | undefined {
  return [...sources]
    .filter(source => source.enabled)
    .sort((left, right) => left.order - right.order)
    .at(0)
}

function categoriesFromItems(items: readonly MarketItem[]): readonly string[] {
  const categories = new Set<string>()
  for (const item of items) {
    for (const category of item.categories ?? []) categories.add(category)
  }
  return [...categories].sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
}

function matchesInstallableQuery(item: MarketItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return [
    item.displayName,
    item.name,
    item.summary,
    item.description,
    item.publisher?.name,
    item.package?.name,
    ...(item.categories ?? []),
  ].some(value => value?.toLocaleLowerCase().includes(needle) === true)
}

function mergeCatalogPages(
  catalog: MarketCatalogResponse | undefined,
  pages: readonly MarketCatalogSourceResult[],
  manualInstall: readonly ManualInstallHint[],
): MarketCatalogResponse | undefined {
  if (catalog === undefined || pages.length === 0) return catalog
  const updates = new Map(pages.map(page => [page.source.sourceRecordId, page]))
  const results = catalog.results.map(current => {
    const next = updates.get(current.source.sourceRecordId)
    if (current.snapshot === undefined || next?.snapshot === undefined) return current
    const seen = new Set<string>()
    const items = [...current.snapshot.items, ...next.snapshot.items].filter(item => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    return {
      ...next,
      source: current.source,
      snapshot: { ...next.snapshot, items, page: next.snapshot.page },
    }
  })
  const hints = new Map([...catalog.manualInstall, ...manualInstall].map(hint => [
    `${hint.sourceRecordId}:${hint.itemId}`,
    hint,
  ]))
  return { ...catalog, results, manualInstall: [...hints.values()], fetchedAt: new Date().toISOString() }
}

export function MarketSurface({ initialView = 'installable', readLocale, t, showHeader = true }: MarketSurfaceProps) {
  const [view, setView] = useState<MarketView>(initialView)
  const [state, setState] = useState<MarketStateResponse>()
  const [catalog, setCatalog] = useState<MarketCatalogResponse>()
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [categoryOptions, setCategoryOptions] = useState<readonly string[]>([])
  const [selectedCategories, setSelectedCategories] = useState<readonly string[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()
  const [loadMoreError, setLoadMoreError] = useState<string>()
  const [selected, setSelected] = useState<VisibleItem>()
  const [addOpen, setAddOpen] = useState(false)
  const [manifestUrl, setManifestUrl] = useState('')
  const [mutationError, setMutationError] = useState<string>()
  const [mutationPending, setMutationPending] = useState(false)
  const [installations, setInstallations] = useState<readonly MarketInstallationView[]>([])
  const [installableIndex, setInstallableIndex] = useState<MarketInstallableResponse>()
  const [installableQuery, setInstallableQuery] = useState('')
  const [appliedInstallableQuery, setAppliedInstallableQuery] = useState('')
  const [installableCategories, setInstallableCategories] = useState<readonly string[]>([])
  const [installableLimit, setInstallableLimit] = useState(INSTALLABLE_PAGE_SIZE)
  const [installableLoaded, setInstallableLoaded] = useState(false)
  const [installableLoading, setInstallableLoading] = useState(false)
  const [installableUnavailable, setInstallableUnavailable] = useState(false)
  const [installableError, setInstallableError] = useState<string>()
  const [installationsLoaded, setInstallationsLoaded] = useState(false)
  const [installationsLoading, setInstallationsLoading] = useState(false)
  const [installationsUnavailable, setInstallationsUnavailable] = useState(false)
  const [installationsError, setInstallationsError] = useState<string>()
  const [selectedInstallation, setSelectedInstallation] = useState<MarketInstallationView>()
  const [selectedInventoryLoading, setSelectedInventoryLoading] = useState(false)
  const [selectedInventoryError, setSelectedInventoryError] = useState<string>()
  const [operationPreview, setOperationPreview] = useState<MarketOperationPreviewResponse>()
  const [operationSuccess, setOperationSuccess] = useState<CompletedOperation>()
  const [operationError, setOperationError] = useState<string>()
  const [operationPending, setOperationPending] = useState(false)
  const [desktopActionError, setDesktopActionError] = useState<string>()
  const [desktopActionPending, setDesktopActionPending] = useState(false)
  const readRequest = useRef<AbortController>()
  const pageRequest = useRef<AbortController>()
  const mutationRequest = useRef<AbortController>()
  const installableRequest = useRef<AbortController>()
  const installationsRequest = useRef<AbortController>()
  const operationRequest = useRef<AbortController>()
  const operationStage = useRef<'preview' | 'execute'>()
  const operationBundleId = useRef<string>()
  const desktopActionRequest = useRef<AbortController>()
  const selectedKeyRef = useRef<string>()
  const viewRef = useRef<MarketView>(initialView)

  const rememberCategories = useCallback((next: MarketCatalogResponse) => {
    setCategoryOptions([...next.categories]
      .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' })))
  }, [])

  const loadCatalog = useCallback(async (
    nextState: MarketStateResponse,
    q: string,
    categories: readonly string[],
    forceRefresh = false,
  ) => {
    readRequest.current?.abort()
    pageRequest.current?.abort()
    pageRequest.current = undefined
    setLoadingMore(false)
    setLoadMoreError(undefined)
    const selected = selectedSource(nextState.sources)
    if (selected === undefined) {
      readRequest.current = undefined
      setCatalog(undefined)
      setQuery('')
      setAppliedQuery('')
      setCategoryOptions([])
      setSelectedCategories([])
      setError(undefined)
      setLoading(false)
      return
    }
    const effectiveQuery = q.trim()
    const request = new AbortController()
    readRequest.current = request
    setLoading(true)
    setError(undefined)
    let catalogApplied = false
    const applyCatalog = (next: MarketCatalogResponse): MarketCatalogResponse | undefined => {
      const retained = retainEnabledCatalog(next, nextState.sources)
      const result = retained?.results[0]
      if (retained === undefined || result?.snapshot === undefined) return undefined
      rememberCategories(retained)
      setAppliedQuery(effectiveQuery)
      setSelectedCategories([...categories])
      setCatalog(retained)
      catalogApplied = true
      return retained
    }
    try {
      const next = forceRefresh
        ? await readMarketCatalog(selected.sourceRecordId, effectiveQuery, readLocale(), categories, request.signal, true)
        : await readMarketCatalog(selected.sourceRecordId, effectiveQuery, readLocale(), categories, request.signal)
      if (!request.signal.aborted && readRequest.current === request) {
        const retained = applyCatalog(next)
        if (retained === undefined) {
          setError(catalogFailureMessage({ code: 'catalog-invalid-response' }, selected, t))
          return
        }
        if (!forceRefresh
          && effectiveQuery === ''
          && categories.length === 0
          && retained.results[0]?.stale === true) {
          const refreshed = await readMarketCatalog(
            selected.sourceRecordId,
            effectiveQuery,
            readLocale(),
            categories,
            request.signal,
            true,
          )
          if (!request.signal.aborted && readRequest.current === request) applyCatalog(refreshed)
        }
      }
    } catch (cause) {
      if (!request.signal.aborted && readRequest.current === request && !catalogApplied) {
        setError(catalogFailureMessage(cause, selected, t))
      }
    } finally {
      if (readRequest.current === request) {
        readRequest.current = undefined
        setLoading(false)
      }
    }
  }, [readLocale, rememberCategories, t])

  const loadState = useCallback(async (
    q: string,
    categories: readonly string[],
    forceRefresh = false,
    loadCatalogAfterState = true,
  ) => {
    if (mutationRequest.current !== undefined) return
    readRequest.current?.abort()
    pageRequest.current?.abort()
    pageRequest.current = undefined
    setLoadingMore(false)
    setLoadMoreError(undefined)
    const request = new AbortController()
    readRequest.current = request
    setLoading(true)
    setError(undefined)
    try {
      const next = await readMarketState(request.signal)
      if (request.signal.aborted || readRequest.current !== request) return
      setState(next)
      setCatalog(current => retainEnabledCatalog(current, next.sources))
      readRequest.current = undefined
      if (!loadCatalogAfterState) {
        if (viewRef.current === 'discover') {
          await loadCatalog(next, q, categories, forceRefresh)
        } else {
          setLoading(false)
        }
        return
      }
      await loadCatalog(next, q, categories, forceRefresh)
    } catch {
      if (!request.signal.aborted && readRequest.current === request) setError(t('catalogError'))
    } finally {
      if (readRequest.current === request) {
        readRequest.current = undefined
        setLoading(false)
      }
    }
  }, [loadCatalog, t])

  const loadInstallations = useCallback(async (): Promise<InstallationLoadOutcome | undefined> => {
    installationsRequest.current?.abort()
    const request = new AbortController()
    installationsRequest.current = request
    setInstallationsLoading(true)
    setInstallationsError(undefined)
    setInstallationsUnavailable(false)
    try {
      const response = await readMarketInstallations(request.signal)
      if (request.signal.aborted || installationsRequest.current !== request) return
      setInstallations(response.installations)
      setInstallationsLoaded(true)
      setInstallationsUnavailable(false)
      return { installations: response.installations }
    } catch (cause) {
      if (request.signal.aborted || installationsRequest.current !== request) return
      const message = isDesktopUnavailable(cause) ? t('desktopUnavailable') : t('installationsError')
      setInstallationsUnavailable(isDesktopUnavailable(cause))
      setInstallationsError(message)
      return { error: message }
    } finally {
      if (installationsRequest.current === request) {
        installationsRequest.current = undefined
        setInstallationsLoading(false)
      }
    }
  }, [t])

  const loadInstallable = useCallback(async (refresh = false) => {
    installableRequest.current?.abort()
    const request = new AbortController()
    installableRequest.current = request
    setInstallableIndex(undefined)
    setInstallableLoaded(false)
    setInstallableLoading(true)
    setInstallableError(undefined)
    setInstallableUnavailable(false)
    try {
      const response = await readMarketInstallable(readLocale(), refresh, request.signal)
      if (request.signal.aborted || installableRequest.current !== request) return
      setInstallableIndex(response)
      setInstallableLoaded(true)
      setInstallableUnavailable(false)
      setInstallableLimit(INSTALLABLE_PAGE_SIZE)
    } catch (cause) {
      if (request.signal.aborted || installableRequest.current !== request) return
      setInstallableIndex(undefined)
      setInstallableLoaded(false)
      setInstallableUnavailable(isDesktopUnavailable(cause))
      setInstallableError(isDesktopUnavailable(cause) ? t('desktopUnavailable') : t('installableError'))
    } finally {
      if (installableRequest.current === request) {
        installableRequest.current = undefined
        setInstallableLoading(false)
      }
    }
  }, [readLocale, t])

  useEffect(() => {
    setQuery('')
    if (viewRef.current === 'installable') {
      void loadState('', [], false, false)
      void loadInstallable()
    } else {
      void loadState('', [])
    }
    return () => {
      readRequest.current?.abort()
      pageRequest.current?.abort()
      mutationRequest.current?.abort()
      installableRequest.current?.abort()
      installationsRequest.current?.abort()
      operationRequest.current?.abort()
      desktopActionRequest.current?.abort()
      readRequest.current = undefined
      pageRequest.current = undefined
      mutationRequest.current = undefined
      installableRequest.current = undefined
      installationsRequest.current = undefined
      operationRequest.current = undefined
      desktopActionRequest.current = undefined
    }
  }, [loadInstallable, loadState])

  const items = useMemo(() => catalog?.results.flatMap(result =>
    (result.snapshot?.items ?? []).map(item => ({ item, source: result.source, stale: result.stale }))) ?? [], [catalog])
  const installableCategoryOptions = useMemo(
    () => categoriesFromItems(installableIndex?.items ?? []),
    [installableIndex],
  )
  const filteredInstallableItems = useMemo(() => (installableIndex?.items ?? [])
    .filter(item => matchesInstallableQuery(item, appliedInstallableQuery))
    .filter(item => installableCategories.length === 0
      || item.categories?.some(category => installableCategories.includes(category)) === true)
    .map(item => ({ item, source: installableIndex!.source, stale: false })), [
    appliedInstallableQuery,
    installableCategories,
    installableIndex,
  ])
  const installableItems = useMemo(
    () => filteredInstallableItems.slice(0, installableLimit),
    [filteredInstallableItems, installableLimit],
  )
  const pageTarget = useMemo(() => catalog?.results.flatMap(result => {
    const cursor = result.snapshot?.page?.nextCursor
    return cursor === undefined ? [] : [{ sourceRecordId: result.source.sourceRecordId, cursor }]
  }).at(0), [catalog])
  const partialFailure = catalog?.results.some(result => result.error !== undefined) ?? false
  const currentSource = state === undefined ? undefined : selectedSource(state.sources)
  const currentSourceHref = currentSource === undefined
    ? undefined
    : safeHttpsExternalHref(currentSource.homepage) ?? safeHttpsExternalHref(currentSource.attribution?.url)
  const selectedManualInstall = useMemo(() => {
    if (selected === undefined) return undefined
    const hints = view === 'installable'
      ? installableIndex?.manualInstall ?? []
      : catalog?.manualInstall ?? []
    return hints.find(hint => (
      hint.sourceRecordId === selected.source.sourceRecordId
      && hint.providerId === selected.source.providerId
      && hint.itemId === selected.item.id
    ))
  }, [catalog, installableIndex, selected, view])

  const mutate = async (mutation: MarketSourceMutation): Promise<boolean> => {
    if (mutationRequest.current !== undefined) return false
    readRequest.current?.abort()
    pageRequest.current?.abort()
    installableRequest.current?.abort()
    readRequest.current = undefined
    pageRequest.current = undefined
    installableRequest.current = undefined
    setLoading(false)
    setLoadingMore(false)
    setLoadMoreError(undefined)
    const request = new AbortController()
    mutationRequest.current = request
    setMutationPending(true)
    setMutationError(undefined)
    try {
      const sources = await mutateMarketSource(mutation, request.signal)
      if (request.signal.aborted || mutationRequest.current !== request) return false
      const next: MarketStateResponse = {
        sources,
        builtIns: state?.builtIns ?? [],
        desktopActions: state?.desktopActions ?? { openTerminal: false, requestRestart: false },
      }
      const sourceChanged = selectedSource(state?.sources ?? [])?.sourceRecordId
        !== selectedSource(sources)?.sourceRecordId
      setState(next)
      if (sourceChanged) {
        setCatalog(undefined)
        setInstallableIndex(undefined)
        setInstallableLoaded(false)
        setInstallableLoading(false)
        setInstallableUnavailable(false)
        setInstallableError(undefined)
        setInstallableQuery('')
        setAppliedInstallableQuery('')
        setInstallableCategories([])
        setInstallableLimit(INSTALLABLE_PAGE_SIZE)
        setQuery('')
        setAppliedQuery('')
        setCategoryOptions([])
        setSelectedCategories([])
        selectedKeyRef.current = undefined
        setSelected(undefined)
      } else {
        setCatalog(current => retainEnabledCatalog(current, sources))
      }
      mutationRequest.current = undefined
      setMutationPending(false)
      await loadCatalog(next, sourceChanged ? '' : appliedQuery, sourceChanged ? [] : selectedCategories)
      return true
    } catch {
      if (!request.signal.aborted && mutationRequest.current === request) setMutationError(t('sourceError'))
      return false
    } finally {
      if (mutationRequest.current === request) {
        mutationRequest.current = undefined
        setMutationPending(false)
      }
    }
  }

  const toggleCategory = (category: string) => {
    if (state === undefined) return
    const categories = selectedCategories.includes(category)
      ? selectedCategories.filter(value => value !== category)
      : [...selectedCategories, category]
    selectedKeyRef.current = undefined
    setSelected(undefined)
    void loadCatalog(state, appliedQuery, categories)
  }

  const loadMore = async () => {
    if (pageRequest.current !== undefined || pageTarget === undefined) return
    const request = new AbortController()
    pageRequest.current = request
    setLoadingMore(true)
    setLoadMoreError(undefined)
    try {
      const next = await readMoreMarketCatalog(
        pageTarget.sourceRecordId,
        pageTarget.cursor,
        appliedQuery,
        readLocale(),
        selectedCategories,
        request.signal,
      )
      if (request.signal.aborted || pageRequest.current !== request) return
      const page = next.results.find(value => value.source.sourceRecordId === pageTarget.sourceRecordId)
      if (page?.snapshot === undefined || page.error !== undefined) {
        setLoadMoreError(t('loadMoreError'))
        return
      }
      rememberCategories(next)
      setCatalog(current => mergeCatalogPages(current, [page], next.manualInstall))
    } catch {
      if (!request.signal.aborted && pageRequest.current === request) setLoadMoreError(t('loadMoreError'))
    } finally {
      if (pageRequest.current === request) {
        pageRequest.current = undefined
        setLoadingMore(false)
      }
    }
  }

  const selectMarketView = (next: MarketView) => {
    if (viewRef.current === next) return
    viewRef.current = next
    setView(next)
    selectedKeyRef.current = undefined
    setSelected(undefined)
    setOperationError(undefined)
    if (next === 'installable') {
      installationsRequest.current?.abort()
      installationsRequest.current = undefined
      setInstallationsLoading(false)
      void loadInstallable()
    } else if (next === 'installed') {
      installableRequest.current?.abort()
      installableRequest.current = undefined
      setInstallableLoading(false)
      void loadInstallations()
    } else if (next === 'discover') {
      installableRequest.current?.abort()
      installationsRequest.current?.abort()
      installableRequest.current = undefined
      installationsRequest.current = undefined
      setInstallableLoading(false)
      setInstallationsLoading(false)
      if (state !== undefined && catalog === undefined && readRequest.current === undefined) {
        void loadCatalog(state, appliedQuery, selectedCategories)
      }
    } else {
      installableRequest.current?.abort()
      installationsRequest.current?.abort()
      installableRequest.current = undefined
      installationsRequest.current = undefined
      setInstallableLoading(false)
      setInstallationsLoading(false)
    }
  }

  const beginOperationPreview = async (requestValue: MarketOperationPreviewRequest) => {
    if (operationRequest.current !== undefined) return
    const request = new AbortController()
    operationRequest.current = request
    operationStage.current = 'preview'
    operationBundleId.current = undefined
    setOperationPending(true)
    setOperationError(undefined)
    setDesktopActionError(undefined)
    setOperationSuccess(undefined)
    try {
      const preview = await previewMarketOperation(requestValue, request.signal)
      if (request.signal.aborted || operationRequest.current !== request) return
      if (preview.action !== requestValue.action) throw new Error('operation preview action mismatch')
      setInstallationsUnavailable(false)
      if (requestValue.action === 'disable' || requestValue.action === 'enable') {
        operationBundleId.current = requestValue.bundleId
      }
      setOperationPreview(preview)
    } catch (cause) {
      if (request.signal.aborted || operationRequest.current !== request) return
      if (isDesktopUnavailable(cause)) {
        setInstallationsUnavailable(true)
        setInstallationsError(t('desktopUnavailable'))
        setOperationError(t('desktopUnavailable'))
      } else {
        setOperationError(operationErrorMessage(cause, t(requestValue.action === 'install'
          ? 'previewError'
          : requestValue.action === 'uninstall'
            ? 'uninstallPreviewError'
            : requestValue.action === 'disable' ? 'disablePreviewError' : 'enablePreviewError')))
      }
    } finally {
      if (operationRequest.current === request) {
        operationRequest.current = undefined
        operationStage.current = undefined
        setOperationPending(false)
      }
    }
  }

  const openItem = (value: VisibleItem) => {
    if (operationStage.current === 'execute') return
    if (operationStage.current === 'preview') {
      operationRequest.current?.abort()
      operationRequest.current = undefined
      operationStage.current = undefined
      setOperationPending(false)
    }
    const selectionKey = visibleItemKey(value)
    selectedKeyRef.current = selectionKey
    setSelected(value)
    setSelectedInstallation(undefined)
    setSelectedInventoryLoading(false)
    setSelectedInventoryError(undefined)
    setOperationPreview(undefined)
    setOperationSuccess(undefined)
    setOperationError(undefined)
    setDesktopActionError(undefined)
    const beginInstallPreview = () => {
      if (selectedKeyRef.current !== selectionKey) return
      void beginOperationPreview({
        action: 'install',
        sourceRecordId: value.source.sourceRecordId,
        itemId: value.item.id,
      })
    }
    const packageName = value.item.package?.name
    if (packageName === undefined) {
      beginInstallPreview()
      return
    }
    const resolveInventory = (current: readonly MarketInstallationView[]) => {
      if (selectedKeyRef.current !== selectionKey) return
      const installation = matchingInstallation(value, current)
      setSelectedInventoryLoading(false)
      if (installation !== undefined) setSelectedInstallation(installation)
      else beginInstallPreview()
    }
    if (installationsLoaded) {
      resolveInventory(installations)
      return
    }
    setSelectedInventoryLoading(true)
    void loadInstallations().then(outcome => {
      if (selectedKeyRef.current !== selectionKey || outcome === undefined) return
      if ('error' in outcome) {
        setSelectedInventoryLoading(false)
        setSelectedInventoryError(outcome.error)
        return
      }
      resolveInventory(outcome.installations)
    })
  }

  const closeItem = () => {
    if (operationPending && operationPreview !== undefined) return
    operationRequest.current?.abort()
    operationRequest.current = undefined
    operationStage.current = undefined
    desktopActionRequest.current?.abort()
    desktopActionRequest.current = undefined
    setOperationPending(false)
    setDesktopActionPending(false)
    operationBundleId.current = undefined
    selectedKeyRef.current = undefined
    setSelected(undefined)
    setSelectedInstallation(undefined)
    setSelectedInventoryLoading(false)
    setSelectedInventoryError(undefined)
    setOperationPreview(undefined)
    setOperationError(undefined)
    setDesktopActionError(undefined)
  }

  const executePreview = async () => {
    const preview = operationPreview
    if (preview === undefined || operationRequest.current !== undefined) return
    const targetBundleId = operationBundleId.current
    const request = new AbortController()
    operationRequest.current = request
    operationStage.current = 'execute'
    setOperationPending(true)
    setOperationError(undefined)
    setDesktopActionError(undefined)
    try {
      const result = await executeMarketOperation(preview.previewId, request.signal)
      if (request.signal.aborted || operationRequest.current !== request) return
      if (result.action !== preview.action) throw new Error('operation response action mismatch')
      setInstallations(current => {
        if (result.action === 'install') return current
        if (result.action === 'uninstall') {
          return current.filter(installation => installation.kind !== 'managed'
            || installation.receipt.receiptId !== result.receiptId)
        }
        if (result.action === 'disable') {
          return current.map(installation => {
            if (installation.kind === 'external'
              && installation.action === 'disable'
              && installation.bundleId === targetBundleId
              && installation.packageName === result.packageName) {
              return {
                kind: 'external' as const,
                status: 'disabled' as const,
                action: 'enable' as const,
                bundleId: installation.bundleId,
                packageName: installation.packageName,
              }
            }
            if (targetBundleId !== undefined
              && installation.kind === 'managed'
              && installation.status === 'active'
              && installation.disableBundleId === targetBundleId
              && installation.receipt.packageName === result.packageName) {
              return {
                kind: 'managed' as const,
                status: 'disabled' as const,
                action: 'uninstall' as const,
                enableBundleId: targetBundleId,
                receipt: installation.receipt,
              }
            }
            return installation
          })
        }
        return current.map(installation => {
          if (installation.kind === 'external'
            && installation.action === 'enable'
            && installation.bundleId === targetBundleId
            && installation.packageName === result.packageName) {
            return {
              kind: 'external' as const,
              status: 'active' as const,
              action: 'disable' as const,
              bundleId: installation.bundleId,
              packageName: installation.packageName,
            }
          }
          if (targetBundleId !== undefined
            && installation.kind === 'managed'
            && installation.status === 'disabled'
            && installation.enableBundleId === targetBundleId
            && installation.receipt.packageName === result.packageName) {
            return {
              kind: 'managed' as const,
              status: 'active' as const,
              action: 'uninstall' as const,
              disableBundleId: targetBundleId,
              receipt: installation.receipt,
            }
          }
          return installation
        })
      })
      setInstallationsLoaded(true)
      operationBundleId.current = undefined
      setOperationPreview(undefined)
      selectedKeyRef.current = undefined
      setSelected(undefined)
      setOperationSuccess({ preview, restartToken: result.restartToken })
      if (result.action === 'install' && viewRef.current === 'installable') void loadInstallable()
      if ((result.action === 'uninstall' || result.action === 'disable' || result.action === 'enable')
        && viewRef.current === 'installed') {
        void loadInstallations()
      }
    } catch (cause) {
      if (request.signal.aborted || operationRequest.current !== request) return
      if (isDesktopUnavailable(cause)) {
        setInstallationsUnavailable(true)
        setInstallationsError(t('desktopUnavailable'))
        setOperationError(t('desktopUnavailable'))
      } else {
        setOperationError(operationErrorMessage(cause, t('executeError')))
      }
    } finally {
      if (operationRequest.current === request) {
        operationRequest.current = undefined
        operationStage.current = undefined
        setOperationPending(false)
      }
    }
  }

  const runDesktopAction = async (action: 'open-terminal' | 'request-restart', restartToken?: string) => {
    if (desktopActionRequest.current !== undefined) return
    const request = new AbortController()
    desktopActionRequest.current = request
    setDesktopActionPending(true)
    setDesktopActionError(undefined)
    try {
      if (action === 'open-terminal') await openMarketTerminal(request.signal)
      else if (restartToken !== undefined) await requestMarketRestart(restartToken, request.signal)
      else throw new Error('restart token missing')
    } catch (cause) {
      if (request.signal.aborted || desktopActionRequest.current !== request) return
      setDesktopActionError(t(isDesktopUnavailable(cause)
        ? 'desktopActionUnavailable'
        : action === 'open-terminal' ? 'terminalError' : 'restartError'))
    } finally {
      if (desktopActionRequest.current === request) {
        desktopActionRequest.current = undefined
        setDesktopActionPending(false)
      }
    }
  }

  return (
    <section
      className="dshMarketRoot"
      aria-label={t('title')}
      aria-busy={loading || loadingMore || mutationPending || installationsLoading || operationPending || desktopActionPending}
    >
      {showHeader && (
        <header className="dshMarketHeader">
          <div className="dshMarketHeaderTitle">
            <h2>{t('title')}</h2>
            <p>{t('subtitle')}</p>
          </div>
        </header>
      )}
      <div className="dshMarketViewBar">
        <div className="dshMarketViewSwitch" role="group" aria-label={t('title')}>
          <Pill active={view === 'discover'} aria-pressed={view === 'discover'} onClick={() => selectMarketView('discover')}>
            <IconDataOutline16 size={14} /><span>{t('discover')}</span>
          </Pill>
          <Pill active={view === 'installable'} aria-pressed={view === 'installable'} onClick={() => selectMarketView('installable')}>
            <IconDownloadOutline16 size={14} /><span>{t('installable')}</span>
          </Pill>
          <Pill active={view === 'installed'} aria-pressed={view === 'installed'} onClick={() => selectMarketView('installed')}>
            <IconCheckOutline16 size={14} /><span>{t('installed')}</span>
          </Pill>
          <Pill active={view === 'sources'} aria-pressed={view === 'sources'} onClick={() => selectMarketView('sources')}>
            <IconSettingsOutline16 size={14} /><span>{t('sources')}</span>
          </Pill>
        </div>
        <Pill className="dshMarketCurrentSource">
          {currentSource === undefined
            ? t('noSourceSelected')
            : currentSourceHref === undefined
              ? `${t('currentSource')}: ${currentSource.name}`
              : (
                <a href={currentSourceHref} target="_blank" rel="noopener noreferrer">
                  {t('currentSource')}: {currentSource.name} <IconRightUpOutline16 size={12} />
                </a>
              )}
        </Pill>
      </div>
      <main className="dshMarketMain">
        {view === 'discover' ? (
          <DiscoverView
            state={state}
            items={items}
            metadata={catalog?.metadata}
            query={query}
            categoryOptions={categoryOptions}
            selectedCategories={selectedCategories}
            loading={loading}
            loadingMore={loadingMore}
            mutationPending={mutationPending}
            error={error}
            loadMoreError={loadMoreError}
            partialFailure={partialFailure}
            onQuery={setQuery}
            onSearch={() => state !== undefined && void loadCatalog(state, query, selectedCategories)}
            onRefresh={() => void loadState(appliedQuery, selectedCategories, true)}
            onToggleCategory={toggleCategory}
            onLoadMore={() => { void loadMore() }}
            hasMore={pageTarget !== undefined}
            onSources={() => selectMarketView('sources')}
            onSelect={openItem}
            t={t}
          />
        ) : view === 'installable' ? (
          <InstallableView
            state={state}
            items={installableItems}
            totalItems={filteredInstallableItems.length}
            query={installableQuery}
            categoryOptions={installableCategoryOptions}
            selectedCategories={installableCategories}
            metadata={installableIndex?.metadata}
            loaded={installableLoaded}
            loading={installableLoading}
            unavailable={installableUnavailable}
            error={installableError}
            operationPending={operationPending}
            onQuery={setInstallableQuery}
            onSearch={() => {
              setAppliedInstallableQuery(installableQuery.trim())
              setInstallableLimit(INSTALLABLE_PAGE_SIZE)
            }}
            onRefresh={() => { void loadInstallable(true) }}
            onToggleCategory={category => {
              setInstallableCategories(current => current.includes(category)
                ? current.filter(value => value !== category)
                : [...current, category])
              setInstallableLimit(INSTALLABLE_PAGE_SIZE)
            }}
            onLoadMore={() => setInstallableLimit(current => current + INSTALLABLE_PAGE_SIZE)}
            onRetry={() => { void loadInstallable() }}
            onSources={() => selectMarketView('sources')}
            onInstall={openItem}
            t={t}
          />
        ) : view === 'installed' ? (
          <InstalledView
            installations={installations}
            loaded={installationsLoaded}
            loading={installationsLoading}
            unavailable={installationsUnavailable}
            error={installationsError ?? operationError}
            operationPending={operationPending}
            onRetry={() => { void loadInstallations() }}
            onUninstall={receipt => {
              void beginOperationPreview({ action: 'uninstall', receiptId: receipt.receiptId })
            }}
            onDisable={bundleId => {
              void beginOperationPreview({ action: 'disable', bundleId })
            }}
            onEnable={bundleId => {
              void beginOperationPreview({ action: 'enable', bundleId })
            }}
            t={t}
          />
        ) : (
          <SourcesView
            state={state}
            catalog={catalog}
            error={mutationError}
            pending={mutationPending}
            adapterGuideHref={catalogAdapterGuideUrl(readLocale())}
            onMutation={mutation => { void mutate(mutation) }}
            onAddStandard={() => setAddOpen(true)}
            t={t}
          />
        )}
      </main>
      {selected !== undefined && (
        <ItemActionModal
          value={selected}
          installation={selectedInstallation}
          inventoryLoading={selectedInventoryLoading}
          inventoryError={selectedInventoryError}
          manualInstall={selectedManualInstall}
          preview={operationPreview?.action === 'install' ? operationPreview : undefined}
          pending={operationPending}
          operationError={operationError}
          desktopActionError={desktopActionError}
          desktopActionPending={desktopActionPending}
          canOpenTerminal={state?.desktopActions.openTerminal === true}
          verificationHelpHref={installRequirementsUrl(readLocale())}
          onClose={closeItem}
          onConfirm={() => { void executePreview() }}
          onOpenTerminal={() => { void runDesktopAction('open-terminal') }}
          onUninstall={receipt => {
            selectedKeyRef.current = undefined
            setSelected(undefined)
            setSelectedInstallation(undefined)
            void beginOperationPreview({ action: 'uninstall', receiptId: receipt.receiptId })
          }}
          onDisable={bundleId => {
            selectedKeyRef.current = undefined
            setSelected(undefined)
            setSelectedInstallation(undefined)
            void beginOperationPreview({ action: 'disable', bundleId })
          }}
          onEnable={bundleId => {
            selectedKeyRef.current = undefined
            setSelected(undefined)
            setSelectedInstallation(undefined)
            void beginOperationPreview({ action: 'enable', bundleId })
          }}
          t={t}
        />
      )}
      {selected === undefined && operationPreview !== undefined && (
        <OperationConfirmModal
          preview={operationPreview}
          pending={operationPending}
          error={operationError}
          onCancel={() => {
            if (operationPending) return
            operationBundleId.current = undefined
            setOperationPreview(undefined)
            setOperationError(undefined)
          }}
          onConfirm={() => { void executePreview() }}
          t={t}
        />
      )}
      {operationSuccess !== undefined && (
        <OperationSuccessModal
          operation={operationSuccess}
          canRestart={state?.desktopActions.requestRestart === true}
          pending={desktopActionPending}
          error={desktopActionError}
          onClose={() => setOperationSuccess(undefined)}
          onRestart={() => { void runDesktopAction('request-restart', operationSuccess.restartToken) }}
          t={t}
        />
      )}
      <Modal
        open={addOpen}
        className="dshMarketModal dshMarketSourceModal"
        contentClassName="dshMarketModalContent"
        onClose={() => { if (!mutationPending) setAddOpen(false) }}
        title={t('addStandard')}
        closeLabel={t('cancel')}
        description={t('sourceNotice')}
        footer={<div className="dshMarketModalActions">
          <Button variant="ghost" disabled={mutationPending} onClick={() => setAddOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="primary"
            icon={<IconPlusOutline16 />}
            disabled={mutationPending || !manifestUrl.trim()}
            onClick={() => {
              void mutate({ action: 'add-standard', manifestUrl: manifestUrl.trim() }).then(succeeded => {
                if (!succeeded) return
                setManifestUrl('')
                setAddOpen(false)
              })
            }}
          >{t('confirmAdd')}</Button>
        </div>}
      >
        <div className="dshMarketModalField">
          <label htmlFor="dsh-market-manifest">{t('standardSource')}</label>
          <Input
            id="dsh-market-manifest"
            value={manifestUrl}
            disabled={mutationPending}
            placeholder={t('manifestPlaceholder')}
            onChange={event => setManifestUrl(event.currentTarget.value)}
          />
          {mutationError !== undefined && <div className="dshMarketError" role="alert">{mutationError}</div>}
        </div>
      </Modal>
    </section>
  )
}

export function MarketSettingsTab({ initialView, readLocale, t }: MarketSettingsTabProps) {
  return <MarketSurface
    {...(initialView === undefined ? {} : { initialView })}
    readLocale={readLocale}
    t={t}
  />
}

function DiscoverView(props: {
  state?: MarketStateResponse | undefined
  items: readonly VisibleItem[]
  metadata: MarketCatalogResponse['metadata']
  query: string
  categoryOptions: readonly string[]
  selectedCategories: readonly string[]
  loading: boolean
  loadingMore: boolean
  mutationPending: boolean
  error?: string | undefined
  loadMoreError?: string | undefined
  partialFailure: boolean
  hasMore: boolean
  onQuery: (value: string) => void
  onSearch: () => void
  onRefresh: () => void
  onToggleCategory: (category: string) => void
  onLoadMore: () => void
  onSources: () => void
  onSelect: (value: VisibleItem) => void
  t: MarketSettingsTabProps['t']
}) {
  const noSources = props.state !== undefined && !props.state.sources.some(source => source.enabled)
  if (noSources) return (
    <div className="dshMarketEmpty">
      <div className="dshMarketEmptyIcon"><IconGlobeOutline14 size={24} /></div>
      <h2>{props.t('emptyTitle')}</h2>
      <p>{props.t('emptyBody')}</p>
      <Button variant="primary" icon={<IconSettingsOutline16 />} onClick={props.onSources}>{props.t('chooseSources')}</Button>
    </div>
  )
  return (
    <div className="dshMarketContent">
      {props.metadata !== undefined && (
        <div className="dshMarketIndexMeta" role="status">
          <span>{props.t('scannedAt')}: {props.metadata.scannedAt}</span>
          <span>{props.t('cacheExpiresAt')}: {props.metadata.expiresAt}</span>
          {props.metadata.providerRevision !== undefined && (
            <span>{props.t('providerRevision')}: {props.metadata.providerRevision}</span>
          )}
          <span>{props.metadata.cacheStatus === 'fresh' ? props.t('freshScan') : props.t('cachedScan')}</span>
        </div>
      )}
      <form className="dshMarketToolbar" onSubmit={event => { event.preventDefault(); props.onSearch() }}>
        <Input
          className="dshMarketSearch"
          icon={<IconSearchOutline16 />}
          value={props.query}
          disabled={props.mutationPending}
          placeholder={props.t('search')}
          onChange={event => props.onQuery(event.currentTarget.value)}
        />
        <Button type="submit" variant="primary" disabled={props.mutationPending} icon={<IconSearchOutline16 />}>{props.t('searchAction')}</Button>
        <Tooltip label={props.t('refresh')}>
          <Button
            type="button"
            size="sm"
            variant="toolbar"
            aria-label={props.t('refresh')}
            disabled={props.loading || props.loadingMore || props.mutationPending}
            icon={<IconRefreshOutline16 />}
            onClick={props.onRefresh}
          />
        </Tooltip>
        <Pill>{props.items.length}</Pill>
      </form>
      {props.categoryOptions.length > 0 && (
        <div className="dshMarketCategories" role="group" aria-label={props.t('categories')}>
          <span>{props.t('categories')}</span>
          {props.categoryOptions.map(category => (
            <Pill
              key={category}
              active={props.selectedCategories.includes(category)}
              aria-pressed={props.selectedCategories.includes(category)}
              disabled={props.mutationPending}
              onClick={() => props.onToggleCategory(category)}
            >{category}</Pill>
          ))}
        </div>
      )}
      {props.partialFailure && <div className="dshMarketBanner" role="status"><StateDot state="warning" />{props.t('partialFailure')}</div>}
      {props.error !== undefined && (
        <div className="dshMarketEmpty" role="alert">
          <StateDot state="error" size={14} />
          <h2>{props.t('catalogError')}</h2><p>{props.error}</p>
          <Button variant="outline" icon={<IconRefreshOutline16 />} onClick={props.onRefresh}>{props.t('retry')}</Button>
        </div>
      )}
      {props.error === undefined && props.loading && props.items.length === 0 && (
        <div className="dshMarketEmpty"><StateDot state="ongoing" size={16} /><p>{props.t('loading')}</p></div>
      )}
      {props.error === undefined && !props.loading && props.items.length === 0 && (
        <div className="dshMarketEmpty"><h2>{props.t('noResults')}</h2></div>
      )}
      <div className="dshMarketGrid">
        {props.items.map(value => <PluginCard key={`${value.source.sourceRecordId}:${value.item.id}`} value={value} onClick={() => props.onSelect(value)} t={props.t} />)}
      </div>
      {(props.hasMore || props.loadMoreError !== undefined) && (
        <div className="dshMarketPagination">
          {props.loadMoreError !== undefined && <div className="dshMarketPaginationError" role="status">{props.loadMoreError}</div>}
          {props.hasMore && (
            <Button
              type="button"
              variant="outline"
              disabled={props.loading || props.loadingMore || props.mutationPending}
              onClick={props.onLoadMore}
            >{props.loadingMore ? props.t('loadingMore') : props.t('loadMore')}</Button>
          )}
        </div>
      )}
    </div>
  )
}

function InstallableView(props: {
  state?: MarketStateResponse | undefined
  items: readonly VisibleItem[]
  totalItems: number
  query: string
  categoryOptions: readonly string[]
  selectedCategories: readonly string[]
  metadata: MarketInstallableResponse['metadata'] | undefined
  loaded: boolean
  loading: boolean
  unavailable: boolean
  error?: string | undefined
  operationPending: boolean
  onQuery: (value: string) => void
  onSearch: () => void
  onRefresh: () => void
  onToggleCategory: (category: string) => void
  onLoadMore: () => void
  onRetry: () => void
  onSources: () => void
  onInstall: (value: VisibleItem) => void
  t: MarketSettingsTabProps['t']
}) {
  const noSources = props.state !== undefined && !props.state.sources.some(source => source.enabled)
  if (noSources) return (
    <div className="dshMarketEmpty">
      <div className="dshMarketEmptyIcon"><IconGlobeOutline14 size={24} /></div>
      <h2>{props.t('emptyTitle')}</h2>
      <p>{props.t('emptyBody')}</p>
      <Button variant="primary" icon={<IconSettingsOutline16 />} onClick={props.onSources}>{props.t('chooseSources')}</Button>
    </div>
  )
  if (props.unavailable) return (
    <div className="dshMarketEmpty" role="status">
      <StateDot state="warning" size={16} />
      <h2>{props.t('desktopRequiredTitle')}</h2>
      <p>{props.t('desktopUnavailable')}</p>
    </div>
  )
  if (props.loading) return (
    <div className="dshMarketEmpty"><StateDot state="ongoing" size={16} /><p>{props.t('scanningInstallable')}</p></div>
  )
  if (!props.loaded && props.error !== undefined) return (
    <div className="dshMarketEmpty" role="alert">
      <StateDot state="error" size={14} />
      <h2>{props.t('installableError')}</h2>
      <Button variant="outline" icon={<IconRefreshOutline16 />} onClick={props.onRetry}>{props.t('retry')}</Button>
    </div>
  )
  if (!props.loaded) return (
    <div className="dshMarketEmpty"><StateDot state="ongoing" size={16} /><p>{props.t('scanningInstallable')}</p></div>
  )
  return (
    <div className="dshMarketContent">
      <div className="dshMarketSectionHead">
        <div><h2>{props.t('installable')}</h2><p>{props.t('installableBody')}</p></div>
        <Button
          variant="outline"
          size="sm"
          disabled={props.loading || props.operationPending}
          icon={<IconRefreshOutline16 />}
          onClick={props.onRefresh}
        >{props.t('rescanInstallable')}</Button>
      </div>
      {props.metadata !== undefined && (
        <div className="dshMarketIndexMeta" role="status">
          <span>{props.t('scannedAt')}: {props.metadata.scannedAt}</span>
          {props.metadata.providerRevision !== undefined && (
            <span>{props.t('providerRevision')}: {props.metadata.providerRevision}</span>
          )}
          <span>{props.metadata.cacheStatus === 'fresh' ? props.t('freshScan') : props.t('cachedScan')}</span>
        </div>
      )}
      <form className="dshMarketToolbar" onSubmit={event => { event.preventDefault(); props.onSearch() }}>
        <Input
          className="dshMarketSearch"
          icon={<IconSearchOutline16 />}
          value={props.query}
          disabled={props.operationPending}
          placeholder={props.t('search')}
          onChange={event => props.onQuery(event.currentTarget.value)}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={props.operationPending}
          icon={<IconSearchOutline16 />}
        >{props.t('searchAction')}</Button>
        <Pill>{props.totalItems}</Pill>
      </form>
      {props.categoryOptions.length > 0 && (
        <div className="dshMarketCategories" role="group" aria-label={props.t('categories')}>
          <span>{props.t('categories')}</span>
          {props.categoryOptions.map(category => (
            <Pill
              key={category}
              active={props.selectedCategories.includes(category)}
              aria-pressed={props.selectedCategories.includes(category)}
              disabled={props.operationPending}
              onClick={() => props.onToggleCategory(category)}
            >{category}</Pill>
          ))}
        </div>
      )}
      {props.error !== undefined && (
        <div className="dshMarketBanner" role="alert">
          <StateDot state="error" />
          <span>{props.error}</span>
        </div>
      )}
      {props.items.length === 0 && (
        <div className="dshMarketEmpty"><h2>{props.t('noInstallable')}</h2><p>{props.t('noInstallableBody')}</p></div>
      )}
      <div className="dshMarketGrid">
        {props.items.map(value => (
          <PluginCard
            key={`${value.source.sourceRecordId}:${value.item.id}`}
            value={value}
            actionLabel={props.t('install')}
            disabled={props.operationPending}
            onClick={() => props.onInstall(value)}
            t={props.t}
          />
        ))}
      </div>
      {props.items.length < props.totalItems && (
        <div className="dshMarketPagination">
          <Button
            type="button"
            variant="outline"
            disabled={props.operationPending}
            onClick={props.onLoadMore}
          >{props.t('loadMore')}</Button>
        </div>
      )}
    </div>
  )
}

function InstalledView(props: {
  installations: readonly MarketInstallationView[]
  loaded: boolean
  loading: boolean
  unavailable: boolean
  error?: string | undefined
  operationPending: boolean
  onRetry: () => void
  onUninstall: (receipt: Extract<MarketInstallationView, { kind: 'managed' }>['receipt']) => void
  onDisable: (bundleId: string) => void
  onEnable: (bundleId: string) => void
  t: MarketSettingsTabProps['t']
}) {
  if (props.unavailable) return (
    <div className="dshMarketEmpty" role="status">
      <StateDot state="warning" size={16} />
      <h2>{props.t('desktopRequiredTitle')}</h2>
      <p>{props.t('desktopUnavailable')}</p>
    </div>
  )
  if (!props.loaded && props.loading) return (
    <div className="dshMarketEmpty"><StateDot state="ongoing" size={16} /><p>{props.t('loadingInstallations')}</p></div>
  )
  if (!props.loaded && props.error !== undefined) return (
    <div className="dshMarketEmpty" role="alert">
      <StateDot state="error" size={14} />
      <h2>{props.t('installationsError')}</h2>
      <Button variant="outline" icon={<IconRefreshOutline16 />} onClick={props.onRetry}>{props.t('retry')}</Button>
    </div>
  )
  return (
    <div className="dshMarketContent">
      <div className="dshMarketSectionHead">
        <div><h2>{props.t('installed')}</h2><p>{props.t('installedBody')}</p></div>
        <Button
          variant="outline"
          size="sm"
          disabled={props.loading || props.operationPending}
          icon={<IconRefreshOutline16 />}
          onClick={props.onRetry}
        >{props.t('refresh')}</Button>
      </div>
      {props.error !== undefined && <div className="dshMarketBanner" role="alert"><StateDot state="error" />{props.error}</div>}
      {props.installations.length === 0 ? (
        <div className="dshMarketEmpty"><h2>{props.t('noInstalled')}</h2><p>{props.t('noInstalledBody')}</p></div>
      ) : (
        <div className="dshMarketReceipts">
          {props.installations.map((installation, index) => (
            <InstallationCard
              key={installation.kind === 'managed'
                ? installation.receipt.receiptId
                : `${installation.kind}:${installation.packageName}:${index}`}
              installation={installation}
              operationPending={props.operationPending}
              onUninstall={props.onUninstall}
              onDisable={props.onDisable}
              onEnable={props.onEnable}
              t={props.t}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function InstallationCard(props: {
  installation: MarketInstallationView
  operationPending: boolean
  onUninstall: (receipt: Extract<MarketInstallationView, { kind: 'managed' }>['receipt']) => void
  onDisable: (bundleId: string) => void
  onEnable: (bundleId: string) => void
  t: MarketSettingsTabProps['t']
}) {
  const { installation } = props
  const receipt = installation.kind === 'managed' ? installation.receipt : undefined
  const packageName = installation.kind === 'managed'
    ? installation.receipt.packageName
    : installation.packageName
  const displayName = receipt?.displayName ?? packageName
  const ownerLabel = installation.kind === 'managed'
    ? props.t('managedPlugin')
    : installation.kind === 'external' ? props.t('externalPlugin') : props.t('immutablePlugin')
  return (
    <article className="dshMarketReceipt">
      <div className="dshMarketReceiptMain">
        <div className="dshMarketReceiptTitle">
          <StateDot state={installation.status === 'disabled' ? 'warning' : 'done'} size={10} />
          <h3>{displayName}</h3>
          <Pill>{ownerLabel}</Pill>
          <Pill>{props.t(installation.status === 'disabled' ? 'disabledPlugin' : 'activePlugin')}</Pill>
        </div>
        <div className="dshMarketReceiptMeta">
          <span>{packageName}{receipt === undefined ? '' : `@${receipt.version}`}</span>
          {receipt !== undefined && <span>{props.t('profile')}: {receipt.profileName}</span>}
          {receipt !== undefined && <span>{props.t('installedAt')}: {receipt.installedAt}</span>}
          {installation.status === 'disabled' && <span>{props.t('disabledRestartRequired')}</span>}
        </div>
      </div>
      <div className="dshMarketReceiptActions">
        {installation.kind === 'managed'
          && installation.status === 'active'
          && installation.disableBundleId !== undefined && <Button
          variant="outline"
          size="sm"
          aria-label={`${props.t('disable')}: ${displayName}`}
          disabled={props.operationPending}
          icon={<IconPauseOutline16 />}
          onClick={() => props.onDisable(installation.disableBundleId!)}
        >{props.t('disable')}</Button>}
        {installation.kind === 'managed'
          && installation.status === 'disabled'
          && installation.enableBundleId !== undefined && <Button
          variant="outline"
          size="sm"
          aria-label={`${props.t('enable')}: ${displayName}`}
          disabled={props.operationPending}
          icon={<IconPlayOutline16 />}
          onClick={() => props.onEnable(installation.enableBundleId!)}
        >{props.t('enable')}</Button>}
        {installation.action === 'uninstall' && <Button
          variant="outline"
          size="sm"
          aria-label={`${props.t('uninstall')}: ${displayName}`}
          disabled={props.operationPending}
          icon={<IconTrashOutline16 />}
          onClick={() => props.onUninstall(installation.receipt)}
        >{props.t('uninstall')}</Button>}
        {installation.action === 'disable' && <Button
          variant="outline"
          size="sm"
          aria-label={`${props.t('disable')}: ${displayName}`}
          disabled={props.operationPending}
          icon={<IconPauseOutline16 />}
          onClick={() => props.onDisable(installation.bundleId)}
        >{props.t('disable')}</Button>}
        {installation.action === 'enable' && <Button
          variant="outline"
          size="sm"
          aria-label={`${props.t('enable')}: ${displayName}`}
          disabled={props.operationPending}
          icon={<IconPlayOutline16 />}
          onClick={() => props.onEnable(installation.bundleId)}
        >{props.t('enable')}</Button>}
      </div>
    </article>
  )
}

function sourceDisplayLabel(source: MarketSourceView): string {
  const attribution = source.attribution?.name
  return attribution === undefined || attribution === source.name
    ? source.name
    : `${source.name} · ${attribution}`
}

function safeHttpsExternalHref(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
      return undefined
    }
    return url.href
  } catch {
    return undefined
  }
}

function PluginCard({ value, actionLabel, disabled = false, onClick, t }: {
  value: VisibleItem
  actionLabel?: string | undefined
  disabled?: boolean
  onClick: () => void
  t: MarketSettingsTabProps['t']
}) {
  const publisher = value.item.publisher?.name ?? value.source.name
  const sourceLabel = sourceDisplayLabel(value.source)
  return (
    <button
      type="button"
      className="dshMarketCard"
      aria-haspopup="dialog"
      aria-label={actionLabel === undefined ? undefined : `${actionLabel}: ${value.item.displayName}`}
      disabled={disabled}
      onClick={onClick}
    >
      <div className="dshMarketCardTop">
        <PluginIcon item={value.item} />
        <div className="dshMarketCardName"><strong>{value.item.displayName}</strong><span>{publisher}</span></div>
      </div>
      <p className="dshMarketSummary">{value.item.summary}</p>
      <div className="dshMarketTags">
        <Pill>{t('source')}: {sourceLabel}</Pill>
        {actionLabel !== undefined && <Pill>{actionLabel}</Pill>}
        {value.stale && <Pill>{t('stale')}</Pill>}
        {value.item.categories?.slice(0, 2).map(category => <Pill key={category}>{category}</Pill>)}
      </div>
    </button>
  )
}

function SourceAttribution({ attribution }: {
  attribution: NonNullable<MarketSourceView['attribution']>
}) {
  const href = safeHttpsExternalHref(attribution.url)
  return (
    <div className="dshMarketSourceAttribution">
      {href === undefined
        ? <span>{attribution.name}</span>
        : <a href={href} target="_blank" rel="noopener noreferrer">{attribution.name}</a>}
      {attribution.notice !== undefined && <span>{attribution.notice}</span>}
    </div>
  )
}

function ItemSourceRow({ source, t }: {
  source: MarketSourceView
  t: MarketSettingsTabProps['t']
}) {
  const label = sourceDisplayLabel(source)
  const href = safeHttpsExternalHref(source.homepage)
    ?? safeHttpsExternalHref(source.attribution?.url)
  return (
    <div className="dshMarketItemSourceRow">
      <span>{t('source')}:</span>
      {href === undefined
        ? <span>{label}</span>
        : (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${t('source')}: ${label}`}
          >
            {label} <IconRightUpOutline16 size={12} />
          </a>
        )}
    </div>
  )
}

function SourcesView({ state, catalog, error, pending, adapterGuideHref, onMutation, onAddStandard, t }: {
  state?: MarketStateResponse | undefined
  catalog?: MarketCatalogResponse | undefined
  error?: string | undefined
  pending: boolean
  adapterGuideHref: string
  onMutation: (mutation: MarketSourceMutation) => void
  onAddStandard: () => void
  t: MarketSettingsTabProps['t']
}) {
  const selectedKeys = new Set(state?.sources.map(source => source.builtInProviderKey).filter(Boolean))
  const available = state?.builtIns.filter(provider => !selectedKeys.has(provider.key)) ?? []
  return (
    <div className="dshMarketContent">
      <div className="dshMarketSectionHead">
        <div><h2>{t('sources')}</h2><p>{t('sourceNotice')}</p></div>
        <Button variant="outline" disabled={pending} icon={<IconPlusOutline16 />} onClick={onAddStandard}>{t('addStandard')}</Button>
      </div>
      <div className="dshMarketBanner dshMarketSourceGuide">
        <IconGlobeOutline14 size={14} />
        <span>
          {t('sourcePartnershipBefore')}
          <a href={DSH_DESKTOP_ISSUES_URL} target="_blank" rel="noopener noreferrer">{t('sourcePartnershipContact')}</a>
          {t('sourcePartnershipAfter')}{' '}
          <a href={adapterGuideHref} target="_blank" rel="noopener noreferrer">{t('sourcePartnershipGuide')}</a>
        </span>
      </div>
      {error !== undefined && <div className="dshMarketBanner" role="alert"><StateDot state="error" />{error}</div>}
      <div className="dshMarketSources" role="radiogroup" aria-label={t('sourceSelection')}>
        {state?.sources.map((source, index, sources) => (
          <SourceRow
            key={source.sourceRecordId}
            source={source}
            result={catalog?.results.find(result => result.source.sourceRecordId === source.sourceRecordId)}
            pending={pending}
            canMoveUp={index > 0}
            canMoveDown={index < sources.length - 1}
            onMoveUp={() => onMutation({ action: 'move', sourceRecordId: source.sourceRecordId, direction: 'up' })}
            onMoveDown={() => onMutation({ action: 'move', sourceRecordId: source.sourceRecordId, direction: 'down' })}
            onSelect={() => {
              if (!source.enabled) onMutation({ action: 'select', sourceRecordId: source.sourceRecordId })
            }}
            onRemove={() => onMutation({ action: 'remove', sourceRecordId: source.sourceRecordId })}
            t={t}
          />
        ))}
      </div>
      {available.length > 0 && <div className="dshMarketSources dshMarketAvailableSources">
        {available.map(provider => (
          <AvailableSource
            key={provider.key}
            provider={provider}
            pending={pending}
            onAdd={() => onMutation({ action: 'add-builtin', key: provider.key })}
            t={t}
          />
        ))}
      </div>}
    </div>
  )
}

function SourceRow({ source, result, pending, canMoveUp, canMoveDown, onMoveUp, onMoveDown, onSelect, onRemove, t }: {
  source: MarketSourceView
  result?: MarketCatalogSourceResult | undefined
  pending: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onSelect: () => void
  onRemove: () => void
  t: MarketSettingsTabProps['t']
}) {
  const endpointHost = (() => {
    try { return new URL(source.endpoint).host }
    catch { return source.endpoint }
  })()
  const resultLabel = result === undefined
    ? t('notChecked')
    : result.error !== undefined && result.snapshot === undefined
      ? t('unavailable')
      : result.stale
        ? t('lastStale')
        : t('available')
  const resultState = result === undefined
    ? 'ongoing'
    : result.error !== undefined && result.snapshot === undefined
      ? 'error'
      : result.stale
        ? 'warning'
        : 'done'
  return (
    <div className="dshMarketSource">
      <div>
        <h3>{source.name}{source.partnership && <Pill>{t('partner')}</Pill>}</h3>
        <p>{source.description ?? source.endpoint}</p>
        {source.attribution !== undefined && <SourceAttribution attribution={source.attribution} />}
        <div className="dshMarketSourceMeta">
          {source.attribution === undefined && <span>{source.providerId}</span>}
          <span>{endpointHost}</span>
          <span>{source.registrationKind === 'built-in' ? t('builtIn') : t('standardAdapter')}</span>
          <span><StateDot state={resultState} size={10} />{resultLabel}</span>
        </div>
      </div>
      <div className="dshMarketSourceActions">
        <Tooltip label={t('moveUp')}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('moveUp')}
            disabled={pending || !canMoveUp}
            icon={<IconChevronUpOutline14 />}
            onClick={onMoveUp}
          />
        </Tooltip>
        <Tooltip label={t('moveDown')}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('moveDown')}
            disabled={pending || !canMoveDown}
            icon={<IconChevronDownOutline14 />}
            onClick={onMoveDown}
          />
        </Tooltip>
        <Button
          variant="outline"
          size="sm"
          role="radio"
          aria-checked={source.enabled}
          disabled={pending}
          icon={source.enabled ? <IconCheckOutline16 /> : undefined}
          onClick={onSelect}
        >{source.enabled ? t('selectedSource') : t('selectSource')}</Button>
        <Tooltip label={t('remove')}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('remove')}
            disabled={pending}
            icon={<IconTrashOutline16 />}
            onClick={onRemove}
          />
        </Tooltip>
      </div>
    </div>
  )
}

function AvailableSource({ provider, pending, onAdd, t }: {
  provider: MarketBuiltInProvider
  pending: boolean
  onAdd: () => void
  t: MarketSettingsTabProps['t']
}) {
  return (
    <div className="dshMarketSource">
      <div>
        <h3>{provider.name}{provider.partnership && <Pill>{t('partner')}</Pill>}</h3>
        <p>{provider.description}</p>
        <SourceAttribution attribution={provider.attribution} />
      </div>
      <Button variant="outline" size="sm" disabled={pending} icon={<IconPlusOutline16 />} onClick={onAdd}>{t('add')}</Button>
    </div>
  )
}

function OperationFacts({ operation, showExpiry = true, t }: {
  operation: MarketOperationPreviewResponse
  showExpiry?: boolean
  t: MarketSettingsTabProps['t']
}) {
  return (
    <dl className="dshMarketOperationFacts">
      <div><dt>{t('plugin')}</dt><dd>{operation.displayName}</dd></div>
      <div><dt>{t('package')}</dt><dd>{operation.packageName}</dd></div>
      {operation.version !== undefined && <div><dt>{t('exactVersion')}</dt><dd>{operation.version}</dd></div>}
      <div><dt>{t('profile')}</dt><dd>{operation.profileName}</dd></div>
      {showExpiry && <div><dt>{t('previewExpires')}</dt><dd>{operation.expiresAt}</dd></div>}
    </dl>
  )
}

function OperationConfirmModal({ preview, pending, error, onCancel, onConfirm, t }: {
  preview: MarketOperationPreviewResponse
  pending: boolean
  error?: string | undefined
  onCancel: () => void
  onConfirm: () => void
  t: MarketSettingsTabProps['t']
}) {
  const installing = preview.action === 'install'
  const uninstalling = preview.action === 'uninstall'
  const disabling = preview.action === 'disable'
  const enabling = preview.action === 'enable'
  const title = installing
    ? t('confirmInstallTitle')
    : uninstalling
      ? t('confirmUninstallTitle')
      : disabling ? t('confirmDisableTitle') : t('confirmEnableTitle')
  const description = installing
    ? t('confirmInstallBody')
    : uninstalling
      ? t('confirmUninstallBody')
      : disabling ? t('confirmDisableBody') : t('confirmEnableBody')
  const confirmLabel = pending
    ? installing
      ? t('installing')
      : uninstalling
        ? t('uninstalling')
        : disabling ? t('disabling') : t('enabling')
    : installing
      ? t('confirmInstall')
      : uninstalling
        ? t('confirmUninstall')
        : disabling ? t('confirmDisable') : t('confirmEnable')
  return (
    <Modal
      open
      className="dshMarketModal dshMarketConfirmModal"
      contentClassName="dshMarketModalContent"
      onClose={onCancel}
      closeLabel={t('cancel')}
      title={title}
      description={description}
      footer={<div className="dshMarketModalActions">
        <Button variant="ghost" disabled={pending} onClick={onCancel}>{t('cancel')}</Button>
        <Button
          variant="primary"
          disabled={pending}
          icon={installing
            ? <IconDownloadOutline16 />
            : uninstalling
              ? <IconTrashOutline16 />
              : enabling ? <IconPlayOutline16 /> : <IconPauseOutline16 />}
          onClick={onConfirm}
        >{confirmLabel}</Button>
      </div>}
    >
      <div className="dshMarketOperationReview">
        <OperationFacts operation={preview} t={t} />
        {installing && <div className="dshMarketOperationWarning"><StateDot state="warning" size={12} /><span>{t('operationWarning')}</span></div>}
        {installing && (
          <div className="dshMarketOperationWarning">
            <StateDot state="warning" size={12} />
            <span>
              {t('operationRiskBeforeContact')}
              <a href={DSH_DESKTOP_ISSUES_URL} target="_blank" rel="noopener noreferrer">{t('contactUs')}</a>
              {t('operationRiskAfterContact')}
            </span>
          </div>
        )}
        {disabling && <>
          <div className="dshMarketOperationWarning"><StateDot state="warning" size={12} /><span>{t('disableWarning')}</span></div>
          <div className="dshMarketOperationWarning"><StateDot state="warning" size={12} /><span>{t('disableRecoveryWarning')}</span></div>
        </>}
        {enabling && <div className="dshMarketOperationWarning"><StateDot state="warning" size={12} /><span>{t('enableWarning')}</span></div>}
        <div className="dshMarketOperationWarning"><StateDot state="warning" size={12} /><span>{t('restartAfterOperation')}</span></div>
        {pending && <div className="dshMarketOperationProgress" role="status"><StateDot state="ongoing" size={12} />{confirmLabel}</div>}
        {error !== undefined && <div className="dshMarketError" role="alert">{error}</div>}
      </div>
    </Modal>
  )
}

function OperationSuccessModal({ operation, canRestart, pending, error, onClose, onRestart, t }: {
  operation: CompletedOperation
  canRestart: boolean
  pending: boolean
  error?: string | undefined
  onClose: () => void
  onRestart: () => void
  t: MarketSettingsTabProps['t']
}) {
  const title = operation.preview.action === 'install'
    ? t('installComplete')
    : operation.preview.action === 'uninstall'
      ? t('uninstallComplete')
      : operation.preview.action === 'disable' ? t('disableComplete') : t('enableComplete')
  return (
    <Modal
      open
      className="dshMarketModal dshMarketStatusModal"
      contentClassName="dshMarketModalContent"
      onClose={() => { if (!pending) onClose() }}
      closeLabel={t('close')}
      title={title}
      description={t('restartRequiredTitle')}
      footer={<div className="dshMarketModalActions">
        <Button variant="ghost" disabled={pending} onClick={onClose}>{t('restartLater')}</Button>
        <Button
          variant="primary"
          disabled={!canRestart || pending}
          icon={<IconRefreshOutline16 />}
          onClick={onRestart}
        >{pending ? t('restarting') : t('restartNow')}</Button>
      </div>}
    >
      <div className="dshMarketOperationReview">
        <OperationFacts operation={operation.preview} showExpiry={false} t={t} />
        <div className="dshMarketOperationSuccess" role="status">
          <StateDot state="done" size={12} />
          <span>{t('restartRequiredBody')}</span>
        </div>
        {error !== undefined && <div className="dshMarketError" role="alert">{error}</div>}
      </div>
    </Modal>
  )
}

function ItemActionModal({
  value,
  installation,
  inventoryLoading,
  inventoryError,
  manualInstall,
  preview,
  pending,
  operationError,
  desktopActionError,
  desktopActionPending,
  canOpenTerminal,
  verificationHelpHref,
  onClose,
  onConfirm,
  onOpenTerminal,
  onUninstall,
  onDisable,
  onEnable,
  t,
}: {
  value: VisibleItem
  installation: MarketInstallationView | undefined
  inventoryLoading: boolean
  inventoryError?: string | undefined
  manualInstall: ManualInstallHint | undefined
  preview: MarketOperationPreviewResponse | undefined
  pending: boolean
  operationError?: string | undefined
  desktopActionError?: string | undefined
  desktopActionPending: boolean
  canOpenTerminal: boolean
  verificationHelpHref: string
  onClose: () => void
  onConfirm: () => void
  onOpenTerminal: () => void
  onUninstall: (receipt: Extract<MarketInstallationView, { kind: 'managed' }>['receipt']) => void
  onDisable: (bundleId: string) => void
  onEnable: (bundleId: string) => void
  t: MarketSettingsTabProps['t']
}) {
  const checking = preview === undefined && pending && operationError === undefined
  const footer = installation === undefined && preview !== undefined ? <>
    <Button variant="ghost" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
    <Button
      variant="primary"
      disabled={pending}
      icon={<IconDownloadOutline16 />}
      onClick={onConfirm}
    >{pending ? t('installing') : t('confirmInstall')}</Button>
  </> : <>
    {value.item.repository !== undefined && (
      <Button
        variant="outline"
        icon={<IconRightUpOutline16 size={12} />}
        onClick={() => window.open(value.item.repository!.url, '_blank', 'noopener,noreferrer')}
      >{t('repository')}</Button>
    )}
    {installation === undefined
      && !inventoryLoading
      && inventoryError === undefined
      && manualInstall !== undefined
      && canOpenTerminal && (
      <Button
        variant="primary"
        disabled={desktopActionPending}
        onClick={onOpenTerminal}
      >{desktopActionPending ? t('openingTerminal') : t('openTerminal')}</Button>
    )}
    <Button variant="ghost" disabled={desktopActionPending} onClick={onClose}>{t('close')}</Button>
  </>
  return (
    <Modal
      open
      className="dshMarketModal dshMarketWideModal"
      contentClassName="dshMarketModalContent"
      onClose={onClose}
      title={preview === undefined ? value.item.displayName : t('confirmInstallTitle')}
      closeLabel={t('close')}
      {...(preview === undefined ? {} : { description: t('confirmInstallBody') })}
      footer={<div className="dshMarketModalActions">{footer}</div>}
    >
      <>
        <ItemSourceRow source={value.source} t={t} />
        {preview !== undefined ? (
          <div className="dshMarketOperationReview">
            <OperationFacts operation={preview} t={t} />
            <div className="dshMarketOperationWarning"><StateDot state="warning" size={12} /><span>{t('operationWarning')}</span></div>
            <div className="dshMarketOperationWarning">
              <StateDot state="warning" size={12} />
              <span>
                {t('operationRiskBeforeContact')}
                <a href={DSH_DESKTOP_ISSUES_URL} target="_blank" rel="noopener noreferrer">{t('contactUs')}</a>
                {t('operationRiskAfterContact')}
              </span>
            </div>
            <div className="dshMarketOperationWarning"><StateDot state="warning" size={12} /><span>{t('restartAfterOperation')}</span></div>
            {pending && <div className="dshMarketOperationProgress" role="status"><StateDot state="ongoing" size={12} />{t('installing')}</div>}
            {operationError !== undefined && <div className="dshMarketError" role="alert">{operationError}</div>}
          </div>
        ) : (
          <div className="dshMarketDetails">
            <div className="dshMarketDetailsIntro">
              <PluginIcon item={value.item} large />
              <p>{value.item.description ?? value.item.summary}</p>
            </div>
            {inventoryLoading && (
              <div className="dshMarketOperationProgress" role="status">
                <StateDot state="ongoing" size={12} />{t('loadingInstallations')}
              </div>
            )}
            {inventoryError !== undefined && (
              <div className="dshMarketBanner" role="alert">
                <StateDot state="warning" />
                <span>{inventoryError}</span>
              </div>
            )}
            {installation !== undefined && (
              <div className="dshMarketReceipts">
                <InstallationCard
                  installation={installation}
                  operationPending={pending}
                  onUninstall={onUninstall}
                  onDisable={onDisable}
                  onEnable={onEnable}
                  t={t}
                />
              </div>
            )}
            {!inventoryLoading && inventoryError === undefined && installation === undefined && checking && (
              <div className="dshMarketOperationProgress" role="status">
                <StateDot state="ongoing" size={12} />{t('checkingInstallMethod')}
              </div>
            )}
            {installation === undefined && !inventoryLoading && !checking && operationError !== undefined && (
              <div className="dshMarketBanner" role="alert">
                <StateDot state="warning" />
                <span>{operationError}</span>
                <a href={verificationHelpHref} target="_blank" rel="noopener noreferrer">
                  {t('verificationDetails')} <IconRightUpOutline16 size={12} />
                </a>
              </div>
            )}
            {installation === undefined && !inventoryLoading && inventoryError === undefined && !checking && manualInstall !== undefined ? (
              <div className="dshMarketManualInstall">
                <div><h3>{t('manualInstallTitle')}</h3><p>{t('manualInstallBody')}</p></div>
                <div className="dshMarketCommand">
                  <span>{t('installCommand')}</span>
                  <code>{manualInstall.displayCommand}</code>
                </div>
                <div className="dshMarketOperationWarning"><StateDot state="warning" size={12} /><span>{t('manualNotVerified')}</span></div>
                {manualInstall.mutable && (
                  <div className="dshMarketOperationWarning"><StateDot state="warning" size={12} /><span>{t('mutableGithubWarning')}</span></div>
                )}
                <div className="dshMarketOperationWarning"><StateDot state="warning" size={12} /><span>{t('operationWarning')}</span></div>
                <div className="dshMarketOperationWarning">
                  <StateDot state="warning" size={12} />
                  <span>
                    {t('operationRiskBeforeContact')}
                    <a href={DSH_DESKTOP_ISSUES_URL} target="_blank" rel="noopener noreferrer">{t('contactUs')}</a>
                    {t('operationRiskAfterContact')}
                  </span>
                </div>
              </div>
            ) : installation === undefined
              && !inventoryLoading
              && inventoryError === undefined
              && !checking
              && operationError === undefined ? <div>{t('readOnly')}</div> : null}
            {desktopActionError !== undefined && <div className="dshMarketError" role="alert">{desktopActionError}</div>}
          </div>
        )}
      </>
    </Modal>
  )
}
