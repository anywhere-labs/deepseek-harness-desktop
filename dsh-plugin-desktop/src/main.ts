/** DSH Desktop executable: minimal Electron bootstrap around the Host Cordis root. */

import { app, crashReporter, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  PROFILE_PATCH_FILENAME,
  resolveProfileDir,
  type FailLoudProcess,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import {
  installDesktopDshRuntime,
  installDesktopPnpmRuntime,
} from './desktop-runtime-environment.ts'
import { desktopProductVersion, ElectronDesktopRuntime } from './electron-runtime.ts'
import {
  ElectronStderrLogger,
  installDesktopChildProcessLogging,
  installDesktopUncaughtExceptionLogging,
  type DesktopLogger,
} from './desktop-logger.ts'
import {
  beginDesktopRun,
  startDesktopCrashReporting,
  type DesktopRun,
} from './crash-evidence.ts'
import { exportDesktopDiagnostics } from './diagnostic-export.ts'
import { createDesktopLifecycleRecorder } from './lifecycle-events.ts'
import type {
  DesktopLifecycleFailureReason,
  DesktopLifecycleRendererFailureReason,
} from './lifecycle-events.ts'
import { FileExporter } from './file-exporter.ts'
import { DESKTOP_SETTINGS_NAMESPACE, type DesktopSettings } from './index.ts'
import { LogFileSink } from './log-files.ts'
import { maskSecrets } from './mask-secrets.ts'
import { resolveDesktopShellEnvironment } from './shell-environment.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import {
  DesktopInstallRecoveryStore,
  desktopInstallRecoveryStatePath,
  type DesktopInstallRecoveryFailureReason,
  type DesktopInstallRecoveryTransaction,
} from './install-recovery.ts'
import {
  beginDesktopProfileStartup,
  assertDesktopProfileName,
  createDesktopWebProfile,
  listDesktopProfiles,
  canDeleteDesktopProfile,
  deleteDesktopProfile,
  readDesktopProfileState,
  selectDesktopProfile,
  type DesktopProfileStartup,
} from './profile-manager.ts'
import { DesktopProfileService } from './profile-service.ts'
import { DesktopActionsService } from './desktop-actions.ts'
import { clearDesktopProfilePluginState, DesktopPluginsService } from './desktop-plugins.ts'
import {
  desktopMarketSnapshotWithEffective,
  readDesktopMarketStateForUserData,
  selectDesktopMarketProvider,
} from './desktop-market.ts'
import { DesktopHostTargetController } from './host-target-controller.ts'
import { desktopHostTargetStatePath } from './host-target.ts'
import DesktopSettingsController from './desktop-settings-controller.ts'
import { DesktopStartupRecoveryController } from './startup-recovery-controller.ts'
import {
  DesktopStartupRecoveryWindow,
  type DesktopStartupRecoveryConfigurationPaths,
  type DesktopStartupRecoveryProfileActions,
  type DesktopStartupFailureStage,
} from './startup-recovery-window.ts'
import { routeDesktopStartupFailure } from './startup-failure-routing.ts'
import { DesktopStartupGeneration } from './startup-generation.ts'
import { DesktopStartupStateCommit } from './startup-state-commit.ts'
import {
  desktopInstallAnchor,
  prepareDesktopProfile,
  type SkippedOptionalEntry,
} from './profile.ts'
import { clearDesktopProfileCheckpoint, DesktopProfileCheckpoint } from './profile-checkpoint.ts'
import { materializeProfile, ProfileMaterializationError } from './profile-materializer.ts'
import type { DesktopPnpmBootstrap } from './pnpm.ts'
import {
  createDesktopExitCoordinator,
  createDesktopShutdown,
  installShutdownRequests,
  type DesktopShutdown,
} from './shutdown.ts'
import {
  diagnoseWindowsVolumes,
  formatWindowsVolumeConcern,
  type WindowsVolumeConcern,
} from './windows-volume-diagnostics.ts'
import type { RendererBootReport } from './renderer-boot-contract.ts'
import { desktopLocaleFromLanguageTag } from './tray-locale.ts'
import { discoverWslHostTargets } from './wsl.ts'
import { startWslHost, type WslHostExit, type WslManagedRuntime } from './wsl-supervisor.ts'
import { WslWorkspaceAdapter } from './wsl-workspace.ts'
import { openWslDesktopTerminal } from './wsl-terminal.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const PRODUCT_NAME = 'DSH Desktop'

class RendererStartupFailure extends Error {
  constructor(
    readonly reason: Extract<DesktopInstallRecoveryFailureReason, 'renderer-failed' | 'renderer-timeout'>,
    report: Extract<RendererBootReport, { status: 'failed' }>,
  ) {
    super(report.error ?? `Renderer boot failed for ${String(report.plugins.length)} plugin(s)`)
    this.name = 'RendererStartupFailure'
  }
}

function lifecycleRendererFailureReason(
  reason: Extract<DesktopInstallRecoveryFailureReason, 'renderer-failed' | 'renderer-timeout'> | undefined,
): DesktopLifecycleRendererFailureReason {
  return reason === 'renderer-timeout' ? 'renderer-timeout' : 'renderer-failed'
}

function lifecycleStartupFailureReason(
  cause: unknown,
  runtime: ElectronDesktopRuntime,
): DesktopLifecycleFailureReason {
  if (cause instanceof RendererStartupFailure) return cause.reason
  return runtime.rendererBootFailureReason ?? 'startup-failed'
}

