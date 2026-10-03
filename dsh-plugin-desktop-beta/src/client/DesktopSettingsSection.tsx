/** Desktop-owned settings section registered into the official Settings shell. */

import {
  useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode,
} from 'react'
import type { DesktopSettingsForm } from './settings-bridge.ts'
import { Check, Copy } from 'lucide-react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DesktopMarketProvider, DesktopProfileView, DesktopSettingsApi, DesktopSettingsView,
} from './desktop-settings-api.ts'
import type { DesktopSettingsLocaleKey } from './desktop-settings-locales.ts'
import type { DesktopClientPlatform } from './environment.ts'
import {
  desktopBrowserAccessAvailable,
  desktopBrowserAccessEnabled,
} from '../desktop-network.ts'

/** Browser view of the Host `dsh-desktop` settings namespace. */
export interface DesktopShellSettings {
  readonly mode: 'compatibility' | 'extended' | 'advanced'
  readonly macosMaterial: 'off' | 'transparent'
  readonly linuxMaterial: 'off' | 'transparent'
  /** Legacy Windows value; Windows has no selectable material and renders opaque. */
  readonly windowsMaterial: 'off' | 'acrylic' | 'mica'
  readonly port: number
  readonly openBrowser: boolean
  readonly networkExposure: 'loopback' | 'lan'
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/** Browser view of the Host `dsh-desktop-notifications` settings namespace. */
export interface DesktopNotificationSettings {
  readonly enabled: boolean
  readonly notifyOnTurnCompletion: boolean
  readonly notifyOnTurnFailure: boolean
  readonly notifyOnJobCompletion: boolean
  readonly notifyOnJobFailure: boolean
  readonly notifyOnScheduleCompletion: boolean
  readonly notifyOnScheduleFailure: boolean
}

/** Registration-side business face for the Desktop settings section. */
export interface DesktopSettingsSectionInjected {
  readonly api: DesktopSettingsApi
  readonly platform: DesktopClientPlatform
  /** Installed Desktop product version rendered by the update section. */
  readonly version: string
  readonly initialMode: DesktopShellSettings['mode']
  readonly setMode: (mode: DesktopShellSettings['mode']) => Promise<void>
  readonly desktopSettings: Pick<DesktopSettingsForm<DesktopShellSettings>, 'getSnapshot' | 'subscribe' | 'set'>
  readonly notificationSettings: Pick<DesktopSettingsForm<DesktopNotificationSettings>, 'getSnapshot' | 'subscribe' | 'set'>
  /** Hosts can omit unsupported features while sharing the existing page. */
  readonly capabilities?: {
    readonly pluginSelectors?: boolean
    readonly windowModes?: boolean
    readonly featuresReadOnly?: boolean
    readonly markets?: readonly DesktopMarketProvider[]
    readonly materialRequiresRestart?: boolean
    readonly nativeLanConfirmation?: boolean
    readonly jobNotifications?: boolean
    readonly updates?: boolean
  }
  readonly introNotice?: ReactNode
  readonly browserActions?: ReactNode
  readonly extraSections?: ReactNode
}

/** Renderer-composed props for the official settings section entry. */
export type DesktopSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'desktop.settings'>
  & InjectFace<DesktopSettingsSectionInjected>

type Translate = DesktopSettingsSectionProps['t']
type BusyOperation = 'load' | 'create-profile' | 'select-profile' | 'delete-profile' | 'select-aa' | 'select-market' | 'mode' | 'material' | 'web' | 'notification'
type RestartState = 'none' | 'restarting' | 'required'
type LanPollWait = (signal: AbortSignal) => Promise<void>

const LAN_POLL_INTERVAL_MS = 250
const LAN_POLL_MAX_READS = 21

const LAN_STATE_LOCALE_KEYS = {
  inactive: 'lanStatusInactive',
  starting: 'lanStatusStarting',
  ready: 'lanStatusReady',
  failed: 'lanStatusFailed',
} as const satisfies Record<DesktopSettingsView['web']['lanState'], DesktopSettingsLocaleKey>

function waitForLanPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, LAN_POLL_INTERVAL_MS)
    const cancel = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
}

/** Refresh Host state, briefly following an in-flight hot LAN transition. */
export async function readDesktopSettingsUntilLanSettled(
  api: Pick<DesktopSettingsApi, 'read'>,
  publish: (view: DesktopSettingsView) => void,
  signal: AbortSignal,
  wait: LanPollWait = waitForLanPoll,
): Promise<DesktopSettingsView> {
  let latest: DesktopSettingsView | undefined
  for (let read = 0; read < LAN_POLL_MAX_READS; read += 1) {
    signal.throwIfAborted()
    latest = await api.read()
    signal.throwIfAborted()
    publish(latest)
    if (latest.web.lanState !== 'starting' || read === LAN_POLL_MAX_READS - 1) return latest
    await wait(signal)
  }
  throw new Error('dsh-plugin-desktop: unreachable LAN settings polling state')
}

