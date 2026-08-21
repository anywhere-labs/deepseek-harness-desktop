import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  FilePenLine,
  FolderOpen,
  PackageX,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Terminal,
  Undo2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { buttonVariants } from '../components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { ScrollArea } from '../components/ui/scroll-area.tsx'
import { cn } from '../lib/utils.ts'

const SCHEME = 'dsh-recovery:'

type Locale = 'en' | 'zh'
type FailureStage =
  | 'electron-ready'
  | 'shell-environment'
  | 'runtime-bootstrap'
  | 'profile-selection'
  | 'install-recovery'
  | 'profile-composition'
  | 'host-boot'
  | 'renderer-startup'
  | 'health-commit'

interface RecoveryBundle {
  readonly bundleId: string
  readonly packageName: string
  readonly status: 'active' | 'disabled'
  readonly owner: 'core' | 'managed' | 'external'
  readonly action: 'disable' | null
}

interface RecoveryInstall {
  readonly recoveryId: string
  readonly packageName: string
  readonly packageVersion: string
  readonly rollbackAvailable: boolean
  readonly retryAvailable: boolean
}

interface RecoverySnapshot {
  readonly profileName: string
  readonly bundles: readonly RecoveryBundle[]
  readonly pendingInstall?: RecoveryInstall
}

interface RecoveryConfirmation {
  readonly kind: 'disable' | 'rollback' | 'retry'
  readonly preview: {
    readonly previewId: string
    readonly packageName: string
    readonly packageVersion?: string
  }
}

interface RecoveryNotice {
  readonly tone: 'info' | 'success' | 'warning' | 'error'
  readonly title: string
  readonly body: string
}

interface RecoveryProfile {
  readonly name: string
  readonly current: boolean
  readonly selectable: boolean
}

interface RecoveryState {
  readonly locale: Locale
  readonly failureStage: FailureStage
  readonly failureDetail: string
  readonly snapshot?: RecoverySnapshot
  readonly snapshotError?: string
  readonly diagnostics: { readonly status: 'saving' | 'saved' | 'failed'; readonly filename?: string }
  readonly confirmation?: RecoveryConfirmation
  readonly notice?: RecoveryNotice
  readonly busy: boolean
  readonly restartReady: boolean
  readonly configurationAvailable: boolean
  readonly profiles?: readonly RecoveryProfile[]
  readonly profileActionToken?: string
  readonly terminalAvailable?: boolean
  readonly profileCreatorAvailable?: boolean
  readonly rollbackLastKnownGoodAvailable?: boolean
}

interface Copy {
  readonly title: string
  readonly lead: string
  readonly currentProfile: string
  readonly startupError: string
  readonly failureStage: string
  readonly stageLabels: Readonly<Record<FailureStage, string>>
  readonly recentInstall: string
  readonly rollbackBody: string
  readonly rollback: string
  readonly retry: string
  readonly retryBody: string
  readonly plugins: string
  readonly pluginsBody: string
  readonly core: string
  readonly managed: string
  readonly external: string
  readonly disabled: string
  readonly disable: string
  readonly diagnostics: string
  readonly savingDiagnostics: string
  readonly diagnosticsSaved: string
  readonly diagnosticsFailed: string
  readonly saveDiagnostics: string
  readonly showDiagnostics: string
  readonly privacy: string
  readonly manualConfiguration: string
  readonly manualConfigurationBody: string
  readonly openSettingsDocument: string
  readonly openProfilePatch: string
  readonly openProfileManifest: string
  readonly openProfileDirectory: string
  readonly profiles: string
  readonly profilesBody: string
  readonly switchProfile: string
  readonly addProfile: string
  readonly openTerminal: string
  readonly restoreLastSuccessful: string
  readonly restart: string
  readonly quit: string
  readonly cancel: string
  readonly confirmDisable: string
  readonly confirmDisableBody: string
  readonly confirmRollback: string
  readonly confirmRollbackBody: string
  readonly confirmRetry: string
  readonly confirmRetryBody: string
  readonly working: string
}

