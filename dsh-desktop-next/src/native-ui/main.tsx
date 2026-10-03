/** Existing Desktop utility pages; Next supplies only state and native actions. */
import { CSPProvider } from '@base-ui/react/csp-provider'
import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useState } from 'react'
import { RecoveryApp, type RecoveryState } from '../../../dsh-plugin-desktop-beta/src/native-ui/recovery/App.tsx'
import { ProfileCreateApp } from '../../../dsh-plugin-desktop-beta/src/native-ui/profile-create/App.tsx'
import { ProfileSelectorApp } from '../../../dsh-plugin-desktop-beta/src/native-ui/profile-selector/App.tsx'
import { DesktopFrame } from '../../../dsh-plugin-desktop-beta/src/native-ui/shared/DesktopFrame.tsx'
import { Alert, AlertDescription } from '../../../dsh-plugin-desktop-beta/src/native-ui/components/ui/alert.tsx'
import { desktopRecoveryCopy } from '../../../dsh-plugin-desktop-beta/src/recovery-copy.ts'
import { useDesktopState } from '../client/desktop-state.ts'
import { NextSettingsAdapter } from '../client/settings-adapter.ts'
import type { DesktopCommand } from '../desktop-contract.ts'
import { recoverySupport } from '../recovery-support.ts'
import './theme.css'

function App() {
  const adapter = useMemo(() => window.desktopNext ? new NextSettingsAdapter(window.desktopNext) : undefined, [])
  if (!adapter) return <Alert variant="destructive"><AlertDescription>Desktop controls could not load. Restart DSH NEXT.</AlertDescription></Alert>
  return <NativePages adapter={adapter} />
}

