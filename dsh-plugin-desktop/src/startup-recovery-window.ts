/** Host-independent Electron recovery window for profile startup failures. */

import { app, BrowserWindow, screen, shell } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopLocale } from './runtime.ts'
import { applicationNeedsReveal, revealApplication } from './electron-reveal.ts'
import {
  DesktopStartupRecoveryController,
  type DesktopStartupRecoveryDisablePreview,
  type DesktopStartupRecoveryInstallPreview,
  type DesktopStartupRecoverySnapshot,
} from './startup-recovery-controller.ts'

const RECOVERY_SCHEME = 'dsh-recovery:'
const RECOVERY_DOCUMENT = fileURLToPath(new URL('./native-ui/recovery.html', import.meta.url))
const MAX_FAILURE_DETAIL_LENGTH = 4_000
const DEFAULT_RECOVERY_WIDTH = 800
const DEFAULT_RECOVERY_HEIGHT = 760
const DEFAULT_RECOVERY_MIN_WIDTH = 680
const DEFAULT_RECOVERY_MIN_HEIGHT = 560
const RECOVERY_WORK_AREA_INSET = 48

type RecoveryWindowResult = 'restart' | 'quit'
type RecoveryNoticeTone = 'info' | 'success' | 'warning' | 'error'

/** Stable launcher stage used to route and explain one startup failure. */
export type DesktopStartupFailureStage =
  | 'electron-ready'
  | 'shell-environment'
  | 'runtime-bootstrap'
  | 'profile-selection'
  | 'install-recovery'
  | 'profile-composition'
  | 'host-boot'
  | 'renderer-startup'
  | 'health-commit'

interface RecoveryNotice {
  readonly tone: RecoveryNoticeTone
  readonly title: string
  readonly body: string
}

type RecoveryConfirmation =
  | { readonly kind: 'disable'; readonly preview: DesktopStartupRecoveryDisablePreview }
  | { readonly kind: 'rollback' | 'retry'; readonly preview: DesktopStartupRecoveryInstallPreview }

interface RecoveryDiagnosticsState {
  readonly status: 'saving' | 'saved' | 'failed'
  readonly filename?: string
}

export interface DesktopStartupRecoveryWindowOptions {
  readonly controller?: DesktopStartupRecoveryController
  /** Fixed active-profile paths selected by the main process. */
  readonly configurationPaths?: DesktopStartupRecoveryConfigurationPaths
  readonly locale: DesktopLocale
  readonly failureStage: DesktopStartupFailureStage
  readonly failureDetail: string
  readonly exportDiagnostics: (signal: AbortSignal) => Promise<string>
  /** Open the launcher-owned terminal even when the Host did not start. */
  readonly openTerminal?: () => void | Promise<void>
  /** Main-process validated actions available from the failure generation. */
  readonly profileActions?: DesktopStartupRecoveryProfileActions
  /** Restore the last healthy Profile and its declarative checkpoint. */
  readonly rollbackLastKnownGood?: (token: string) => void | Promise<void>
}

export interface DesktopStartupRecoveryProfile {
  readonly name: string
  readonly current: boolean
  readonly selectable: boolean
}

export interface DesktopStartupRecoveryProfileActions {
  /** Opaque per-window capability token; the main process must re-check it. */
  readonly token: string
  readonly list: () => readonly DesktopStartupRecoveryProfile[]
  readonly switchProfile: (name: string, token: string) => void | Promise<void>
  /** Open the isolated native creator; it accepts no filesystem path. */
  readonly openCreator: () => void | Promise<void>
}

export interface DesktopStartupRecoveryConfigurationPaths {
  readonly settingsDocument: string
  readonly profilePatch: string
  readonly profileManifest: string
  readonly profileDirectory: string
}

export interface DesktopStartupRecoveryScreenApi {
  getCursorScreenPoint(): { readonly x: number; readonly y: number }
  getDisplayNearestPoint(point: { readonly x: number; readonly y: number }): {
    readonly workAreaSize: { readonly width: number; readonly height: number }
  }
  getPrimaryDisplay(): {
    readonly workAreaSize: { readonly width: number; readonly height: number }
  }
}

export interface DesktopStartupRecoveryWindowBounds {
  readonly width: number
  readonly height: number
  readonly minWidth: number
  readonly minHeight: number
}

function validWorkAreaSize(
  value: { readonly width: number; readonly height: number } | undefined,
): { readonly width: number; readonly height: number } | undefined {
  if (value === undefined
    || !Number.isFinite(value.width)
    || !Number.isFinite(value.height)
    || value.width < 1
    || value.height < 1) return undefined
  return { width: Math.floor(value.width), height: Math.floor(value.height) }
}

function currentWorkAreaSize(
  screenApi: DesktopStartupRecoveryScreenApi,
): { readonly width: number; readonly height: number } | undefined {
  try {
    const current = validWorkAreaSize(
      screenApi.getDisplayNearestPoint(screenApi.getCursorScreenPoint()).workAreaSize,
    )
    if (current !== undefined) return current
  } catch {
    // Electron's screen API can be unavailable during an early-ready failure.
  }
  try {
    return validWorkAreaSize(screenApi.getPrimaryDisplay().workAreaSize)
  } catch {
    return undefined
  }
}

