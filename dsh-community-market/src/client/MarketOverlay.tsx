import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Button,
  IconCheckOutline16,
  IconCloseOutline16,
  IconCordisPluginOutline14,
  IconDataOutline16,
  IconGlobeOutline14,
  IconLoadingOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconRightUpOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
  Input,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CatalogSnapshot } from '../contracts/generated/catalog-snapshot.js'
import type { MarketBuiltInProvider, MarketCatalogResponse, MarketSourceMutation, MarketSourceView, MarketStateResponse } from '../api-types.js'
import { mutateMarketSource, readMarketCatalog, readMarketState } from './api.js'
import type { MarketController } from './controller.js'

type MarketItem = CatalogSnapshot['items'][number]
type MarketView = 'discover' | 'sources'

interface VisibleItem {
  readonly item: MarketItem
  readonly source: MarketSourceView
  readonly stale: boolean
}

export type MarketOverlayProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<'community-market'>
  & { controller: MarketController; readLocale: () => string }

export function MarketOverlay({ controller, readLocale, t }: MarketOverlayProps) {
  const opened = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [view, setView] = useState<MarketView>('discover')
  const [state, setState] = useState<MarketStateResponse>()
  const [catalog, setCatalog] = useState<MarketCatalogResponse>()
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<VisibleItem>()
  const [addOpen, setAddOpen] = useState(false)
  const [manifestUrl, setManifestUrl] = useState('')
  const [mutationError, setMutationError] = useState<string>()
  const activeRequest = useRef<AbortController>()

  const loadCatalog = useCallback(async (nextState: MarketStateResponse, q: string) => {
    if (!nextState.sources.some(source => source.enabled)) {
      setCatalog(undefined)
      setLoading(false)
      return
    }
    activeRequest.current?.abort()
    const request = new AbortController()
    activeRequest.current = request
    setLoading(true)
    setError(undefined)
    try {
      setCatalog(await readMarketCatalog(q, readLocale(), request.signal))
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : t('catalogError'))
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = undefined
        setLoading(false)
      }
    }
  }, [readLocale, t])

  const loadState = useCallback(async (q: string) => {
    activeRequest.current?.abort()
    const request = new AbortController()
    activeRequest.current = request
    setLoading(true)
    setError(undefined)
    try {
      const next = await readMarketState(request.signal)
      setState(next)
      activeRequest.current = undefined
      await loadCatalog(next, q)
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : t('catalogError'))
      setLoading(false)
    }
  }, [loadCatalog, t])

  useEffect(() => {
    if (!opened) return
    setQuery('')
    void loadState('')
    return () => {
      activeRequest.current?.abort()
      activeRequest.current = undefined
    }
  }, [opened, loadState])

  useEffect(() => {
    if (!opened) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && selected === undefined && !addOpen) controller.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addOpen, controller, opened, selected])

  const items = useMemo(() => catalog?.results.flatMap(result =>
    (result.snapshot?.items ?? []).map(item => ({ item, source: result.source, stale: result.stale }))) ?? [], [catalog])
  const partialFailure = catalog?.results.some(result => result.error !== undefined) ?? false
  const enabledCount = state?.sources.filter(source => source.enabled).length ?? 0

  const mutate = async (mutation: MarketSourceMutation): Promise<boolean> => {
    setMutationError(undefined)
    try {
      const sources = await mutateMarketSource(mutation)
      const next = { sources, builtIns: state?.builtIns ?? [] }
      setState(next)
      await loadCatalog(next, query)
      return true
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : t('sourceError'))
      return false
    }
  }

  const close = () => {
    setSelected(undefined)
    setAddOpen(false)
    controller.close()
  }

  if (!opened) return null
  return (
    <section className="dshMarketRoot" aria-label={t('title')}>
      <header className="dshMarketHeader">
        <Tooltip label={t('close')}>
          <button type="button" className="dshMarketIconButton" aria-label={t('close')} onClick={close}>
            <IconCloseOutline16 size={18} />
          </button>
        </Tooltip>
        <div className="dshMarketHeaderTitle">
          <h1>{t('title')}</h1>
          <p>{t('subtitle')}</p>
        </div>
        <span className="dshMarketToolbarMeta">{enabledCount} {t('sources')}</span>
      </header>
      <div className="dshMarketBody">
        <nav className="dshMarketNav" aria-label={t('title')}>
          <button type="button" aria-current={view === 'discover' ? 'page' : undefined} onClick={() => setView('discover')}>
            <IconDataOutline16 size={17} /><span>{t('discover')}</span>
          </button>
          <button type="button" aria-current={view === 'sources' ? 'page' : undefined} onClick={() => setView('sources')}>
            <IconSettingsOutline16 size={17} /><span>{t('sources')}</span>
          </button>
          <div className="dshMarketReadOnly">{t('readOnly')}</div>
        </nav>
        <main className="dshMarketMain">
          {view === 'discover' ? (
            <DiscoverView
              state={state}
              items={items}
              query={query}
              loading={loading}
              error={error}
              partialFailure={partialFailure}
              onQuery={setQuery}
              onSearch={() => state !== undefined && void loadCatalog(state, query)}
              onRefresh={() => void loadState(query)}
              onSources={() => setView('sources')}
              onSelect={setSelected}
              t={t}
            />
          ) : (
            <SourcesView
              state={state}
              error={mutationError}
              onMutation={mutation => { void mutate(mutation) }}
              onAddStandard={() => setAddOpen(true)}
              t={t}
            />
          )}
        </main>
      </div>
      {selected !== undefined && <DetailsDrawer value={selected} onClose={() => setSelected(undefined)} t={t} />}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={t('addStandard')}
        closeLabel={t('cancel')}
        description={t('sourceNotice')}
        footer={<>
          <Button variant="ghost" onClick={() => setAddOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="primary"
            icon={<IconPlusOutline16 />}
            disabled={!manifestUrl.trim()}
            onClick={() => {
              void mutate({ action: 'add-standard', manifestUrl: manifestUrl.trim() }).then(succeeded => {
                if (!succeeded) return
                setManifestUrl('')
                setAddOpen(false)
              })
            }}
          >{t('confirmAdd')}</Button>
        </>}
      >
        <div className="dshMarketModalField">
          <label htmlFor="dsh-market-manifest">{t('standardSource')}</label>
          <Input id="dsh-market-manifest" value={manifestUrl} placeholder={t('manifestPlaceholder')} onChange={event => setManifestUrl(event.currentTarget.value)} />
          {mutationError !== undefined && <div className="dshMarketError">{mutationError}</div>}
        </div>
      </Modal>
    </section>
  )
}

