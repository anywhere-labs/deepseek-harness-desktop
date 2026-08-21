import { useEffect, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  OFFICE_IM_RECOMMENDED_PLUGINS,
  WORKER_PACK_RECOMMENDED_PLUGINS,
  type WorkerPackRecommendedPlugin,
} from '../worker-pack.ts'
import type { DesktopLocaleKey } from './locales.ts'
import {
  readMarketSources,
  selectWorkerPackCatalog,
  workerPackCatalogSelected,
} from './market-actions.ts'

export type WorkerPackTabProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'dsh-desktop'>

function RecommendedPluginCard({
  plugin,
  t,
}: {
  readonly plugin: WorkerPackRecommendedPlugin
  readonly t: WorkerPackTabProps['t']
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
    </article>
  )
}

const ROLE_KEY: Record<WorkerPackRecommendedPlugin['role'], DesktopLocaleKey> = {
  'workspace-shell': 'pluginWorkspaceShell',
  'workspace-context': 'pluginWorkspaceContext',
  'office-dingtalk': 'pluginOfficeDingtalk',
  'office-wecom': 'pluginOfficeWecom',
}

type CatalogState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly selected: boolean }
  | { readonly status: 'busy' }
  | { readonly status: 'error' }

export function WorkerPackTab({ t }: WorkerPackTabProps): ReactNode {
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    void readMarketSources(controller.signal).then(
      (sources) => {
        setCatalog({ status: 'ready', selected: workerPackCatalogSelected(sources) })
      },
      () => { setCatalog({ status: 'error' }) },
    )
    return () => controller.abort()
  }, [])

  const addCatalog = (): void => {
    setCatalog({ status: 'busy' })
    void selectWorkerPackCatalog().then(
      (sources) => { setCatalog({ status: 'ready', selected: workerPackCatalogSelected(sources) }) },
      () => { setCatalog({ status: 'error' }) },
    )
  }

  return (
    <section className="dshWorkerRoot">
      <div className="dshWorkerSection">
        <h2>{t('workerTitle')}</h2>
        <p className="dshWorkerLead">{t('workerBody')}</p>
      </div>
      <div className="dshWorkerSection">
        <h2>{t('presetTitle')}</h2>
        <p>{t('presetBody')}</p>
      </div>
      <div className="dshWorkerSection">
        <h2>{t('pluginsTitle')}</h2>
        <p>{t('pluginsBody')}</p>
        {WORKER_PACK_RECOMMENDED_PLUGINS.map(plugin => (
          <RecommendedPluginCard key={plugin.packageName} plugin={plugin} t={t} />
        ))}
      </div>
      <div className="dshWorkerSection">
        <h2>{t('officeImTitle')}</h2>
        <p>{t('officeImBody')}</p>
        {OFFICE_IM_RECOMMENDED_PLUGINS.map(plugin => (
          <RecommendedPluginCard key={plugin.packageName} plugin={plugin} t={t} />
        ))}
      </div>
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
      <div className="dshWorkerSection">
        <h2>{t('mcpHintTitle')}</h2>
        <p>{t('mcpHintBody')}</p>
      </div>
    </section>
  )
}