const COPY: Record<Locale, Copy> = {
  en: {
    title: 'DSH Desktop Recovery',
    lead: 'The active Profile could not start. Diagnose the problem, restore a healthy configuration, or choose another Profile.',
    currentProfile: 'Current',
    startupError: 'Startup error',
    failureStage: 'Failure stage',
    stageLabels: {
      'electron-ready': 'Electron initialization',
      'shell-environment': 'Shell environment',
      'runtime-bootstrap': 'Desktop runtime preparation',
      'profile-selection': 'Profile selection',
      'install-recovery': 'Protected installation recovery',
      'profile-composition': 'Plugin Profile composition',
      'host-boot': 'Plugin Host startup',
      'renderer-startup': 'Desktop interface startup',
      'health-commit': 'Startup health confirmation',
    },
    recentInstall: 'Last protected installation',
    rollbackBody: 'Restores package.json, pnpm-lock.yaml, and pnpm-workspace.yaml to their pre-install state. node_modules is rebuilt separately.',
    rollback: 'Restore pre-install configuration',
    retry: 'Retry once',
    retryBody: 'Authorize one new startup verification. Another failure returns to this recovery assistant.',
    plugins: 'Plugin loading',
    pluginsBody: 'You can skip a mutable plugin bundle on the next start without uninstalling its files.',
    core: 'Built in',
    managed: 'Installed by Plugin Market',
    external: 'Installed another way',
    disabled: 'Disabled',
    disable: 'Disable',
    diagnostics: 'Diagnostics and recovery tools',
    savingDiagnostics: 'Saving a local diagnostic archive…',
    diagnosticsSaved: 'Diagnostics were saved locally and will not be uploaded automatically.',
    diagnosticsFailed: 'Diagnostics could not be saved. You can retry the export.',
    saveDiagnostics: 'Export diagnostics',
    showDiagnostics: 'Show diagnostics',
    privacy: 'Diagnostic archives may contain local paths, logs, system information, and crash-memory fragments. Review them before sharing.',
    manualConfiguration: 'Configuration files',
    manualConfigurationBody: 'Open only the active Profile paths selected by DSH Desktop.',
    openSettingsDocument: 'Open configuration file',
    openProfilePatch: 'Edit patch',
    openProfileManifest: 'Edit manifest',
    openProfileDirectory: 'Open folder',
    profiles: 'Profiles',
    profilesBody: 'Switch to another healthy Profile or create a new one without starting the plugin Host.',
    switchProfile: 'Switch',
    addProfile: 'Add Profile',
    openTerminal: 'Open DSH Terminal',
    restoreLastSuccessful: 'Restore last successful Profile',
    restart: 'Restart DSH Desktop',
    quit: 'Quit',
    cancel: 'Cancel',
    confirmDisable: 'Disable this plugin?',
    confirmDisableBody: 'The plugin will be skipped after restart. Its files remain installed.',
    confirmRollback: 'Restore the protected configuration?',
    confirmRollbackBody: 'A local diagnostic archive is saved first, then the protected Profile files are restored.',
    confirmRetry: 'Retry this configuration once?',
    confirmRetryBody: 'The next Desktop generation will verify the current installation once.',
    working: 'Applying the recovery action…',
  },
  zh: {
    title: 'DSH Desktop 恢复助手',
    lead: '当前配置无法启动。你可以诊断问题、恢复健康配置，或切换到其他配置。',
    currentProfile: '当前',
    startupError: '启动错误',
    failureStage: '失败阶段',
    stageLabels: {
      'electron-ready': 'Electron 初始化',
      'shell-environment': 'Shell 环境恢复',
      'runtime-bootstrap': '桌面运行时准备',
      'profile-selection': '配置选择',
      'install-recovery': '受保护安装恢复',
      'profile-composition': '插件配置组合',
      'host-boot': '插件 Host 启动',
      'renderer-startup': '桌面界面启动',
      'health-commit': '启动健康状态确认',
    },
    recentInstall: '最近一次受保护安装',
    rollbackBody: '恢复安装前的 package.json、pnpm-lock.yaml 和 pnpm-workspace.yaml；node_modules 会单独重建。',
    rollback: '恢复安装前配置',
    retry: '仅重试一次',
    retryBody: '授权下一次启动验证；如果仍然失败，会再次进入恢复助手。',
    plugins: '插件加载',
    pluginsBody: '你可以让下次启动跳过可管理的插件加载项，而不卸载插件文件。',
    core: '内置组件',
    managed: '通过插件市场安装',
    external: '通过其他方式安装',
    disabled: '已禁用',
    disable: '禁用',
    diagnostics: '诊断与恢复工具',
    savingDiagnostics: '正在保存本地诊断包…',
    diagnosticsSaved: '诊断信息已保存在本地，不会自动上传。',
    diagnosticsFailed: '无法保存诊断信息，可以重新尝试导出。',
    saveDiagnostics: '导出诊断',
    showDiagnostics: '显示诊断文件',
    privacy: '诊断包可能包含本地路径、日志、系统信息和崩溃内存片段，分享前请先检查。',
    manualConfiguration: '配置文件',
    manualConfigurationBody: '只打开由 DSH Desktop 确认的当前配置路径。',
    openSettingsDocument: '打开配置文件',
    openProfilePatch: '编辑补丁',
    openProfileManifest: '编辑清单',
    openProfileDirectory: '打开目录',
    profiles: '配置',
    profilesBody: '无需启动插件 Host，即可切换到其他健康配置或创建新配置。',
    switchProfile: '切换',
    addProfile: '新增配置',
    openTerminal: '打开 DSH 终端',
    restoreLastSuccessful: '恢复上次成功启动的配置',
    restart: '重新启动 DSH Desktop',
    quit: '退出',
    cancel: '取消',
    confirmDisable: '确认禁用这个插件？',
    confirmDisableBody: '重启后会跳过这个插件，插件文件仍会保留。',
    confirmRollback: '确认恢复受保护配置？',
    confirmRollbackBody: '系统会先保存本地诊断包，再恢复受保护的配置文件。',
    confirmRetry: '确认重试当前配置一次？',
    confirmRetryBody: '下一代 Desktop 会使用当前安装状态再验证一次。',
    working: '正在执行恢复操作…',
  },
}