/** Persist ordinary-browser permission and refresh the already-running edge. */
export async function persistDesktopBrowserAccessHot(
  settings: Pick<DesktopSettingsForm<DesktopShellSettings>, 'set'>,
  checked: boolean,
  currentExposure: DesktopShellSettings['networkExposure'],
  refresh: () => Promise<DesktopSettingsView>,
): Promise<DesktopSettingsView> {
  if (!checked && currentExposure === 'lan') {
    await settings.set('networkExposure', 'loopback')
  }
  await settings.set('openBrowser', checked)
  return refresh()
}

/** Persist LAN intent and refresh its hot HTTPS ingress state. */
export async function persistDesktopNetworkExposureHot(
  settings: Pick<DesktopSettingsForm<DesktopShellSettings>, 'set'>,
  exposure: DesktopShellSettings['networkExposure'],
  refresh: () => Promise<DesktopSettingsView>,
): Promise<DesktopSettingsView> {
  await settings.set('networkExposure', exposure)
  return refresh()
}

/** URLs are advertised only after the user explicitly enables browser access. */
export function desktopBrowserUrlsShouldRender(
  browserAccess: boolean,
  _networkExposure: DesktopShellSettings['networkExposure'],
): boolean {
  return browserAccess
}

/** Keep cancellation side-effect free; only explicit confirmation enables LAN. */
export function resolveDesktopLanConfirmation(
  confirmed: boolean,
  dismiss: () => void,
  enableLan: () => void,
): void {
  dismiss()
  if (confirmed) enableLan()
}

function useScope<T>(scope: Pick<DesktopSettingsForm<T>, 'getSnapshot' | 'subscribe'>) {
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const snapshot = useCallback(() => scope.getSnapshot(), [scope])
  return useSyncExternalStore(subscribe, snapshot)
}

export function Choice({
  title,
  body,
  aside,
  selected,
  reselectable,
  disabled,
  action,
  status,
  badge,
}: {
  title: ReactNode
  body: ReactNode
  aside?: ReactNode
  selected: boolean
  reselectable?: boolean
  disabled?: boolean
  action: () => void
  status?: ReactNode
  badge?: ReactNode
}) {
  const actionable = disabled !== true && (!selected || reselectable === true)
  const choose = (): void => {
    if (actionable) action()
  }
  return (
    <div
      role="radio"
      className="dshDesktopSettingsChoice"
      data-selected={selected ? 'true' : undefined}
      data-actionable={actionable ? 'true' : undefined}
      aria-checked={selected}
      aria-disabled={disabled === true ? 'true' : undefined}
      tabIndex={disabled === true ? -1 : 0}
      onClick={choose}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        choose()
      }}
    >
      <span className="dshDesktopSettingsChoiceCopy">
        <span className="dshDesktopSettingsChoiceTitle">
          {title}
          {badge !== undefined && <span className="dshDesktopSettingsBadge">{badge}</span>}
          {status !== undefined && <span className="dshDesktopSettingsBadge">{status}</span>}
        </span>
        <span className="dshDesktopSettingsChoiceBody">{body}</span>
      </span>
      {aside}
    </div>
  )
}

function RepositoryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="dshDesktopSettingsChoiceLink"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={event => { event.stopPropagation() }}
    >
      {children}
    </a>
  )
}

export function DesktopSettingsToggleRow({
  label,
  badge,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode
  badge?: ReactNode
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const labelId = useId()
  return (
    <div className="dshDesktopSettingsToggleRow">
      <span className="dshDesktopSettingsToggleLabel" id={labelId}>
        {label}
        {badge !== undefined && <span className="dshDesktopSettingsBadge">{badge}</span>}
      </span>
      <button
        type="button"
        role="switch"
        className="dshDesktopSettingsToggle"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => { onChange(!checked) }}
      >
        <span className="dshDesktopSettingsToggleKnob" aria-hidden="true" />
      </button>
    </div>
  )
}

function profileState(profile: DesktopProfileView, t: Translate): string {
  if (!profile.exists || !profile.webCapable || !profile.selectable) return t('profileUnavailable')
  return t('profileReady')
}