function DiscoverView(props: {
  state?: MarketStateResponse | undefined
  items: readonly VisibleItem[]
  query: string
  loading: boolean
  error?: string | undefined
  partialFailure: boolean
  onQuery: (value: string) => void
  onSearch: () => void
  onRefresh: () => void
  onSources: () => void
  onSelect: (value: VisibleItem) => void
  t: MarketOverlayProps['t']
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
      <form className="dshMarketToolbar" onSubmit={event => { event.preventDefault(); props.onSearch() }}>
        <Input className="dshMarketSearch" icon={<IconSearchOutline16 />} value={props.query} placeholder={props.t('search')} onChange={event => props.onQuery(event.currentTarget.value)} />
        <Button type="submit" variant="primary" icon={<IconSearchOutline16 />}>{props.t('searchAction')}</Button>
        <Tooltip label={props.t('refresh')}>
          <button type="button" className="dshMarketIconButton" aria-label={props.t('refresh')} onClick={props.onRefresh}>
            <IconRefreshOutline16 className={props.loading ? 'dshMarketSpinner' : undefined} />
          </button>
        </Tooltip>
        <span className="dshMarketToolbarMeta">{props.items.length}</span>
      </form>
      {props.partialFailure && <div className="dshMarketBanner"><IconWarningOutline16 />{props.t('partialFailure')}</div>}
      {props.error !== undefined && (
        <div className="dshMarketEmpty">
          <div className="dshMarketEmptyIcon"><IconWarningOutline16 size={24} /></div>
          <h2>{props.t('catalogError')}</h2><p>{props.error}</p>
          <Button variant="outline" icon={<IconRefreshOutline16 />} onClick={props.onRefresh}>{props.t('retry')}</Button>
        </div>
      )}
      {props.error === undefined && props.loading && props.items.length === 0 && (
        <div className="dshMarketEmpty"><IconLoadingOutline16 className="dshMarketSpinner" size={26} /><p>{props.t('loading')}</p></div>
      )}
      {props.error === undefined && !props.loading && props.items.length === 0 && (
        <div className="dshMarketEmpty"><h2>{props.t('noResults')}</h2></div>
      )}
      <div className="dshMarketGrid">
        {props.items.map(value => <PluginCard key={`${value.source.sourceRecordId}:${value.item.id}`} value={value} onClick={() => props.onSelect(value)} t={props.t} />)}
      </div>
    </div>
  )
}

