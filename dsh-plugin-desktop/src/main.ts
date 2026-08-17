/** DSH Desktop executable: minimal Electron bootstrap around the Host Cordis root. */

import { app } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  type FailLoudProcess,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import {
  installDesktopDshRuntime,
  installDesktopPnpmRuntime,
} from './desktop-runtime-environment.ts'
import { ElectronDesktopRuntime } from './electron-runtime.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import {
  beginDesktopProfileStartup,
  listDesktopProfiles,
  markDesktopProfileFailed,
  markDesktopProfileHealthy,
  selectDesktopProfile,
  type DesktopProfileStartup,
} from './profile-manager.ts'
import { DesktopProfileService } from './profile-service.ts'
import { prepareDesktopProfile, type SkippedOptionalEntry } from './profile.ts'
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

const BIN_NAME = 'dsh-plugin-desktop'
const PRODUCT_NAME = 'DSH Desktop'

/** Report profile recovery without changing startup or rollback outcomes. */
function notifyProfileRecovery(runtime: ElectronDesktopRuntime, body: string): void {
  try {
    runtime.updates.notify({ title: 'Unable to Open Profile', body })
  } catch (cause) {
    process.stderr.write(
      `${BIN_NAME}: failed to show profile recovery notification: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
  }
}

/** Report optional user UI plugins skipped to keep startup recoverable. */
function notifySkippedOptionalEntries(
  runtime: ElectronDesktopRuntime,
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
    process.stderr.write(
      `${BIN_NAME}: failed to show skipped plugin notification: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
  }
}

/** Surface path/volume risks that otherwise become obscure sandbox or pnpm failures later. */
function warnWindowsVolumeConcerns(concerns: readonly WindowsVolumeConcern[]): void {
  for (const concern of concerns) {
    process.stderr.write(`${BIN_NAME}: Windows volume warning: ${formatWindowsVolumeConcern(concern)}\n`)
  }
}

/** Notify once after the UI is ready; stderr carries the exact paths. */
function notifyWindowsVolumeConcerns(
  runtime: ElectronDesktopRuntime,
  concerns: readonly WindowsVolumeConcern[],
): void {
  if (concerns.length === 0) return
  try {
    runtime.updates.notify({
      title: 'Storage May Be Unsupported',
      body: `${concerns[0]?.label ?? 'A configured path'} is on a volume that may break sandboxed commands or plugin installs.`,
    })
  } catch (cause) {
    process.stderr.write(
      `${BIN_NAME}: failed to show Windows volume warning: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
  }
}

/** Start one Electron process and leave lifetime to the mounted desktop plugin. */
async function start(): Promise<void> {
  app.setName(PRODUCT_NAME)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  let current: Context | undefined
  let profileStartup: DesktopProfileStartup | undefined
  let profileStatePath: string | undefined
  let shutdown: DesktopShutdown | undefined
  let removeShutdownRequests: (() => void) | undefined
  let disposeDshRuntime: (() => void) | undefined
  let disposePnpmRuntime: (() => void) | undefined
  let runtime!: ElectronDesktopRuntime
  const nativeExit = createDesktopExitCoordinator(
    {
      prepareToQuit: () => { runtime.prepareToQuit() },
      relaunch: () => { app.relaunch() },
      exit: code => { app.exit(code) },
    },
    () => { removeShutdownRequests?.() },
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
    if (profileStartup === undefined || profileStatePath === undefined) {
      throw new Error('dsh-plugin-desktop: renderer boot health arrived before profile startup')
    }
    if (report.status === 'healthy') {
      markDesktopProfileHealthy(profileStatePath, profileStartup.profileName)
    } else {
      markDesktopProfileFailed(profileStatePath, profileStartup.profileName)
    }
  })
  const finalExit = (code: number): void => { nativeExit.finish(code) }
  shutdown = createDesktopShutdown(
    async () => {
      try {
        await current?.fiber.dispose()
      } finally {
        disposeDshRuntime?.()
        disposePnpmRuntime?.()
      }
    },
    finalExit,
  )
  const requestQuit = (code: number): void => { void shutdown.request(code) }
  removeShutdownRequests = installShutdownRequests(process, app, requestQuit)

  app.on('second-instance', () => { runtime.show() })
  await app.whenReady()
  if (process.platform === 'win32') app.setAppUserModelId('ai.deepseek.dsh.desktop')
  if (app.isPackaged && process.cwd() === '/') process.chdir(app.getPath('home'))
  const homeDir = resolveDshHome()
  const windowsVolumeConcerns = diagnoseWindowsVolumes(process.platform, [
    { label: 'application install', path: process.execPath },
    { label: 'desktop user data', path: app.getPath('userData') },
    { label: 'DSH home', path: homeDir },
  ])
  warnWindowsVolumeConcerns(windowsVolumeConcerns)

  const failLoudProcess: FailLoudProcess = {
    on: (event, handler) => process.on(event, handler),
    off: (event, handler) => process.off(event, handler),
    stderr: process.stderr,
    exit: finalExit,
  }
  installFailLoud(BIN_NAME, failLoudProcess, async () => {
    try {
      await current?.fiber.dispose()
    } finally {
      disposeDshRuntime?.()
      disposePnpmRuntime?.()
    }
  })

  try {
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
    const releasePnpmRuntime = (): void => { pnpmRuntime.dispose() }
    disposePnpmRuntime = releasePnpmRuntime
    const selectionStatePath = join(app.getPath('userData'), 'profile-selection', 'state.json')
    profileStatePath = selectionStatePath
    profileStartup = beginDesktopProfileStartup(selectionStatePath, homeDir)
    const activeProfileName = profileStartup.profileName
    const prepared = prepareDesktopProfile(
      process.env.DSH_TELEMETRY_DISABLED,
      homeDir,
      process.platform,
      activeProfileName,
    )
    const dshBootstrapPath = fileURLToPath(new URL('./desktop-cli.js', import.meta.url))
    const dshRuntime = process.platform === 'win32'
      ? installDesktopDshRuntime({
          platform: process.platform,
          appExecutable: process.execPath,
          dshBootstrapPath,
          profileName: activeProfileName,
          homeDir,
          stateDir: join(app.getPath('userData'), 'host-commands', activeProfileName),
          environment: process.env,
        })
      : undefined
    const releaseDshRuntime = (): void => { dshRuntime?.dispose() }
    disposeDshRuntime = releaseDshRuntime
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
    const releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
    const ctx = await boot(
      BIN_NAME,
      prepared.rootConfig,
      prepared.patches,
      async (hostCtx) => {
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
        current = hostCtx
        hostCtx.effect(
          () => releasePackageResolver,
          'dsh-plugin-desktop: profile package resolution',
        )
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        hostCtx.provide('desktopRuntime', runtime)
        hostCtx.provide('desktopPnpmBootstrap', desktopPnpmBootstrap)
        await hostCtx.plugin(DesktopProfileService, {
          current: {
            name: activeProfileName,
            dir: prepared.profile.dir,
          },
          list: () => listDesktopProfiles(homeDir),
          persistSelection: name => { selectDesktopProfile(selectionStatePath, homeDir, name) },
          requestRestart: () => runtime.requestRestart(),
        })
        provideCmdline(hostCtx, {
          args: ['--host', '127.0.0.1', '--port', '0'],
          exit: requestQuit,
        })
      },
      prepared.bareModuleBaseUrl,
    ).catch((cause: unknown) => {
      releasePackageResolver()
      throw cause
    })
    current = ctx
    runtime.configureTerminal({
      profileName: activeProfileName,
      profileDir: prepared.profile.dir,
      homeDir: prepared.homeDir,
    })
    await runtime.mountScheduled()
    notifySkippedOptionalEntries(runtime, prepared.skippedOptionalEntries)
    notifyWindowsVolumeConcerns(runtime, windowsVolumeConcerns)
    if (profileStartup.rolledBackFrom !== undefined) {
      notifyProfileRecovery(
        runtime,
        `Reopened last-known-good profile ${activeProfileName}.`,
      )
    }
  } catch (cause) {
    process.stderr.write(`${BIN_NAME}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
    let exitCode = 1
    if (profileStartup !== undefined && profileStatePath !== undefined) {
      const retryLastKnownGood = profileStartup.profileName !== profileStartup.state.lastKnownGood
      try {
        markDesktopProfileFailed(profileStatePath, profileStartup.profileName)
        if (retryLastKnownGood) {
          nativeExit.requestRelaunch()
          exitCode = 0
          notifyProfileRecovery(
            runtime,
            `Reopening last-known-good profile ${profileStartup.state.lastKnownGood}.`,
          )
        }
      } catch (stateCause) {
        process.stderr.write(`${BIN_NAME}: failed to roll back desktop profile state: ${stateCause instanceof Error ? stateCause.message : String(stateCause)}\n`)
      }
    }
    await shutdown.request(exitCode)
  }
}

void start()
