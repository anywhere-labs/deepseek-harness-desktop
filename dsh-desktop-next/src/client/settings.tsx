/** Mount the existing Desktop page and controls against Next's native adapter. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DesktopSettingsSection, DesktopSettingsToggleRow } from '../../../dsh-plugin-desktop-beta/src/client/DesktopSettingsSection.tsx'
import { DesktopNativeActions } from '../../../dsh-plugin-desktop-beta/src/client/DesktopNativeActions.tsx'
import { en, zh, type DesktopSettingsLocaleKey } from '../../../dsh-plugin-desktop-beta/src/client/desktop-settings-locales.ts'
import type { DesktopCommand, DesktopState } from '../desktop-contract.ts'
import { NextSettingsAdapter } from './settings-adapter.ts'
import { DesktopPermissionsSection } from './permissions.tsx'
import { useDesktopState } from './desktop-state.ts'
import { NextUpdateSettings } from './updates.tsx'

export function desktopTranslate(language: string): (key: string) => string {
  const copy = language.startsWith('zh') ? zh : en
  return key => {
    if (key === 'presentationTitle') return language.startsWith('zh') ? '窗口外观' : 'Window appearance'
    if (key === 'windowMaterialBody') return language.startsWith('zh') ? '设置窗口背景效果，更改后立即生效。' : 'Set the window background effect. Changes apply immediately.'
    if (key === 'deleteProfileWarning') return language.startsWith('zh') ? '此 Profile 将移入恢复备份目录。共享的会话和设置会保留。' : 'Move this Profile to recovery backups. Shared sessions and settings are retained.'
    if (key === 'presentationIntro') return language.startsWith('zh') ? '设置当前平台支持的窗口外观。' : 'Choose the window appearance supported on this platform.'
    if (key === 'browserCompatibilityNotice') return language.startsWith('zh') ? '开关即时生效；关闭访问会断开已有的浏览器连接。' : 'Changes take effect immediately. Disabling access disconnects existing browser connections.'
    return Object.hasOwn(copy, key) ? copy[key as DesktopSettingsLocaleKey] : key
  }
}

export function NextDesktopSettings({ adapter, language, onOpenPlugins }: { adapter: NextSettingsAdapter; language: string; onOpenPlugins(): void }) {
  const state = useDesktopState(adapter)
  const t = desktopTranslate(language)
  return <div data-next-desktop-settings=""><DesktopSettingsSection
    t={t} api={adapter.api} version={state?.version ?? ''} platform={state?.platform === 'darwin' || state?.platform === 'win32' ? state.platform : 'linux'}
    initialMode="compatibility"
    setMode={async () => { throw new Error('Window modes are not supported in Next') }}
    desktopSettings={adapter.desktopSettings} notificationSettings={adapter.notificationSettings}
    capabilities={{ logging: false, windowModes: false, pluginSelectors: false, updates: false, materialRequiresRestart: false, nativeLanConfirmation: true, jobNotifications: false }}
    introNotice={<div className="dshDesktopSettingsNotice dshNextPluginSettingsNotice" data-next-plugin-settings-notice>
      <span>{language.startsWith('zh') ? '插件市场和远程控制设置已移至插件页面。' : 'Plugin market and remote control settings have moved to the Plugins page.'}</span>
      <Button variant="outline" size="sm" onClick={onOpenPlugins}>{language.startsWith('zh') ? '前往插件页面' : 'Go to Plugins'}</Button>
    </div>}
    browserActions={state && <NextBrowserActions adapter={adapter} state={state} language={language} />}
    extraSections={<>
      {adapter.bridge.permissions && <DesktopPermissionsSection service={adapter.bridge.permissions} language={language} />}
      {state && <NextDesktopOptions adapter={adapter} state={state} language={language} />}
    </>}
  /></div>
}

export function NextDesktopActions({ adapter, language }: { adapter: NextSettingsAdapter; language: string }) {
  const state = useDesktopState(adapter)
  return <DesktopNativeActions api={adapter.api} t={desktopTranslate(language)} placement="settings" terminalAvailable={state?.platform === 'darwin' || state?.platform === 'win32'} />
}

function NextBrowserActions({ adapter, state, language }: { adapter: NextSettingsAdapter; state: DesktopState; language: string }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const run = async (): Promise<void> => {
    setBusy(true); setFailure('')
    try { await adapter.command({ type: 'export-ca' }) } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  if (!state.browserUrl || state.lan?.state !== 'ready') return null
  return <>
    {failure && <p role="alert" className="dshDesktopSettingsError">{failure}</p>}
    <div className="dshDesktopSettingsDialogActions">
      <button type="button" className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary" disabled={busy || state.busy} onClick={() => { void run() }}>{language.startsWith('zh') ? '导出 CA 证书' : 'Export CA certificate'}</button>
    </div>
  </>
}

/** Next-only preferences use the existing Desktop form and switch components. */
function NextDesktopOptions({ adapter, state, language }: { adapter: NextSettingsAdapter; state: DesktopState; language: string }) {
  const t = (cn: string, en: string): string => language.startsWith('zh') ? cn : en
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setFailure('')
    try { await operation() } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const action = (type: DesktopCommand['type'], cn: string, en: string, unavailable = false) => <button key={type} type="button" className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary" disabled={busy || state.busy || unavailable} onClick={() => { void run(() => adapter.command({ type } as DesktopCommand)) }}>{t(cn, en)}</button>
  return <>
    {failure && <p role="alert" className="dshDesktopSettingsError">{failure}</p>}
    <NextUpdateSettings state={state} language={language} run={command => { void run(() => adapter.command(command)) }} />
    <section className="dshDesktopSettingsGroup"><h3>{t('后台运行', 'Background operation')}</h3>
      <DesktopSettingsToggleRow label={t('关闭窗口后保持后台运行', 'Keep running after closing the window')} checked={state.preferences.closeToTray} disabled={busy || state.busy || state.safeMode} onChange={closeToTray => { void run(() => adapter.savePreferences({ closeToTray })) }} />
      <p className="dshDesktopSettingsHint">{state.trayAvailable ? t('可从托盘重新打开窗口。', 'Reopen the window from the tray.') : t('系统托盘不可用，关闭主窗口将退出应用。', 'The tray is unavailable; closing the main window quits the application.')}</p>
    </section>
    <section className="dshDesktopSettingsGroup"><h3>{t('桌面工具', 'Desktop tools')}</h3>
      <div className="dshDesktopSettingsDialogActions" style={{ flexWrap: 'wrap' }}>
        {action('restart-onboarding', '设置向导', 'Setup wizard', state.safeMode)}
        {action('open-home', '打开数据目录', 'Open data directory')}{action('open-profile', '打开 Profile 目录', 'Open Profile directory')}{action('open-logs', '打开日志目录', 'Open log directory')}{action('devtools', '开发者工具', 'Developer Tools')}
      </div>
      <label className="dshDesktopSettingsMaterialField">{t('日志级别', 'Log level')}<select className="dshDesktopSettingsSelect" value={state.preferences.logLevel} disabled={busy || state.busy || state.safeMode} onChange={event => { const logLevel = event.currentTarget.value as DesktopState['preferences']['logLevel']; void run(() => adapter.savePreferences({ logLevel })) }}>{['debug', 'info', 'warn', 'error'].map(value => <option key={value}>{value}</option>)}</select></label>
      <DesktopSettingsToggleRow label={t('开发者日志', 'Developer logging')} checked={state.preferences.developerLogging} disabled={busy || state.busy || state.safeMode} onChange={developerLogging => { void run(() => adapter.savePreferences({ developerLogging })) }} />
      <p className="dshDesktopSettingsHint">{t('记录模型请求、工具执行和通信的耗时与结果，不记录聊天正文或工具输入输出。日志保留七天，最多占用 200 MiB。会话事件可按序号与官方 Session Log 对照。', 'Record model requests, tool execution and communication timing and outcomes, without chat bodies or tool inputs and outputs. History is retained for seven days, up to 200 MiB. Match session events to the official Session Log by sequence number.')}</p>
      <button type="button" className="dshDesktopSettingsButton" onClick={() => { void run(() => adapter.command({ type: 'controls', page: 'recovery' })) }}>{t('打开恢复助手', 'Open recovery assistant')}</button>
    </section>
  </>
}
