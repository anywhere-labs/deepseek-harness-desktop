import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { realpathSync } from 'node:fs'

import { desktopArgumentsWithoutLaunchWorkspace } from './launch-workspace-path.ts'

/** One-process launch marker used to enter recovery before Profile Host boot. */
export const DESKTOP_RECOVERY_MODE_ARGUMENT = '--dsh-desktop-recovery'
/** Process marker selecting the disposable Safe Mode DSH environment. */
export const DESKTOP_SAFE_MODE_ARGUMENT = '--dsh-desktop-safe-mode'

/**
 * Rebuild the current Electron command line without retaining one-shot modes.
 *
 * A launch folder is one of those one-shot inputs: it states what this launch
 * was asked to open, not what the application should reopen every time it
 * restarts itself.
 */
export function desktopDefaultRelaunchArguments(argv: readonly string[] = process.argv): string[] {
  return desktopArgumentsWithoutLaunchWorkspace(argv.slice(1))
    .filter(argument => argument !== DESKTOP_RECOVERY_MODE_ARGUMENT
      && argument !== DESKTOP_SAFE_MODE_ARGUMENT)
}

/**
 * Resolve the outer AppImage file when running from a Linux AppImage.
 *
 * The AppImage runtime exports `APPIMAGE` as the absolute path of the image it
 * mounted; outside Linux the variable carries no meaning and is ignored.
 */
export function desktopAppImagePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const appImage = env.APPIMAGE
  return platform === 'linux' && appImage ? appImage : undefined
}

/** The part of Electron's `app` that a relaunch needs. */
export interface DesktopRelaunchTarget {
  relaunch(options?: { args?: string[] }): void
}

/** The part of `child_process.spawn` that an AppImage relaunch needs. */
export type DesktopRelaunchSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Pick<ChildProcess, 'on' | 'unref'>

/** Injectable process facts for {@link relaunchDesktopApp}. */
export interface DesktopRelaunchEnvironment {
  appImage?: string | undefined
  argv?: readonly string[]
  env?: NodeJS.ProcessEnv
  pid?: number
  /** Pid of the extracting AppImage runtime that owns this run, if any. */
  runtimePid?: number | undefined
  spawn?: DesktopRelaunchSpawn
  reportError?: (cause: Error) => void
}

/**
 * Pid of the AppImage runtime that extracted this run, when there is one.
 *
 * With `--appimage-extract-and-run` (or `APPIMAGE_EXTRACT_AND_RUN=1`) the
 * runtime unpacks the image into a directory named after its hash, stays
 * behind as this process's parent, and deletes that directory once the app
 * exits. A FUSE-mounted run replaces the runtime with the app instead, so its
 * parent is never the AppImage file itself.
 */
export function desktopAppImageExtractingRuntimePid(
  appImage: string,
  parentPid: number = process.ppid,
  resolve: (path: string) => string = realpathSync,
): number | undefined {
  try {
    return resolve(`/proc/${parentPid}/exe`) === resolve(appImage) ? parentPid : undefined
  } catch {
    return undefined
  }
}

/**
 * Bash handoff run as `bash -c SCRIPT '<pid>...' <AppImage> [args...]`.
 *
 * It first closes every inherited descriptor above stderr: `child_process`
 * passes on whatever the main process did not mark close-on-exec, which
 * includes files inside the old mount (keeping it from unmounting), the old
 * crash handler's socket, and listening sockets the new instance must bind
 * again. Bash is used because POSIX `sh` cannot close descriptors above 9, and
 * the AppImage's own `AppRun` already requires it. It then waits for every
 * listed pid to exit: the old app, so the new one does not lose the
 * single-instance lock, and an extracting runtime, so it has finished deleting
 * the directory the new runtime is about to extract into again.
 */
export const DESKTOP_APPIMAGE_RELAUNCH_SCRIPT = [
  'for fd in /proc/$$/fd/*; do fd=${fd##*/}; if [ "$fd" -gt 2 ]; then eval "exec $fd>&-"; fi; done',
  'for pid in $0; do while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done; done',
  'exec "$@"',
].join('\n')