/** Report profile recovery without changing startup or rollback outcomes. */
function notifyProfileRecovery(runtime: ElectronDesktopRuntime, logger: DesktopLogger, body: string): void {
  try {
    runtime.updates.notify({ title: 'Unable to Open Profile', body })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show profile recovery notification: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Explain a completed cross-restart install rollback after Desktop is healthy again. */
async function showInstallRollbackNotice(
  transaction: DesktopInstallRecoveryTransaction,
  locale: 'en' | 'zh',
  logger: DesktopLogger,
): Promise<boolean> {
  const copy = locale === 'zh'
    ? {
        title: '插件安装已回滚',
        message: `DSH Desktop 已恢复安装 ${transaction.packageName} 前的配置。`,
        detail: '上一次启动未能通过健康验证。DSH Desktop 已在本地保存诊断信息，并恢复 package.json、pnpm-lock.yaml 和 pnpm-workspace.yaml；诊断信息不会自动上传。',
        confirm: '知道了',
      }
    : {
        title: 'Plugin installation rolled back',
        message: `DSH Desktop restored the configuration from before ${transaction.packageName} was installed.`,
        detail: 'The previous startup did not pass its health check. DSH Desktop saved diagnostics locally and restored package.json, pnpm-lock.yaml, and pnpm-workspace.yaml. Diagnostics are not uploaded automatically.',
        confirm: 'OK',
      }
  try {
    await dialog.showMessageBox({
      type: 'info',
      title: copy.title,
      message: copy.message,
      detail: copy.detail,
      buttons: [copy.confirm],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    return true
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show install rollback notice: ${cause instanceof Error ? cause.message : String(cause)}`)
    return false
  }
}

/** Explain an automatic last-known-good profile restore before relaunching. */
async function showProfileCheckpointRestoreNotice(
  profileName: string,
  locale: 'en' | 'zh',
  logger: DesktopLogger,
): Promise<void> {
  const copy = locale === 'zh'
    ? {
        title: '已恢复最近一次可用配置',
        message: `DSH Desktop 已恢复最近一次成功启动的配置「${profileName}」。`,
        detail: '诊断信息已尽可能保存在本地；如果恢复涉及依赖声明，插件依赖也已按锁文件重新同步。DSH Desktop 现在将重新启动。',
        confirm: '重新启动',
      }
    : {
        title: 'Last healthy configuration restored',
        message: `DSH Desktop restored Profile “${profileName}” from the last successful startup.`,
        detail: 'Diagnostics were saved locally when possible. When dependency declarations were restored, plugin dependencies were synchronized from the lockfile. DSH Desktop will now restart.',
        confirm: 'Restart',
      }
  try {
    await dialog.showMessageBox({
      type: 'info',
      title: copy.title,
      message: copy.message,
      detail: copy.detail,
      buttons: [copy.confirm],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show profile restore notice: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Report optional user UI plugins skipped to keep startup recoverable. */
function notifySkippedOptionalEntries(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  entries: readonly SkippedOptionalEntry[],
): void {
  if (entries.length === 0) return
  const names = entries.map(entry => entry.name)
  const suffix = names.length > 1 ? ` and ${names.length - 1} more` : ''
  try {
    runtime.updates.notify({
      title: 'Skipped Unavailable UI Plugin',
      body: `${names[0]} is not installed in this profile${suffix}.`,
    })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show skipped plugin notification: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Surface path/volume risks that otherwise become obscure sandbox or pnpm failures later. */
function warnWindowsVolumeConcerns(logger: DesktopLogger, concerns: readonly WindowsVolumeConcern[]): void {
  for (const concern of concerns) {
    logger.error(`${BIN_NAME}: Windows volume warning: ${formatWindowsVolumeConcern(concern)}`)
  }
}

/** Notify once after the UI is ready; stderr carries the exact paths. */
function notifyWindowsVolumeConcerns(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  concerns: readonly WindowsVolumeConcern[],
): void {
  if (concerns.length === 0) return
  try {
    runtime.updates.notify({
      title: 'Storage May Be Unsupported',
      body: `${concerns[0]?.label ?? 'A configured path'} is on a volume that may break sandboxed commands or plugin installs.`,
    })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show Windows volume warning: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

function wslHostExitFailure(distribution: string, result: WslHostExit): Error {
  const outcome = result.error === undefined
    ? `exit code ${String(result.exitCode)}${result.signal === null ? '' : `, signal ${result.signal}`}`
    : result.error
  return new Error(`${BIN_NAME}: WSL Host ${distribution} terminated before startup health was committed (${outcome})`)
}

function createWslWorkspaceAdapter(
  distribution: string,
  managedRuntime: WslManagedRuntime,
  logger: DesktopLogger,
): WslWorkspaceAdapter {
  return new WslWorkspaceAdapter({
    distribution,
    homeDir: managedRuntime.prerequisites.homeDir,
    showOpenDialog: async options => await dialog.showOpenDialog({
      title: options.title,
      defaultPath: options.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    }),
    reportOutsideDistribution: async () => {
      const locale = desktopLocaleFromLanguageTag(app.getLocale())
      const copy = locale === 'zh'
        ? {
            title: '请选择 WSL 文件夹',
            message: `工作区必须位于 WSL 发行版「${distribution}」中。`,
            detail: String.raw`请从该发行版的 \\wsl.localhost 目录中选择文件夹。Windows 路径不会自动转换为 Linux 工作区。`,
          }
        : {
            title: 'Choose a WSL folder',
            message: `The workspace must be inside the “${distribution}” WSL distribution.`,
            detail: String.raw`Choose a folder under this distribution’s \\wsl.localhost share. Windows paths are not translated into Linux workspaces.`,
          }
      try {
        await dialog.showMessageBox({
          type: 'warning',
          title: copy.title,
          message: copy.message,
          detail: copy.detail,
          buttons: ['OK'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
      } catch (cause) {
        logger.error(`${BIN_NAME}: failed to explain rejected WSL workspace: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    },
  })
}

async function chooseWslStartupRecovery(
  distribution: string,
  cause: unknown,
): Promise<'local' | 'quit'> {
  const locale = desktopLocaleFromLanguageTag(app.getLocale())
  const detail = maskSecrets(cause instanceof Error ? cause.message : String(cause))
  const copy = locale === 'zh'
    ? {
        title: 'WSL Host 无法启动',
        message: `DSH Desktop 无法在「${distribution}」中启动完整 Host。`,
        detail: `${detail}\n\n你可以切回本机 Host 并重新启动。WSL 中的 Profile 和数据不会被删除。`,
        local: '切回本机 Host',
        quit: '退出',
      }
    : {
        title: 'WSL Host could not start',
        message: `DSH Desktop could not start the complete Host in “${distribution}”.`,
        detail: `${detail}\n\nYou can switch back to the Local Host and restart. Profiles and data in WSL will not be deleted.`,
        local: 'Use Local Host',
        quit: 'Quit',
      }
  const result = await dialog.showMessageBox({
    type: 'error',
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    buttons: [copy.local, copy.quit],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  return result.response === 0 ? 'local' : 'quit'
}

/** Keep post-health WSL recovery failures on the native trusted surface. */
async function chooseWslProfileRecoveryFailure(
  distribution: string,
  message: string,
): Promise<'local' | 'quit'> {
  const locale = desktopLocaleFromLanguageTag(app.getLocale())
  const detail = maskSecrets(message)
  const copy = locale === 'zh'
    ? {
        title: 'WSL 配置恢复失败',
        message: `DSH Desktop 无法在「${distribution}」中完成配置恢复。`,
        detail: `${detail}\n\n你可以切回本机 Host。WSL 中的 Profile、诊断和数据会保留，便于之后在 WSL 终端中修复。`,
        local: '切回本机 Host',
        quit: '退出',
      }
    : {
        title: 'WSL Profile recovery failed',
        message: `DSH Desktop could not complete Profile recovery in “${distribution}”.`,
        detail: `${detail}\n\nYou can switch to the Local Host. The WSL Profile, diagnostics, and data are preserved for repair from a WSL terminal.`,
        local: 'Use Local Host',
        quit: 'Quit',
      }
  const result = await dialog.showMessageBox({
    type: 'error',
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    buttons: [copy.local, copy.quit],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  return result.response === 0 ? 'local' : 'quit'
}

/** Start one Electron process and leave lifetime to the mounted desktop plugin. */
async function start(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  let profileStartup: DesktopProfileStartup | undefined
  let shutdown: DesktopShutdown | undefined
  let removeShutdownRequests: (() => void) | undefined
  let removeUncaughtExceptionLogging: (() => void) | undefined
  let removeChildProcessLogging: (() => void) | undefined
  let fileExporter: FileExporter | undefined
  let runtime!: ElectronDesktopRuntime
  let logSink: LogFileSink | undefined
  let installRecovery: DesktopInstallRecoveryStore | undefined
  let startupRecoveryController: DesktopStartupRecoveryController | undefined
  let startupRecoveryWindow: DesktopStartupRecoveryWindow | undefined
  let startupRecoveryConfigurationPaths: DesktopStartupRecoveryConfigurationPaths | undefined
  let startupStateCommit: DesktopStartupStateCommit | undefined
  let rolledBackInstallToNotify: DesktopInstallRecoveryTransaction | undefined
  let profileCheckpoint: DesktopProfileCheckpoint | undefined
  let restoreHealthyProfile: (() => Promise<boolean>) | undefined
  let restoreLastKnownGoodProfile: ((token: string) => Promise<void>) | undefined
  let startupRecoveryProfileActions: DesktopStartupRecoveryProfileActions | undefined
  let profileRecoveryActionUsed = false
  let recoveryTerminalAvailable = false
  let profileRollbackPrepared = false
  let protectedInstallVerificationActive = false
  let startupStage: DesktopStartupFailureStage = 'electron-ready'
  const appVersion = desktopProductVersion()
  try {
    logSink = new LogFileSink(join(app.getPath('userData'), 'logs'), {
      maxFileBytes: 10 * 1024 * 1024,
      maxDirectoryBytes: 200 * 1024 * 1024,
    })
    logSink.enforceDirectoryCap()
    logSink.purgeOlderThan(7)
    logSink.writeHeader(`--- ${BIN_NAME} ${PRODUCT_NAME} ${appVersion} ${process.platform} node ${process.version} run ${Date.now()} ---`)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    process.stderr.write(`${BIN_NAME}: file logging unavailable: ${maskSecrets(detail)}\n`)
    logSink = undefined
  }
  const electronLogger = new ElectronStderrLogger(logSink)
  const generation = new DesktopStartupGeneration({ logger: electronLogger })
  const generationId = generation.id
  const lifecycleRecorder = createDesktopLifecycleRecorder({
    userDataDir: app.getPath('userData'),
    appVersion,
    platform: process.platform,
    arch: process.arch,
    logger: electronLogger,
  })
  lifecycleRecorder.startStartup(startupStage)
  try {
    startDesktopCrashReporting(crashReporter, {
      productName: PRODUCT_NAME,
      version: appVersion,
      platform: process.platform,
      arch: process.arch,
    })
  } catch (cause) {
    electronLogger.error(`${BIN_NAME}: local crash reporting unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  let desktopRun: DesktopRun | undefined
  try {
    desktopRun = beginDesktopRun(
      join(app.getPath('userData'), 'crash-evidence', 'active-run.json'),
      {
        startedAt: new Date().toISOString(),
        pid: process.pid,
        version: appVersion,
      },
    )
    const previousRun = desktopRun.previousRun
    if (previousRun !== undefined) {
      electronLogger.error('unreadable' in previousRun
        ? `${BIN_NAME}: previous desktop run did not shut down cleanly (active run marker unreadable)`
        : `${BIN_NAME}: previous desktop run did not shut down cleanly (startedAt: ${previousRun.startedAt}, pid: ${String(previousRun.pid)}, version: ${previousRun.version})`)
    }
  } catch (cause) {
    electronLogger.error(`${BIN_NAME}: active run tracking unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  removeChildProcessLogging = installDesktopChildProcessLogging(app, electronLogger)
  const nativeExit = createDesktopExitCoordinator(
    {
      prepareToQuit: () => { runtime.prepareToQuit() },
      relaunch: () => { app.relaunch() },
      exit: code => { app.exit(code) },
    },
    () => {
      removeShutdownRequests?.()
      removeUncaughtExceptionLogging?.()
      removeChildProcessLogging?.()
      try {
        desktopRun?.markClean()
      } catch (cause) {
        electronLogger.error(`${BIN_NAME}: failed to clear active run marker: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    },
  )
  const hostTargetController = new DesktopHostTargetController(
    desktopHostTargetStatePath(app.getPath('userData')),
    {
      distributions: [],
      wslSupported: process.platform === 'win32',
      ...(process.platform === 'win32' ? { problem: 'WSL discovery is in progress.' } : {}),
    },
    cause => {
      electronLogger.error(
        `${BIN_NAME}: invalid Host target state was ignored: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    },
  )
  let restartRequested = false
  runtime = new ElectronDesktopRuntime(async () => {
    if (shutdown === undefined) {
      throw new Error('dsh-plugin-desktop: shutdown coordinator is not ready')
    }
    if (restartRequested) return
    restartRequested = true
    nativeExit.requestRelaunch()
    await shutdown.request(0)
  }, (report) => {
    if (report.status === 'failed') {
      lifecycleRecorder.finishRendererBoot(
        report,
        lifecycleRendererFailureReason(runtime.rendererBootFailureReason),
      )
    }
    // Main owns every pre-health failure branch. Returning true prevents the
    // legacy Renderer recovery dialog from racing the native startup window.
    return report.status === 'failed'
  }, electronLogger, undefined, hostTargetController)
  const finalExit = (code: number): void => { nativeExit.finish(code) }
  shutdown = createDesktopShutdown(
    async () => { await generation.release() },
    finalExit,
  )
  const requestQuit = (code: number): void => { void shutdown.request(code) }
  removeUncaughtExceptionLogging = installDesktopUncaughtExceptionLogging(
    process,
    electronLogger,
    requestQuit,
  )
  removeShutdownRequests = installShutdownRequests(process, app, requestQuit)

  const failLoudProcess: FailLoudProcess = {
    on: (event, handler) => process.on(event, handler),
    off: (event, handler) => process.off(event, handler),
    stderr: electronLogger,
    exit: finalExit,
  }
  installFailLoud(BIN_NAME, failLoudProcess, async () => { await generation.release() })

  const openStartupRecoveryWindow = async (
    failureDetail: string,
    controller: DesktopStartupRecoveryController | undefined,
  ): Promise<'restart' | 'quit' | 'unavailable'> => {
    if (!app.isReady()) return 'unavailable'
    try {
      startupRecoveryWindow = new DesktopStartupRecoveryWindow({
        ...(controller === undefined ? {} : { controller }),
        ...(startupRecoveryConfigurationPaths === undefined
          ? {}
          : { configurationPaths: startupRecoveryConfigurationPaths }),
        locale: desktopLocaleFromLanguageTag(app.getLocale()),
        failureStage: startupStage,
        failureDetail: maskSecrets(failureDetail),
        exportDiagnostics: async signal => await exportDesktopDiagnostics(app.getPath('userData'), {
          appVersion,
          crashDumpsDir: app.getPath('crashDumps'),
          signal,
        }),
        ...(recoveryTerminalAvailable ? { openTerminal: () => { runtime.openTerminal() } } : {}),
        ...(startupRecoveryProfileActions === undefined ? {} : { profileActions: startupRecoveryProfileActions }),
        ...(restoreLastKnownGoodProfile === undefined ? {} : { rollbackLastKnownGood: restoreLastKnownGoodProfile }),
      })
      return await startupRecoveryWindow.run()
    } catch (cause) {
      electronLogger.error(
        `${BIN_NAME}: failed to open startup recovery window: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      return 'unavailable'
    } finally {
      startupRecoveryWindow = undefined
    }
  }

  app.on('second-instance', () => {
    if (startupRecoveryWindow !== undefined) startupRecoveryWindow.show()
    else runtime.show()
  })
  try {
    await app.whenReady()
    startupStage = 'shell-environment'
    lifecycleRecorder.transitionStartupStage(startupStage)
    if (process.platform === 'win32') app.setAppUserModelId('ai.deepseek.dsh.desktop')
    const discoveredHostTargets = await discoverWslHostTargets()
    hostTargetController.updateDiscovery({
      distributions: discoveredHostTargets.distributions,
      wslSupported: discoveredHostTargets.wslSupported,
      ...(discoveredHostTargets.problem === undefined ? {} : { problem: discoveredHostTargets.problem }),
    })
    const selectedHostTarget = hostTargetController.read().current
    if (selectedHostTarget.mode === 'wsl') {
      const distribution = selectedHostTarget.distribution
      try {
        if (!discoveredHostTargets.distributions.includes(distribution)) {
          throw new Error(`${BIN_NAME}: selected WSL 2 distribution is not available: ${distribution}`)
        }
        const runtimeBundlePath = app.isPackaged
          ? join(process.resourcesPath, 'wsl-runtime')
          : process.env.DSH_DESKTOP_WSL_BUNDLE_DIR
        if (runtimeBundlePath === undefined) {
          throw new Error(
            `${BIN_NAME}: source builds require DSH_DESKTOP_WSL_BUNDLE_DIR to select a prepared runtime bundle`,
          )
        }
        startupStage = 'runtime-bootstrap'
        lifecycleRecorder.transitionStartupStage(startupStage)
        let workspace: WslWorkspaceAdapter | undefined
        const workspaceFor = (managedRuntime: WslManagedRuntime): WslWorkspaceAdapter => {
          workspace ??= createWslWorkspaceAdapter(distribution, managedRuntime, electronLogger)
          return workspace
        }
        startupStage = 'host-boot'
        lifecycleRecorder.transitionStartupStage(startupStage)
        const host = await startWslHost({
          distribution,
          productVersion: appVersion,
          runtimeBundlePath,
          runtime,
          logger: electronLogger,
          pickDirectory: async managedRuntime => await workspaceFor(managedRuntime).pickDirectory(),
          validateDirectory: async (managedRuntime, path) => await workspaceFor(managedRuntime).validateDirectory(path),
          openTerminal: (managedRuntime, ready) => {
            openWslDesktopTerminal({
              distribution,
              homeDir: ready.homeDir,
              profileName: ready.profileName,
              profileDir: ready.profileDir,
              runtimeRoot: managedRuntime.runtimeRoot,
              onLaunchError: cause => {
                electronLogger.error(
                  `${BIN_NAME}: failed to open WSL terminal: ${cause instanceof Error ? cause.message : String(cause)}`,
                )
                try {
                  runtime.updates.notify({
                    title: 'Unable to Open WSL Terminal',
                    body: `Windows Terminal and the console host could not open ${distribution}.`,
                  })
                } catch {}
              },
            })
          },
          exportRecoveryDiagnostics: async () => {
            const diagnosticsPath = await exportDesktopDiagnostics(app.getPath('userData'), {
              appVersion,
              crashDumpsDir: app.getPath('crashDumps'),
            })
            electronLogger.error(`${BIN_NAME}: WSL recovery diagnostics saved: ${diagnosticsPath}`)
          },
          showProfileRestoreNotice: async profileName => {
            await showProfileCheckpointRestoreNotice(
              profileName,
              desktopLocaleFromLanguageTag(app.getLocale()),
              electronLogger,
            )
          },
          showRecoveryFailure: async message => await chooseWslProfileRecoveryFailure(distribution, message),
          requestQuit,
        })
        generation.bindHost(host)
        startupStage = 'renderer-startup'
        lifecycleRecorder.transitionStartupStage(startupStage)
        lifecycleRecorder.startRendererBoot()
        const rendererBoot = runtime.beginRendererBootMonitoring({
          commitHealthy: async () => {
            lifecycleRecorder.finishRendererBoot({ status: 'healthy' }, 'renderer-failed')
            startupStage = 'health-commit'
            lifecycleRecorder.transitionStartupStage(startupStage)
            await host.commitHealthy()
          },
        })
        const [, rendererVerdict] = await Promise.race([
          Promise.all([runtime.mountScheduled(), rendererBoot] as const),
          host.terminated.then((result) => { throw wslHostExitFailure(distribution, result) }),
        ])
        if ('failureReason' in rendererVerdict) {
          throw new RendererStartupFailure(rendererVerdict.failureReason, rendererVerdict.report)
        }
        lifecycleRecorder.completeStartup(startupStage, rendererVerdict.report)
        return
      } catch (cause) {
        runtime.stopRendererBootMonitoring()
        lifecycleRecorder.failRendererBootIfPending(lifecycleRendererFailureReason(runtime.rendererBootFailureReason))
        lifecycleRecorder.failStartup(startupStage, lifecycleStartupFailureReason(cause, runtime))
        electronLogger.errorCause(cause)
        let recovery: 'local' | 'quit' = 'quit'
        try {
          recovery = await chooseWslStartupRecovery(distribution, cause)
        } catch (recoveryCause) {
          electronLogger.error(
            `${BIN_NAME}: WSL recovery dialog failed: ${recoveryCause instanceof Error ? recoveryCause.message : String(recoveryCause)}`,
          )
        }
        if (recovery === 'local') {
          hostTargetController.select({ mode: 'local' })
          nativeExit.requestRelaunch()
        }
        await shutdown.request(recovery === 'local' ? 0 : 1)
        return
      }
    }
    if (app.isPackaged && process.cwd() === '/') process.chdir(app.getPath('home'))
    const shellEnvironmentResolution = await resolveDesktopShellEnvironment({
      environment: process.env,
      home: app.getPath('home'),
      isPackaged: app.isPackaged,
      platform: process.platform,
    })
    for (const [name, value] of Object.entries(shellEnvironmentResolution.updates)) process.env[name] = value
    const homeDir = resolveDshHome()
    const windowsVolumeConcerns = diagnoseWindowsVolumes(process.platform, [
      { label: 'application install', path: process.execPath },
      { label: 'desktop user data', path: app.getPath('userData') },
      { label: 'DSH home', path: homeDir },
    ])
    warnWindowsVolumeConcerns(electronLogger, windowsVolumeConcerns)

    startupStage = 'runtime-bootstrap'
    lifecycleRecorder.transitionStartupStage(startupStage)
    const installRecoveryStatePath = desktopInstallRecoveryStatePath(app.getPath('userData'))
    const environment = loadLayeredEnv(BIN_NAME, process.cwd())
    const electronVersion = process.versions.electron
    if (electronVersion === undefined) {
      throw new Error(`${BIN_NAME}: plugin runtime requires the Electron runtime version`)
    }
    const pnpmBinPath = packagedDependencyPath(import.meta.url, 'pnpm/bin/pnpm.mjs')
    const pnpmRuntime = installDesktopPnpmRuntime({
      platform: process.platform,
      appExecutable: process.execPath,
      pnpmBinPath,
      electronVersion,
      stateDir: join(app.getPath('userData'), 'runtime-commands'),
      environment: process.env,
    })
    const releasePnpmRuntime = generation.own(() => { pnpmRuntime.dispose() })
    const selectionStatePath = join(app.getPath('userData'), 'profile-selection', 'state.json')
    const pluginManagementStatePath = join(app.getPath('userData'), 'plugin-management', 'state.json')
    const startupRecoveryStatePath = join(app.getPath('userData'), 'startup-recovery', 'state.json')
    startupStage = 'profile-selection'
    lifecycleRecorder.transitionStartupStage(startupStage)
    profileStartup = beginDesktopProfileStartup(selectionStatePath, homeDir)
    const activeProfileName = profileStartup.profileName
    const activeProfileDir = resolveProfileDir(activeProfileName, homeDir)
    const recoveryProfileToken = randomUUID()
    startupRecoveryProfileActions = {
      token: recoveryProfileToken,
      list: () => listDesktopProfiles(homeDir).map(profile => ({
        name: profile.name,
        current: profile.name === activeProfileName,
        selectable: profile.webCapable && profile.problem === undefined,
      })),
      switchProfile: (name, token) => {
        if (token !== recoveryProfileToken || profileRecoveryActionUsed) {
          throw new Error(`${BIN_NAME}: the Profile recovery action is no longer valid`)
        }
        profileRecoveryActionUsed = true
        assertDesktopProfileName(name)
        const selection = readDesktopProfileState(selectionStatePath)
        if (selection.active !== activeProfileName) throw new Error(`${BIN_NAME}: active Profile changed before recovery`)
        const target = listDesktopProfiles(homeDir).find(profile => profile.name === name)
        if (target === undefined || !target.webCapable || target.problem !== undefined) {
          throw new Error(`${BIN_NAME}: Profile ${JSON.stringify(name)} is unavailable`)
        }
        selectDesktopProfile(selectionStatePath, homeDir, name)
      },
      openCreator: () => {
        runtime.openProfileCreateWindow({
          onSubmit: async name => {
            assertDesktopProfileName(name)
            const selection = readDesktopProfileState(selectionStatePath)
            if (selection.active !== activeProfileName) throw new Error(`${BIN_NAME}: active Profile changed before recovery`)
            createDesktopWebProfile(homeDir, name)
            selectDesktopProfile(selectionStatePath, homeDir, name)
          },
        })
      },
    }
    try {
      profileCheckpoint = new DesktopProfileCheckpoint({
        userDataDir: app.getPath('userData'),
        profileDir: activeProfileDir,
        profileName: activeProfileName,
        provider: 'desktop-profile',
      })
    } catch (cause) {
      electronLogger.error(
        `${BIN_NAME}: healthy profile checkpoints are unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    startupRecoveryConfigurationPaths = {
      settingsDocument: join(homeDir, 'settings.yaml'),
      profilePatch: join(activeProfileDir, PROFILE_PATCH_FILENAME),
      profileManifest: join(activeProfileDir, 'package.json'),
      profileDirectory: activeProfileDir,
    }
    installRecovery = new DesktopInstallRecoveryStore({
      statePath: installRecoveryStatePath,
      profileName: activeProfileName,
      profileDir: activeProfileDir,
      generationId,
    })
    const stateCommit = new DesktopStartupStateCommit({
      profile: profileStartup,
      profileStatePath: selectionStatePath,
      installRecovery,
      quiesceForRecovery: () => generation.quiesceForRecovery(),
      logger: electronLogger,
    })
    startupStateCommit = stateCommit
    startupRecoveryController = new DesktopStartupRecoveryController({
      pluginState: {
        profileName: activeProfileName,
        homeDir,
        statePath: startupRecoveryStatePath,
      },
      generationId,
      currentGeneration: () => ({
        profileName: readDesktopProfileState(selectionStatePath).active,
        generationId,
      }),
      installRecovery,
    })
    startupStage = 'install-recovery'
    lifecycleRecorder.transitionStartupStage(startupStage)
    const recoveryClaim = await installRecovery.claim()
    stateCommit.observeInstallRecoveryClaim(recoveryClaim)
    protectedInstallVerificationActive = recoveryClaim.action === 'verify'
    if (recoveryClaim.action === 'prompt') {
      electronLogger.error(
        `${BIN_NAME}: protected plugin install ${recoveryClaim.transaction.packageName} (${recoveryClaim.transaction.transactionId}) requires a recovery choice after ${recoveryClaim.reason}`,
      )
      const recoveryResult = await openStartupRecoveryWindow(
        `Protected plugin installation ${recoveryClaim.transaction.packageName}@${recoveryClaim.transaction.packageVersion} requires a recovery choice after ${recoveryClaim.reason}.`,
        startupRecoveryController,
      )
      startupRecoveryController.dispose()
      startupRecoveryController = undefined
      if (recoveryResult === 'restart') nativeExit.requestRelaunch()
      lifecycleRecorder.failStartup(startupStage, 'startup-failed')
      await shutdown.request(recoveryResult === 'restart' ? 0 : 1)
      return
    } else if (
      recoveryClaim.action === 'terminal'
      && recoveryClaim.transaction.phase === 'manual-recovery-required'
    ) {
      throw new Error(`${BIN_NAME}: plugin install recovery requires manual repair before this profile can start`)
    } else if (
      recoveryClaim.action === 'terminal'
      && recoveryClaim.transaction.phase === 'rolled-back'
      && recoveryClaim.transaction.rollbackNotifiedAt === undefined
    ) {
      rolledBackInstallToNotify = recoveryClaim.transaction
    } else if (recoveryClaim.action === 'deferred') {
      electronLogger.error(
        `${BIN_NAME}: deferred plugin install recovery (${recoveryClaim.reason}) for ${recoveryClaim.transaction.packageName}`,
      )
    }
    startupStage = 'profile-composition'
    lifecycleRecorder.transitionStartupStage(startupStage)
    const marketUserDataDir = app.getPath('userData')
    const marketSelection = readDesktopMarketStateForUserData(marketUserDataDir)
    const prepared = prepareDesktopProfile(
      process.env.DSH_TELEMETRY_DISABLED,
      homeDir,
      process.platform,
      activeProfileName,
      pluginManagementStatePath,
      marketSelection,
      startupRecoveryStatePath,
      {
        onSettingsDocumentResolved: settingsDocument => {
          if (startupRecoveryConfigurationPaths === undefined) return
          startupRecoveryConfigurationPaths = {
            ...startupRecoveryConfigurationPaths,
            settingsDocument,
          }
        },
      },
    )
    if (profileCheckpoint === undefined) {
      try {
        profileCheckpoint = new DesktopProfileCheckpoint({
          userDataDir: app.getPath('userData'),
          profileDir: prepared.profile.dir,
          profileName: activeProfileName,
          provider: 'desktop-profile',
        })
      } catch (cause) {
        electronLogger.error(
          `${BIN_NAME}: healthy profile checkpoints remain unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }
    if (prepared.marketFailure !== undefined) {
      electronLogger.error(
        `${BIN_NAME}: requested Market provider ${prepared.market.requested} was disabled for this generation: ${prepared.marketFailure}`,
      )
    }
    startupStage = 'runtime-bootstrap'
    lifecycleRecorder.transitionStartupStage(startupStage)
    const dshBootstrapPath = fileURLToPath(new URL('./desktop-cli.js', import.meta.url))
    const dshRuntime = process.platform === 'win32'
      ? installDesktopDshRuntime({
          platform: process.platform,
          appExecutable: process.execPath,
          dshBootstrapPath,
          profileName: activeProfileName,
          homeDir,
          stateDir: join(app.getPath('userData'), 'host-commands', activeProfileName),
          installRecoveryStatePath,
          environment: process.env,
        })
      : undefined
    const releaseDshRuntime = generation.own(() => { dshRuntime?.dispose() })
    const desktopPnpmBootstrap: DesktopPnpmBootstrap = {
      activeProfileName,
      activeProfileDir: prepared.profile.dir,
      homeDir,
      appExecutable: process.execPath,
      pnpmBinPath,
      electronVersion,
      nodeBinDir: pnpmRuntime.nodeBinDir,
      nodeShimPath: pnpmRuntime.nodeShimPath,
      clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
      dshBootstrapPath,
      installRecoveryStatePath,
      generationId,
      externalMarketInstallEnabled: prepared.market.effective === 'dsh-market',
    }
    const restoreProfileCheckpoint = async (
      checkpoint: DesktopProfileCheckpoint,
      profileName: string,
      profileDir: string,
      attemptId: string,
      forceMaterialization = false,
      showNotice = true,
    ): Promise<boolean> => {
      const inspection = checkpoint.inspectRestore(attemptId)
      if (!inspection.snapshotExists || inspection.restoreAttempted
        || (!inspection.currentDiffers && !forceMaterialization)) return false
      try {
        const diagnosticsPath = await exportDesktopDiagnostics(app.getPath('userData'), {
          appVersion,
          crashDumpsDir: app.getPath('crashDumps'),
        })
        electronLogger.error(`${BIN_NAME}: startup diagnostics saved before profile restore: ${diagnosticsPath}`)
      } catch (diagnosticCause) {
        electronLogger.error(
          `${BIN_NAME}: failed to export diagnostics before profile restore: ${diagnosticCause instanceof Error ? diagnosticCause.message : String(diagnosticCause)}`,
        )
      }
      const restored = checkpoint.restoreLatest(attemptId)
      if (restored.status !== 'restored') return false
      const dependencyFilesChanged = restored.changedFiles.some(name =>
        name === 'package.json' || name === 'pnpm-lock.yaml' || name === 'pnpm-workspace.yaml')
      if (dependencyFilesChanged || forceMaterialization) {
        try {
          await materializeProfile({
            appExecutable: process.execPath,
            clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
            pnpmBinPath,
            nodeBinDir: pnpmRuntime.nodeBinDir,
            nodeShimPath: pnpmRuntime.nodeShimPath,
            homeDir,
            profileDir,
            electronVersion,
          })
        } catch (materializationCause) {
          const detail = materializationCause instanceof ProfileMaterializationError
            ? materializationCause.result?.stderr || materializationCause.message
            : materializationCause instanceof Error ? materializationCause.message : String(materializationCause)
          electronLogger.error(`${BIN_NAME}: restored profile dependency synchronization failed: ${maskSecrets(detail)}`)
          return false
        }
      }
      if (showNotice) {
        await showProfileCheckpointRestoreNotice(
          profileName,
          desktopLocaleFromLanguageTag(app.getLocale()),
          electronLogger,
        )
      }
      return true
    }
    restoreHealthyProfile = async () => {
      const checkpoint = profileCheckpoint
      if (checkpoint === undefined) return false
      return await restoreProfileCheckpoint(
        checkpoint,
        activeProfileName,
        activeProfileDir,
        generationId,
      )
    }
    restoreLastKnownGoodProfile = async (token: string) => {
      if (token !== recoveryProfileToken || profileRecoveryActionUsed) {
        throw new Error(`${BIN_NAME}: the Profile recovery action is no longer valid`)
      }
      profileRecoveryActionUsed = true
      const selection = readDesktopProfileState(selectionStatePath)
      if (selection.active !== activeProfileName) throw new Error(`${BIN_NAME}: active Profile changed before recovery`)
      const targetProfile = selection.lastKnownGood
      const target = listDesktopProfiles(homeDir).find(profile => profile.name === targetProfile)
      if (target === undefined || !target.webCapable || target.problem !== undefined) {
        throw new Error(`${BIN_NAME}: last-known-good Profile is unavailable`)
      }
      const targetDir = resolveProfileDir(targetProfile, homeDir)
      const targetCheckpoint = targetProfile === activeProfileName && profileCheckpoint !== undefined
        ? profileCheckpoint
        : new DesktopProfileCheckpoint({
            userDataDir: app.getPath('userData'),
            profileDir: targetDir,
            profileName: targetProfile,
            provider: 'desktop-profile',
          })
      if (!targetCheckpoint.inspectRestore().snapshotExists) {
        throw new Error(`${BIN_NAME}: no healthy configuration snapshot is available`)
      }
      if (!await generation.quiesceForRecovery()) {
        throw new Error(`${BIN_NAME}: Host could not be stopped safely for Profile recovery`)
      }
      const restored = await restoreProfileCheckpoint(
        targetCheckpoint,
        targetProfile,
        targetDir,
        `manual-${generationId}-${randomUUID()}`,
        true,
        false,
      )
      if (!restored) throw new Error(`${BIN_NAME}: healthy Profile snapshot was not restored`)
      selectDesktopProfile(selectionStatePath, homeDir, targetProfile)
    }
    startupStage = 'host-boot'
    lifecycleRecorder.transitionStartupStage(startupStage)
    const releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
    // Configure the launcher-owned terminal before Host boot so the native
    // recovery window can still open it when profile composition fails.
    runtime.configureTerminal({
      profileName: activeProfileName,
      profileDir: prepared.profile.dir,
      homeDir: prepared.homeDir,
    })
    recoveryTerminalAvailable = true
    const ctx = await boot(
      BIN_NAME,
      prepared.rootConfig,
      prepared.patches,
      async (hostCtx) => {
        generation.bindHost(hostCtx)
        hostCtx.effect(
          () => releasePnpmRuntime,
          'dsh-plugin-desktop: packaged pnpm runtime PATH',
        )
        if (dshRuntime !== undefined) {
          hostCtx.effect(
            () => releaseDshRuntime,
            'dsh-plugin-desktop: packaged dsh runtime PATH',
          )
        }
        hostCtx.effect(
          () => releasePackageResolver,
          'dsh-plugin-desktop: profile package resolution',
        )
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        hostCtx.provide('desktopRuntime', runtime)
        hostCtx.provide('desktopPnpmBootstrap', desktopPnpmBootstrap)
        await hostCtx.plugin(DesktopActionsService, {
          openTerminal: () => { runtime.openTerminal() },
          requestRestart: () => runtime.requestRestart(),
        })
        if (prepared.market.effective === 'community-market') {
          await hostCtx.plugin(DesktopPluginsService, {
            profileName: activeProfileName,
            homeDir,
            statePath: pluginManagementStatePath,
            recoveryStatePath: startupRecoveryStatePath,
            installAnchor: desktopInstallAnchor(),
          })
        }
        if (logSink !== undefined) {
          fileExporter = new FileExporter(logSink)
          hostCtx.logger.exporter(fileExporter)
        }
        await hostCtx.plugin(DesktopProfileService, {
          current: {
            name: activeProfileName,
            dir: prepared.profile.dir,
          },
          create: name => createDesktopWebProfile(homeDir, name),
          list: () => listDesktopProfiles(homeDir),
          canDelete: name => canDeleteDesktopProfile({
            home: homeDir,
            selectionStatePath,
            currentProfileName: activeProfileName,
          }, name),
          delete: name => deleteDesktopProfile({
            home: homeDir,
            selectionStatePath,
            currentProfileName: activeProfileName,
            ...(installRecovery === undefined ? {} : { installRecovery }),
            clearDisabledState: () => clearDesktopProfilePluginState(pluginManagementStatePath, name),
            clearCheckpoint: () => clearDesktopProfileCheckpoint(app.getPath('userData'), resolveProfileDir(name, homeDir)),
          }, name),
          persistSelection: name => { selectDesktopProfile(selectionStatePath, homeDir, name) },
          requestRestart: () => runtime.requestRestart(),
        })
        let pendingSettingsRestart: ReturnType<typeof setImmediate> | undefined
        const scheduleSettingsRestart = (): void => {
          pendingSettingsRestart ??= setImmediate(() => {
            pendingSettingsRestart = undefined
            void runtime.requestRestart().catch((cause: unknown) => {
              hostCtx.logger.error(
                `${BIN_NAME}: failed to restart after Desktop setting change: ${cause instanceof Error ? cause.message : String(cause)}`,
              )
            })
          })
        }
        hostCtx.effect(() => () => {
          if (pendingSettingsRestart !== undefined) clearImmediate(pendingSettingsRestart)
          pendingSettingsRestart = undefined
        }, 'dsh-plugin-desktop: pending Desktop settings restart')
        const readMarket = () => desktopMarketSnapshotWithEffective(
          readDesktopMarketStateForUserData(marketUserDataDir),
          prepared.market.effective,
        )
        const prepareProfileRollback = () => {
          if (profileRollbackPrepared) {
            throw new Error(`${BIN_NAME}: a last-known-good Profile restore is already pending`)
          }
          const selection = readDesktopProfileState(selectionStatePath)
          if (selection.active !== activeProfileName) {
            throw new Error(`${BIN_NAME}: active Profile changed before recovery`)
          }
          const targetProfile = selection.lastKnownGood
          const target = listDesktopProfiles(homeDir).find(candidate => candidate.name === targetProfile)
          if (target === undefined || !target.webCapable || target.problem !== undefined) {
            throw new Error(`${BIN_NAME}: last-known-good Profile is unavailable`)
          }
          const targetDir = resolveProfileDir(targetProfile, homeDir)
          let targetCheckpoint: DesktopProfileCheckpoint | undefined
          let targetSnapshotExists = false
          if (target.exists) {
            targetCheckpoint = targetProfile === activeProfileName && profileCheckpoint !== undefined
              ? profileCheckpoint
              : new DesktopProfileCheckpoint({
                  userDataDir: app.getPath('userData'),
                  profileDir: targetDir,
                  profileName: targetProfile,
                  provider: 'desktop-profile',
                })
            targetSnapshotExists = targetCheckpoint.inspectRestore().snapshotExists
          }
          if (targetCheckpoint === undefined || !targetSnapshotExists) {
            throw new Error(`${BIN_NAME}: no healthy configuration snapshot is available`)
          }
          profileRollbackPrepared = true
          return Object.freeze({
            response: Object.freeze({
              accepted: true as const,
              restartRequired: true as const,
              targetProfile,
            }),
            afterResponse: () => {
              void (async () => {
                const fresh = readDesktopProfileState(selectionStatePath)
                if (fresh.active !== activeProfileName || fresh.lastKnownGood !== targetProfile) {
                  throw new Error(`${BIN_NAME}: Profile selection changed before recovery`)
                }
                if (!await generation.quiesceForRecovery()) {
                  throw new Error(`${BIN_NAME}: Host could not be stopped safely for Profile recovery`)
                }
                const restored = await restoreProfileCheckpoint(
                  targetCheckpoint,
                  targetProfile,
                  targetDir,
                  `manual-${generationId}`,
                  true,
                )
                if (!restored) throw new Error(`${BIN_NAME}: healthy Profile snapshot was not restored`)
                stateCommit.restoreLastKnownGoodProfile()
                nativeExit.requestRelaunch()
                await shutdown?.request(0)
              })().catch(async (cause: unknown) => {
                const detail = cause instanceof Error ? cause.message : String(cause)
                electronLogger.error(
                  `${BIN_NAME}: explicit last-known-good Profile restore failed: ${detail}`,
                )
                const recoveryResult = await openStartupRecoveryWindow(
                  `The requested last-known-good Profile restore could not be completed: ${detail}`,
                  startupRecoveryController,
                )
                if (recoveryResult === 'restart') nativeExit.requestRelaunch()
                await shutdown?.request(recoveryResult === 'restart' ? 0 : 1)
              })
            },
          })
        }
        hostCtx.provide('desktopSettingsController', new DesktopSettingsController({
          profiles: hostCtx.desktopProfiles,
          readHostTarget: () => runtime.hostTarget,
          selectHostTarget: async selection => { await runtime.selectHostTarget(selection) },
          persistProfileSelection: name => {
            selectDesktopProfile(selectionStatePath, homeDir, name)
          },
          readMarket,
          selectMarket: async provider => desktopMarketSnapshotWithEffective(
            await selectDesktopMarketProvider(marketUserDataDir, provider),
            prepared.market.effective,
          ),
          scheduleRestart: scheduleSettingsRestart,
          openTerminal: () => { runtime.openTerminal() },
          exportDiagnostics: () => runtime.exportDiagnostics(),
          openProfileCreator: () => {
            runtime.openProfileCreateWindow({
              onSubmit: async name => {
                hostCtx.desktopProfiles.create(name)
                await hostCtx.desktopProfiles.select(name)
              },
            })
          },
          prepareProfileRollback,
        }))
        provideCmdline(hostCtx, {
          args: ['--host', '127.0.0.1', '--port', String(prepared.port)],
          exit: requestQuit,
        })
      },
      prepared.bareModuleBaseUrl,
    ).catch((cause: unknown) => {
      releasePackageResolver()
      throw cause
    })
    generation.bindHost(ctx)
    fileExporter?.setThreshold((ctx.settings.get(DESKTOP_SETTINGS_NAMESPACE) as DesktopSettings | undefined)?.logLevel ?? 'info')
    ctx.on('settings/updated', (namespace, next) => {
      if (namespace !== DESKTOP_SETTINGS_NAMESPACE) return
      fileExporter?.setThreshold((next as DesktopSettings).logLevel)
    })
    startupStage = 'renderer-startup'
    lifecycleRecorder.transitionStartupStage(startupStage)
    lifecycleRecorder.startRendererBoot()
    const rendererBoot = runtime.beginRendererBootMonitoring({
      commitHealthy: async () => {
        lifecycleRecorder.finishRendererBoot({ status: 'healthy' }, 'renderer-failed')
        startupStage = 'health-commit'
        lifecycleRecorder.transitionStartupStage(startupStage)
        await stateCommit.commitHealthy()
        try {
          profileCheckpoint?.captureHealthy()
        } catch (cause) {
          electronLogger.error(
            `${BIN_NAME}: failed to checkpoint the healthy profile configuration: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        }
      },
    })
    const [, rendererVerdict] = await Promise.all([
      runtime.mountScheduled(),
      rendererBoot,
    ])
    const rendererReport = rendererVerdict.report
    if (!('failureReason' in rendererVerdict)) {
      if (rolledBackInstallToNotify !== undefined) {
        const notified = await showInstallRollbackNotice(
          rolledBackInstallToNotify,
          desktopLocaleFromLanguageTag(app.getLocale()),
          electronLogger,
        )
        if (notified && installRecovery !== undefined) {
          try {
            const transaction = rolledBackInstallToNotify
            if (transaction.receiptId.startsWith('dsh-market:')) {
              // dsh-market has no receipt ledger to reconcile. Its Desktop
              // compatibility receipt exists only to bind the recovery WAL,
              // so the launcher owns cleanup after the user sees the result.
              await installRecovery.clear(transaction.transactionId)
            } else {
              await installRecovery.markRollbackNotified(transaction.transactionId)
            }
            rolledBackInstallToNotify = undefined
          } catch (cause) {
            electronLogger.error(
              `${BIN_NAME}: failed to persist install rollback notice: ${cause instanceof Error ? cause.message : String(cause)}`,
            )
          }
        }
      }
    } else {
      throw new RendererStartupFailure(
        rendererVerdict.failureReason,
        rendererVerdict.report,
      )
    }
    lifecycleRecorder.completeStartup(startupStage, rendererReport)
    notifySkippedOptionalEntries(runtime, electronLogger, prepared.skippedOptionalEntries)
    notifyWindowsVolumeConcerns(runtime, electronLogger, windowsVolumeConcerns)
    if (profileStartup.rolledBackFrom !== undefined) {
      notifyProfileRecovery(
        runtime,
        electronLogger,
        `Reopened last-known-good profile ${activeProfileName}.`,
      )
    }
  } catch (cause) {
    runtime.stopRendererBootMonitoring()
    lifecycleRecorder.failRendererBootIfPending(lifecycleRendererFailureReason(runtime.rendererBootFailureReason))
    lifecycleRecorder.failStartup(startupStage, lifecycleStartupFailureReason(cause, runtime))
    electronLogger.errorCause(cause)
    let exitCode = 1
    const failureReason: DesktopInstallRecoveryFailureReason = cause instanceof RendererStartupFailure
      ? cause.reason
      : runtime.rendererBootFailureReason ?? 'startup-failed'
    if (!protectedInstallVerificationActive && restoreHealthyProfile !== undefined) {
      const recoveryActionsSafe = await generation.quiesceForRecovery()
      if (recoveryActionsSafe) {
        try {
          if (await restoreHealthyProfile()) {
            nativeExit.requestRelaunch()
            startupRecoveryController?.dispose()
            await shutdown.request(0)
            return
          }
        } catch (restoreCause) {
          electronLogger.error(
            `${BIN_NAME}: latest healthy profile restore was unavailable: ${restoreCause instanceof Error ? restoreCause.message : String(restoreCause)}`,
          )
        }
      }
    }
    const failureCommit = startupStateCommit === undefined
      ? {
          route: routeDesktopStartupFailure({
            appReady: app.isReady(),
            stage: startupStage,
            verifyingProtectedInstall: false,
            ...(profileStartup === undefined
              ? {}
              : {
                  profile: {
                    active: profileStartup.profileName,
                    lastKnownGood: profileStartup.state.lastKnownGood,
                  },
                }),
          }),
          recoveryActionsSafe: await generation.quiesceForRecovery(),
        }
      : await startupStateCommit.commitFailure({
          appReady: app.isReady(),
          stage: startupStage,
          failureReason,
        })
    const failureRoute = failureCommit.route
    if (failureCommit.reopenLastKnownGood !== undefined) {
      nativeExit.requestRelaunch()
      exitCode = 0
      notifyProfileRecovery(
        runtime,
        electronLogger,
        `Reopening last-known-good profile ${failureCommit.reopenLastKnownGood}.`,
      )
    }
    if (exitCode !== 0
      && (failureRoute === 'protected-install-recovery' || failureRoute === 'startup-recovery')) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      const recoveryResult = await openStartupRecoveryWindow(
        detail,
        failureCommit.recoveryActionsSafe ? startupRecoveryController : undefined,
      )
      if (recoveryResult === 'restart') {
        nativeExit.requestRelaunch()
        exitCode = 0
      }
    }
    startupRecoveryController?.dispose()
    await shutdown.request(exitCode)
  }
}

async function run(): Promise<void> {
  app.setName(PRODUCT_NAME)
  if (process.argv.includes('--export-diagnostics')) {
    try {
      await app.whenReady()
      const path = await exportDesktopDiagnostics(app.getPath('userData'), {
        appVersion: desktopProductVersion(),
        crashDumpsDir: app.getPath('crashDumps'),
      })
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(`${path}\n`, error => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
      })
      app.exit(0)
    } catch (cause) {
      const message = `dsh-plugin-desktop: failed to export diagnostics: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`
      await new Promise<void>(resolve => {
        process.stderr.write(message, () => { resolve() })
      })
      app.exit(1)
    }
    return
  }
  await start()
}

/** Last-resort branch for launcher failures that happen before start's owned coordinator exists. */
async function handleFatalLauncherFailure(cause: unknown): Promise<void> {
  const detail = maskSecrets(cause instanceof Error ? cause.stack ?? cause.message : String(cause))
  process.stderr.write(`${BIN_NAME}: fatal launcher failure: ${detail}\n`)
  if (!app.isReady()) {
    app.exit(1)
    return
  }
  try {
    const recoveryWindow = new DesktopStartupRecoveryWindow({
      locale: desktopLocaleFromLanguageTag(app.getLocale()),
      failureStage: 'electron-ready',
      failureDetail: detail,
      exportDiagnostics: async signal => await exportDesktopDiagnostics(app.getPath('userData'), {
        appVersion: desktopProductVersion(),
        crashDumpsDir: app.getPath('crashDumps'),
        signal,
      }),
    })
    const result = await recoveryWindow.run()
    if (result === 'restart') {
      app.relaunch()
      app.exit(0)
    } else {
      app.exit(1)
    }
  } catch (windowCause) {
    process.stderr.write(
      `${BIN_NAME}: fatal recovery window failure: ${maskSecrets(windowCause instanceof Error ? windowCause.stack ?? windowCause.message : String(windowCause))}\n`,
    )
    app.exit(1)
  }
}

void run().catch(async (cause: unknown) => { await handleFatalLauncherFailure(cause) })
