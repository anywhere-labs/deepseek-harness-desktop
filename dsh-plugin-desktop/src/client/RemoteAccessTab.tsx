import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { parseDesktopRemoteSettings, type DesktopWorkbenchSettings } from '../workbench-settings.ts'
import { readRemoteStatus, type RemoteStatusView } from './workbench-actions.ts'

export interface RemoteAccessTabInjected {
  readonly scope: SettingsScope<DesktopWorkbenchSettings>
}

export type RemoteAccessTabProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'dsh-desktop'>
  & InjectFace<RemoteAccessTabInjected>

export function RemoteAccessTab({ scope, t }: Pick<RemoteAccessTabProps, 'scope' | 't'>): ReactNode {
  const snapshot = useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot())
  const remote = snapshot.value?.remote ?? { enabled: false, trustedHost: '' }
  const [enabled, setEnabled] = useState(remote.enabled)
  const [trustedHost, setTrustedHost] = useState(remote.trustedHost)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [plane, setPlane] = useState<RemoteStatusView | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    void readRemoteStatus(controller.signal).then(
      (next) => { setPlane(next) },
      () => {},
    )
    return () => controller.abort()
  }, [])

  if (snapshot.status === 'loading') return <p className="dshMcpLead">{t('mcpLoading')}</p>
  if (snapshot.status === 'unavailable' || !snapshot.writable) {
    return <p className="dshMcpLead">{t('mcpUnavailable')}</p>
  }

  const save = (): void => {
    setStatus('saving')
    try {
      const parsed = parseDesktopRemoteSettings({ enabled, trustedHost })
      void scope.set('remote', parsed).then(
        () => { setStatus('saved') },
        () => { setStatus('error') },
      )
    } catch {
      setStatus('error')
    }
  }

  return (
    <section className="dshMcpRoot">
      <div className="dshMcpSection">
        <h2>{t('remoteTitle')}</h2>
        <p className="dshMcpLead">{t('remoteBody')}</p>
      </div>
      <label className="dshMcpField">
        <span>{t('remoteEnabled')}</span>
        <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
      </label>
      <label className="dshMcpField">
        <span>{t('remoteHost')}</span>
        <input value={trustedHost} onChange={event => setTrustedHost(event.target.value)} />
      </label>
      <div className="dshWorkerActions">
        <button type="button" className="dshWorkerButton" disabled={status === 'saving'} onClick={save}>
          {status === 'saving' ? t('remoteSaving') : t('remoteSave')}
        </button>
      </div>
      {status === 'saved' ? <p className="dshMcpStatus" data-tone="ok">{t('remoteSaved')}</p> : null}
      {status === 'error' ? <p className="dshMcpStatus" data-tone="error">{t('remoteSaveError')}</p> : null}
      <p className="dshMcpLead">{plane?.enabled === true ? t('remoteStatusOn') : t('remoteStatusOff')}</p>
      <p className="dshMcpLead">{t('remotePixel')}</p>
    </section>
  )
}
