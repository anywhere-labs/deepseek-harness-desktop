import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export type WorkerPackTabProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'dsh-desktop'>

/** Non-market workbench intro. Recommended plugins live on Internal Market. */
export function WorkerPackTab({ t }: Pick<WorkerPackTabProps, 't'>): ReactNode {
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
    </section>
  )
}