/** Clamp recovery dimensions to the current display, with the primary display as fallback. */
export function desktopStartupRecoveryWindowBounds(
  screenApi: DesktopStartupRecoveryScreenApi = screen,
): DesktopStartupRecoveryWindowBounds {
  const workArea = currentWorkAreaSize(screenApi)
  const width = workArea === undefined
    ? DEFAULT_RECOVERY_WIDTH
    : Math.min(DEFAULT_RECOVERY_WIDTH, Math.max(1, workArea.width - RECOVERY_WORK_AREA_INSET))
  const height = workArea === undefined
    ? DEFAULT_RECOVERY_HEIGHT
    : Math.min(DEFAULT_RECOVERY_HEIGHT, Math.max(1, workArea.height - RECOVERY_WORK_AREA_INSET))
  return {
    width,
    height,
    minWidth: Math.min(DEFAULT_RECOVERY_MIN_WIDTH, width),
    minHeight: Math.min(DEFAULT_RECOVERY_MIN_HEIGHT, height),
  }
}

export interface DesktopStartupRecoveryViewModel {
  readonly locale: DesktopLocale
  readonly failureStage: DesktopStartupFailureStage
  readonly failureDetail: string
  readonly snapshot?: DesktopStartupRecoverySnapshot
  readonly snapshotError?: string
  readonly diagnostics: RecoveryDiagnosticsState
  readonly confirmation?: RecoveryConfirmation
  readonly notice?: RecoveryNotice
  readonly busy: boolean
  readonly restartReady: boolean
  readonly configurationAvailable: boolean
  readonly profiles?: readonly DesktopStartupRecoveryProfile[]
  readonly profileActionToken?: string
  readonly terminalAvailable?: boolean
  readonly profileCreatorAvailable?: boolean
  readonly rollbackLastKnownGoodAvailable?: boolean
}

interface RecoveryCopy {
  readonly title: string
  readonly lead: string
  readonly currentProfile: string
  readonly startupError: string
  readonly startupStage: string
  readonly stageLabels: Readonly<Record<DesktopStartupFailureStage, string>>
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
  readonly disabledSuccess: string
  readonly disabledPending: string
  readonly rollbackSuccess: string
  readonly retrySuccess: string
  readonly manualRequired: string
  readonly diagnosticsRequired: string
  readonly manualConfiguration: string
  readonly manualConfigurationBody: string
  readonly openSettingsDocument: string
  readonly openProfilePatch: string
  readonly openProfileManifest: string
  readonly openProfileDirectory: string
}

