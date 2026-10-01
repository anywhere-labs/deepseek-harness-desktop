/** DSH Desktop executable: minimal Electron bootstrap around the Host Cordis root. */

// Tool subprocesses start the private Node runner through this Electron binary,
// so that runner child needs ELECTRON_RUN_AS_NODE. Exporting it from this
// process would also reach every Chromium child — renderer, GPU, network
// service, and the utility hosts — and each of them would start as Node and die
// before it could launch. The dsh-subprocess-local patch scopes the flag to the
// runner child alone.

import { formatUnexpectedHostExit, startIsolatedDesktopHost } from './host-process.ts'
import { app, clipboard, crashReporter, safeStorage, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import {
  DSH_LAUNCH_ENVIRONMENT_KEY,
  type LaunchEnvironmentSnapshot,
} from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-web-app'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  isDesktopBackgroundNodeRequest,
  isDesktopInstallerQuitRequest,
} from './desktop-installer-quit.ts'
import { createDesktopBrowserAccess } from './desktop-browser-access.ts'
import {
  installDesktopDshRuntime,
  installDesktopPnpmRuntime,
} from './desktop-runtime-environment.ts'
import { desktopProductVersion, ElectronDesktopRuntime } from './electron-runtime.ts'
import { getOrCreateDesktopInstallationId } from './desktop-installation-id.ts'
import {
  createDesktopFailLoudProcess,
  describeDesktopChildProcess,
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
import { dshProductVersion } from './dsh-product-version.ts'
import { exportDesktopDiagnostics } from './diagnostic-export.ts'
import { createDesktopLifecycleRecorder } from './lifecycle-events.ts'
import type {
  DesktopLifecycleFailureReason,
  DesktopLifecycleRendererFailureReason,
} from './lifecycle-events.ts'
import { FileExporter } from './file-exporter.ts'
import { installAgentErrorLogging } from './agent-error-logging.ts'
import { observeDesktopPreferenceSettings } from './settings-bridge.ts'
import {
  desktopLanBrowserUrls,
  desktopLoopbackBrowserUrl,
} from './desktop-network.ts'
import { desktopLanAddresses } from './lan-addresses.ts'
import {
  buildDesktopProxyOverlay,
  desktopProxyEnvLookup,
  parsePacProxyResult,
  socksProxyDiagnostic,
  PROBE_URLS,
  type DesktopSystemProxyProbe,
} from './system-proxy.ts'
import type { DesktopLanHttpsPrivateKeyProtector } from './lan-https-certificate.ts'
import {
  DESKTOP_LAN_HTTPS_CA_PATH,
  DesktopLanHttpsRuntime,
} from './lan-https-runtime.ts'
import { LogFileSink } from './log-files.ts'
import { maskSecrets } from './mask-secrets.ts'
import { resolveDesktopShellEnvironment } from './shell-environment.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import {
  beginDesktopProfileStartup,
  assertDesktopProfileName,
  createDesktopWebProfile,
  listDesktopProfiles,
  canDeleteDesktopProfile,
  deleteDesktopProfile,
  readDesktopProfileState,
  selectDesktopProfile,
} from './profile-manager.ts'
import { DesktopProfileService } from './profile-service.ts'
import { createDesktopProfileBoot } from './profile-context.ts'
import { logInactiveStartupEntries } from './startup-audit.ts'
import { DesktopActionsService } from './desktop-actions.ts'
import { clearDesktopProfilePluginState, DesktopPluginsService } from './desktop-plugins.ts'
import {
  desktopMarketSnapshotWithEffective,
  readDesktopMarketStateForUserData,
  selectDesktopMarketProvider,
  type DesktopMarketProvider,
  type DesktopMarketSnapshot,
} from './desktop-market.ts'
import DesktopSettingsController from './desktop-settings-controller.ts'
import {
  resolveDesktopDataDirectory,
  selectDesktopDataDirectory,
  type DesktopDataDirectoryLocation,
} from './desktop-data-directory.ts'
import { acquireDesktopDataOperationLock } from './desktop-data-operation-lock.ts'
import { resetDesktopDataDirectory } from './desktop-factory-reset.ts'
import { desktopRecycleBinEnabled } from './desktop-recycle-bin.ts'
import {
  clearDesktopProfilePreferences,
  desktopProfilePreferencesFromSettings,
  readDesktopProfilePreferences,
  writeDesktopProfilePreferences,
  type DesktopProfilePreferences,
  type DesktopProfilePreferencesStateV1,
} from './profile-preferences.ts'
import {
  DesktopStartupRecoveryController,
  DesktopStartupRecoveryControllerError,
} from './startup-recovery-controller.ts'
import {
  DesktopStartupRecoveryWindow,
  type RecoveryWindowResult,
  type DesktopStartupRecoveryConfigurationPaths,
  type DesktopStartupRecoveryDataActions,
  type DesktopStartupRecoveryProfileActions,
  type DesktopStartupFailureStage,
} from './startup-recovery-window.ts'
import { routeDesktopStartupFailure } from './startup-failure-routing.ts'
import { DesktopStartupGeneration } from './startup-generation.ts'
import {
  desktopInstallAnchor,
  healDesktopProfileModuleFallback,
  prepareDesktopProfile,
  type SkippedOptionalEntry,
} from './profile.ts'
import { DesktopProfileCheckpoint } from './profile-checkpoint.ts'
import {
  beginDesktopSetupWizard,
  desktopSetupWizardPending,
  completeOrSkipDesktopSetupWizard,
  desktopSetupWizardRequired,
  desktopSetupWizardStateConstants,
  readDesktopSetupWizardState,
  desktopSetupAccountPending,
  dismissDesktopSetupAccount,
} from './setup-wizard-state.ts'
import {
  migrateDesktopBrowserAccessSettings,
  migrateDesktopWindowMaterialSettings,
  migrateLegacyAgentPresetSettings,
  mirrorDesktopSetupWizardProfileSettings,
  normalizeDesktopSetupWizardSettings,
  readDesktopSetupWizardSettings,
  updateDesktopSetupWizardSettings,
} from './setup-wizard-settings.ts'
import { isDesktopSetupWizardInput, desktopSetupWizardSelectionIsAvailable } from './setup-wizard-contract.ts'
import { ProfileCreateWindow } from './profile-create-window.ts'
import { DesktopProfileSelectionWindow } from './profile-selection-window.ts'
import { showDesktopDialog } from './desktop-dialog-window.ts'
import {
  clearDesktopProfileUsageHistory,
  desktopReleaseUserDataLocations,
  hasDesktopProfileUsageHistory,
  inspectDesktopProfileChannelAdmission,
} from './profile-channel-admission.ts'
import {
  formatProfileMaterializationFailure,
  materializeProfile,
  ProfileMaterializationError,
} from './profile-materializer.ts'
import {
  formatRecoveryPluginRemoveFailure,
  removeRecoveryPlugin,
} from './recovery-plugin-uninstall.ts'
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
import { desktopLocaleFromLanguageTag, desktopTrayLabel } from './tray-locale.ts'
import { desktopNativeCopy } from './native-dialog-copy.ts'
import {
  desktopLaunchWorkspaceRequest,
  type DesktopLaunchWorkspaceRequest,
} from './launch-workspace-path.ts'
import {
  desktopDefaultRelaunchArguments,
  desktopRecoveryModeRequested,
  desktopRecoveryRelaunchArguments,
  desktopSafeModeRelaunchArguments,
  desktopSafeModeRequested,
  relaunchDesktopApp,
} from './relaunch-arguments.ts'
import {
  cleanupDesktopSafeModeEnvironment,
  DESKTOP_SAFE_MODE_DEFAULTS,
  DESKTOP_SAFE_MODE_PROFILE_NAME,
  ensureDesktopSafeModeEnvironment,
  resetDesktopSafeModeEnvironment,
  desktopSafeModePaths,
  type DesktopSafeModePaths,
} from './safe-mode.ts'
import {
  recoverOversizedSessionProjectionCache,
  type SessionProjectionCacheRecoveryResult,
} from './session-projcache-recovery.ts'
import {
  DESKTOP_APP_ID,
  DESKTOP_PACKAGE_NAME,
  DESKTOP_PRODUCT_NAME,
  DESKTOP_RELEASE_CHANNEL,
  OTHER_DESKTOP_PRODUCT_IDENTITY,
} from './product-identity.ts'
import {
  desktopSharedHomeNoticeRequired,
  resolveDesktopChannelHome,
} from './desktop-channel-home.ts'
import { desktopRecoveryCopy } from './recovery-copy.ts'

const BIN_NAME = DESKTOP_PACKAGE_NAME
const PRODUCT_NAME = DESKTOP_PRODUCT_NAME