/** Search-path variables that the AppImage `AppRun` prefixes with its mount. */
const APPIMAGE_MOUNT_PATH_VARIABLES = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR'] as const

/**
 * Drop this run's mount directory from the search paths `AppRun` extended.
 *
 * The next `AppRun` prepends its own mount again, so without this every
 * in-app restart would leave one more entry pointing at an unmounted image.
 */
export function desktopAppImageRelaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  const appDir = env.APPDIR
  if (!appDir) return next
  for (const name of APPIMAGE_MOUNT_PATH_VARIABLES) {
    const value = next[name]
    if (value === undefined) continue
    const kept = value.split(':').filter(entry => entry !== appDir && !entry.startsWith(`${appDir}/`))
    if (kept.length === 0) delete next[name]
    else next[name] = kept.join(':')
  }
  return next
}

/**
 * Schedule a new desktop process to start once this one exits.
 *
 * Outside an AppImage this is exactly `app.relaunch()` (with `args` when
 * given). Inside an AppImage Electron's relauncher cannot restart the app:
 * its default target is the executable inside this run's `/tmp/.mount_*` FUSE
 * mount, which is torn down with this process; and pointing it at `$APPIMAGE`
 * fails as well, because Chromium starts the relauncher helper with
 * `no_new_privs`, so the new AppImage runtime's setuid `fusermount` cannot
 * mount the image and exits 127. A detached shell spawned from the main
 * process keeps normal privileges, waits for this pid to exit, and then execs
 * the AppImage file with the same arguments a bare relaunch would reuse. An
 * extracted run restarts extracted, since the runtime consumes
 * `--appimage-extract-and-run` and FUSE is usually why it was used.
 */
export function relaunchDesktopApp(
  app: DesktopRelaunchTarget,
  args?: readonly string[],
  environment: DesktopRelaunchEnvironment = {},
): void {
  const appImage = 'appImage' in environment ? environment.appImage : desktopAppImagePath()
  if (appImage === undefined) {
    app.relaunch(args === undefined ? undefined : { args: [...args] })
    return
  }
  const spawnProcess = environment.spawn ?? spawn
  const runtimePid = 'runtimePid' in environment ? environment.runtimePid : desktopAppImageExtractingRuntimePid(appImage)
  const env = desktopAppImageRelaunchEnvironment(environment.env ?? process.env)
  if (runtimePid !== undefined) env.APPIMAGE_EXTRACT_AND_RUN = '1'
  const reportError = environment.reportError
    ?? ((cause: Error) => { process.stderr.write(`AppImage relaunch failed: ${cause.message}\n`) })
  const child = spawnProcess('/usr/bin/env', [
    'bash',
    '-c',
    DESKTOP_APPIMAGE_RELAUNCH_SCRIPT,
    [environment.pid ?? process.pid, ...(runtimePid === undefined ? [] : [runtimePid])].join(' '),
    appImage,
    ...(args ?? (environment.argv ?? process.argv).slice(1)),
  ], {
    detached: true,
    stdio: 'ignore',
    env,
  })
  child.on('error', reportError)
  child.unref()
}

/** Build a one-shot recovery-mode command line. */
export function desktopRecoveryRelaunchArguments(argv: readonly string[] = process.argv): string[] {
  return [...desktopDefaultRelaunchArguments(argv), DESKTOP_RECOVERY_MODE_ARGUMENT]
}

/** Detect an explicit recovery-mode launch without accepting prefix variants. */
export function desktopRecoveryModeRequested(argv: readonly string[] = process.argv): boolean {
  return argv.slice(1).includes(DESKTOP_RECOVERY_MODE_ARGUMENT)
}

/** Build a one-shot command line that boots against the isolated Safe Mode home. */
export function desktopSafeModeRelaunchArguments(argv: readonly string[] = process.argv): string[] {
  return [...desktopDefaultRelaunchArguments(argv), DESKTOP_SAFE_MODE_ARGUMENT]
}

/** Detect only the exact Safe Mode argument, never a prefix variant. */
export function desktopSafeModeRequested(argv: readonly string[] = process.argv): boolean {
  return argv.slice(1).includes(DESKTOP_SAFE_MODE_ARGUMENT)
}