const COPY: Record<DesktopLocale, RecoveryCopy> = {
  en: {
    title: 'DSH Desktop Recovery',
    lead: 'The active profile could not start. Save diagnostics, restore the last protected installation, or temporarily disable a plugin before trying again.',
    currentProfile: 'Active profile',
    startupError: 'Startup error',
    startupStage: 'Failure stage',
    stageLabels: {
      'electron-ready': 'Electron initialization',
      'shell-environment': 'Shell environment',
      'runtime-bootstrap': 'Desktop runtime preparation',
      'profile-selection': 'Profile selection',
      'install-recovery': 'Protected installation recovery',
      'profile-composition': 'Plugin profile composition',
      'host-boot': 'Plugin Host startup',
      'renderer-startup': 'Desktop interface startup',
      'health-commit': 'Startup health confirmation',
    },
    recentInstall: 'Last protected installation',
    rollbackBody: 'Restores only package.json, pnpm-lock.yaml, and pnpm-workspace.yaml to their pre-install state. It does not restore node_modules.',
    rollback: 'Restore pre-install configuration',
    retry: 'Retry once',
    retryBody: 'Authorizes one new startup verification. If it fails, this recovery window will return.',
    plugins: 'Temporarily disable a plugin',
    pluginsBody: 'Disabling skips that plugin bundle on the next start. It does not uninstall files or isolate plugin code.',
    core: 'Built in',
    managed: 'Installed by Plugin Market',
    external: 'Installed another way',
    disabled: 'Disabled',
    disable: 'Disable',
    diagnostics: 'Diagnostics',
    savingDiagnostics: 'Saving a local diagnostic archive…',
    diagnosticsSaved: 'Diagnostics were saved locally and will not be uploaded automatically.',
    diagnosticsFailed: 'Diagnostics could not be saved. Retry before restoring configuration.',
    saveDiagnostics: 'Save diagnostics',
    showDiagnostics: 'Show in folder',
    privacy: 'Diagnostic archives may contain local paths, logs, system information, and crash-memory fragments. Review the archive before sharing it.',
    restart: 'Restart DSH Desktop',
    quit: 'Quit',
    cancel: 'Cancel',
    confirmDisable: 'Confirm plugin disable',
    confirmDisableBody: 'This plugin will be skipped in the active profile after restart. Its files will remain installed.',
    confirmRollback: 'Confirm configuration restore',
    confirmRollbackBody: 'A local diagnostic archive must be saved first. Then the three protected profile files will be restored to their pre-install state.',
    confirmRetry: 'Confirm one retry',
    confirmRetryBody: 'The next Desktop generation will try this installed configuration once. Another failure returns to recovery.',
    working: 'Applying recovery action…',
    disabledSuccess: 'The plugin is now marked disabled. Restart Desktop to apply the change.',
    disabledPending: 'The plugin is now marked disabled. Choose whether to retry the protected installation or restore its pre-install configuration.',
    rollbackSuccess: 'The pre-install configuration was restored. Restart Desktop to continue.',
    retrySuccess: 'One startup retry was authorized. Restart Desktop to continue.',
    manualRequired: 'The protected files changed outside the known install transaction. Desktop did not overwrite them.',
    diagnosticsRequired: 'Diagnostics were not saved, so configuration recovery was not started.',
    manualConfiguration: 'Edit configuration manually',
    manualConfigurationBody: 'Use the system editor for patch overrides or the plugin manifest for duplicate bundle entries. This recovery page cannot choose an arbitrary path.',
    openSettingsDocument: 'Open configuration file',
    openProfilePatch: 'Edit configuration patch',
    openProfileManifest: 'Edit plugin manifest',
    openProfileDirectory: 'Open configuration folder',
  },
  zh: {
    title: 'DSH Desktop 恢复',
    lead: '当前配置无法启动。你可以先保存诊断信息，然后恢复最近一次受保护安装，或暂时禁用一个插件后重试。',
    currentProfile: '当前配置',
    startupError: '启动错误',
    startupStage: '失败阶段',
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
    rollbackBody: '只会把 package.json、pnpm-lock.yaml 和 pnpm-workspace.yaml 恢复到安装前状态，不会恢复 node_modules。',
    rollback: '恢复安装前配置',
    retry: '仅重试一次',
    retryBody: '只授权下一次启动验证；如果仍然失败，会再次进入此恢复窗口。',
    plugins: '暂时禁用插件',
    pluginsBody: '禁用后，下次启动会跳过该插件的加载配置；不会卸载插件文件，也不会隔离插件代码。',
    core: '内置组件',
    managed: '通过插件市场安装',
    external: '通过其他方式安装',
    disabled: '已禁用',
    disable: '禁用',
    diagnostics: '诊断信息',
    savingDiagnostics: '正在保存本地诊断包…',
    diagnosticsSaved: '诊断信息已保存在本地，不会自动上传。',
    diagnosticsFailed: '无法保存诊断信息。请先重试，再恢复配置。',
    saveDiagnostics: '保存诊断信息',
    showDiagnostics: '在文件夹中显示',
    privacy: '诊断包可能包含本地路径、日志、系统信息和崩溃内存片段，分享前请先检查。',
    restart: '重新启动 DSH Desktop',
    quit: '退出',
    cancel: '取消',
    confirmDisable: '确认禁用插件',
    confirmDisableBody: '重启后，当前配置将跳过这个插件；插件文件仍会保留。',
    confirmRollback: '确认恢复配置',
    confirmRollbackBody: '系统必须先在本地保存诊断包，然后才会把三个受保护的配置文件恢复到安装前状态。',
    confirmRetry: '确认重试一次',
    confirmRetryBody: '下一代 Desktop 会使用当前安装状态再尝试一次；如果仍然失败，会返回恢复窗口。',
    working: '正在执行恢复操作…',
    disabledSuccess: '插件已标记为禁用。请重新启动 Desktop 使改动生效。',
    disabledPending: '插件已标记为禁用。请选择重试这次受保护安装，或恢复安装前配置。',
    rollbackSuccess: '安装前配置已恢复。请重新启动 Desktop。',
    retrySuccess: '已授权一次启动重试。请重新启动 Desktop。',
    manualRequired: '受保护文件出现了安装事务之外的改动。为避免覆盖你的修改，Desktop 没有恢复这些文件。',
    diagnosticsRequired: '诊断信息尚未保存，因此没有开始恢复配置。',
    manualConfiguration: '手动编辑配置',
    manualConfigurationBody: '配置覆盖错误请编辑补丁文件；插件重复加载请编辑插件加载清单。恢复页面不能选择任意路径。',
    openSettingsDocument: '打开配置文件',
    openProfilePatch: '编辑配置补丁',
    openProfileManifest: '编辑插件加载清单',
    openProfileDirectory: '打开配置目录',
  },
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function recoveryHref(action: string, id?: string): string {
  const url = new URL(`${RECOVERY_SCHEME}//${action}`)
  if (id !== undefined) url.searchParams.set('id', id)
  return url.href
}

function recoveryProfileHref(action: string, token: string, name: string): string {
  const url = new URL(`${RECOVERY_SCHEME}//${action}`)
  url.searchParams.set('id', token)
  url.searchParams.set('name', name)
  return url.href
}

function button(copy: string, action: string, id?: string, primary = false): string {
  return `<a class="button${primary ? ' primary' : ''}" href="${escapeHtml(recoveryHref(action, id))}">${escapeHtml(copy)}</a>`
}

function noticeHtml(notice: RecoveryNotice | undefined): string {
  if (notice === undefined) return ''
  return `<section class="notice ${notice.tone}"><strong>${escapeHtml(notice.title)}</strong><p>${escapeHtml(notice.body)}</p></section>`
}

function confirmationHtml(model: DesktopStartupRecoveryViewModel, copy: RecoveryCopy): string {
  const confirmation = model.confirmation
  if (confirmation === undefined) return ''
  if (confirmation.kind === 'disable') {
    return `<section class="card confirmation"><h2>${escapeHtml(copy.confirmDisable)}</h2><p><code>${escapeHtml(confirmation.preview.packageName)}</code></p><p>${escapeHtml(copy.confirmDisableBody)}</p><div class="actions">${button(copy.cancel, 'home')}${button(copy.disable, 'confirm-disable', confirmation.preview.previewId, true)}</div></section>`
  }
  const rollback = confirmation.kind === 'rollback'
  return `<section class="card confirmation"><h2>${escapeHtml(rollback ? copy.confirmRollback : copy.confirmRetry)}</h2><p><code>${escapeHtml(confirmation.preview.packageName)}@${escapeHtml(confirmation.preview.packageVersion)}</code></p><p>${escapeHtml(rollback ? copy.confirmRollbackBody : copy.confirmRetryBody)}</p><div class="actions">${button(copy.cancel, 'home')}${button(rollback ? copy.rollback : copy.retry, rollback ? 'confirm-rollback' : 'confirm-retry', confirmation.preview.previewId, true)}</div></section>`
}

/** Render the complete no-script local recovery document. */
export function renderDesktopStartupRecoveryHtml(model: DesktopStartupRecoveryViewModel): string {
  const copy = COPY[model.locale]
  const snapshot = model.snapshot
  const diagnosticsText = model.diagnostics.status === 'saving'
    ? copy.savingDiagnostics
    : model.diagnostics.status === 'saved'
      ? copy.diagnosticsSaved
      : copy.diagnosticsFailed
  const confirmation = confirmationHtml(model, copy)
  const pending = snapshot?.pendingInstall
  const pendingHtml = pending === undefined ? '' : `<section class="card"><h2>${escapeHtml(copy.recentInstall)}</h2><p><code>${escapeHtml(pending.packageName)}@${escapeHtml(pending.packageVersion)}</code></p><p>${escapeHtml(copy.rollbackBody)}</p><div class="actions">${pending.rollbackAvailable ? button(copy.rollback, 'preview-rollback', pending.recoveryId, true) : ''}${pending.retryAvailable ? button(copy.retry, 'preview-retry', pending.recoveryId) : ''}</div>${pending.retryAvailable ? `<p class="muted">${escapeHtml(copy.retryBody)}</p>` : ''}</section>`
  const bundleRows = snapshot?.bundles.map(bundle => {
    const owner = bundle.owner === 'core' ? copy.core : bundle.owner === 'managed' ? copy.managed : copy.external
    const status = bundle.status === 'disabled' ? `<span class="pill">${escapeHtml(copy.disabled)}</span>` : ''
    const action = bundle.action === 'disable' ? button(copy.disable, 'preview-disable', bundle.bundleId) : ''
    return `<li><div><code>${escapeHtml(bundle.packageName)}</code><span class="meta">${escapeHtml(owner)}</span></div><div class="row-actions">${status}${action}</div></li>`
  }).join('') ?? ''
  const bundlesHtml = snapshot === undefined
    ? ''
    : `<section class="card"><h2>${escapeHtml(copy.plugins)}</h2><p>${escapeHtml(copy.pluginsBody)}</p>${bundleRows.length === 0 ? '' : `<ul>${bundleRows}</ul>`}</section>`
  const diagnosticAction = model.diagnostics.status === 'saved'
    ? button(copy.showDiagnostics, 'show-diagnostics')
    : button(copy.saveDiagnostics, 'export-diagnostics')
  const configurationHtml = model.configurationAvailable
    ? `<section class="card"><h2>${escapeHtml(copy.manualConfiguration)}</h2><p>${escapeHtml(copy.manualConfigurationBody)}</p><div class="actions">${button(copy.openSettingsDocument, 'open-settings-document')}${button(copy.openProfilePatch, 'open-profile-patch')}${button(copy.openProfileManifest, 'open-profile-manifest')}${button(copy.openProfileDirectory, 'open-profile-directory')}</div></section>`
    : ''
  const profileRows = model.profiles?.map(profile => {
    const action = !profile.current && profile.selectable && model.profileActionToken !== undefined
      ? `<a class="button" href="${escapeHtml(recoveryProfileHref('switch-profile', model.profileActionToken, profile.name))}">${escapeHtml(copy.retry)}</a>`
      : ''
    const current = profile.current ? `<span class="pill">${escapeHtml(copy.currentProfile)}</span>` : ''
    return `<li><div><code>${escapeHtml(profile.name)}</code></div><div class="row-actions">${current}${action}</div></li>`
  }).join('') ?? ''
  const profileHtml = model.profiles === undefined
    ? ''
    : `<section class="card"><h2>${escapeHtml(copy.currentProfile)}</h2><p>${escapeHtml(copy.lead)}</p>${profileRows.length === 0 ? '' : `<ul>${profileRows}</ul>`}<div class="actions">${model.profileCreatorAvailable ? button('Add Profile', 'open-profile-creator') : ''}</div></section>`
  const terminalAction = model.terminalAvailable ? button('Open DSH Terminal', 'open-terminal') : ''
  const rollbackAction = model.rollbackLastKnownGoodAvailable && model.profileActionToken !== undefined
    ? button('Restore last successful Profile', 'rollback-last-known-good', model.profileActionToken, true)
    : ''
  const restart = model.restartReady || pending === undefined
    ? button(copy.restart, 'restart', undefined, model.restartReady)
    : ''
  const body = confirmation.length > 0
    ? confirmation
    : `${pendingHtml}${bundlesHtml}${profileHtml}${configurationHtml}<section class="card"><h2>${escapeHtml(copy.diagnostics)}</h2><p>${escapeHtml(diagnosticsText)}</p>${model.diagnostics.filename === undefined ? '' : `<p><code>${escapeHtml(model.diagnostics.filename)}</code></p>`}<p class="muted">${escapeHtml(copy.privacy)}</p><div class="actions">${diagnosticAction}${terminalAction}${rollbackAction}</div></section>`
  return `<!doctype html>
<html lang="${model.locale === 'zh' ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(copy.title)}</title>
  <style>
    :root{color-scheme:light dark;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f2f3f5;color:#202124}*{box-sizing:border-box}body{margin:0}main{width:min(820px,100%);margin:0 auto;padding:34px 30px 28px}h1{font-size:28px;margin:0 0 8px}h2{font-size:17px;margin:0 0 10px}p{margin:7px 0}.lead{color:#5f6368;margin-bottom:20px}.profile{font-size:13px;color:#6b7280}.card,.notice{background:#fff;border:1px solid #dfe1e5;border-radius:12px;padding:18px;margin:14px 0;box-shadow:0 1px 2px #0000000d}.error-detail{white-space:pre-wrap;overflow-wrap:anywhere;max-height:130px;overflow:auto;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f7f8;border-radius:8px;padding:12px}.notice strong{display:block}.notice.error,.notice.warning{border-color:#d97706}.notice.success{border-color:#16a34a}.notice.info{border-color:#2563eb}ul{list-style:none;padding:0;margin:14px 0 0;border-top:1px solid #e5e7eb}li{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid #e5e7eb}.meta{display:block;color:#6b7280;font-size:12px;margin-top:2px}.row-actions,.actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.actions{margin-top:15px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:7px 13px;border:1px solid #9aa0a6;border-radius:9px;color:inherit;text-decoration:none;background:transparent}.button:hover{background:#eef0f2}.button.primary{background:#1a73e8;border-color:#1a73e8;color:white}.pill{font-size:12px;padding:3px 8px;border-radius:999px;background:#e8eaed}.muted{font-size:12px;color:#6b7280}.footer{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:18px}.busy{opacity:.7;pointer-events:none}@media(max-width:640px){main{padding:22px 16px 18px}h1{font-size:24px}.card,.notice{padding:14px}.footer{justify-content:stretch}.footer .button{flex:1 1 180px}}@media(max-width:420px){main{padding:18px 12px 14px}li{align-items:stretch;flex-direction:column}.row-actions,.actions,.footer{align-items:stretch;flex-direction:column}.button{width:100%}}@media(prefers-color-scheme:dark){:root{background:#202124;color:#f1f3f4}.lead,.profile,.meta,.muted{color:#9aa0a6}.card,.notice{background:#292a2d;border-color:#45464a}.error-detail{background:#202124}.button:hover{background:#35363a}.pill{background:#3c4043}ul,li{border-color:#45464a}}
  </style>
</head>
<body><main class="${model.busy ? 'busy' : ''}">
  <h1>${escapeHtml(copy.title)}</h1>
  <p class="lead">${escapeHtml(copy.lead)}</p>
  ${snapshot === undefined ? '' : `<p class="profile">${escapeHtml(copy.currentProfile)}：${escapeHtml(snapshot.profileName)}</p>`}
  <section class="card"><h2>${escapeHtml(copy.startupError)}</h2><p class="profile">${escapeHtml(copy.startupStage)}：${escapeHtml(copy.stageLabels[model.failureStage])}</p><div class="error-detail">${escapeHtml(model.failureDetail.slice(0, MAX_FAILURE_DETAIL_LENGTH))}</div></section>
  ${model.snapshotError === undefined ? '' : noticeHtml({ tone: 'error', title: copy.plugins, body: model.snapshotError })}
  ${noticeHtml(model.notice)}
  ${model.busy ? `<section class="card"><p>${escapeHtml(copy.working)}</p></section>` : body}
  <div class="footer">${restart}${button(copy.quit, 'quit')}</div>
</main></body></html>`
}

/** Parse only the fixed action origin used by this no-script document. */
export function parseDesktopStartupRecoveryAction(
  href: string,
): { readonly action: string; readonly id?: string; readonly name?: string } | undefined {
  let url: URL
  try { url = new URL(href) } catch { return undefined }
  if (url.protocol !== RECOVERY_SCHEME
    || url.username.length > 0
    || url.password.length > 0
    || url.port.length > 0
    || url.pathname !== ''
    || url.hash.length > 0) return undefined
  const action = url.hostname
  const allowed = new Set([
    'home',
    'preview-disable',
    'confirm-disable',
    'preview-rollback',
    'confirm-rollback',
    'preview-retry',
    'confirm-retry',
    'export-diagnostics',
    'show-diagnostics',
    'open-settings-document',
    'open-profile-patch',
    'open-profile-manifest',
    'open-profile-directory',
    'open-terminal',
    'open-profile-creator',
    'switch-profile',
    'rollback-last-known-good',
    'restart',
    'quit',
  ])
  if (!allowed.has(action)) return undefined
  const keys = [...url.searchParams.keys()]
  if (keys.some(key => key !== 'id' && key !== 'name') || url.searchParams.getAll('id').length > 1 || url.searchParams.getAll('name').length > 1) return undefined
  const id = url.searchParams.get('id') ?? undefined
  const needsId = action.startsWith('preview-') || action.startsWith('confirm-') || action === 'switch-profile' || action === 'rollback-last-known-good'
  if (needsId !== (id !== undefined) || id !== undefined && (id.length < 8 || id.length > 160)) return undefined
  const name = url.searchParams.get('name') ?? undefined
  if (action === 'switch-profile') {
    if (name === undefined || name.length === 0 || Buffer.byteLength(name, 'utf8') > 255 || name.includes('/') || name.includes('\\') || /[\0\r\n]/u.test(name)) return undefined
  } else if (name !== undefined) return undefined
  return { action, ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }) }
}