function PluginCard({ value, onClick, t }: { value: VisibleItem; onClick: () => void; t: MarketOverlayProps['t'] }) {
  const publisher = value.item.publisher?.name ?? value.source.name
  return (
    <button type="button" className="dshMarketCard" onClick={onClick}>
      <div className="dshMarketCardTop">
        <div className="dshMarketGlyph"><IconCordisPluginOutline14 size={20} /></div>
        <div className="dshMarketCardName"><strong>{value.item.displayName}</strong><span>{publisher}</span></div>
      </div>
      <p className="dshMarketSummary">{value.item.summary}</p>
      <div className="dshMarketTags">
        <span className="dshMarketTag">{t('source')}: {value.source.name}</span>
        {value.stale && <span className="dshMarketTag">{t('stale')}</span>}
        {value.item.categories?.slice(0, 2).map(category => <span key={category} className="dshMarketTag">{category}</span>)}
      </div>
    </button>
  )
}

function SourcesView({ state, error, onMutation, onAddStandard, t }: {
  state?: MarketStateResponse | undefined
  error?: string | undefined
  onMutation: (mutation: MarketSourceMutation) => void
  onAddStandard: () => void
  t: MarketOverlayProps['t']
}) {
  const selectedKeys = new Set(state?.sources.map(source => source.builtInProviderKey).filter(Boolean))
  const available = state?.builtIns.filter(provider => !selectedKeys.has(provider.key)) ?? []
  return (
    <div className="dshMarketContent">
      <div className="dshMarketSectionHead">
        <div><h2>{t('sources')}</h2><p>{t('sourceNotice')}</p></div>
        <Button variant="outline" icon={<IconPlusOutline16 />} onClick={onAddStandard}>{t('addStandard')}</Button>
      </div>
      {error !== undefined && <div className="dshMarketBanner"><IconWarningOutline16 />{error}</div>}
      <div className="dshMarketSources">
        {state?.sources.map(source => (
          <SourceRow
            key={source.sourceRecordId}
            source={source}
            onToggle={() => onMutation({ action: 'set-enabled', sourceRecordId: source.sourceRecordId, enabled: !source.enabled })}
            onRemove={() => onMutation({ action: 'remove', sourceRecordId: source.sourceRecordId })}
            t={t}
          />
        ))}
        {available.map(provider => <AvailableSource key={provider.key} provider={provider} onAdd={() => onMutation({ action: 'add-builtin', key: provider.key })} t={t} />)}
      </div>
    </div>
  )
}

function SourceRow({ source, onToggle, onRemove, t }: { source: MarketSourceView; onToggle: () => void; onRemove: () => void; t: MarketOverlayProps['t'] }) {
  return (
    <div className="dshMarketSource">
      <div><h3>{source.name}{source.partnership && <span className="dshMarketPartner">{t('partner')}</span>}</h3><p>{source.description ?? source.endpoint}</p></div>
      <div className="dshMarketSourceActions">
        <span className="dshMarketStatus" data-enabled={source.enabled}><span className="dshMarketStatusDot" />{source.enabled ? t('enabled') : t('disabled')}</span>
        <Button variant="outline" size="sm" icon={source.enabled ? <IconCheckOutline16 /> : undefined} onClick={onToggle}>{source.enabled ? t('disable') : t('enable')}</Button>
        <Tooltip label={t('remove')}><button type="button" className="dshMarketIconButton" aria-label={t('remove')} onClick={onRemove}><IconTrashOutline16 /></button></Tooltip>
      </div>
    </div>
  )
}

function AvailableSource({ provider, onAdd, t }: { provider: MarketBuiltInProvider; onAdd: () => void; t: MarketOverlayProps['t'] }) {
  return (
    <div className="dshMarketSource">
      <div><h3>{provider.name}{provider.partnership && <span className="dshMarketPartner">{t('partner')}</span>}</h3><p>{provider.description}</p></div>
      <Button variant="outline" size="sm" icon={<IconPlusOutline16 />} onClick={onAdd}>{t('add')}</Button>
    </div>
  )
}

function DetailsDrawer({ value, onClose, t }: { value: VisibleItem; onClose: () => void; t: MarketOverlayProps['t'] }) {
  return <>
    <button type="button" className="dshMarketDrawerMask" aria-label={t('close')} onClick={onClose} />
    <aside className="dshMarketDrawer" aria-label={t('details')}>
      <div className="dshMarketDrawerHead"><h2>{t('details')}</h2><button type="button" className="dshMarketIconButton" aria-label={t('close')} onClick={onClose}><IconCloseOutline16 /></button></div>
      <div className="dshMarketDrawerBody">
        <h3>{value.item.displayName}</h3>
        <div className="dshMarketDrawerMeta">{t('source')}: {value.source.name}</div>
        <div className="dshMarketDrawerSummary">{value.item.description ?? value.item.summary}</div>
        {value.item.repository !== undefined && <Button variant="outline" icon={<IconRightUpOutline16 />} onClick={() => window.open(value.item.repository!.url, '_blank', 'noopener,noreferrer')}>{t('repository')}</Button>}
        <div className="dshMarketDrawerNotice">{t('readOnly')}</div>
      </div>
    </aside>
  </>
}
