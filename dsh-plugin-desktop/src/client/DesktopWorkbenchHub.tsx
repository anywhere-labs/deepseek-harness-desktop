import { useState, type ReactNode } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DESKTOP_WORKBENCH_PAGE_IDS } from '../worker-pack.ts'
import type { DesktopWorkbenchSettings } from '../workbench-settings.ts'
import type { DesktopLocaleKey } from './locales.ts'
import { HomeMigrationTab } from './HomeMigrationTab.tsx'
import { LocalModelsTab } from './LocalModelsTab.tsx'
import { RemoteAccessTab } from './RemoteAccessTab.tsx'
import { WorkerPackTab } from './WorkerPackTab.tsx'

export interface DesktopWorkbenchHubInjected {
  readonly scope: SettingsScope<DesktopWorkbenchSettings>
}

export type DesktopWorkbenchHubProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'dsh-desktop'>
  & InjectFace<DesktopWorkbenchHubInjected>

/** Pages kept under one Plugins tab so the official tab row stays readable. */
export type DesktopWorkbenchPage = typeof DESKTOP_WORKBENCH_PAGE_IDS[number]

const PAGES: readonly { readonly id: DesktopWorkbenchPage; readonly label: DesktopLocaleKey }[] = [
  { id: 'pack', label: 'workerTab' },
  { id: 'models', label: 'modelsTab' },
  { id: 'home', label: 'homeTab' },
  { id: 'remote', label: 'remoteTab' },
]

/** Desktop workbench surfaces share one Plugins tab, with an inner page switch. */
export function DesktopWorkbenchHub({ scope, t }: DesktopWorkbenchHubProps): ReactNode {
  const [page, setPage] = useState<DesktopWorkbenchPage>('pack')
  return (
    <div className="dshWorkerHub">
      <nav className="dshWorkerSubnav" aria-label={t('workbenchNav')}>
        {PAGES.map(entry => (
          <button
            key={entry.id}
            type="button"
            data-active={page === entry.id ? 'true' : undefined}
            onClick={() => { setPage(entry.id) }}
          >
            {t(entry.label)}
          </button>
        ))}
      </nav>
      {page === 'pack' ? <WorkerPackTab t={t} /> : null}
      {page === 'models' ? <LocalModelsTab scope={scope} t={t} /> : null}
      {page === 'home' ? <HomeMigrationTab scope={scope} t={t} /> : null}
      {page === 'remote' ? <RemoteAccessTab scope={scope} t={t} /> : null}
    </div>
  )
}