/** One native recovery window whose renderer has no script, Node, IPC, or network capability. */
export class DesktopStartupRecoveryWindow {
  private window: BrowserWindow | undefined
  private snapshot: DesktopStartupRecoverySnapshot | undefined
  private snapshotError: string | undefined
  private diagnostics: RecoveryDiagnosticsState = { status: 'saving' }
  private diagnosticPath: string | undefined
  private diagnosticTask: Promise<string> | undefined
  private readonly diagnosticAbort = new AbortController()
  private confirmation: RecoveryConfirmation | undefined
  private notice: RecoveryNotice | undefined
  private busy = false
  private restartReady = false
  private profiles: readonly DesktopStartupRecoveryProfile[] | undefined
  private resolveResult: ((result: RecoveryWindowResult) => void) | undefined
  private settled = false

  constructor(private readonly options: DesktopStartupRecoveryWindowOptions) {}

  /** Open the local recovery document and settle only on explicit restart, quit, or close. */
  async run(): Promise<RecoveryWindowResult> {
    const result = new Promise<RecoveryWindowResult>(resolve => { this.resolveResult = resolve })
    try {
      this.snapshot = await this.options.controller?.snapshot()
    } catch (cause) {
      this.snapshotError = cause instanceof Error ? cause.message : String(cause)
    }
    this.refreshProfiles()
    const window = new BrowserWindow({
      title: COPY[this.options.locale].title,
      ...desktopStartupRecoveryWindowBounds(),
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#202124',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
        partition: 'dsh-recovery',
      },
    })
    this.window = window
    window.accessibleTitle = COPY[this.options.locale].title
    window.removeMenu()
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-attach-webview', event => { event.preventDefault() })
    const navigate = (event: Electron.Event, href: string): void => {
      const action = parseDesktopStartupRecoveryAction(href)
      event.preventDefault()
      if (action !== undefined) void this.handleAction(action)
    }
    window.webContents.on('will-navigate', navigate)
    window.webContents.on('will-redirect', navigate)
    const show = (): void => { revealApplication(window) }
    const activate = (): void => {
      if (applicationNeedsReveal(window)) show()
    }
    app.on('activate', activate)
    if (process.platform === 'darwin') app.on('did-become-active', activate)
    window.once('ready-to-show', show)
    window.on('closed', () => {
      app.off('activate', activate)
      if (process.platform === 'darwin') app.off('did-become-active', activate)
      this.window = undefined
      this.finish('quit')
    })
    await this.render()
    void this.startDiagnosticExport().catch(() => {})
    return await result
  }

  /** Bring an already open recovery window to the foreground. */
  show(): void {
    if (this.window === undefined || this.window.isDestroyed()) return
    revealApplication(this.window)
  }

  private async handleAction(action: { readonly action: string; readonly id?: string; readonly name?: string }): Promise<void> {
    if (this.busy || this.settled) return
    try {
      if (action.action === 'home') {
        this.confirmation = undefined
        this.notice = undefined
      } else if (action.action === 'preview-disable' && action.id !== undefined) {
        this.confirmation = { kind: 'disable', preview: await this.requireController().previewDisable(action.id) }
      } else if (action.action === 'confirm-disable' && action.id !== undefined) {
        await this.runBusy(async () => {
          const pendingRecovery = this.snapshot?.pendingInstall !== undefined
          const result = await this.requireController().executeDisable(action.id!)
          this.confirmation = undefined
          this.notice = {
            tone: 'success',
            title: result.packageName,
            body: pendingRecovery
              ? COPY[this.options.locale].disabledPending
              : COPY[this.options.locale].disabledSuccess,
          }
          this.restartReady = !pendingRecovery
          await this.refreshSnapshot()
        })
      } else if (action.action === 'preview-rollback' && action.id !== undefined) {
        this.confirmation = { kind: 'rollback', preview: await this.requireController().previewRollback(action.id) }
      } else if (action.action === 'confirm-rollback' && action.id !== undefined) {
        if (!await this.ensureDiagnostics()) {
          this.notice = { tone: 'error', title: COPY[this.options.locale].diagnostics, body: COPY[this.options.locale].diagnosticsRequired }
        } else {
          await this.runBusy(async () => {
            const result = await this.requireController().executeInstallAction(action.id!)
            this.confirmation = undefined
            if (result.action === 'rollback' && result.status === 'manual-recovery-required') {
              this.notice = { tone: 'warning', title: result.packageName, body: COPY[this.options.locale].manualRequired }
            } else {
              this.notice = { tone: 'success', title: result.packageName, body: COPY[this.options.locale].rollbackSuccess }
              this.restartReady = true
            }
            await this.refreshSnapshot()
          })
        }
      } else if (action.action === 'preview-retry' && action.id !== undefined) {
        this.confirmation = { kind: 'retry', preview: await this.requireController().previewRetry(action.id) }
      } else if (action.action === 'confirm-retry' && action.id !== undefined) {
        if (!await this.ensureDiagnostics()) {
          this.notice = { tone: 'error', title: COPY[this.options.locale].diagnostics, body: COPY[this.options.locale].diagnosticsRequired }
        } else {
          await this.runBusy(async () => {
            const result = await this.requireController().executeInstallAction(action.id!)
            this.confirmation = undefined
            this.notice = { tone: 'success', title: result.packageName, body: COPY[this.options.locale].retrySuccess }
            this.restartReady = true
            await this.refreshSnapshot()
          })
        }
      } else if (action.action === 'export-diagnostics') {
        await this.startDiagnosticExport().catch(() => {})
      } else if (action.action === 'show-diagnostics' && this.diagnosticPath !== undefined) {
        shell.showItemInFolder(this.diagnosticPath)
      } else if (action.action === 'open-terminal') {
        if (this.options.openTerminal === undefined) throw new Error('DSH Terminal is unavailable for this startup stage.')
        await this.options.openTerminal()
      } else if (action.action === 'open-profile-creator') {
        if (this.options.profileActions === undefined) throw new Error('Profile creation is unavailable for this startup stage.')
        await this.options.profileActions.openCreator()
      } else if (action.action === 'switch-profile' && action.id !== undefined && action.name !== undefined) {
        const actions = this.options.profileActions
        if (actions === undefined) throw new Error('Profile switching is unavailable for this startup stage.')
        const profileName = action.name
        const actionToken = action.id
        await this.runBusy(async () => {
          await actions.switchProfile(profileName, actionToken)
          this.notice = {
            tone: 'success',
            title: profileName,
            body: this.options.locale === 'zh'
              ? '配置选择已保存。请重新启动 DSH Desktop。'
              : 'Profile selection saved. Restart DSH Desktop to apply it.',
          }
          this.restartReady = true
          this.refreshProfiles()
        })
      } else if (action.action === 'rollback-last-known-good' && action.id !== undefined) {
        if (this.options.rollbackLastKnownGood === undefined) throw new Error('Last-known-good Profile recovery is unavailable for this startup stage.')
        const actionToken = action.id
        await this.runBusy(async () => {
          await this.options.rollbackLastKnownGood?.(actionToken)
          this.notice = this.options.locale === 'zh'
            ? { tone: 'success', title: '配置已恢复', body: '已恢复上次成功启动的配置及其快照。请重新启动 DSH Desktop。' }
            : { tone: 'success', title: 'Profile restored', body: 'The last successful Profile and configuration were restored. Restart DSH Desktop to continue.' }
          this.restartReady = true
        })
      } else if (action.action === 'open-settings-document') {
        await this.openConfigurationPath('settingsDocument')
      } else if (action.action === 'open-profile-patch') {
        await this.openConfigurationPath('profilePatch')
      } else if (action.action === 'open-profile-manifest') {
        await this.openConfigurationPath('profileManifest')
      } else if (action.action === 'open-profile-directory') {
        await this.openConfigurationPath('profileDirectory')
      } else if (action.action === 'restart') {
        this.finish('restart')
        return
      } else if (action.action === 'quit') {
        await this.ensureDiagnostics()
        this.finish('quit')
        return
      }
    } catch (cause) {
      this.notice = {
        tone: 'error',
        title: COPY[this.options.locale].title,
        body: cause instanceof Error ? cause.message : String(cause),
      }
    }
    await this.render()
  }

  private async runBusy(operation: () => Promise<void>): Promise<void> {
    this.busy = true
    await this.render()
    try { await operation() } finally { this.busy = false }
  }

  private async refreshSnapshot(): Promise<void> {
    try {
      this.snapshot = await this.requireController().snapshot()
      this.snapshotError = undefined
    } catch (cause) {
      this.snapshotError = cause instanceof Error ? cause.message : String(cause)
    }
  }

  private refreshProfiles(): void {
    try {
      this.profiles = this.options.profileActions?.list()
    } catch {
      this.profiles = undefined
    }
  }

  private async ensureDiagnostics(): Promise<boolean> {
    try {
      await this.startDiagnosticExport()
      return true
    } catch {
      return false
    }
  }

  private startDiagnosticExport(): Promise<string> {
    if (this.diagnostics.status === 'saved' && this.diagnosticPath !== undefined) {
      return Promise.resolve(this.diagnosticPath)
    }
    if (this.diagnosticTask !== undefined) return this.diagnosticTask

    const task = this.saveDiagnostics()
    this.diagnosticTask = task
    void task.catch(() => {
      if (this.diagnosticTask === task) this.diagnosticTask = undefined
    })
    return task
  }

  private async saveDiagnostics(): Promise<string> {
    this.diagnostics = { status: 'saving' }
    await this.render()
    try {
      const path = await this.options.exportDiagnostics(this.diagnosticAbort.signal)
      this.diagnosticPath = path
      this.diagnostics = { status: 'saved', filename: basename(path) }
      await this.render()
      return path
    } catch (cause) {
      this.diagnostics = { status: 'failed' }
      this.notice = {
        tone: 'error',
        title: COPY[this.options.locale].diagnostics,
        body: cause instanceof Error ? cause.message : String(cause),
      }
      await this.render()
      throw cause
    }
  }

  private async render(): Promise<void> {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    const model: DesktopStartupRecoveryViewModel = {
      locale: this.options.locale,
      failureStage: this.options.failureStage,
      failureDetail: this.options.failureDetail,
      ...(this.snapshot === undefined ? {} : { snapshot: this.snapshot }),
      ...(this.snapshotError === undefined ? {} : { snapshotError: this.snapshotError }),
      diagnostics: this.diagnostics,
      ...(this.confirmation === undefined ? {} : { confirmation: this.confirmation }),
      ...(this.notice === undefined ? {} : { notice: this.notice }),
      busy: this.busy,
      restartReady: this.restartReady,
      configurationAvailable: this.options.configurationPaths !== undefined,
      ...(this.profiles === undefined ? {} : { profiles: this.profiles }),
      ...(this.options.profileActions === undefined ? {} : { profileActionToken: this.options.profileActions.token }),
      ...(this.options.openTerminal === undefined ? {} : { terminalAvailable: true }),
      ...(this.options.profileActions === undefined ? {} : { profileCreatorAvailable: true }),
      ...(this.options.rollbackLastKnownGood === undefined ? {} : { rollbackLastKnownGoodAvailable: true }),
    }
    const state = Buffer.from(JSON.stringify(model), 'utf8').toString('base64url')
    await window.loadFile(RECOVERY_DOCUMENT, { query: { state } })
  }

  private finish(result: RecoveryWindowResult): void {
    if (this.settled) return
    this.settled = true
    this.diagnosticAbort.abort(new DOMException('Recovery window closed.', 'AbortError'))
    const window = this.window
    this.window = undefined
    if (window !== undefined && !window.isDestroyed()) window.destroy()
    this.resolveResult?.(result)
    this.resolveResult = undefined
  }

  private requireController(): DesktopStartupRecoveryController {
    if (this.options.controller === undefined) {
      throw new Error('Desktop plugin recovery actions are unavailable for this startup stage.')
    }
    return this.options.controller
  }

  private async openConfigurationPath(
    kind: keyof DesktopStartupRecoveryConfigurationPaths,
  ): Promise<void> {
    const path = this.options.configurationPaths?.[kind]
    if (path === undefined) throw new Error('Desktop profile configuration is unavailable for this startup stage.')
    if (kind === 'settingsDocument') {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      try {
        await writeFile(path, '', { flag: 'wx', mode: 0o600 })
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
      }
    }
    if (kind === 'settingsDocument' && process.platform === 'darwin') {
      await new Promise<void>((resolve, reject) => {
        execFile('/usr/bin/open', ['-t', path], { windowsHide: true }, cause => {
          if (cause === null) resolve()
          else reject(cause)
        })
      })
      return
    }
    const error = await shell.openPath(path)
    if (error.length > 0) throw new Error(error)
  }
}

export default DesktopStartupRecoveryWindow
