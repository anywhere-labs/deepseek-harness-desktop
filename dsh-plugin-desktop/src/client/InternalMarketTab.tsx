import { useEffect, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  OFFICE_IM_RECOMMENDED_PLUGINS,
  WORKBENCH_LATER_RECOMMENDED_PLUGINS,
  WORKER_PACK_RECOMMENDED_PLUGINS,
  recommendedPackageInstalled,
  recommendedPluginsFor,
  summarizeWorkerPackInstallResults,
  type WorkerPackInstallKind,
  type WorkerPackRecommendedPlugin,
} from '../worker-pack.ts'
import type { DesktopLocaleKey } from './locales.ts'
import {
  installRecommendedPlugins,
  readMarketSources,
  readWorkerPackInstallations,
  requestWorkerPackRestart,
  selectWorkerPackCatalog,
  workerPackCatalogSelected,
} from './market-actions.ts'

export type InternalMarketTabProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'dsh-desktop'>

const ROLE_KEY: Record<WorkerPackRecommendedPlugin['role'], DesktopLocaleKey> = {
  'workspace-shell': 'pluginWorkspaceShell',
  'workspace-context': 'pluginWorkspaceContext',
  'workspace-mobile': 'pluginWorkspaceMobile',
  'office-dingtalk': 'pluginOfficeDingtalk',
  'office-wecom': 'pluginOfficeWecom',
}

function RecommendedPluginCard({
  plugin,
  t,
  installed,
  busy,
  onInstall,
}: {
  readonly plugin: WorkerPackRecommendedPlugin
  readonly t: InternalMarketTabProps['t']
  readonly installed: boolean
  readonly busy: boolean
  readonly onInstall: (packageName: string) => void
}): ReactNode {
  return (
    <article className="dshWorkerCard">
      <h3>{plugin.displayName}</h3>
      <p>{t(ROLE_KEY[plugin.role])}</p>
      <div className="dshWorkerMeta">
        <span>{t('pluginPackage')}</span>
        <code className="dshWorkerCode">{plugin.packageName}</code>
        <a href={plugin.repositoryUrl} target="_blank" rel="noreferrer">{t('openRepository')}</a>
      </div>
      <div className="dshWorkerActions">
        <button
          type="button"
          className="dshWorkerButton dshWorkerButtonSecondary"
          disabled={busy || installed}
          onClick={() => onInstall(plugin.packageName)}
        >
          {installed ? t('installed') : t('installPlugin')}
        </button>
      </div>
    </article>
  )
}

type CatalogState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly selected: boolean }
  | { readonly status: 'busy' }
  | { readonly status: 'error' }

type InstallState =
  | { readonly status: 'idle' }
  | { readonly status: 'busy' }
  | { readonly status: 'done'; readonly tone: 'ok' | 'error'; readonly message: DesktopLocaleKey; readonly restartToken?: string }

/** Four-way move glyph matching official settings-tab chrome, without primitives. */
function InternalMarketGlyph(): ReactNode {
  return (
    <svg
      className="dshInternalMarketGlyph"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="5 9 2 12 5 15" />
      <polyline points="9 5 12 2 15 5" />
      <polyline points="15 9 18 12 15 15" />
      <polyline points="9 15 12 18 15 15" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="12" y1="2" x2="12" y2="22" />
    </svg>
  )
}