export const MARKET_OPTIONS: readonly {
  id: DesktopMarketProvider
  title: DesktopSettingsLocaleKey
  body: DesktopSettingsLocaleKey
}[] = [
  { id: 'disabled', title: 'marketDisabled', body: 'marketDisabledBody' },
  { id: 'community-market', title: 'communityMarket', body: 'communityMarketBody' },
  { id: 'dsh-market', title: 'dshMarket', body: 'dshMarketBody' },
]

const COMMUNITY_MARKET_URL = 'https://github.com/anywhere-labs/deepseek-harness-desktop/tree/master/dsh-community-market'
const DSH_MARKET_URL = 'https://github.com/dsh-market/dsh-market'
const AWESOME_DSH_PLUGIN_URL = 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin'

export function marketTitle(option: (typeof MARKET_OPTIONS)[number], t: Translate): ReactNode {
  if (option.id === 'community-market') {
    return <RepositoryLink href={COMMUNITY_MARKET_URL}>{t(option.title)}</RepositoryLink>
  }
  if (option.id === 'dsh-market') {
    return <RepositoryLink href={DSH_MARKET_URL}>{t(option.title)}</RepositoryLink>
  }
  return t(option.title)
}

export function marketBody(option: (typeof MARKET_OPTIONS)[number], t: Translate): ReactNode {
  if (option.id !== 'dsh-market') return t(option.body)
  return (
    <>
      {t(option.body)}{' '}
      <RepositoryLink href={AWESOME_DSH_PLUGIN_URL}>awesome-dsh-plugin</RepositoryLink>
    </>
  )
}

function DesktopBrowserUrl({ url, api, t, onOpen }: {
  url: string
  api: DesktopSettingsApi
  t: Translate
  onOpen: React.MouseEventHandler<HTMLAnchorElement>
}) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  const link = <a href={url} onClick={onOpen} target="_blank" rel="noopener noreferrer">{url}</a>
  if (!api.copyBrowser) return link
  const copy = async (): Promise<void> => {
    setBusy(true); setFailed(false); setCopied(false)
    try { await api.copyBrowser!(url); setCopied(true) } catch { setFailed(true) } finally { setBusy(false) }
  }
  return <>
    <div className="dshDesktopSettingsUrlRow">
      {link}
      <button type="button" className="dshDesktopSettingsUrlCopy" disabled={busy}
        aria-label={`${t('copyBrowserUrl')} ${new URL(url).host}`} title={t(copied ? 'browserUrlCopied' : 'copyBrowserUrl')}
        onClick={() => { void copy() }}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
    {failed && <p role="alert" className="dshDesktopSettingsError">{t('operationFailed')}</p>}
  </>
}