function NativePages({ adapter }: { adapter: NextSettingsAdapter }) {
  const state = useDesktopState(adapter)
  const locale = new URLSearchParams(location.search).get('locale') === 'zh' ? 'zh' : 'en'
  const t = (cn: string, en: string) => locale === 'zh' ? cn : en
  const [page, setPage] = useState(location.hash.slice(1) || 'recovery')
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { const change = () => setPage(location.hash.slice(1)); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change) }, [])
  const perform = async (command: DesktopCommand): Promise<void> => {
    if (busy) return
    setFailure(''); setBusy(true)
    try { await adapter.command(command) } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  useEffect(() => {
    const navigate = (event: MouseEvent): void => {
      const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]')
      if (!anchor) return
      const url = new URL(anchor.href)
      if (!['dsh-recovery:', 'dsh-profile-selector:'].includes(url.protocol)) return
      event.preventDefault()
      if (busy) return
      const actions: Record<string, DesktopCommand> = {
        restart: { type: 'recovery-action', action: 'restart' }, quit: { type: 'quit' }, cancel: { type: 'close-controls' },
        'enter-safe-mode': { type: 'safe-mode' }, 'normal-mode': { type: 'normal-mode' },
        'export-diagnostics': { type: 'diagnostics' },
        'open-terminal': { type: 'terminal' }, 'open-profile-directory': { type: 'open-profile' },
        'open-profile-creator': { type: 'controls', page: 'create-profile' }, create: { type: 'controls', page: 'create-profile' },
        recover: { type: 'recover' }, 'repair-global': { type: 'repair-global' },
        'open-home': { type: 'open-home' }, 'open-logs': { type: 'open-logs' },
      }
      const recoveryActions = ['open-checkpoint', 'preview-checkpoint', 'preview-uninstall',
        'preview-disable', 'preview-enable', 'open-settings-document',
        'open-profile-patch', 'open-profile-manifest', 'show-diagnostics', 'begin-change-data-directory',
        'restore-default-data-directory', 'factory-reset']
      if (recoveryActions.includes(url.hostname)) {
        const slot = /^slot-([123])$/.exec(url.searchParams.get('id') ?? '')
        const id = slot ? state?.recovery?.checkpoints[Number(slot[1]) - 1]?.id : url.searchParams.get('id') ?? undefined
        void perform({ type: 'recovery-action', action: url.hostname, ...(id ? { id } : {}) })
        return
      }
      const command = url.hostname === 'switch-profile' || url.hostname === 'switch'
        ? { type: 'switch' as const, name: url.searchParams.get('name') ?? '' } : actions[url.hostname]
      if (command) void perform(command)
    }
    document.addEventListener('click', navigate)
    return () => document.removeEventListener('click', navigate)
  }, [adapter, busy, state])
  if (!state) return <><DesktopFrame /><main className="dshNativeContent p-6"><Alert><AlertDescription>{t('正在读取桌面状态…', 'Loading Desktop state…')}</AlertDescription></Alert></main></>
  if (page === 'create-profile') return <ProfileCreateApp onCancel={() => { void perform({ type: 'close-controls' }) }} onCreate={async name => {
    await adapter.command({ type: 'create', name })
    await adapter.command({ type: 'switch', name })
    const updated = await adapter.refresh()
    if (updated.selected === name) await adapter.command({ type: 'close-controls' })
    else await adapter.command({ type: 'controls', page: 'profiles' })
  }} />
  const notice = failure ? { tone: 'error' as const, title: t('操作未完成', 'Action failed'), body: failure } : undefined
  const profiles = state.profiles.map(name => ({ name, current: name === state.selected, selectable: !state.unavailableProfiles.includes(name) }))
  if (page === 'profiles') return <ProfileSelectorApp state={{ locale, profiles, busy: busy || state.busy, restartReady: false, ...(notice ? { notice } : {}) }} />
  // Recovery, first-run setup and Profile tools work without a Host. Settings live in the app.
  const copy = { ...desktopRecoveryCopy(locale),
    restart: state.safeMode ? t('退出安全模式并重启', 'Exit Safe Mode and Restart') : t('退出并重启', 'Quit and restart'),
    safeModeBody: t('使用独立的临时环境，不载入原环境的插件、补丁和凭据。退出安全模式后移除临时数据，返回原 Profile。', 'Use a temporary environment without the original plugins, patches or credentials. Leaving Safe Mode removes temporary data and returns to the original Profile.'),
    safeModeActiveBody: t('当前主窗口使用临时环境。可在恢复助手中检查和修复原 Profile。退出安全模式并重启后，将返回原 Profile，临时数据不会保留。', 'The main window is using a temporary environment. Use the recovery assistant to inspect and repair the original Profile. Exiting Safe Mode and restarting returns to that Profile and removes the temporary data.'),
    rollbackGuideBody: t('将当前 Profile 的配置恢复到最近一次成功启动的状态。', 'Restore this Profile to its last successful-start configuration.'),
    rollbackBody: t('还原所选检查点的 Profile 配置并安装所需插件依赖，不回滚共享数据。', 'Restore the selected Profile configuration and install its required plugin dependencies, without reverting shared data.'),
  }
  const recovery: RecoveryState = {
    locale, failureStage: 'host-boot', failureDetail: state.failure, requested: !state.failure,
    snapshot: { profileName: state.selected, bundles: state.recovery?.bundles ?? [], checkpoints: (['slot-1', 'slot-2', 'slot-3'] as const).map((slotId, index) => {
      const checkpoint = state.recovery?.checkpoints[index]
      return { slotId, status: checkpoint ? 'available' as const : 'empty' as const,
        ...(checkpoint ? { capturedAt: checkpoint.created, fileCount: checkpoint.fileCount, totalBytes: checkpoint.totalBytes } : {}) }
    }) },
    ...(state.recovery?.error ? { snapshotError: state.recovery.error } : {}),
    profileDirectory: state.recovery?.profileDirectory,
    dataDirectory: { currentDirectory: state.home, usingDefaultDirectory: state.recovery?.usingDefaultDirectory ?? true, editing: false },
    busy: busy || state.busy, restartReady: true, activeTab: 'quick', configurationAvailable: true,
    diagnostics: state.recovery?.diagnosticsFile ? { status: 'saved', filename: state.recovery.diagnosticsFile } : { status: 'idle' }, logs: state.logs.slice(-24_000), profiles, profileActionToken: 'next', profileCreatorAvailable: true,
    terminalAvailable: state.platform === 'darwin' || state.platform === 'win32', safeModeAvailable: !state.safeMode, safeModeActive: state.safeMode,
    notice: notice ?? (busy ? undefined : state.recovery?.notice),
  }
  return <RecoveryApp state={recovery} copy={copy} support={recoverySupport(locale)} />
}

createRoot(document.getElementById('root')!).render(<CSPProvider disableStyleElements><App /></CSPProvider>)