/** Desktop-owned curated recommendations. Community market stays the open store. */
export function InternalMarketTab({ t }: InternalMarketTabProps): ReactNode {
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' })
  const [installedNames, setInstalledNames] = useState<readonly string[]>([])
  const [install, setInstall] = useState<InstallState>({ status: 'idle' })

  const refreshInstallations = async (signal?: AbortSignal): Promise<void> => {
    const installations = await readWorkerPackInstallations(signal)
    setInstalledNames([
      ...WORKER_PACK_RECOMMENDED_PLUGINS,
      ...WORKBENCH_LATER_RECOMMENDED_PLUGINS,
      ...OFFICE_IM_RECOMMENDED_PLUGINS,
    ].filter(plugin => recommendedPackageInstalled(plugin.packageName, installations)).map(plugin => plugin.packageName))
  }

  useEffect(() => {
    const controller = new AbortController()
    void readMarketSources(controller.signal).then(
      (sources) => {
        setCatalog({ status: 'ready', selected: workerPackCatalogSelected(sources) })
      },
      () => { setCatalog({ status: 'error' }) },
    )
    void refreshInstallations(controller.signal).catch(() => undefined)
    return () => controller.abort()
  }, [])

  const addCatalog = (): void => {
    setCatalog({ status: 'busy' })
    void selectWorkerPackCatalog().then(
      (sources) => { setCatalog({ status: 'ready', selected: workerPackCatalogSelected(sources) }) },
      () => { setCatalog({ status: 'error' }) },
    )
  }

  const runInstall = (packageNames: readonly string[]): void => {
    setInstall({ status: 'busy' })
    void installRecommendedPlugins(packageNames).then(
      async (outcome) => {
        await refreshInstallations().catch(() => undefined)
        setCatalog({ status: 'ready', selected: true })
        const message = summarizeWorkerPackInstallResults(outcome.results)
        setInstall({
          status: 'done',
          tone: message === 'installError' || message === 'installMissing' ? 'error' : 'ok',
          message,
          ...(outcome.restartToken === undefined ? {} : { restartToken: outcome.restartToken }),
        })
      },
      () => { setInstall({ status: 'done', tone: 'error', message: 'installError' }) },
    )
  }

  const installKind = (kind: WorkerPackInstallKind): void => {
    runInstall(recommendedPluginsFor(kind).map(plugin => plugin.packageName))
  }

  const restartNow = (): void => {
    if (install.status !== 'done' || install.restartToken === undefined) return
    void requestWorkerPackRestart(install.restartToken).catch(() => undefined)
  }

  const busy = catalog.status === 'busy' || install.status === 'busy'
  const isInstalled = (packageName: string): boolean => installedNames.includes(packageName)

  return (
    <section className="dshWorkerRoot dshInternalMarketRoot" aria-label={t('internalMarketTitle')}>
      <header className="dshInternalMarketHeader">
        <div className="dshInternalMarketGlyphWrap">
          <InternalMarketGlyph />
        </div>
        <div className="dshInternalMarketHeaderTitle">
          <h2>{t('internalMarketTitle')}</h2>
          <p>{t('internalMarketBody')}</p>
        </div>
      </header>
      <div className="dshWorkerSection">
        <h2>{t('pluginsTitle')}</h2>
        <p>{t('pluginsBody')}</p>
        <div className="dshWorkerActions">
          <button
            type="button"
            className="dshWorkerButton"
            disabled={busy || WORKER_PACK_RECOMMENDED_PLUGINS.every(plugin => isInstalled(plugin.packageName))}
            onClick={() => installKind('workspace')}
          >
            {t('installWorkspace')}
          </button>
        </div>
        {WORKER_PACK_RECOMMENDED_PLUGINS.map(plugin => (
          <RecommendedPluginCard
            key={plugin.packageName}
            plugin={plugin}
            t={t}
            installed={isInstalled(plugin.packageName)}
            busy={busy}
            onInstall={packageName => runInstall([packageName])}
          />
        ))}
      </div>
      <div className="dshWorkerSection">
        <h2>{t('laterTitle')}</h2>
        <p>{t('laterBody')}</p>
        <div className="dshWorkerActions">
          <button
            type="button"
            className="dshWorkerButton dshWorkerButtonSecondary"
            disabled={busy || WORKBENCH_LATER_RECOMMENDED_PLUGINS.every(plugin => isInstalled(plugin.packageName))}
            onClick={() => installKind('later')}
          >
            {t('installLater')}
          </button>
        </div>
        {WORKBENCH_LATER_RECOMMENDED_PLUGINS.map(plugin => (
          <RecommendedPluginCard
            key={plugin.packageName}
            plugin={plugin}
            t={t}
            installed={isInstalled(plugin.packageName)}
            busy={busy}
            onInstall={packageName => runInstall([packageName])}
          />
        ))}
      </div>
      <div className="dshWorkerSection">
        <h2>{t('officeImTitle')}</h2>
        <p>{t('officeImBody')}</p>
        <div className="dshWorkerActions">
          <button
            type="button"
            className="dshWorkerButton"
            disabled={busy || OFFICE_IM_RECOMMENDED_PLUGINS.every(plugin => isInstalled(plugin.packageName))}
            onClick={() => installKind('office-im')}
          >
            {t('installOfficeIm')}
          </button>
        </div>
        {OFFICE_IM_RECOMMENDED_PLUGINS.map(plugin => (
          <RecommendedPluginCard
            key={plugin.packageName}
            plugin={plugin}
            t={t}
            installed={isInstalled(plugin.packageName)}
            busy={busy}
            onInstall={packageName => runInstall([packageName])}
          />
        ))}
      </div>
      {install.status === 'busy' ? <p className="dshWorkerStatus">{t('installBusy')}</p> : null}
      {install.status === 'done'
        ? (
            <div className="dshWorkerSection">
              <p className="dshWorkerStatus" data-tone={install.tone}>{t(install.message)}</p>
              {install.restartToken === undefined
                ? null
                : (
                    <div className="dshWorkerActions">
                      <button type="button" className="dshWorkerButton" onClick={restartNow}>
                        {t('installRestartNow')}
                      </button>
                    </div>
                  )}
            </div>
          )
        : null}
      <div className="dshWorkerSection">
        <h2>{t('catalogTitle')}</h2>
        <p>{t('catalogBody')}</p>
        <div className="dshWorkerActions">
          <button
            type="button"
            className="dshWorkerButton"
            disabled={catalog.status === 'busy' || (catalog.status === 'ready' && catalog.selected)}
            onClick={addCatalog}
          >
            {t('addCatalog')}
          </button>
        </div>
        {catalog.status === 'busy' ? <p className="dshWorkerStatus">{t('catalogBusy')}</p> : null}
        {catalog.status === 'error' ? <p className="dshWorkerStatus" data-tone="error">{t('catalogError')}</p> : null}
        {catalog.status === 'ready' && catalog.selected
          ? <p className="dshWorkerStatus" data-tone="ok">{t('catalogReady')}</p>
          : null}
      </div>
    </section>
  )
}