function withDesktopDshHome(
  environment: LaunchEnvironmentSnapshot,
  homeDir: string,
): LaunchEnvironmentSnapshot {
  const entry = Object.freeze({ value: homeDir, source: 'process' as const })
  return Object.freeze({
    get: (name: string) => name.toUpperCase() === 'DSH_HOME' ? entry : environment.get(name),
    getFrom: (name: string, sources: Parameters<LaunchEnvironmentSnapshot['getFrom']>[1]) => {
      return name.toUpperCase() === 'DSH_HOME' && sources.includes('process')
        ? entry
        : environment.getFrom(name, sources)
    },
  })
}

/** The proxy resolver reads a fresh configuration lazily; give it a moment before believing DIRECT. */
const SYSTEM_PROXY_PROBE_ATTEMPTS = 3
const SYSTEM_PROXY_PROBE_BACKOFF_MS = 200

/**
 * Ask Chromium what the operating system routes each probe URL through.
 *
 * Chromium already owns this answer: it reads the Windows registry, the macOS network preferences,
 * and the Linux desktop settings, and it evaluates PAC and WPAD before answering. Re-reading those
 * sources here would mean reimplementing all of it and still disagreeing with the application's own
 * windows. Probing is the whole reason a "system proxy" toggle in a proxy client now reaches the
 * agent: that toggle sets no environment variable.
 *
 * A failure is never fatal. The application must start on a machine whose proxy configuration
 * cannot be read, connecting directly, exactly as it did before this existed.
 *
 * Nothing is logged from here. Every note travels out on the return value and reaches the log
 * through the one resolution the caller reports, so a diagnostic can never be printed twice or --
 * worse -- printed in a shape that disagrees with the decision that was actually made.
 *
 * @returns the proxy for each scheme, whether probes disagreed, and what was rejected.
 */
async function probeSystemProxy(): Promise<DesktopSystemProxyProbe> {
  const notes: string[] = []
  const rejected: string[] = []
  try {
    const resolver = session.defaultSession
    try {
      await resolver.forceReloadProxyConfig()
    } catch (cause) {
      notes.push(`could not refresh the system proxy configuration: ${String(cause)}`)
    }
    for (let attempt = 1; attempt <= SYSTEM_PROXY_PROBE_ATTEMPTS; attempt += 1) {
      // Every attempt re-reads one configuration, so only the last round describes what was acted
      // on. Clearing keeps a single SOCKS port from being reported once per attempt.
      rejected.length = 0
      const answers = new Map<string, string>()
      for (const url of PROBE_URLS) {
        const result = parsePacProxyResult(await resolver.resolveProxy(url))
        if (result.kind === 'proxy') answers.set(url, result.url)
        else if (result.kind === 'unsupported') rejected.push(socksProxyDiagnostic(url, result.detail))
      }
      if (answers.size === 0) {
        // A session resolves its first request before the configuration lands; retry before
        // concluding the machine is direct, but never let that delay a genuinely direct start.
        if (rejected.length > 0 || attempt === SYSTEM_PROXY_PROBE_ATTEMPTS) break
        await new Promise(resolve => setTimeout(resolve, SYSTEM_PROXY_PROBE_BACKOFF_MS))
        continue
      }
      const probe: { http?: string; https?: string } = {}
      for (const [url, proxy] of answers) {
        if (url.startsWith('https:')) probe.https ??= proxy
        else probe.http ??= proxy
      }
      const disagreed = new Set(answers.values()).size > 1 || answers.size !== PROBE_URLS.length
      return { ...probe, disagreed, notes: Object.freeze([...notes, ...rejected]) }
    }
  } catch (cause) {
    notes.push(`could not read the system proxy configuration: ${String(cause)}`)
  }
  return { notes: Object.freeze([...notes, ...rejected]) }
}

/** Require OS-backed secret storage; Linux's plaintext fallback is not sufficient for a CA key. */
function desktopLanHttpsPrivateKeyProtector(): DesktopLanHttpsPrivateKeyProtector {
  return {
    available: () => {
      if (!safeStorage.isEncryptionAvailable()) return false
      if (process.platform !== 'linux') return true
      const backend = safeStorage.getSelectedStorageBackend()
      return backend !== 'basic_text' && backend !== 'unknown'
    },
    seal: plaintext => safeStorage.encryptString(Buffer.from(plaintext).toString('utf8')),
    open: sealed => Buffer.from(safeStorage.decryptString(Buffer.from(sealed)), 'utf8'),
  }
}

class RendererStartupFailure extends Error {
  constructor(
    readonly reason: 'renderer-failed' | 'renderer-timeout',
    report: Extract<RendererBootReport, { status: 'failed' }>,
  ) {
    super(report.error ?? `Renderer boot failed for ${String(report.plugins.length)} plugin(s)`)
    this.name = 'RendererStartupFailure'
  }
}

