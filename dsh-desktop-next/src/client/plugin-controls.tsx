/** Desktop choices on the official Plugins overview, using its manager and existing controls. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { BundleInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, PluginArtworkDefault, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { Choice, MARKET_OPTIONS, marketBody, marketTitle } from '../../../dsh-plugin-desktop-beta/src/client/DesktopSettingsSection.tsx'
import { en as desktopEn, zh as desktopZh, type DesktopSettingsLocaleKey } from '../../../dsh-plugin-desktop-beta/src/client/desktop-settings-locales.ts'
import { ComputerUseSettings } from './computer-use.tsx'
import { COMMUNITY_MARKET as COMMUNITY, DSH_MARKET as MARKET, marketToggleTargets, type MarketName } from './market-toggle.ts'

const REMOTE = '@agents-anywhere/dsh-bridge-next'
const COMPUTER_ITEM = 'desktop-next-computer-use'

type Translate = (cn: string, en: string) => string

export function registerPluginControls(ctx: Context): void {
  ctx.inject(['remote', 'remote.pluginManager'], inner => {
    inner.slots.inject('plugins.overview', () => {
      const dispose = inner.slots.register({ name: 'plugins.overview', id: 'desktop-next', order: 0,
        locale: 'desktop-next', inject: () => ({ context: inner }),
      }, PluginControls)
      const hidden = [COMMUNITY, MARKET, REMOTE].map(key => inner.slots.register({ name: 'plugins.bundle.hidden', key }, () => null))
      const item = inner.slots.register({ name: 'plugins.item', id: COMPUTER_ITEM, label: 'Computer Use',
        locale: 'desktop-next', inject: () => ({ context: inner }),
      }, ComputerUseItem)
      const hiddenItem = inner.slots.register({ name: 'plugins.item.hidden', key: COMPUTER_ITEM }, () => null)
      const actions = inner.slots.register({ name: 'plugins.detail.actions', id: COMPUTER_ITEM,
        locale: 'desktop-next', inject: () => ({ context: inner }),
      }, ComputerUseActions)
      return () => { actions(); hiddenItem(); item(); for (const off of hidden) off(); dispose() }
    })
  })
}

function PluginControls({ context, t: translate, onOpenBundle, onOpenItem }: PropsLocale<'desktop-next'> & PropsRuntime<'plugins.overview'> & { context: Context }) {
  const zh = translate('language') === 'zh'
  const t = (cn: string, en: string): string => zh ? cn : en
  const desktopCopy = zh ? desktopZh : desktopEn
  const desktopText = (key: string): string => Object.hasOwn(desktopCopy, key) ? desktopCopy[key as DesktopSettingsLocaleKey] : key
  const [bundles, setBundles] = useState<BundleInfo[]>([])
  const [revision, refresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [preferredMarket, setPreferredMarket] = useState<MarketName>(COMMUNITY)
  const pending = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const reload = (): void => { refresh(value => value + 1) }
    const off = context.remote.$on('plugin-manager/changed', reload)
    const reset = context.on('connection/reset', reload)
    window.addEventListener('focus', reload)
    return () => { off(); reset(); window.removeEventListener('focus', reload) }
  }, [context])
  useEffect(() => {
    let disposed = false
    setLoading(true)
    void context.remote.pluginManager.listBundles().then(result => {
      if (disposed) return
      if (!result.ok) throw new Error(result.error.message)
      setBundles(result.value)
    }).catch(failure => { if (!disposed) { setBundles([]); setError(String(failure)) } })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [context, revision])
  const community = bundles.find(row => row.name === COMMUNITY)
  const market = bundles.find(row => row.name === MARKET)
  useEffect(() => {
    if (community?.enabled && !market?.enabled) setPreferredMarket(COMMUNITY)
    if (market?.enabled && !community?.enabled) setPreferredMarket(MARKET)
  }, [community?.enabled, market?.enabled])
  const change = async (names: readonly string[], enabled: boolean): Promise<void> => {
    if (pending.current || loading) return
    pending.current = true
    setBusy(true); setError(''); setNotice('')
    try {
      // Each Host operation writes its selection under the official Profile lock.
      for (const name of names) {
        const result = await context.remote.pluginManager.setBundleEnabled(name, enabled)
        if (!result.ok) throw new Error(result.error.message)
        const change = result.value
        if (change.application === 'failed' || change.application === 'cancelled') throw new Error(change.error?.diagnostic ?? t('无法更改插件状态。', 'Could not change the plugin state.'))
        if (change.application === 'restart-required') setNotice(t('已保存，请重启后台服务以应用。', 'Saved. Restart the background service to apply.'))
        if (change.application === 'overridden') setNotice(t('已保存，但当前配置覆盖了此选择。', 'Saved, but another configuration overrides this choice.'))
        if (enabled && (name === COMMUNITY || name === MARKET)) setPreferredMarket(name)
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { pending.current = false; setBusy(false); refresh(value => value + 1) }
  }
  const bothMarkets = community?.enabled === true && market?.enabled === true
  const locked = (row?: BundleInfo): boolean => loading || busy || !row || row.readOnlyReason !== undefined || row.error !== undefined
  const activeMarkets = [community, market].flatMap(row => row?.enabled === true ? [row] : [])
  const marketToggleLocked = loading || busy || marketToggleTargets(bundles, preferredMarket, activeMarkets.length === 0).length === 0
  return <div className="dshNextPluginControls" data-next-plugin-controls>
    <section className="dshDesktopSettingsGroup" data-next-markets aria-labelledby="next-market-title">
      <div className="dshNextMarketHeader">
        <div><h3 id="next-market-title">{desktopText('marketTitle')}</h3>
          <p className="dshDesktopSettingsGroupIntro">{desktopText('marketIntro')}</p></div>
        <Switch label={t('启用插件市场', 'Enable plugin market')} checked={activeMarkets.length > 0}
          disabled={marketToggleLocked} onChange={enabled => {
            void change(marketToggleTargets(bundles, preferredMarket, enabled), enabled)
          }} />
      </div>
      <div className="dshNextMarketChoices" role="radiogroup" aria-labelledby="next-market-title">
        {MARKET_OPTIONS.filter(option => option.id !== 'disabled').map(option => {
          const isCommunity = option.id === 'community-market'
          const row = isCommunity ? community : market
          return <Choice key={option.id} title={marketTitle(option, desktopText)} body={marketBody(option, desktopText)}
            badge={isCommunity ? desktopText('beta') : undefined} selected={row?.enabled === true && !bothMarkets}
            disabled={locked(row)} action={() => { void change([isCommunity ? COMMUNITY : MARKET], true) }} />
        })}
      </div>
      {bothMarkets && <p role="status" className="dshDesktopSettingsHint">{t('当前两个市场均已开启，请选择保留其中一个。', 'Both markets are currently enabled. Choose which one to keep.')}</p>}
    </section>
    <div className="dshNextPluginSections">
      <PluginCard title={t('远程控制', 'Remote Control')} description={remoteDescription(t)}
        icon={<PluginArtworkDefault size={36} />} onOpen={() => { onOpenBundle(REMOTE) }}>
        <RemoteControlSettings context={context} t={t} />
      </PluginCard>
      <PluginCard title="Computer Use" description={computerDescription(t)}
        icon={<PluginArtworkDefault size={36} />} onOpen={() => { onOpenItem(COMPUTER_ITEM) }}>
        <ComputerUseSettings context={context} zh={zh} />
      </PluginCard>
    </div>
    {notice && <p role="status" className="dshDesktopSettingsHint">{notice}</p>}
    {error && <div role="alert" className="dshDesktopSettingsError">{error} <Button variant="outline" size="sm" disabled={loading || busy} onClick={() => { setError(''); refresh(value => value + 1) }}>{t('重试', 'Retry')}</Button></div>}
  </div>
}

const remoteDescription = (t: Translate): string => t(
  '通过 Agents Anywhere 从手机或其他设备连接。启用后，在侧边栏的“远程控制”中完成配对。',
  'Connect from your phone or another device with Agents Anywhere. After enabling, pair it from Remote Control in the sidebar.',
)

const computerDescription = (t: Translate): string => t(
  '让 AI 查看屏幕、操作鼠标和键盘。截图理解需要支持图片输入的模型。',
  'Let AI view the screen and control the mouse and keyboard. Understanding screenshots requires a model with image input.',
)

function ComputerUseItem({ context, t, view }: PropsLocale<'desktop-next'> & PropsRuntime<'plugins.item'> & { context: Context }) {
  const zh = t('language') === 'zh'
  if (view === 'summary') return computerDescription((cn, en) => zh ? cn : en)
  return <ComputerUseSettings context={context} zh={zh} mode="page" />
}

function ComputerUseActions({ context, t, subject }: PropsLocale<'desktop-next'> & PropsRuntime<'plugins.detail.actions'> & { context: Context }) {
  if (subject.kind !== 'item' || subject.id !== COMPUTER_ITEM) return null
  return <ComputerUseSettings context={context} zh={t('language') === 'zh'} mode="actions" />
}

function PluginCard({ title, description, icon, onOpen, children }: {
  title: string; description: string; icon: ReactNode; onOpen(): void; children: ReactNode
}) {
  return <div className="dshNextPluginCard" data-next-plugin-card>
    <span className="dshNextPluginIcon" aria-hidden="true">{icon}</span>
    <div className="dshNextPluginCardMain">
      <button type="button" className="dshNextPluginCardOpen" aria-label={`${title} — ${description}`} onClick={onOpen}>{title}</button>
      <span className="dshNextPluginCardDescription">{description}</span>
    </div>
    <div className="dshNextPluginCardActions">{children}</div>
  </div>
}

function RemoteControlSettings({ context, t }: { context: Context; t: Translate }) {
  const [row, setRow] = useState<BundleInfo>()
  const [revision, refresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const reload = (): void => { refresh(value => value + 1) }
    const off = context.remote.$on('plugin-manager/changed', reload)
    const reset = context.on('connection/reset', reload)
    window.addEventListener('focus', reload)
    return () => { off(); reset(); window.removeEventListener('focus', reload) }
  }, [context])
  useEffect(() => {
    let disposed = false
    setLoading(true)
    void context.remote.pluginManager.listBundles().then(result => {
      if (disposed) return
      if (!result.ok) throw new Error(result.error.message)
      setRow(result.value.find(bundle => bundle.name === REMOTE))
    }).catch(failure => { if (!disposed) { setRow(undefined); setError(String(failure)) } })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [context, revision])
  const change = async (enabled: boolean): Promise<void> => {
    if (busy || loading || !row) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await context.remote.pluginManager.setBundleEnabled(REMOTE, enabled)
      if (!result.ok) throw new Error(result.error.message)
      const change = result.value
      if (change.application === 'failed' || change.application === 'cancelled') throw new Error(change.error?.diagnostic ?? t('无法更改插件状态。', 'Could not change the plugin state.'))
      if (change.application === 'restart-required') setNotice(t('已保存，请重启后台服务以应用。', 'Saved. Restart the background service to apply.'))
      if (change.application === 'overridden') setNotice(t('已保存，但当前配置覆盖了此选择。', 'Saved, but another configuration overrides this choice.'))
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false); refresh(value => value + 1) }
  }
  const openPanel = (): void => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-slot="sidebar.footer.action"] button[aria-haspopup="dialog"][aria-label="远程控制"], [data-slot="sidebar.footer.action"] button[aria-haspopup="dialog"][aria-label="Remote Control"], [data-slot="sidebar.footer.action"] button[aria-haspopup="dialog"][aria-label="Mobile connection"], [data-slot="sidebar.footer.action"] button[aria-haspopup="dialog"][aria-label="手机连接"], [data-slot="sidebar.footer.action"] button[aria-haspopup="dialog"][aria-label="Agents Anywhere"]')
    if (trigger) { setError(''); trigger.click() }
    else setError(t('远程控制界面尚未就绪，请稍后重试。', 'Remote control is not ready yet. Try again shortly.'))
  }
  return <div className="dshNextPluginDetail" data-next-remote-control>
    <div className="dshNextPluginActions">
      <Button variant="outline" size="sm" disabled={!row?.enabled || loading || busy} onClick={openPanel}>{t('打开面板', 'Open panel')}</Button>
      <Switch label={t('启用远程控制', 'Enable remote control')} checked={row?.enabled ?? false}
        disabled={loading || busy || !row || row.readOnlyReason !== undefined || row.error !== undefined}
        onChange={enabled => { void change(enabled) }} />
    </div>
    {notice && <span role="status" className="dshDesktopSettingsHint">{notice}</span>}
    {error && <span role="alert" className="dshDesktopSettingsError">{error}</span>}
  </div>
}