function decodeState(): RecoveryState | undefined {
  const encoded = new URLSearchParams(window.location.search).get('state')
  if (encoded === null || encoded.length > 512_000) return undefined
  try {
    const normalized = encoded.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0))
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (value !== null && typeof value === 'object') return value as RecoveryState
  } catch { /* Render the bounded fallback below. */ }
  return undefined
}

function href(action: string, id?: string, name?: string): string {
  const url = new URL(`${SCHEME}//${action}`)
  if (id !== undefined) url.searchParams.set('id', id)
  if (name !== undefined) url.searchParams.set('name', name)
  return url.href
}

function Action({ action, children, className, icon, id, name, variant = 'outline' }: {
  readonly action: string
  readonly children: ReactNode
  readonly className?: string
  readonly icon?: ReactNode
  readonly id?: string
  readonly name?: string
  readonly variant?: 'default' | 'outline' | 'secondary' | 'destructive'
}): JSX.Element {
  return <a className={cn(buttonVariants({ variant }), className)} href={href(action, id, name)}>{icon}{children}</a>
}

function Owner({ owner, copy }: { readonly owner: RecoveryBundle['owner']; readonly copy: Copy }): JSX.Element {
  return <span className="text-xs text-muted-foreground">{owner === 'core' ? copy.core : owner === 'managed' ? copy.managed : copy.external}</span>
}

function Notice({ notice }: { readonly notice: RecoveryNotice }): JSX.Element {
  const destructive = notice.tone === 'error'
  return <Alert className={cn(notice.tone === 'success' && 'border-emerald-500/50', notice.tone === 'warning' && 'border-amber-500/60')} variant={destructive ? 'destructive' : 'default'}>
    {notice.tone === 'success' ? <CheckCircle2 /> : <AlertTriangle />}
    <AlertTitle>{notice.title}</AlertTitle><AlertDescription>{notice.body}</AlertDescription>
  </Alert>
}

