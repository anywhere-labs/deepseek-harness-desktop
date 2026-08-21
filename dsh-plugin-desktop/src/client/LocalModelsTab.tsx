import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopWorkbenchSettings } from '../workbench-settings.ts'
import {
  applyLocalModel,
  scanLocalModels,
  startLocalModel,
  type LocalModelProbeView,
} from './workbench-actions.ts'

export interface LocalModelsTabInjected {
  readonly scope: SettingsScope<DesktopWorkbenchSettings>
}

export type LocalModelsTabProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'dsh-desktop'>
  & InjectFace<LocalModelsTabInjected>

export function LocalModelsTab({ scope, t }: Pick<LocalModelsTabProps, 'scope' | 't'>): ReactNode {
  const snapshot = useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot())
  const [results, setResults] = useState<readonly LocalModelProbeView[]>([])
  const [status, setStatus] = useState<'idle' | 'busy' | 'error' | 'applied'>('idle')

  const scan = (): void => {
    setStatus('busy')
    void scanLocalModels().then(
      (next) => {
        setResults(next)
        setStatus('idle')
      },
      () => { setStatus('error') },
    )
  }

  if (snapshot.status === 'loading') return <p className="dshMcpLead">{t('modelsBusy')}</p>
  if (snapshot.status === 'unavailable') return <p className="dshMcpLead">{t('mcpUnavailable')}</p>

  return (
    <section className="dshMcpRoot">
      <div className="dshMcpSection">
        <h2>{t('modelsTitle')}</h2>
        <p className="dshMcpLead">{t('modelsBody')}</p>
      </div>
      {snapshot.writable ? (
        <label className="dshMcpField">
          <span>{t('modelsAutoStart')}</span>
          <input
            type="checkbox"
            checked={snapshot.value?.localModels.autoStart === true}
            onChange={event => { void scope.set('localModels', { autoStart: event.target.checked }) }}
          />
        </label>
      ) : null}
      <div className="dshWorkerActions">
        <button type="button" className="dshWorkerButton" disabled={status === 'busy'} onClick={scan}>
          {t('modelsScan')}
        </button>
      </div>
      {status === 'busy' ? <p className="dshWorkerStatus">{t('modelsBusy')}</p> : null}
      {status === 'error' ? <p className="dshWorkerStatus" data-tone="error">{t('modelsError')}</p> : null}
      {status === 'applied' ? <p className="dshWorkerStatus" data-tone="ok">{t('modelsApplied')}</p> : null}
      {results.length === 0 && status !== 'busy' ? <p className="dshMcpLead">{t('modelsEmpty')}</p> : null}
      {results.map(result => (
        <article key={result.id} className="dshMcpCard">
          <h3>{result.displayName}</h3>
          <p>
            <code className="dshWorkerCode">{result.origin}</code>
            {' · '}
            {result.running ? t('modelsRunning') : t('modelsStopped')}
            {result.started ? ` · ${t('modelsStarted')}` : ''}
          </p>
          {result.models.length > 0 ? (
            <p className="dshWorkerCode">{result.models.map(model => model.id).join(', ')}</p>
          ) : null}
          {result.error !== undefined ? <p className="dshWorkerStatus" data-tone="error">{result.error}</p> : null}
          <div className="dshWorkerActions">
            <button
              type="button"
              className="dshWorkerButton dshWorkerButtonSecondary"
              disabled={status === 'busy' || result.running}
              onClick={() => {
                setStatus('busy')
                void startLocalModel({ id: result.id, origin: result.origin }).then(
                  (next) => {
                    setResults(current => current.map(entry => entry.id === next.id ? next : entry))
                    setStatus('idle')
                  },
                  () => { setStatus('error') },
                )
              }}
            >
              {t('modelsStart')}
            </button>
            <button
              type="button"
              className="dshWorkerButton"
              disabled={status === 'busy' || !result.running}
              onClick={() => {
                setStatus('busy')
                void applyLocalModel({ id: result.id, origin: result.origin }).then(
                  (next) => {
                    setResults(current => current.map(entry => entry.id === next.id ? next : entry))
                    setStatus('applied')
                  },
                  () => { setStatus('error') },
                )
              }}
            >
              {t('modelsApply')}
            </button>
          </div>
        </article>
      ))}
    </section>
  )
}