function lifecycleRendererFailureReason(
  reason: 'renderer-failed' | 'renderer-timeout' | undefined,
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

/** Report optional user UI plugins skipped to keep startup recoverable. */
function notifySkippedOptionalEntries(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  entries: readonly SkippedOptionalEntry[],
): void {
  if (entries.length === 0) return
  const copy = desktopNativeCopy(runtime.locale)
  const names = entries.map(entry => entry.name)
  try {
    runtime.updates.notify({
      title: copy.skippedPluginTitle,
      body: copy.skippedPluginBody(names[0]!, names.length - 1),
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
  const copy = desktopNativeCopy(runtime.locale)
  const concernLabel = concerns[0]?.label
  const label = runtime.locale === 'zh'
    ? concernLabel === 'application install' ? '应用安装目录'
      : concernLabel === 'desktop user data' ? '桌面用户数据'
        : concernLabel === 'DSH home' ? 'DSH 主目录'
          : '某个配置路径'
    : concernLabel ?? 'A configured path'
  try {
    runtime.updates.notify({
      title: copy.unsupportedStorageTitle,
      body: copy.unsupportedStorageBody(label),
    })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show Windows volume warning: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

function notifySessionProjectionCacheRecovery(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  _recovery: Extract<SessionProjectionCacheRecoveryResult, { status: 'quarantined' }>,
): void {
  try {
    runtime.updates.notify({
      title: 'Recovered Session Cache',
      body: 'An oversized session projection cache was moved aside and will be rebuilt from session history.',
    })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show session projection cache recovery notification: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Explain the disposable environment after the Safe Mode renderer is healthy. */
function notifyDesktopSafeModeActive(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
): void {
  const copy = desktopRecoveryCopy(runtime.locale)
  try {
    runtime.updates.notify({
      title: copy.safeModeNotificationTitle,
      body: copy.safeModeNotificationBody,
    })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show Safe Mode notification: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Use one Profile-owned Market request as the first composition input. */
function desktopProfileMarketSnapshot(market: DesktopMarketProvider): DesktopMarketSnapshot {
  return Object.freeze({
    requested: market,
    effective: market,
    legacyDefaulted: false,
  })
}

/**
 * Mirror only the Profile-owned settings leaves into the exact prepared document,
 * and only while that document still awaits 0.1.7's one-shot import.
 */
async function mirrorDesktopProfilePreferences(
  settingsDocument: string,
  preferences: DesktopProfilePreferences,
): Promise<void> {
  await mirrorDesktopSetupWizardProfileSettings(settingsDocument, preferences)
}

/** Start one Electron process and leave lifetime to the mounted desktop plugin. */
async function start(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  if (isDesktopInstallerQuitRequest(process.argv, process.platform)) {
    app.quit()
    return
  }

  let shutdown: DesktopShutdown | undefined
  let removeShutdownRequests: (() => void) | undefined
  let removeUncaughtExceptionLogging: (() => void) | undefined
  let removeChildProcessLogging: (() => void) | undefined
  // Electron reports a Host exit as a bare code with no reason. The most recent
  // Chromium child failure is the only thing that can say who else went down
  // with it, so keep it for the Host exit record.
  let lastChildProcessGone: string | undefined
  let fileExporter: FileExporter | undefined
  // A folder named by this launch waits here until the Host page is mounted.
  // No background-Node guard applies to the first instance: a development run
  // legitimately looks like one, and a first instance is by definition a real
  // launch rather than a descendant command re-entering the executable.
  let pendingLaunchWorkspacePath = desktopLaunchWorkspaceRequest(process.argv)?.path
  let launchWorkspaceReady = false
  let runtime!: ElectronDesktopRuntime
  let logSink: LogFileSink | undefined
  let startupRecoveryController: DesktopStartupRecoveryController | undefined
  let startupRecoveryWindow: DesktopStartupRecoveryWindow | undefined
  let profileCompatibilityCreateWindow: ProfileCreateWindow | undefined
  let profileSelectionWindow: DesktopProfileSelectionWindow | undefined
  let startupRecoveryConfigurationPaths: DesktopStartupRecoveryConfigurationPaths | undefined
  let profileCheckpoint: DesktopProfileCheckpoint | undefined
  let startupRecoveryProfileActions: DesktopStartupRecoveryProfileActions | undefined
  let startupRecoveryDataActions: DesktopStartupRecoveryDataActions | undefined
  let safeModePaths: DesktopSafeModePaths | undefined
  let prepareSafeMode: (() => void) | undefined
  let sessionProjectionCacheRecovery:
    | Extract<SessionProjectionCacheRecoveryResult, { status: 'quarantined' }>
    | undefined
  let recoveryTerminalAvailable = false
  let startupStage: DesktopStartupFailureStage = 'electron-ready'
  const desktopUserDataDir = app.getPath('userData')
  const appVersion = desktopProductVersion()
  const currentDshVersion = dshProductVersion()
  const setupWizardVersions = Object.freeze({
    desktopVersion: appVersion,
    dshVersion: currentDshVersion,
    setupRevision: desktopSetupWizardStateConstants.setupRevision,
  })
  const recoveryModeRequested = desktopRecoveryModeRequested()
  const safeModeRequested = desktopSafeModeRequested()
  const inheritedDshHome = process.env.DSH_HOME
  const safeModeHomeDir = desktopSafeModePaths(desktopUserDataDir).homeDir
  try {
    logSink = new LogFileSink(join(app.getPath('userData'), 'logs'), {
      maxFileBytes: 10 * 1024 * 1024,
      maxDirectoryBytes: 200 * 1024 * 1024,
      ...(desktopRecycleBinEnabled()
        ? { trashItem: (path: string) => shell.trashItem(path) }
        : {}),
    })
    logSink.enforceDirectoryCap()
    await logSink.purgeOlderThan(7)
    logSink.writeHeader(`--- ${BIN_NAME} ${PRODUCT_NAME} ${appVersion} ${process.platform} node ${process.version} run ${Date.now()} ---`)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    process.stderr.write(`${BIN_NAME}: file logging unavailable: ${maskSecrets(detail)}\n`)
    logSink = undefined
  }
  const electronLogger = new ElectronStderrLogger(logSink)
  if (safeModeRequested) {
    safeModePaths = ensureDesktopSafeModeEnvironment(desktopUserDataDir)
  } else {
    if (process.env.DSH_HOME === safeModeHomeDir) delete process.env.DSH_HOME
    try {
      cleanupDesktopSafeModeEnvironment(desktopUserDataDir)
    } catch (cause) {
      electronLogger.error(`${BIN_NAME}: failed to remove the previous Safe Mode environment: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
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
  removeChildProcessLogging = installDesktopChildProcessLogging(app, electronLogger, details => {
    lastChildProcessGone = describeDesktopChildProcess(details)
  })
  const nativeExit = createDesktopExitCoordinator(
    {
      prepareToQuit: () => { runtime.prepareToQuit() },
      relaunch: args => {
        relaunchDesktopApp(app, args ?? desktopDefaultRelaunchArguments())
      },
      exit: code => { app.exit(code) },
    },
    () => {
      removeShutdownRequests?.()
      removeUncaughtExceptionLogging?.()
      removeChildProcessLogging?.()
      if (safeModePaths !== undefined) {
        if (inheritedDshHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = inheritedDshHome
        try {
          cleanupDesktopSafeModeEnvironment(desktopUserDataDir)
        } catch (cause) {
          electronLogger.error(`${BIN_NAME}: failed to remove the Safe Mode environment: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      try {
        desktopRun?.markClean()
      } catch (cause) {
        electronLogger.error(`${BIN_NAME}: failed to clear active run marker: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    },
  )
  let restartRequested = false
  const installationId = await getOrCreateDesktopInstallationId(app.getPath('userData'))
  runtime = new ElectronDesktopRuntime(async target => {
    if (shutdown === undefined) {
      throw new Error('dsh-plugin-desktop: shutdown coordinator is not ready')
    }
    if (restartRequested) return
    if (target === 'safe-mode') {
      if (prepareSafeMode === undefined) throw new Error(`${BIN_NAME}: Safe Mode is unavailable`)
      prepareSafeMode()
    }
    restartRequested = true
    nativeExit.requestRelaunch(
      target === 'safe-mode'
        ? desktopSafeModeRelaunchArguments()
        : target === 'recovery'
          ? desktopRecoveryRelaunchArguments()
          : desktopDefaultRelaunchArguments(),
    )
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
  }, electronLogger, undefined, undefined, installationId)
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

  const openStartupRecoveryWindow = async (
    failureDetail: string,
    controller: DesktopStartupRecoveryController | undefined,
    requested = false,
  ): Promise<RecoveryWindowResult | 'unavailable'> => {
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
        ...(requested ? { requested: true } : {}),
        exportDiagnostics: async signal => await exportDesktopDiagnostics(app.getPath('userData'), {
          appVersion,
          crashDumpsDir: app.getPath('crashDumps'),
          signal,
        }),
        ...(recoveryTerminalAvailable ? { openTerminal: () => { runtime.openTerminal() } } : {}),
        ...(startupRecoveryProfileActions === undefined ? {} : { profileActions: startupRecoveryProfileActions }),
        ...(startupRecoveryDataActions === undefined ? {} : { dataActions: startupRecoveryDataActions }),
        ...(prepareSafeMode === undefined ? {} : { enterSafeMode: prepareSafeMode }),
        ...(safeModePaths === undefined ? {} : { safeModeActive: true }),
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

  const showPreHostSurface = (): boolean => {
    if (profileCompatibilityCreateWindow !== undefined) {
      profileCompatibilityCreateWindow.open()
      return true
    }
    if (profileSelectionWindow !== undefined) {
      profileSelectionWindow.show()
      return true
    }
    if (startupRecoveryWindow !== undefined) {
      startupRecoveryWindow.show()
      return true
    }
    return false
  }
  /** Apply native policy to one launch folder and hand it to the Host page. */
  const openLaunchWorkspace = async (path: string): Promise<void> => {
    try {
      if (!await runtime.admitWorkspacePath(path)) return
      const delivery = await runtime.openWorkspacePath(path)
      if (delivery === 'unavailable') {
        electronLogger.error(`${BIN_NAME}: no renderer could accept the launch workspace: ${path}`)
      }
    } catch (cause) {
      electronLogger.error(
        `${BIN_NAME}: failed to open the launch workspace: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }

  /** Take one launch folder, deferring it until the Host page can accept it. */
  const acceptLaunchWorkspace = (request: DesktopLaunchWorkspaceRequest | undefined): void => {
    if (request === undefined) return
    if (!launchWorkspaceReady) {
      pendingLaunchWorkspacePath = request.path
      return
    }
    void openLaunchWorkspace(request.path)
  }

  app.on('activate', () => { showPreHostSurface() })
  if (process.platform === 'darwin') app.on('did-become-active', () => { showPreHostSurface() })
  app.on('second-instance', (_event, argv) => {
    if (isDesktopInstallerQuitRequest(argv, process.platform)) {
      requestQuit(0)
      return
    }
    const launchWorkspace = desktopLaunchWorkspaceRequest(argv)
    if (isDesktopBackgroundNodeRequest(argv)) {
      // A descendant Node command re-entered as a GUI process. Only the
      // launcher's own flag tells a workspace hand-off apart from whatever
      // paths that command happens to carry on its own command line.
      if (launchWorkspace?.explicit !== true) return
    }
    if (!showPreHostSurface()) runtime.show()
    acceptLaunchWorkspace(launchWorkspace)
  })
  try {
    await app.whenReady()
    startupStage = 'shell-environment'
    lifecycleRecorder.transitionStartupStage(startupStage)
    if (process.platform === 'win32') app.setAppUserModelId(DESKTOP_APP_ID)
    if (app.isPackaged && process.cwd() === '/') process.chdir(app.getPath('home'))
    const shellEnvironmentResolution = await resolveDesktopShellEnvironment({
      environment: process.env,
      home: app.getPath('home'),
      isPackaged: app.isPackaged,
      platform: process.platform,
    })
    for (const [name, value] of Object.entries(shellEnvironmentResolution.updates)) process.env[name] = value
    const profileUserDataDir = safeModePaths?.userDataDir ?? desktopUserDataDir
    prepareSafeMode = safeModePaths === undefined
      ? () => {
          const paths = resetDesktopSafeModeEnvironment(desktopUserDataDir)
          try {
            createDesktopWebProfile(paths.homeDir, DESKTOP_SAFE_MODE_PROFILE_NAME)
            selectDesktopProfile(
              join(paths.userDataDir, 'profile-selection', 'state.json'),
              paths.homeDir,
              DESKTOP_SAFE_MODE_PROFILE_NAME,
            )
          } catch (cause) {
            cleanupDesktopSafeModeEnvironment(desktopUserDataDir)
            throw cause
          }
        }
      : undefined
    const failLoudProcess: FailLoudProcess = createDesktopFailLoudProcess(
      process,
      electronLogger,
      finalExit,
      () => { removeUncaughtExceptionLogging?.() },
    )
    installFailLoud(BIN_NAME, failLoudProcess, async () => { await generation.release() })

    startupStage = 'runtime-bootstrap'
    lifecycleRecorder.transitionStartupStage(startupStage)
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
    const dshBootstrapPath = fileURLToPath(new URL('./desktop-cli.js', import.meta.url))
    const releasePnpmRuntime = generation.own(() => { pnpmRuntime.dispose() })
    const channelHomeResolution = resolveDesktopChannelHome()
    const fallbackHome = channelHomeResolution.homeDir
    const defaultHome = channelHomeResolution.channelHome
    const fallbackSource = channelHomeResolution.status === 'explicit' ? 'environment' : 'default'
    let dataDirectoryLocation: DesktopDataDirectoryLocation | undefined
    let homeDir: string
    if (safeModePaths !== undefined) {
      homeDir = safeModePaths.homeDir
    } else {
      dataDirectoryLocation = resolveDesktopDataDirectory(
        desktopUserDataDir,
        fallbackHome,
        fallbackSource,
      )
      homeDir = dataDirectoryLocation.homeDir
    }
    process.env.DSH_HOME = homeDir
    const desktopLaunchEnvironment = withDesktopDshHome(environment, homeDir)
    // Before anything can send a request. `installProxyFromEnvironment` also writes the resolved
    // names back into `process.env` in both casings, which is how `host-process.ts`'s
    // `env: { ...process.env }` carries this route to the Host and to every process it spawns --
    // pnpm, stdio MCP servers, the bash tool.
    const proxyResolution = buildDesktopProxyOverlay({
      env: desktopLaunchEnvironment,
      probe: await probeSystemProxy(),
      lanAddresses: desktopLanAddresses(),
    })
    electronLogger.info(`${BIN_NAME}: ${proxyResolution.summary}`)
    for (const diagnostic of proxyResolution.diagnostics) electronLogger.error(`${BIN_NAME}: ${diagnostic}`)
    const releaseProxy = await installProxyFromEnvironment(
      desktopProxyEnvLookup(desktopLaunchEnvironment, proxyResolution.overlay),
      message => { electronLogger.error(`${BIN_NAME}: ${message}`) },
    )
    generation.own(() => { void releaseProxy() })
    const projectionCacheRecovery = recoverOversizedSessionProjectionCache(homeDir)
    if (projectionCacheRecovery.status === 'quarantined') {
      sessionProjectionCacheRecovery = projectionCacheRecovery
      electronLogger.error(
        `${BIN_NAME}: quarantined oversized session projection cache (${String(projectionCacheRecovery.sizeBytes)} bytes) at `
          + `${projectionCacheRecovery.cachePath}; backup saved to ${projectionCacheRecovery.backupPath}`,
      )
    }
    const windowsVolumeConcerns = diagnoseWindowsVolumes(process.platform, [
      { label: 'application install', path: process.execPath },
      { label: 'desktop user data', path: desktopUserDataDir },
      { label: 'DSH home', path: homeDir },
    ])
    warnWindowsVolumeConcerns(electronLogger, windowsVolumeConcerns)
    const selectionStatePath = join(profileUserDataDir, 'profile-selection', 'state.json')
    const pluginManagementStatePath = join(profileUserDataDir, 'plugin-management', 'state.json')
    const marketUserDataDir = profileUserDataDir
    const releaseUserDataLocations = desktopReleaseUserDataLocations(
      app.getPath('appData'),
      marketUserDataDir,
    )
    const createFreshDesktopProfile = (name: string) => {
      const created = createDesktopWebProfile(homeDir, name)
      clearDesktopProfileUsageHistory(releaseUserDataLocations, created.dir)
      return created
    }
    startupStage = 'profile-selection'
    lifecycleRecorder.transitionStartupStage(startupStage)
    const profileDirectoriesBeforeStartup = new Set(
      listDesktopProfiles(homeDir).map(profile => profile.dir),
    )
    // Keep Profile recovery usable when the persisted selection no longer exists.
    const locale = desktopLocaleFromLanguageTag(app.getLocale())
    const recoveryProfileToken = randomUUID()
    let activeProfileName = readDesktopProfileState(selectionStatePath).active
    let expectedRecoveryProfileName = activeProfileName
    const openStartupProfileCreator = async (): Promise<void> => {
      await new Promise<void>(resolve => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          resolve()
        }
        profileCompatibilityCreateWindow = new ProfileCreateWindow({
          locale,
          onSubmit: name => {
            assertDesktopProfileName(name)
            const selection = readDesktopProfileState(selectionStatePath)
            if (selection.active !== expectedRecoveryProfileName) {
              throw new Error(`${BIN_NAME}: active Profile changed outside recovery`)
            }
            createFreshDesktopProfile(name)
            selectDesktopProfile(selectionStatePath, homeDir, name)
            expectedRecoveryProfileName = name
            finish()
          },
          onCancel: finish,
        })
        profileCompatibilityCreateWindow.open()
      })
      profileCompatibilityCreateWindow = undefined
    }
    startupRecoveryProfileActions = {
      token: recoveryProfileToken,
      list: () => {
        const selectedProfileName = readDesktopProfileState(selectionStatePath).active
        return listDesktopProfiles(homeDir).map(profile => ({
          name: profile.name,
          current: profile.name === selectedProfileName,
          selectable: profile.webCapable && profile.problem === undefined,
        }))
      },
      switchProfile: (name, token) => {
        if (token !== recoveryProfileToken) {
          throw new Error(`${BIN_NAME}: the Profile recovery action is no longer valid`)
        }
        assertDesktopProfileName(name)
        const selection = readDesktopProfileState(selectionStatePath)
        if (selection.active !== expectedRecoveryProfileName) {
          throw new Error(`${BIN_NAME}: active Profile changed outside recovery`)
        }
        const target = listDesktopProfiles(homeDir).find(profile => profile.name === name)
        if (target === undefined || !target.webCapable || target.problem !== undefined) {
          throw new Error(`${BIN_NAME}: Profile ${JSON.stringify(name)} is unavailable`)
        }
        selectDesktopProfile(selectionStatePath, homeDir, name)
        expectedRecoveryProfileName = name
      },
      openCreator: openStartupProfileCreator,
    }
    const profileStartup = beginDesktopProfileStartup(selectionStatePath, homeDir)
    activeProfileName = profileStartup.profileName
    expectedRecoveryProfileName = activeProfileName
    const activeProfileDir = resolveProfileDir(activeProfileName, homeDir)
    if (!profileDirectoriesBeforeStartup.has(activeProfileDir)) {
      clearDesktopProfileUsageHistory(releaseUserDataLocations, activeProfileDir)
    }
    // Recovery can open before Profile composition and Host boot. Fix the
    // launcher-owned terminal identity as soon as Profile selection succeeds
    // so every recovery entry path exposes the same terminal action.
    runtime.configureTerminal({
      profileName: activeProfileName,
      profileDir: activeProfileDir,
      homeDir,
    })
    recoveryTerminalAvailable = true
    if (safeModePaths !== undefined) {
      const safeModeTray = runtime.registerTrayItem({
        group: 'status',
        order: -100,
        label: () => desktopTrayLabel(runtime.locale, 'exitSafeMode'),
        invoke: async () => {
          if (restartRequested) return
          restartRequested = true
          nativeExit.requestRelaunch(desktopDefaultRelaunchArguments())
          await shutdown.request(0)
        },
      })
      generation.own(() => { safeModeTray.dispose() })
    } else {
      const safeModeTray = runtime.registerTrayItem({
        group: 'tools',
        order: 100,
        label: () => desktopTrayLabel(runtime.locale, 'enterSafeMode'),
        invoke: () => runtime.requestSafeModeRestart(),
      })
      generation.own(() => { safeModeTray.dispose() })
    }
    const openCompatibilityProfileSelector = async (): Promise<'restart' | 'cancel' | 'unavailable'> => {
      const profileActions = startupRecoveryProfileActions
      if (profileActions === undefined) return 'unavailable'
      try {
        profileSelectionWindow = new DesktopProfileSelectionWindow({ locale, profileActions })
        return await profileSelectionWindow.run()
      } catch (cause) {
        electronLogger.error(
          `${BIN_NAME}: failed to open Profile selector: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
        return 'unavailable'
      } finally {
        profileSelectionWindow = undefined
      }
    }
    if (!recoveryModeRequested) {
      const copy = desktopNativeCopy(locale)
      // Both releases used to share one DSH home, and with it the installation
      // module index that each core generation rewrites. Offer the move once per
      // launch; nothing is copied, so the shared directory keeps working as is.
      if (dataDirectoryLocation !== undefined
        && desktopSharedHomeNoticeRequired(channelHomeResolution, dataDirectoryLocation.source)) {
        const sharedLocation = dataDirectoryLocation
        const otherProductName = OTHER_DESKTOP_PRODUCT_IDENTITY.productName
        const result = await showDesktopDialog({
          type: 'warning',
          title: copy.sharedDataDirectoryTitle,
          message: copy.sharedDataDirectoryMessage(PRODUCT_NAME, otherProductName),
          detail: copy.sharedDataDirectoryDetail(
            sharedLocation.homeDir,
            channelHomeResolution.channelHome,
          ),
          advisory: copy.sharedDataDirectoryWarning(
            otherProductName,
            join(sharedLocation.homeDir, 'sessions'),
          ),
          presentation: 'profile-compatibility',
          buttons: [copy.useChannelDataDirectory, copy.shareDataDirectoryAnyway, copy.quit],
          defaultId: 0,
          cancelId: 1,
        })
        if (result.response === 2) {
          await shutdown.request(0)
          return
        }
        if (result.response === 0) {
          let moved = false
          const lease = acquireDesktopDataOperationLock(
            desktopUserDataDir,
            'move Desktop onto its release-channel data directory',
          )
          try {
            await selectDesktopDataDirectory(
              desktopUserDataDir,
              sharedLocation,
              channelHomeResolution.channelHome,
              { createIfMissing: true },
            )
            moved = true
          } catch (cause) {
            electronLogger.error(
              `${BIN_NAME}: could not select the release-channel data directory: `
                + `${cause instanceof Error ? cause.message : String(cause)}`,
            )
          } finally {
            lease.release()
          }
          if (moved) {
            nativeExit.requestRelaunch()
            await shutdown.request(0)
            return
          }
          await showDesktopDialog({
            type: 'error',
            title: copy.sharedDataDirectoryTitle,
            message: copy.sharedDataDirectoryFailed,
            buttons: [copy.ok],
            defaultId: 0,
            cancelId: 0,
          })
        }
      }
      while (true) {
        const admission = inspectDesktopProfileChannelAdmission(
          releaseUserDataLocations,
          activeProfileDir,
          activeProfileName,
        )
        if (admission.status === 'allow') break
        const previous = admission.reason === 'other-channel-latest'
          ? admission.previous
          : undefined
        const result = await showDesktopDialog({
          type: 'warning',
          title: copy.profileCompatibilityTitle,
          message: copy.profileCompatibilityMessage(activeProfileName, previous?.productName),
          detail: previous === undefined
            ? copy.profileCompatibilityUnknownDetail(PRODUCT_NAME, appVersion, currentDshVersion)
            : copy.profileCompatibilityDetail(
                previous.desktopVersion,
                previous.dshVersion ?? copy.unknownVersion,
                PRODUCT_NAME,
                appVersion,
                currentDshVersion,
              ),
          advisory: copy.profileCompatibilityWarning,
          presentation: 'profile-compatibility',
          buttons: [copy.switchProfile, copy.useProfileAnyway, copy.quit],
          defaultId: 0,
          cancelId: 2,
        })
        if (result.response === 1) break
        if (result.response === 2) {
          await shutdown.request(0)
          return
        }
        const selectionResult = await openCompatibilityProfileSelector()
        if (selectionResult !== 'restart') continue
        nativeExit.requestRelaunch()
        await shutdown.request(0)
        return
      }
    }
    try {
      profileCheckpoint = new DesktopProfileCheckpoint({
        userDataDir: profileUserDataDir,
        profileDir: activeProfileDir,
        homeDir,
        profileName: activeProfileName,
        provider: 'desktop-profile',
        appVersion,
        desktopPackageName: DESKTOP_PACKAGE_NAME,
        releaseChannel: DESKTOP_RELEASE_CHANNEL,
        dshVersion: currentDshVersion,
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
    if (dataDirectoryLocation !== undefined) {
      const recoveryDataLocation = dataDirectoryLocation
      const selectRecoveryDataDirectory = async (
        targetDirectory: string,
        signal: AbortSignal,
        operation: string,
        createIfMissing = false,
      ): Promise<void> => {
        const lease = acquireDesktopDataOperationLock(desktopUserDataDir, operation)
        try {
          const current = resolveDesktopDataDirectory(
            desktopUserDataDir,
            fallbackHome,
            fallbackSource,
          )
          if (current.homeDir !== recoveryDataLocation.homeDir
            || current.generation !== recoveryDataLocation.generation) {
            throw new Error(`${BIN_NAME}: active data directory changed while Recovery Assistant was open`)
          }
          const selection = await selectDesktopDataDirectory(
            desktopUserDataDir,
            current,
            targetDirectory,
            { signal, createIfMissing },
          )
          if (selection.target.kind === 'existing') {
            const selectedName = readDesktopProfileState(selectionStatePath).active
            const available = listDesktopProfiles(selection.location.homeDir)
              .filter(profile => profile.webCapable && profile.problem === undefined)
            const nextProfile = available.find(profile => profile.name === selectedName)
              ?? available.find(profile => profile.name === 'desktop')
              ?? available[0]
            if (nextProfile !== undefined && nextProfile.name !== selectedName) {
              try {
                selectDesktopProfile(selectionStatePath, selection.location.homeDir, nextProfile.name)
                expectedRecoveryProfileName = nextProfile.name
              } catch (cause) {
                electronLogger.error(
                  `${BIN_NAME}: selected data directory requires Profile selection in Recovery Assistant: ${cause instanceof Error ? cause.message : String(cause)}`,
                )
              }
            }
          }
        } finally {
          lease.release()
        }
      }
      const normalizedDefaultHome = process.platform === 'win32' ? defaultHome.toLowerCase() : defaultHome
      const normalizedCurrentHome = process.platform === 'win32'
        ? recoveryDataLocation.homeDir.toLowerCase()
        : recoveryDataLocation.homeDir
      startupRecoveryDataActions = {
        currentDirectory: recoveryDataLocation.homeDir,
        usingDefaultDirectory: normalizedCurrentHome === normalizedDefaultHome,
        defaultDirectoryMissing: () => !existsSync(defaultHome),
        changeDirectory: async (targetDirectory: string, signal: AbortSignal) => {
          await selectRecoveryDataDirectory(
            targetDirectory,
            signal,
            'change DSH data directory from Recovery Assistant',
          )
        },
        restoreDefaultDirectory: async (signal: AbortSignal, createIfMissing: boolean) => {
          await selectRecoveryDataDirectory(
            defaultHome,
            signal,
            'restore default DSH data directory from Recovery Assistant',
            createIfMissing,
          )
        },
        resetDirectory: async () => {
          const lease = acquireDesktopDataOperationLock(
            desktopUserDataDir,
            'factory reset DSH data directory from Recovery Assistant',
          )
          try {
            await resetDesktopDataDirectory({
              homeDir: recoveryDataLocation.homeDir,
              userDataDir: marketUserDataDir,
              protectedPaths: [
                app.getPath('home'),
                app.getPath('appData'),
                desktopUserDataDir,
                dirname(process.execPath),
                process.cwd(),
              ],
              trashItem: async path => { await shell.trashItem(path) },
              clearProfileUsageHistory: profileDir => { clearDesktopProfileUsageHistory(releaseUserDataLocations, profileDir) },
            })
          } finally {
            lease.release()
          }
        },
      }
    }
    if (profileCheckpoint !== undefined) {
      startupRecoveryController = new DesktopStartupRecoveryController({
        pluginState: {
          profileName: activeProfileName,
          homeDir,
          statePath: pluginManagementStatePath,
        },
        generationId,
        currentGeneration: () => ({
          profileName: readDesktopProfileState(selectionStatePath).active,
          generationId,
        }),
        uninstallPlugin: async packageName => {
          try {
            await removeRecoveryPlugin({
              appExecutable: process.execPath,
              dshBootstrapPath,
              profileName: activeProfileName,
              profileDir: activeProfileDir,
              homeDir,
              nodeBinDir: pnpmRuntime.nodeBinDir,
              nodeShimPath: pnpmRuntime.nodeShimPath,
              pnpmBinDir: pnpmRuntime.pathDir,
              electronVersion,
              packageName,
            })
          } catch (cause) {
            const detail = maskSecrets(formatRecoveryPluginRemoveFailure(cause))
            electronLogger.error(`${BIN_NAME}: recovery plugin uninstall failed:\n${detail}`)
            throw new DesktopStartupRecoveryControllerError(
              'operation-failed',
              'The plugin could not be removed from the current Profile.',
              { operationStage: 'plugin-change', diagnosticDetail: detail },
            )
          }
        },
        checkpoints: profileCheckpoint,
        openCheckpointDirectory: async path => {
          const error = await shell.openPath(path)
          if (error.length > 0) throw new Error(error)
        },
        afterCheckpointRestore: async result => {
          if (!result.dependencyMaterializationRequired) return
          try {
            await materializeProfile({
              appExecutable: process.execPath,
              clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
              pnpmBinPath,
              nodeBinDir: pnpmRuntime.nodeBinDir,
              nodeShimPath: pnpmRuntime.nodeShimPath,
              homeDir,
              profileDir: activeProfileDir,
              electronVersion,
            })
          } catch (cause) {
            const detail = maskSecrets(formatProfileMaterializationFailure(cause))
            electronLogger.error(`${BIN_NAME}: checkpoint dependency materialization failed:\n${detail}`)
            throw new DesktopStartupRecoveryControllerError(
              'operation-failed',
              'The checkpoint files were restored, but Profile dependencies could not be rebuilt.',
              {
                operationStage: 'dependency-materialization',
                diagnosticDetail: detail,
              },
            )
          }
        },
      })
    }
    if (recoveryModeRequested) {
      const recoveryResult = await openStartupRecoveryWindow(
        'Recovery mode was requested from the Desktop restart menu.',
        startupRecoveryController,
        true,
      )
      startupRecoveryController?.dispose()
      startupRecoveryController = undefined
      if (recoveryResult === 'restart') nativeExit.requestRelaunch()
      else if (recoveryResult === 'safe-mode') {
        nativeExit.requestRelaunch(desktopSafeModeRelaunchArguments())
      }
      await shutdown.request(recoveryResult === 'restart' || recoveryResult === 'safe-mode' ? 0 : 1)
      return
    }
    startupStage = 'profile-composition'
    lifecycleRecorder.transitionStartupStage(startupStage)
    const lanAddresses = desktopLanAddresses()
    const legacyMarketSelection = readDesktopMarketStateForUserData(marketUserDataDir)
    let profilePreferences = readDesktopProfilePreferences(marketUserDataDir, activeProfileDir)
    let marketSelection = profilePreferences === undefined
      ? legacyMarketSelection
      : desktopProfileMarketSnapshot(profilePreferences.market)
    const preparationHooks = {
      get aaEnabled() { return safeModePaths === undefined && profilePreferences?.aaEnabled === true },
      lanAddresses,
      onSettingsDocumentResolved: (settingsDocument: string) => {
        if (startupRecoveryConfigurationPaths === undefined) return
        startupRecoveryConfigurationPaths = {
          ...startupRecoveryConfigurationPaths,
          settingsDocument,
        }
      },
    }
    await healDesktopProfileModuleFallback(homeDir)
    let prepared = prepareDesktopProfile(
      process.env.DSH_TELEMETRY_DISABLED,
      homeDir,
      process.platform,
      activeProfileName,
      pluginManagementStatePath,
      marketSelection,
      preparationHooks,
    )
    let legacyPresetMigrated = false
    if (safeModePaths === undefined) {
      try {
        legacyPresetMigrated = await migrateLegacyAgentPresetSettings(prepared.settingsDocument)
      } catch (cause) {
        // A Profile whose settings document cannot be rewritten keeps the
        // broken default it already had. Throwing here would trade that one
        // failing preset id for the recovery window on every launch.
        electronLogger.error(
          `${BIN_NAME}: failed to persist legacy agent preset migration: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }
    if (legacyPresetMigrated) {
      prepared = prepareDesktopProfile(
        process.env.DSH_TELEMETRY_DISABLED,
        homeDir,
        process.platform,
        activeProfileName,
        pluginManagementStatePath,
        marketSelection,
        preparationHooks,
      )
    }
    if (safeModePaths !== undefined) {
      const safeModeDefaults = DESKTOP_SAFE_MODE_DEFAULTS
      await updateDesktopSetupWizardSettings(prepared.settingsDocument, safeModeDefaults.settings)
      await selectDesktopMarketProvider(marketUserDataDir, safeModeDefaults.market)
      marketSelection = readDesktopMarketStateForUserData(marketUserDataDir)
      profilePreferences = await writeDesktopProfilePreferences(
        marketUserDataDir,
        prepared.profile.dir,
        desktopProfilePreferencesFromSettings(
          safeModeDefaults.settings,
          safeModeDefaults.settings.notifications,
          safeModeDefaults.market,
          safeModeDefaults.aaEnabled,
        ),
      )
      prepared = prepareDesktopProfile(
        process.env.DSH_TELEMETRY_DISABLED,
        homeDir,
        process.platform,
        activeProfileName,
        pluginManagementStatePath,
        marketSelection,
        preparationHooks,
      )
    } else if (profilePreferences === undefined) {
      const browserAccessMigrated = await migrateDesktopBrowserAccessSettings(prepared.settingsDocument)
      let windowMaterialMigrated = false
      try {
        windowMaterialMigrated = await migrateDesktopWindowMaterialSettings(prepared.settingsDocument)
      } catch (cause) {
        // Legacy Acrylic is already normalized to off by the read boundary. A
        // read-only settings file must not turn removal of the effect into a
        // startup failure merely because the durable cleanup could not be saved.
        electronLogger.error(
          `${BIN_NAME}: failed to persist removed Acrylic material migration: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
      if (browserAccessMigrated || windowMaterialMigrated) {
        prepared = prepareDesktopProfile(
          process.env.DSH_TELEMETRY_DISABLED,
          homeDir,
          process.platform,
          activeProfileName,
          pluginManagementStatePath,
          marketSelection,
          preparationHooks,
        )
      }
      const importedSettings = readDesktopSetupWizardSettings(prepared.settingsDocument)
      profilePreferences = await writeDesktopProfilePreferences(
        marketUserDataDir,
        prepared.profile.dir,
        desktopProfilePreferencesFromSettings(
          prepared,
          importedSettings.notifications,
          legacyMarketSelection.requested,
        ),
      )
    } else {
      // Existing Profile state is the source of truth. Mirror it only after the
      // first prepare has resolved this Profile's exact settings document.
      await mirrorDesktopProfilePreferences(prepared.settingsDocument, profilePreferences)
      try {
        await migrateDesktopWindowMaterialSettings(prepared.settingsDocument)
      } catch (cause) {
        // Keep retrying the device-owned Acrylic cleanup on later launches,
        // even after this Profile has completed its one-time preference import.
        electronLogger.error(
          `${BIN_NAME}: failed to persist removed Acrylic material migration: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
      await selectDesktopMarketProvider(marketUserDataDir, profilePreferences.market)
      marketSelection = readDesktopMarketStateForUserData(marketUserDataDir)
      prepared = prepareDesktopProfile(
        process.env.DSH_TELEMETRY_DISABLED,
        homeDir,
        process.platform,
        activeProfileName,
        pluginManagementStatePath,
        marketSelection,
        preparationHooks,
      )
    }
    // Desktop setup has its own per-Profile trigger, independent of account state.
    // The official page checks that trigger before showing its own account flow.
    const setupWizardState = safeModePaths === undefined
      ? readDesktopSetupWizardState(marketUserDataDir, prepared.profile.dir) : undefined
    let setupPending = safeModePaths === undefined
      && desktopSetupWizardRequired(setupWizardState, setupWizardVersions)
      && (desktopSetupWizardPending(marketUserDataDir, prepared.profile.dir)
        || !hasDesktopProfileUsageHistory(releaseUserDataLocations, prepared.profile.dir, activeProfileName))
    if (setupPending) await beginDesktopSetupWizard(marketUserDataDir, prepared.profile.dir)
    const setupInput = { ...readDesktopSetupWizardSettings(prepared.settingsDocument), appVersion,
      profileName: activeProfileName, platform: runtime.platform,
      market: marketSelection.requested, aaEnabled: profilePreferences?.aaEnabled === true }
    let setupSaving = false
    let setupRestartPending = false
    runtime.setupOnboarding = {
      read: async () => ({ required: setupPending, edition: 'desktop', profile: activeProfileName,
        restartPending: setupRestartPending,
        accountPending: safeModePaths === undefined && !setupPending && desktopSetupAccountPending(marketUserDataDir, prepared.profile.dir),
        input: setupInput }),
      dismissAccount: async profile => {
        if (setupPending || profile !== activeProfileName || safeModePaths !== undefined) throw new Error('Desktop account setup is unavailable')
        dismissDesktopSetupAccount(marketUserDataDir, prepared.profile.dir)
      },
      applyPending: async profile => {
        if (setupPending || setupSaving || profile !== activeProfileName || safeModePaths !== undefined
          || desktopSetupAccountPending(marketUserDataDir, prepared.profile.dir)) throw new Error('Desktop settings are not ready to apply')
        if (!setupRestartPending) return
        setupRestartPending = false
        setImmediate(() => {
          nativeExit.requestRelaunch(desktopDefaultRelaunchArguments())
          void shutdown.request(0)
        })
      },
      finish: async (profile, selection, applySettings) => {
        if (!setupPending || setupSaving || profile !== activeProfileName || safeModePaths !== undefined) throw new Error('Desktop setup is unavailable')
        if (selection !== undefined && (!isDesktopSetupWizardInput({ ...selection, appVersion,
          profileName: profile, platform: runtime.platform }) || !desktopSetupWizardSelectionIsAvailable(selection, { platform: runtime.platform }))) {
          throw new Error('Invalid Desktop setup selection')
        }
        // Preferences only mirror the Profile; its patch layer decides the next
        // generation. Refuse before writing anything rather than half-apply Setup.
        if (selection !== undefined && applySettings === undefined) throw new Error('Desktop settings are unavailable')
        setupSaving = true
        try {
          if (selection !== undefined) {
            profilePreferences = await writeDesktopProfilePreferences(marketUserDataDir, prepared.profile.dir,
              desktopProfilePreferencesFromSettings(selection, selection.notifications, selection.market, selection.aaEnabled === true))
            await selectDesktopMarketProvider(marketUserDataDir, selection.market)
            // A new Profile has no settings document left to import, so save
            // through the live settings scopes the way the mode picker does.
            await applySettings!(normalizeDesktopSetupWizardSettings({
              mode: selection.mode,
              macosMaterial: selection.macosMaterial,
              windowsMaterial: selection.windowsMaterial,
              openBrowser: selection.openBrowser,
              networkExposure: selection.networkExposure,
              notifications: selection.notifications,
            }))
          }
          // Keep the existing per-Profile marker; a failed save must remain resumable.
          await completeOrSkipDesktopSetupWizard(marketUserDataDir, prepared.profile.dir,
            selection === undefined ? 'skipped' : 'completed', setupWizardVersions)
          setupPending = false
          // Keep the current renderer/Host alive for official login and onboarding.
          // Preferences are applied on the next launch, requested explicitly afterwards.
          setupRestartPending = selection !== undefined
        } finally { setupSaving = false }
      },
    }
    if (profileCheckpoint === undefined) {
      try {
        profileCheckpoint = new DesktopProfileCheckpoint({
          userDataDir: profileUserDataDir,
          profileDir: prepared.profile.dir,
          homeDir,
          profileName: activeProfileName,
          provider: 'desktop-profile',
          appVersion,
          desktopPackageName: DESKTOP_PACKAGE_NAME,
          releaseChannel: DESKTOP_RELEASE_CHANNEL,
          dshVersion: currentDshVersion,
        })
      } catch (cause) {
        electronLogger.error(
          `${BIN_NAME}: healthy profile checkpoints remain unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }
    startupStage = 'runtime-bootstrap'
    lifecycleRecorder.transitionStartupStage(startupStage)
    const dshRuntime = process.platform === 'win32'
      ? installDesktopDshRuntime({
          platform: process.platform,
          appExecutable: process.execPath,
          dshBootstrapPath,
          profileName: activeProfileName,
          homeDir,
          stateDir: join(profileUserDataDir, 'host-commands', activeProfileName),
          environment: process.env,
        })
      : undefined
    const releaseDshRuntime = generation.own(() => { dshRuntime?.dispose() })
    if (prepared.requiresDependencyMigration) {
      electronLogger.error(`${BIN_NAME}: migrating legacy Profile dependency layout with packaged pnpm`)
      try {
        await materializeProfile({
          appExecutable: process.execPath,
          clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
          pnpmBinPath,
          nodeBinDir: pnpmRuntime.nodeBinDir,
          nodeShimPath: pnpmRuntime.nodeShimPath,
          homeDir,
          profileDir: prepared.profile.dir,
          electronVersion,
          updateLockfile: true,
        })
        prepared = prepareDesktopProfile(
          process.env.DSH_TELEMETRY_DISABLED,
          homeDir,
          process.platform,
          activeProfileName,
          pluginManagementStatePath,
          marketSelection,
          preparationHooks,
        )
        if (prepared.requiresDependencyMigration) {
          throw new Error(`${BIN_NAME}: packaged pnpm did not produce compatible Profile dependency metadata`)
        }
      } catch (migrationCause) {
        const detail = migrationCause instanceof ProfileMaterializationError
          ? migrationCause.result?.stderr || migrationCause.message
          : migrationCause instanceof Error ? migrationCause.message : String(migrationCause)
        throw new Error(`${BIN_NAME}: Profile dependency migration failed: ${maskSecrets(detail)}`)
      }
    }
    if (prepared.aaFailure !== undefined) {
      electronLogger.error(`${BIN_NAME}: requested AA bundle was disabled for this generation: ${maskSecrets(prepared.aaFailure)}`)
    }
    if (prepared.marketFailure !== undefined) {
      electronLogger.error(
        `${BIN_NAME}: requested Market provider ${prepared.market.requested} was disabled for this generation: ${prepared.marketFailure}`,
      )
    }
    const prepareHostCertificate = async () => {
      if (prepared.lanAddresses.length === 0) return { failureCode: 'no-address' }
      const { createLanHttpsCertificate, DesktopLanHttpsCertificateError } = await import('./lan-https-certificate.ts')
      try {
        const certificate = await createLanHttpsCertificate(
          marketUserDataDir,
          prepared.lanAddresses,
          desktopLanHttpsPrivateKeyProtector(),
        )
        return { certificate }
      } catch (cause) {
        const failureCode = cause instanceof DesktopLanHttpsCertificateError ? cause.code : 'certificate-state'
        electronLogger.error(
          `${BIN_NAME}: LAN HTTPS certificate setup is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
        return { failureCode }
      }
    }
    const lanHttps = new DesktopLanHttpsRuntime({
      addresses: prepared.lanAddresses, prepareCertificate: prepareHostCertificate, requestedPort: 0,
    })
    const browserAccess = createDesktopBrowserAccess(
      prepared.mode === 'compatibility' && prepared.openBrowser,
    )
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
    }
    await healDesktopProfileModuleFallback(homeDir, prepared.profile)
    if (profilePreferences === undefined) {
      throw new Error(`${BIN_NAME}: active Profile preferences were not initialized`)
    }
    if (process.env.DSH_DESKTOP_ISOLATED_HOST !== '0') {
      startupStage = 'host-boot'
      lifecycleRecorder.transitionStartupStage(startupStage)
      await startIsolatedDesktopHost({
        host: { prepared, profilePreferences, homeDir, activeProfileName, pluginManagementStatePath,
          selectionStatePath, marketUserDataDir, releaseUserDataLocations, desktopLaunchEnvironment,
          desktopProxyOverlay: proxyResolution.overlay,
          desktopPnpmBootstrap, logDirectory: join(desktopUserDataDir, 'logs', 'host') },
        runtime, rendererToken: browserAccess.rendererHeader.value,
        prepareCertificate: prepareHostCertificate,
        bindHost: host => generation.bindHost(host), requestQuit,
        onFailure: (error, exit) => {
          electronLogger.error(formatUnexpectedHostExit(error, exit))
          lifecycleRecorder.recordHostExit({
            exitCode: exit.exitCode,
            expected: false,
            uptimeMs: exit.uptimeMs,
            ...(lastChildProcessGone === undefined ? {} : { childProcessGone: lastChildProcessGone }),
          })
          runtime.notifyAttention({ title: PRODUCT_NAME, body: error.message })
          // A dialog that cannot open must not turn a dead Host into a dead app.
          void runtime.showHostStoppedRecovery({ exitCode: exit.exitCode })
            .catch((cause: unknown) => { electronLogger.errorCause(cause) })
        },
      })
    } else {
      let currentProfilePreferences: DesktopProfilePreferences = profilePreferences
      let profilePreferencesWriteTail: Promise<void> = Promise.resolve()
      let profilePreferencesStopping = false
      // Setup saves from the Electron process after this Host booted; follow the
      // durable file so its Market and AA choices are neither reverted nor hidden.
      const latestProfilePreferences = (): DesktopProfilePreferences =>
        readDesktopProfilePreferences(marketUserDataDir, prepared.profile.dir) ?? currentProfilePreferences
      const readProfilePreferences = (): DesktopProfilePreferences => {
        try { return latestProfilePreferences() } catch { return currentProfilePreferences }
      }
      const enqueueProfilePreferencesWrite = (
        update: (current: DesktopProfilePreferences) => DesktopProfilePreferences,
      ): Promise<DesktopProfilePreferencesStateV1> => {
        if (profilePreferencesStopping) {
          return Promise.reject(new Error(`${BIN_NAME}: Profile preferences are stopping`))
        }
        const write = profilePreferencesWriteTail.then(async () => {
          const next = update(latestProfilePreferences())
          const stored = await writeDesktopProfilePreferences(
            marketUserDataDir,
            prepared.profile.dir,
            next,
          )
          currentProfilePreferences = stored
          return stored
        })
        profilePreferencesWriteTail = write.then(() => undefined, () => undefined)
        return write
      }
      const flushProfilePreferencesWrites = async (): Promise<void> => {
        profilePreferencesStopping = true
        await profilePreferencesWriteTail
      }
      startupStage = 'host-boot'
      lifecycleRecorder.transitionStartupStage(startupStage)
      const releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
      const profileBoot = createDesktopProfileBoot(prepared, desktopPnpmBootstrap)
      const ctx = await boot(
        BIN_NAME,
        prepared.rootConfig,
        prepared.patches,
        async (hostCtx) => {
          profileBoot.prepare(hostCtx)
          // Keep Host imports and browser bundle discovery on the same public
          // profile-overlay resolver used by packaged Electron.
          hostCtx.loader.internal = undefined
          generation.bindHost(hostCtx)
          hostCtx.effect(
            () => async () => { await flushProfilePreferencesWrites() },
            'dsh-plugin-desktop: flush Profile preference writes',
          )
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
          hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, desktopLaunchEnvironment)
          hostCtx.provide('desktopBrowserAccess', browserAccess)
          hostCtx.provide('desktopLanHttps', lanHttps)
          hostCtx.provide('desktopRuntime', runtime)
          hostCtx.provide('desktopPnpmBootstrap', desktopPnpmBootstrap)
          hostCtx.provide('desktopClipboard', {
            writeText: (text: string) => clipboard.writeText(text),
            readText: () => clipboard.readText(),
          })
          await hostCtx.plugin(DesktopActionsService, {
            openTerminal: () => { runtime.openTerminal() },
            requestRestart: () => runtime.requestRestart(),
          })
          if (prepared.market.effective === 'community-market') {
            await hostCtx.plugin(DesktopPluginsService, {
              profileName: activeProfileName,
              homeDir,
              statePath: pluginManagementStatePath,
              installAnchor: desktopInstallAnchor(),
            })
          }
          if (logSink !== undefined) {
            fileExporter = new FileExporter(logSink)
            hostCtx.logger.exporter(fileExporter)
          }
          // Registered before the plugin tree mounts, so no agent can fail unrecorded.
          installAgentErrorLogging(hostCtx)
          await hostCtx.plugin(DesktopProfileService, {
            current: {
              name: activeProfileName,
              dir: prepared.profile.dir,
            },
            create: name => createFreshDesktopProfile(name),
            list: () => listDesktopProfiles(homeDir),
            canDelete: name => canDeleteDesktopProfile({
              home: homeDir,
              selectionStatePath,
              currentProfileName: activeProfileName,
            }, name),
            delete: async name => {
              const profileDir = resolveProfileDir(name, homeDir)
              await deleteDesktopProfile({
                home: homeDir,
                selectionStatePath,
                currentProfileName: activeProfileName,
                clearDisabledState: () => clearDesktopProfilePluginState(pluginManagementStatePath, name),
                clearCheckpoint: async () => {
                  clearDesktopProfileUsageHistory(releaseUserDataLocations, profileDir)
                },
              }, name)
              try {
                await clearDesktopProfilePreferences(marketUserDataDir, profileDir)
              } catch (cause) {
                hostCtx.logger.error(
                  `${BIN_NAME}: deleted Profile left stale preference state: ${cause instanceof Error ? cause.message : String(cause)}`,
                )
              }
            },
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
            desktopProfileMarketSnapshot(readProfilePreferences().market),
            prepared.market.effective,
          )
          hostCtx.provide('desktopSettingsController', new DesktopSettingsController({
            profiles: hostCtx.desktopProfiles,
            readMarket,
            readAa: () => ({ requested: readProfilePreferences().aaEnabled === true, effective: prepared.aaEnabled }),
            selectAa: async enabled => {
              await enqueueProfilePreferencesWrite(current => desktopProfilePreferencesFromSettings(
                current,
                current.notifications,
                current.market,
                enabled,
              ))
            },
            readWeb: () => {
              const lan = lanHttps.snapshot()
              const lanOrigins = lan.state === 'ready' && lan.actualPort !== null
                ? desktopLanBrowserUrls(lan.actualPort, lan.addresses)
                : []
              return {
                localUrl: hostCtx.connection.authenticatedUrl(
                  desktopLoopbackBrowserUrl(hostCtx.webServer.port),
                ),
                lanUrls: lanOrigins.map(url => hostCtx.connection.authenticatedUrl(url)),
                lanState: lan.state,
                lanError: lan.errorCode,
                lanCaFingerprint: lan.caFingerprint,
                lanCaUrls: lanOrigins.map((origin) => {
                  return new URL(DESKTOP_LAN_HTTPS_CA_PATH, origin).href
                }),
              }
            },
            selectMarket: async provider => {
              await enqueueProfilePreferencesWrite(current => desktopProfilePreferencesFromSettings(
                current,
                current.notifications,
                provider,
                current.aaEnabled === true,
              ))
              return desktopMarketSnapshotWithEffective(
                await selectDesktopMarketProvider(marketUserDataDir, provider),
                prepared.market.effective,
              )
            },
            scheduleRestart: scheduleSettingsRestart,
            scheduleRecoveryRestart: () => {
              void runtime.requestRecoveryRestart().catch((cause: unknown) => {
                hostCtx.logger.error(
                  `${BIN_NAME}: failed to restart in recovery mode: ${cause instanceof Error ? cause.message : String(cause)}`,
                )
              })
            },
            openTerminal: () => { runtime.openTerminal() },
            reloadRenderer: () => { runtime.reloadRenderer() },
            toggleDeveloperTools: () => { runtime.toggleDeveloperTools() },
            exportDiagnostics: () => runtime.exportDiagnostics(),
          }))
          provideCmdline(hostCtx, {
            args: [
              '--port',
              String(prepared.port),
            ],
            exit: requestQuit,
          })
        },
        prepared.bareModuleBaseUrl,
      ).catch((cause: unknown) => {
        releasePackageResolver()
        throw cause
      })
      generation.bindHost(ctx)
      profileBoot.markReady()
      observeDesktopPreferenceSettings(ctx, fileExporter, enqueueProfilePreferencesWrite)
      void logInactiveStartupEntries(ctx, BIN_NAME)
    }
    startupStage = 'renderer-startup'
    lifecycleRecorder.transitionStartupStage(startupStage)
    lifecycleRecorder.startRendererBoot()
    const rendererBoot = runtime.beginRendererBootMonitoring({
      commitHealthy: async () => {
        lifecycleRecorder.finishRendererBoot({ status: 'healthy' }, 'renderer-failed')
        startupStage = 'health-commit'
        lifecycleRecorder.transitionStartupStage(startupStage)
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
    if ('failureReason' in rendererVerdict) {
      throw new RendererStartupFailure(
        rendererVerdict.failureReason,
        rendererVerdict.report,
      )
    }
    lifecycleRecorder.completeStartup(startupStage, rendererReport)
    // Only a renderer that reached a healthy boot can take a workspace, so the
    // hand-off is released here rather than beside the mount: a startup that
    // ended in the recovery route must not also try to open a folder.
    launchWorkspaceReady = true
    const requestedWorkspacePath = pendingLaunchWorkspacePath
    pendingLaunchWorkspacePath = undefined
    if (requestedWorkspacePath !== undefined) void openLaunchWorkspace(requestedWorkspacePath)
    notifySkippedOptionalEntries(runtime, electronLogger, prepared.skippedOptionalEntries)
    notifyWindowsVolumeConcerns(runtime, electronLogger, windowsVolumeConcerns)
    if (safeModePaths !== undefined && DESKTOP_SAFE_MODE_DEFAULTS.settings.notifications.enabled) {
      notifyDesktopSafeModeActive(runtime, electronLogger)
    }
    if (sessionProjectionCacheRecovery !== undefined) {
      notifySessionProjectionCacheRecovery(runtime, electronLogger, sessionProjectionCacheRecovery)
    }
  } catch (cause) {
    runtime.stopRendererBootMonitoring()
    lifecycleRecorder.failRendererBootIfPending(lifecycleRendererFailureReason(runtime.rendererBootFailureReason))
    lifecycleRecorder.failStartup(startupStage, lifecycleStartupFailureReason(cause, runtime))
    electronLogger.errorCause(cause)
    let exitCode = 1
    const failureRoute = routeDesktopStartupFailure({
      appReady: app.isReady(),
      stage: startupStage,
    })
    const recoveryActionsSafe = await generation.quiesceForRecovery()
    if (failureRoute === 'startup-recovery') {
      const detail = cause instanceof Error ? cause.message : String(cause)
      const recoveryResult = await openStartupRecoveryWindow(
        detail,
        recoveryActionsSafe ? startupRecoveryController : undefined,
      )
      if (recoveryResult === 'restart') {
        nativeExit.requestRelaunch()
        exitCode = 0
      } else if (recoveryResult === 'safe-mode') {
        nativeExit.requestRelaunch(desktopSafeModeRelaunchArguments())
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
      relaunchDesktopApp(app)
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