/** Render the Desktop settings page. */
export function DesktopSettingsSection({
  t,
  api,
  platform,
  version,
  initialMode,
  setMode: persistMode,
  desktopSettings,
  notificationSettings,
  capabilities,
  introNotice,
  browserActions,
  extraSections,
}: DesktopSettingsSectionInjected & Pick<PropsLocale<'desktop.settings'>, 't'>) {
  const desktop = useScope(desktopSettings)
  const notifications = useScope(notificationSettings)
  const [view, setView] = useState<DesktopSettingsView>()
  const [profileName, setProfileName] = useState('')
  const [busy, setBusy] = useState<BusyOperation | undefined>('load')
  const [loadFailed, setLoadFailed] = useState(false)
  const [operationFailed, setOperationFailed] = useState(false)
  const [aaStatus, setAaStatus] = useState<'idle' | 'saving' | 'failed' | 'saved'>('idle')
  const [restart, setRestart] = useState<RestartState>('none')
  const [pendingProfileDelete, setPendingProfileDelete] = useState<string>()
  const [confirmLan, setConfirmLan] = useState(false)
  const [updateCheck, setUpdateCheck] = useState<'idle' | 'checking' | 'failed'>('idle')
  const lanPoll = useRef<AbortController>()

  const refreshView = useCallback(async () => {
    lanPoll.current?.abort()
    const controller = new AbortController()
    lanPoll.current = controller
    try {
      return await readDesktopSettingsUntilLanSettled(api, setView, controller.signal)
    } finally {
      if (lanPoll.current === controller) lanPoll.current = undefined
    }
  }, [api])

  const load = useCallback(async () => {
    setBusy('load')
    setLoadFailed(false)
    setOperationFailed(false)
    try {
      await refreshView()
    } catch (cause) {
      if (!isAbortError(cause)) setLoadFailed(true)
    } finally {
      setBusy(current => current === 'load' ? undefined : current)
    }
  }, [refreshView])

  useEffect(() => { void load() }, [load])
  useEffect(() => () => { lanPoll.current?.abort() }, [])
  useEffect(() => {
    if (restart !== 'restarting') return
    const timer = setTimeout(() => { setRestart('required') }, 8_000)
    return () => { clearTimeout(timer) }
  }, [restart])

  const run = useCallback(async (operation: BusyOperation, invoke: () => Promise<void>) => {
    setBusy(operation)
    setOperationFailed(false)
    if (operation !== 'select-aa') setAaStatus('idle')
    try {
      await invoke()
    } catch {
      setOperationFailed(true)
    } finally {
      setBusy(current => current === operation ? undefined : current)
    }
  }, [])

  const requestRestart = (): void => { setRestart('restarting') }
  const settingsWritable = desktop.status === 'ready' && desktop.writable
  const notificationsWritable = notifications.status === 'ready' && notifications.writable
  const storedMode = desktop.value?.mode ?? initialMode
  const configuredNetworkExposure = desktop.value?.networkExposure ?? 'loopback'
  const browserAccess = desktopBrowserAccessEnabled(
    storedMode,
    desktop.value?.openBrowser ?? false,
    configuredNetworkExposure,
  )
  const mode = storedMode
  const networkExposure = browserAccess ? configuredNetworkExposure : 'loopback'
  const notificationValue = notifications.value ?? {
    enabled: true,
    notifyOnTurnCompletion: true,
    notifyOnTurnFailure: true,
    notifyOnJobCompletion: true,
    notifyOnJobFailure: true,
    notifyOnScheduleCompletion: true,
    notifyOnScheduleFailure: true,
  }

  const createProfile = (event: FormEvent): void => {
    event.preventDefault()
    const name = profileName.trim()
    if (name.length === 0) return
    void run('create-profile', async () => {
      setView(await api.createProfile(name))
      setProfileName('')
    })
  }

  const selectProfile = (name: string): void => {
    void run('select-profile', async () => {
      const response = await api.selectProfile(name)
      if (response.restartRequired) requestRestart()
      else setView(await refreshView())
    })
  }

  const deleteProfile = (name: string): void => {
    void run('delete-profile', async () => {
      setView(await api.deleteProfile(name))
      setPendingProfileDelete(undefined)
    })
  }

  const selectAa = (enabled: boolean): void => {
    setAaStatus('saving')
    void run('select-aa', async () => {
      try {
        if (!api.selectAa) throw new Error('AA selection is unavailable')
        const response = await api.selectAa(enabled)
        setView(current => current === undefined ? current : {
          ...current, aa: { requested: enabled, effective: current.aa?.effective ?? false },
        })
        setAaStatus('saved')
        if (response.restartRequired) requestRestart()
        else setView(await refreshView())
      } catch (cause) {
        setAaStatus('failed')
        throw cause
      }
    })
  }

  const selectMarket = (provider: DesktopMarketProvider): void => {
    void run('select-market', async () => {
      const response = await api.selectMarket(provider)
      setView(current => current === undefined ? current : {
        ...current,
        market: { requested: provider, effective: current.market.effective, legacyDefaulted: false },
      })
      if (response.restartRequired) requestRestart()
      else setView(await refreshView())
    })
  }

  const openBrowser = (event: React.MouseEvent<HTMLAnchorElement>, url: string): void => {
    if (!api.openBrowser) return
    event.preventDefault()
    void run('web', () => api.openBrowser!(url))
  }

  const setMode = (next: DesktopShellSettings['mode']): void => {
    void run('mode', async () => {
      await persistMode(next)
      requestRestart()
    })
  }

  const setMaterial = (next: string): void => {
    void run('material', async () => {
      if (platform === 'darwin') {
        if (next !== 'off' && next !== 'transparent') {
          throw new Error(`dsh-plugin-desktop: invalid macOS material ${JSON.stringify(next)}`)
        }
        await desktopSettings.set('macosMaterial', next)
      } else if (platform === 'linux') {
        if (next !== 'off' && next !== 'transparent') {
          throw new Error(`dsh-plugin-desktop: invalid Linux material ${JSON.stringify(next)}`)
        }
        await desktopSettings.set('linuxMaterial', next)
      }
      if (capabilities?.materialRequiresRestart !== false) requestRestart()
    })
  }

  const setNotification = (field: keyof DesktopNotificationSettings, checked: boolean): void => {
    void run('notification', async () => { await notificationSettings.set(field, checked) })
  }

  // The interactive update flow owns its own native dialogs and downloads, so it
  // stays outside the settings-scope busy state and reports only its own failures.
  const runUpdateCheck = (): void => {
    setUpdateCheck('checking')
    void api.checkForUpdates()
      .then(() => { setUpdateCheck('idle') })
      .catch(() => { setUpdateCheck('failed') })
  }

  const setBrowserAccess = (checked: boolean): void => {
    void run('web', async () => {
      if (checked) {
        if (!desktopBrowserAccessAvailable(mode)) return
        await persistDesktopBrowserAccessHot(desktopSettings, true, configuredNetworkExposure, refreshView)
        return
      }
      await persistDesktopBrowserAccessHot(desktopSettings, false, configuredNetworkExposure, refreshView)
    })
  }

  const setNetworkExposure = (exposure: DesktopShellSettings['networkExposure']): void => {
    void run('web', async () => {
      if (exposure === 'lan' && (!desktopBrowserAccessAvailable(mode) || !browserAccess)) return
      await persistDesktopNetworkExposureHot(desktopSettings, exposure, refreshView)
    })
  }

  return (
    <div className="dshDesktopSettings">
      <header className="dshDesktopSettingsHeader">
        <h2>{t('title')}</h2>
        <p>{t('intro')}</p>
      </header>

      {introNotice}
      {operationFailed && aaStatus !== 'failed' && <p className="dshDesktopSettingsError" role="alert">{t('operationFailed')}</p>}
      {restart !== 'none' && (
        <p className="dshDesktopSettingsSuccess" role="status">
          {t(restart === 'restarting' ? 'restarting' : 'restartRequired')}
        </p>
      )}

      <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-profile-title">
        <div>
          <h3 id="dsh-desktop-profile-title">{t('profileTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{t('profileIntro')}</p>
        </div>
        {busy === 'load' && view === undefined && <p className="dshDesktopSettingsHint">{t('loading')}</p>}
        {loadFailed && view === undefined && (
          <div>
            <p className="dshDesktopSettingsError" role="alert">{t('unavailable')}</p>
            <button type="button" className="dshDesktopSettingsButton" onClick={() => { void load() }}>{t('retry')}</button>
          </div>
        )}
        {view !== undefined && (
          <>
            <div className="dshDesktopSettingsList" role="radiogroup" aria-labelledby="dsh-desktop-profile-title">
              {view.profiles.map((profile) => {
                const current = profile.name === view.current
                const deleteAction = profile.deletable && !current && busy === undefined && restart === 'none'
                  ? (
                    <div className="dshDesktopSettingsChoiceAside" onClick={event => { event.stopPropagation() }}>
                      {pendingProfileDelete === profile.name ? (
                        <div className="dshDesktopSettingsDeleteConfirm" role="group" aria-label={t('confirmDeleteProfile')}>
                          <span className="dshDesktopSettingsDeleteWarning">{t('deleteProfileWarning')}</span>
                          <span className="dshDesktopSettingsDeleteActions">
                            <button
                              type="button"
                              className="dshDesktopSettingsButton dshDesktopSettingsButtonDanger"
                              disabled={busy !== undefined}
                              onClick={() => { deleteProfile(profile.name) }}
                            >
                              {busy === 'delete-profile' ? t('deletingProfile') : t('confirmDeleteProfile')}
                            </button>
                            <button
                              type="button"
                              className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary"
                              disabled={busy !== undefined}
                              onClick={() => { setPendingProfileDelete(undefined) }}
                            >
                              {t('cancelDeleteProfile')}
                            </button>
                          </span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary"
                          onClick={() => { setPendingProfileDelete(profile.name) }}
                        >
                          {t('deleteProfile')}
                        </button>
                      )}
                    </div>
                  ) : undefined
                return (
                  <Choice
                    key={profile.name}
                    title={profile.name}
                    body={profileState(profile, t)}
                    selected={current}
                    disabled={!profile.selectable || busy !== undefined || restart !== 'none'}
                    action={() => { selectProfile(profile.name) }}
                    status={current ? t('activeProfile') : undefined}
                    aside={deleteAction}
                  />
                )
              })}
            </div>
            <form className="dshDesktopSettingsForm" onSubmit={createProfile}>
              <label className="dshDesktopSettingsField">
                {t('profileName')}
                <input
                  className="dshDesktopSettingsInput"
                  value={profileName}
                  maxLength={128}
                  autoComplete="off"
                  placeholder={t('profileNamePlaceholder')}
                  disabled={busy !== undefined || restart !== 'none'}
                  onChange={event => { setProfileName(event.currentTarget.value) }}
                />
              </label>
              <button
                type="submit"
                className="dshDesktopSettingsButton"
                disabled={profileName.trim().length === 0 || busy !== undefined || restart !== 'none'}
              >
                {busy === 'create-profile' ? t('creatingProfile') : t('create')}
              </button>
            </form>
          </>
        )}
      </section>

      {capabilities?.pluginSelectors !== false && <>
      <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-market-title">
        <div>
          <h3 id="dsh-desktop-market-title">{t('marketTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{t('marketIntro')}</p>
        </div>
        {view?.market.legacyDefaulted === true && <p className="dshDesktopSettingsNotice">{t('legacyMarketNotice')}</p>}
        {view !== undefined && view.market.requested !== view.market.effective && restart === 'none' && (
          <p className="dshDesktopSettingsNotice" role="status">{t('marketLoadFailed')}</p>
        )}
        {view !== undefined && (
          <div className="dshDesktopSettingsList" role="radiogroup" aria-labelledby="dsh-desktop-market-title">
            {MARKET_OPTIONS.filter(option => capabilities?.markets === undefined || capabilities.markets.includes(option.id)).map(option => (
              <Choice
                key={option.id}
                title={marketTitle(option, t)}
                badge={option.id === 'community-market' ? t('beta') : undefined}
                body={marketBody(option, t)}
                selected={view.market.requested === option.id}
                reselectable={view.market.requested === option.id && view.market.requested !== view.market.effective}
                disabled={capabilities?.featuresReadOnly === true || busy !== undefined || restart !== 'none'}
                action={() => { selectMarket(option.id) }}
                status={view.market.requested === option.id && view.market.requested !== view.market.effective
                    ? t('retryMarket')
                    : view.market.requested === option.id ? t('selected') : undefined}
              />
            ))}
          </div>
        )}
      </section>

      <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-aa-title">
        <div>
          <h3 id="dsh-desktop-aa-title">{t('aaTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{t('aaIntro')}</p>
        </div>
        {view?.aa?.requested === true && !view.aa.effective && restart === 'none' && (
          <p className="dshDesktopSettingsNotice" role="status">{t('aaLoadFailed')}</p>
        )}
        {aaStatus === 'saving' && <p className="dshDesktopSettingsNotice" role="status">{t('aaSaving')}</p>}
        {aaStatus === 'failed' && <p className="dshDesktopSettingsError" role="alert">{t('aaSaveFailed')}</p>}
        {aaStatus === 'saved' && <p className="dshDesktopSettingsSuccess" role="status">
          {t(restart === 'restarting' ? 'restarting' : restart === 'required' ? 'restartRequired' : 'aaSaved')}
        </p>}
        {view !== undefined && <div className="dshDesktopSettingsList" role="radiogroup" aria-labelledby="dsh-desktop-aa-title">
          {[false, true].map(enabled => <Choice
            key={String(enabled)}
            title={t(enabled ? 'aaEnabled' : 'aaDisabled')}
            badge={enabled ? t('beta') : undefined}
            body={t(enabled ? 'aaEnabledBody' : 'aaDisabledBody')}
            selected={(view.aa?.requested ?? false) === enabled}
            reselectable={enabled && view.aa?.requested === true && !view.aa.effective}
            disabled={capabilities?.featuresReadOnly === true || busy !== undefined || restart !== 'none'}
            action={() => { selectAa(enabled) }}
            status={enabled && view.aa?.requested === true && !view.aa.effective
              ? t('retryAa') : (view.aa?.requested ?? false) === enabled ? t('selected') : undefined}
          />)}
        </div>}
      </section>

      </>}

      {/* Window modes, or macOS's material choice; with neither the group would be empty. */}
      {(capabilities?.windowModes !== false || platform === 'darwin') && <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-presentation-title">
        <div>
          <h3 id="dsh-desktop-presentation-title">{t('presentationTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{t('presentationIntro')}</p>
        </div>
        {desktop.status === 'unavailable' && <p className="dshDesktopSettingsNotice">{t('readOnly')}</p>}
        {capabilities?.windowModes !== false && <div className="dshDesktopSettingsList" role="radiogroup" aria-labelledby="dsh-desktop-presentation-title">
          <Choice
            title={t('compatibilityMode')}
            body={t('compatibilityModeBody')}
            selected={mode === 'compatibility'}
            disabled={!settingsWritable || busy !== undefined || restart !== 'none'}
            action={() => { setMode('compatibility') }}
            status={mode === 'compatibility' ? t('selected') : undefined}
          />
          <Choice
            title={t('extendedMode')}
            body={platform === 'linux' ? t('extendedUnavailableLinux') : t('extendedModeBody')}
            selected={mode === 'extended'}
            disabled={platform === 'linux' || !settingsWritable || busy !== undefined || restart !== 'none'}
            action={() => { setMode('extended') }}
            status={mode === 'extended' ? t('selected') : undefined}
          />
          <Choice
            title={t('advancedMode')}
            body={platform === 'linux' ? t('advancedUnavailableLinux') : t('advancedModeBody')}
            selected={mode === 'advanced'}
            disabled={platform === 'linux' || !settingsWritable || busy !== undefined || restart !== 'none'}
            action={() => { setMode('advanced') }}
            status={mode === 'advanced' ? t('selected') : undefined}
          />
        </div>}
        {platform === 'darwin' && (
          <label className="dshDesktopSettingsMaterialField">
            <span className="dshDesktopSettingsMaterialCopy">
              <span className="dshDesktopSettingsChoiceTitle">{t('windowMaterial')}</span>
              <span className="dshDesktopSettingsChoiceBody">{t('windowMaterialBody')}</span>
            </span>
            <select
              className="dshDesktopSettingsSelect"
              value={desktop.value?.macosMaterial ?? 'transparent'}
              disabled={!settingsWritable || busy !== undefined || restart !== 'none'}
              onChange={event => { setMaterial(event.currentTarget.value) }}
            >
              <option value="off">{t('windowMaterialOff')}</option>
              <option value="transparent">{t('windowMaterialTransparent')}</option>
            </select>
          </label>
        )}
      </section>}

      <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-web-title">
        <div>
          <h3 id="dsh-desktop-web-title">{t('webTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{t('webIntro')}</p>
        </div>
        <DesktopSettingsToggleRow
          label={t('openBrowser')}
          checked={browserAccess}
          disabled={!desktopBrowserAccessAvailable(mode) || !settingsWritable || busy !== undefined}
          onChange={setBrowserAccess}
        />
        <p className="dshDesktopSettingsNotice">{t('browserCompatibilityNotice')}</p>
        <DesktopSettingsToggleRow
          label={t('lanAccess')}
          badge={t('beta')}
          checked={networkExposure === 'lan'}
          disabled={!browserAccess || !settingsWritable || busy !== undefined}
          onChange={(checked) => {
            if (checked && capabilities?.nativeLanConfirmation !== true) setConfirmLan(true)
            else if (checked) setNetworkExposure('lan')
            else setNetworkExposure('loopback')
          }}
        />
        {view !== undefined && (
          <div className="dshDesktopSettingsLanStatus" data-state={view.web.lanState} role="status">
            <span className="dshDesktopSettingsChoiceTitle">
              {t('lanStatus')}
              <span className="dshDesktopSettingsBadge">{t(LAN_STATE_LOCALE_KEYS[view.web.lanState])}</span>
            </span>
            {view.web.lanError !== null && (
              <span className="dshDesktopSettingsChoiceBody">
                {t('lanError')}: <code>{view.web.lanError}</code>
              </span>
            )}
          </div>
        )}
        {desktopBrowserUrlsShouldRender(browserAccess, networkExposure) && view !== undefined && view.web.localUrl !== '' && (
          <div className="dshDesktopSettingsUrls">
            <span className="dshDesktopSettingsChoiceTitle">{t('browserUrls')}</span>
            <DesktopBrowserUrl key={view.web.localUrl} url={view.web.localUrl} api={api} t={t} onOpen={event => openBrowser(event, view.web.localUrl)} />
            {view.web.lanUrls.length > 0 && <span className="dshDesktopSettingsChoiceTitle">{t('lanHttpsUrls')}</span>}
            {view.web.lanUrls.map(url => <DesktopBrowserUrl key={url} url={url} api={api} t={t} onOpen={event => openBrowser(event, url)} />)}
          </div>
        )}
        {browserActions}
        {networkExposure === 'lan' && view !== undefined && (
          <>
            <p className="dshDesktopSettingsNotice">{t('lanTrustNotice')}</p>
            {(view.web.lanCaFingerprint !== null || view.web.lanCaUrls.length > 0) && (
              <div className="dshDesktopSettingsUrls">
                <span className="dshDesktopSettingsChoiceTitle">{t('lanCaTitle')}</span>
                {view.web.lanCaFingerprint !== null && (
                  <span className="dshDesktopSettingsLanFingerprint">
                    {t('lanCaFingerprint')}: <code>{view.web.lanCaFingerprint}</code>
                  </span>
                )}
                {view.web.lanCaUrls.length > 0 && <span className="dshDesktopSettingsChoiceBody">{t('lanCaDownloads')}</span>}
                {view.web.lanCaUrls.map(url => <a href={url} key={url} target="_blank" rel="noopener noreferrer">{url}</a>)}
              </div>
            )}
          </>
        )}
      </section>

      <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-notifications-title">
        <div>
          <h3 id="dsh-desktop-notifications-title">{t('notificationsTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{t('notificationsIntro')}</p>
        </div>
        {notifications.status === 'unavailable' && <p className="dshDesktopSettingsNotice">{t('readOnly')}</p>}
        <DesktopSettingsToggleRow
          label={t('notificationsEnabled')}
          checked={notificationValue.enabled}
          disabled={!notificationsWritable || busy !== undefined}
          onChange={checked => { setNotification('enabled', checked) }}
        />
        <div className="dshDesktopSettingsDetails">
          <DesktopSettingsToggleRow
            label={t('turnCompletion')}
            checked={notificationValue.notifyOnTurnCompletion}
            disabled={!notificationValue.enabled || !notificationsWritable || busy !== undefined}
            onChange={checked => { setNotification('notifyOnTurnCompletion', checked) }}
          />
          <DesktopSettingsToggleRow
            label={t('turnFailure')}
            checked={notificationValue.notifyOnTurnFailure}
            disabled={!notificationValue.enabled || !notificationsWritable || busy !== undefined}
            onChange={checked => { setNotification('notifyOnTurnFailure', checked) }}
          />
          <DesktopSettingsToggleRow
            label={t('scheduleCompletion')}
            checked={notificationValue.notifyOnScheduleCompletion}
            disabled={!notificationValue.enabled || !notificationsWritable || busy !== undefined}
            onChange={checked => { setNotification('notifyOnScheduleCompletion', checked) }}
          />
          <DesktopSettingsToggleRow
            label={t('scheduleFailure')}
            checked={notificationValue.notifyOnScheduleFailure}
            disabled={!notificationValue.enabled || !notificationsWritable || busy !== undefined}
            onChange={checked => { setNotification('notifyOnScheduleFailure', checked) }}
          />
          {capabilities?.jobNotifications !== false && <><DesktopSettingsToggleRow
            label={t('jobCompletion')}
            checked={notificationValue.notifyOnJobCompletion}
            disabled={!notificationValue.enabled || !notificationsWritable || busy !== undefined}
            onChange={checked => { setNotification('notifyOnJobCompletion', checked) }}
          />
          <DesktopSettingsToggleRow
            label={t('jobFailure')}
            checked={notificationValue.notifyOnJobFailure}
            disabled={!notificationValue.enabled || !notificationsWritable || busy !== undefined}
            onChange={checked => { setNotification('notifyOnJobFailure', checked) }}
          /></>}
        </div>
      </section>

      {capabilities?.updates !== false && (
        <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-updates-title">
          <div>
            <h3 id="dsh-desktop-updates-title">{t('updatesTitle')}</h3>
            <p className="dshDesktopSettingsGroupIntro">{t('updatesIntro')}</p>
          </div>
          <div className="dshDesktopSettingsUpdateRow">
            <span className="dshDesktopSettingsChoiceCopy">
              <span className="dshDesktopSettingsChoiceTitle">{t('currentVersion')}</span>
              <span className="dshDesktopSettingsChoiceBody">{`v${version}`}</span>
            </span>
            <button
              type="button"
              className="dshDesktopSettingsButton"
              disabled={updateCheck === 'checking'}
              onClick={runUpdateCheck}
            >
              {t(updateCheck === 'checking' ? 'checkingForUpdates' : 'checkForUpdates')}
            </button>
          </div>
          {updateCheck === 'failed' && (
            <p className="dshDesktopSettingsError" role="alert">{t('checkForUpdatesError')}</p>
          )}
        </section>
      )}

      {extraSections}
      {confirmLan && (
        <div className="dshDesktopSettingsDialogBackdrop" role="presentation">
          <div className="dshDesktopSettingsDialog" role="alertdialog" aria-modal="true" aria-labelledby="dsh-desktop-lan-warning-title" aria-describedby="dsh-desktop-lan-warning-body">
            <h3 id="dsh-desktop-lan-warning-title">{t('lanWarningTitle')}</h3>
            <p id="dsh-desktop-lan-warning-body">{t('lanWarningBody')}</p>
            <div className="dshDesktopSettingsDialogActions">
              <button
                type="button"
                className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary"
                onClick={() => {
                  resolveDesktopLanConfirmation(false, () => { setConfirmLan(false) }, () => { setNetworkExposure('lan') })
                }}
              >
                {t('lanCancel')}
              </button>
              <button
                type="button"
                className="dshDesktopSettingsButton dshDesktopSettingsButtonDanger"
                onClick={() => {
                  resolveDesktopLanConfirmation(true, () => { setConfirmLan(false) }, () => { setNetworkExposure('lan') })
                }}
              >
                {t('lanConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
