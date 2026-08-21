import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopWorkbenchSettings } from '../workbench-settings.ts'
import {
  applyHomeMigrationSource,
  previewHomeMigrationSource,
  type HomeMigrationPreviewView,
} from './workbench-actions.ts'

export interface HomeMigrationTabInjected {
  readonly scope: SettingsScope<DesktopWorkbenchSettings>
}

export type HomeMigrationTabProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'dsh-desktop'>
  & InjectFace<HomeMigrationTabInjected>

export function HomeMigrationTab({ scope, t }: HomeMigrationTabProps): ReactNode {
  const snapshot = useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot())
  const [source, setSource] = useState(snapshot.value?.home.lastSource ?? '')
  const [preview, setPreview] = useState<HomeMigrationPreviewView | undefined>(undefined)
  const [status, setStatus] = useState<'idle' | 'busy' | 'error' | 'applied'>('idle')

  if (snapshot.status === 'loading') return <p className="dshMcpLead">{t('homeBusy')}</p>
  if (snapshot.status === 'unavailable') return <p className="dshMcpLead">{t('mcpUnavailable')}</p>

  return (
    <section className="dshMcpRoot">
      <div className="dshMcpSection">
        <h2>{t('homeTitle')}</h2>
        <p className="dshMcpLead">{t('homeBody')}</p>
      </div>
      <label className="dshMcpField">
        <span>{t('homeSource')}</span>
        <input value={source} onChange={event => setSource(event.target.value)} />
      </label>
      <div className="dshWorkerActions">
        <button
          type="button"
          className="dshWorkerButton"
          disabled={status === 'busy' || source.trim().length === 0}
          onClick={() => {
            setStatus('busy')
            void previewHomeMigrationSource(source.trim()).then(
              (next) => {
                setPreview(next)
                setStatus('idle')
                if (snapshot.writable) void scope.set('home', { lastSource: source.trim() })
              },
              () => { setStatus('error') },
            )
          }}
        >
          {t('homePreview')}
        </button>
        <button
          type="button"
          className="dshWorkerButton dshWorkerButtonSecondary"
          disabled={status === 'busy' || preview === undefined}
          onClick={() => {
            if (preview === undefined) return
            setStatus('busy')
            void applyHomeMigrationSource(preview.source, preview.token).then(
              () => { setStatus('applied') },
              () => { setStatus('error') },
            )
          }}
        >
          {t('homeApply')}
        </button>
      </div>
      {status === 'busy' ? <p className="dshWorkerStatus">{t('homeBusy')}</p> : null}
      {status === 'error' ? <p className="dshWorkerStatus" data-tone="error">{t('homeError')}</p> : null}
      {status === 'applied' ? <p className="dshWorkerStatus" data-tone="ok">{t('homeApplied')}</p> : null}
      {preview !== undefined ? (
        <article className="dshMcpCard">
          <p>
            {t('homeToken')}
            {': '}
            <code className="dshWorkerCode">{preview.token}</code>
          </p>
          {preview.domains.map(domain => (
            <div key={domain.domain} className="dshMcpField">
              <strong>{domain.domain}</strong>
              <span>
                {domain.sourceEntries}
                {' → '}
                {domain.targetEntries}
              </span>
              {domain.conflicts.length > 0 ? (
                <p>
                  {t('homeConflicts')}
                  {': '}
                  {domain.conflicts.join(', ')}
                </p>
              ) : null}
              {domain.sourceNamespaces !== undefined ? (
                <p className="dshWorkerCode">{domain.sourceNamespaces.join(', ')}</p>
              ) : null}
            </div>
          ))}
        </article>
      ) : null}
    </section>
  )
}