function Confirmation({ confirmation, copy }: { readonly confirmation: RecoveryConfirmation; readonly copy: Copy }): JSX.Element {
  const rollback = confirmation.kind === 'rollback'
  const disable = confirmation.kind === 'disable'
  const title = disable ? copy.confirmDisable : rollback ? copy.confirmRollback : copy.confirmRetry
  const body = disable ? copy.confirmDisableBody : rollback ? copy.confirmRollbackBody : copy.confirmRetryBody
  const action = disable ? 'confirm-disable' : rollback ? 'confirm-rollback' : 'confirm-retry'
  const label = disable ? copy.disable : rollback ? copy.rollback : copy.retry
  return <Card>
    <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{confirmation.preview.packageName}{confirmation.preview.packageVersion === undefined ? '' : `@${confirmation.preview.packageVersion}`}</CardDescription></CardHeader>
    <CardContent><p className="text-sm text-muted-foreground">{body}</p></CardContent>
    <CardFooter className="justify-end gap-2"><Action action="home">{copy.cancel}</Action><Action action={action} id={confirmation.preview.previewId} variant={disable ? 'destructive' : 'default'}>{label}</Action></CardFooter>
  </Card>
}

function RecoveryContent({ state, copy }: { readonly state: RecoveryState; readonly copy: Copy }): JSX.Element {
  const pending = state.snapshot?.pendingInstall
  if (state.confirmation !== undefined) return <Confirmation confirmation={state.confirmation} copy={copy} />
  return <>
    {pending === undefined ? null : <Card>
      <CardHeader><CardTitle>{copy.recentInstall}</CardTitle><CardDescription>{pending.packageName}@{pending.packageVersion}</CardDescription></CardHeader>
      <CardContent className="space-y-2"><p className="text-sm text-muted-foreground">{copy.rollbackBody}</p>{pending.retryAvailable ? <p className="text-sm text-muted-foreground">{copy.retryBody}</p> : null}</CardContent>
      <CardFooter className="flex-wrap justify-end gap-2">
        {pending.rollbackAvailable ? <Action action="preview-rollback" icon={<Undo2 />} id={pending.recoveryId} variant="default">{copy.rollback}</Action> : null}
        {pending.retryAvailable ? <Action action="preview-retry" icon={<RefreshCw />} id={pending.recoveryId}>{copy.retry}</Action> : null}
      </CardFooter>
    </Card>}

    {state.snapshot === undefined ? null : <Card>
      <CardHeader><CardTitle>{copy.plugins}</CardTitle><CardDescription>{copy.pluginsBody}</CardDescription></CardHeader>
      <CardContent className="divide-y p-0">
        {state.snapshot.bundles.map(bundle => <div className="flex items-center justify-between gap-4 px-6 py-3" key={bundle.bundleId}>
          <div className="min-w-0"><p className="truncate text-sm font-medium">{bundle.packageName}</p><Owner copy={copy} owner={bundle.owner} /></div>
          <div className="flex shrink-0 items-center gap-2">{bundle.status === 'disabled' ? <span className="rounded-full bg-muted px-2 py-1 text-xs">{copy.disabled}</span> : null}{bundle.action === 'disable' ? <Action action="preview-disable" icon={<PackageX />} id={bundle.bundleId} variant="destructive">{copy.disable}</Action> : null}</div>
        </div>)}
      </CardContent>
    </Card>}

    {state.profiles === undefined ? null : <Card>
      <CardHeader><CardTitle>{copy.profiles}</CardTitle><CardDescription>{copy.profilesBody}</CardDescription></CardHeader>
      <CardContent className="divide-y p-0">
        {state.profiles.map(profile => <div className="flex items-center justify-between gap-4 px-6 py-3" key={profile.name}>
          <span className="min-w-0 truncate text-sm font-medium">{profile.name}</span>
          {profile.current ? <span className="rounded-full bg-muted px-2 py-1 text-xs">{copy.currentProfile}</span> : profile.selectable && state.profileActionToken !== undefined ? <Action action="switch-profile" id={state.profileActionToken} name={profile.name}>{copy.switchProfile}</Action> : null}
        </div>)}
      </CardContent>
      {state.profileCreatorAvailable ? <CardFooter className="justify-end pt-6"><Action action="open-profile-creator" icon={<Plus />}>{copy.addProfile}</Action></CardFooter> : null}
    </Card>}

    {state.configurationAvailable ? <Card>
      <CardHeader><CardTitle>{copy.manualConfiguration}</CardTitle><CardDescription>{copy.manualConfigurationBody}</CardDescription></CardHeader>
      <CardFooter className="flex-wrap gap-2 pt-6">
        <Action action="open-settings-document" icon={<FilePenLine />}>{copy.openSettingsDocument}</Action>
        <Action action="open-profile-patch" icon={<FilePenLine />}>{copy.openProfilePatch}</Action>
        <Action action="open-profile-manifest" icon={<FilePenLine />}>{copy.openProfileManifest}</Action>
        <Action action="open-profile-directory" icon={<FolderOpen />}>{copy.openProfileDirectory}</Action>
      </CardFooter>
    </Card> : null}

    <Card>
      <CardHeader><CardTitle>{copy.diagnostics}</CardTitle><CardDescription>{state.diagnostics.status === 'saving' ? copy.savingDiagnostics : state.diagnostics.status === 'saved' ? copy.diagnosticsSaved : copy.diagnosticsFailed}</CardDescription></CardHeader>
      <CardContent className="space-y-2">{state.diagnostics.filename === undefined ? null : <code className="block break-all rounded-lg bg-muted p-3 text-xs">{state.diagnostics.filename}</code>}<p className="text-xs text-muted-foreground">{copy.privacy}</p></CardContent>
      <CardFooter className="flex-wrap justify-end gap-2">
        <Action action={state.diagnostics.status === 'saved' ? 'show-diagnostics' : 'export-diagnostics'} icon={<Archive />}>{state.diagnostics.status === 'saved' ? copy.showDiagnostics : copy.saveDiagnostics}</Action>
        {state.terminalAvailable ? <Action action="open-terminal" icon={<Terminal />}>{copy.openTerminal}</Action> : null}
        {state.rollbackLastKnownGoodAvailable && state.profileActionToken !== undefined ? <Action action="rollback-last-known-good" icon={<RotateCcw />} id={state.profileActionToken} variant="default">{copy.restoreLastSuccessful}</Action> : null}
      </CardFooter>
    </Card>
  </>
}

export function RecoveryApp(): JSX.Element {
  const state = decodeState()
  if (state === undefined) return <main className="flex min-h-screen items-center justify-center p-6"><Alert variant="destructive"><AlertTriangle /><AlertTitle>DSH Desktop Recovery</AlertTitle><AlertDescription>The recovery state could not be read. Quit and start DSH Desktop again.</AlertDescription></Alert></main>
  const copy = COPY[state.locale]
  return <main className={cn('h-screen overflow-hidden p-5 sm:p-7', state.busy && 'pointer-events-none opacity-70')}><div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4">
    <header className="shrink-0 space-y-2"><h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1><p className="text-sm leading-relaxed text-muted-foreground">{copy.lead}</p>{state.snapshot === undefined ? null : <p className="text-xs text-muted-foreground">{copy.currentProfile}: {state.snapshot.profileName}</p>}</header>
    <ScrollArea className="min-h-0 flex-1 pr-3"><div className="space-y-4 pb-2">
      <Card><CardHeader><CardTitle>{copy.startupError}</CardTitle><CardDescription>{copy.failureStage}: {copy.stageLabels[state.failureStage]}</CardDescription></CardHeader><CardContent><pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs leading-relaxed">{state.failureDetail}</pre></CardContent></Card>
      {state.snapshotError === undefined ? null : <Alert variant="destructive"><AlertTriangle /><AlertTitle>{copy.plugins}</AlertTitle><AlertDescription>{state.snapshotError}</AlertDescription></Alert>}
      {state.notice === undefined ? null : <Notice notice={state.notice} />}
      {state.busy ? <Card><CardContent className="flex items-center gap-2 pt-6 text-sm"><RefreshCw className="animate-spin" />{copy.working}</CardContent></Card> : <RecoveryContent copy={copy} state={state} />}
    </div></ScrollArea>
    <footer className="flex shrink-0 flex-wrap justify-end gap-2">{state.restartReady || state.snapshot?.pendingInstall === undefined ? <Action action="restart" icon={<RotateCcw />} variant={state.restartReady ? 'default' : 'outline'}>{copy.restart}</Action> : null}<Action action="quit" icon={<Power />}>{copy.quit}</Action></footer>
  </div></main>
}
