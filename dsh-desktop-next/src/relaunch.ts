import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { realpathSync } from 'node:fs'

/** Explicit launch modes survive a native relaunch without leaking into later restarts. */
export const RECOVERY_ARGUMENT = '--next-recovery'
export const SAFE_ARGUMENT = '--next-safe-mode'
export const ONBOARDING_ARGUMENT = '--next-onboarding'

export function relaunchArguments(argv: readonly string[], recovery: boolean, safe: boolean, onboarding = false): string[] {
  return [...argv.filter(value => value !== RECOVERY_ARGUMENT && value !== SAFE_ARGUMENT && value !== ONBOARDING_ARGUMENT),
    ...recovery ? [RECOVERY_ARGUMENT] : safe ? [SAFE_ARGUMENT] : onboarding ? [ONBOARDING_ARGUMENT] : []]
}

/** The part of `child_process.spawn` that an AppImage relaunch needs. */
export type RelaunchSpawn = (command: string, args: readonly string[], options: SpawnOptions) => Pick<ChildProcess, 'on' | 'unref'>

/** Injectable process facts for {@link relaunchApp}. */
export interface RelaunchEnvironment {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  pid?: number
  /** Pid of the extracting AppImage runtime that owns this run, if any. */
  runtimePid?: number | undefined
  spawn?: RelaunchSpawn
  reportError?: (cause: Error) => void
}

/**
 * Pid of the AppImage runtime that extracted this run, when there is one.
 *
 * With `--appimage-extract-and-run` (or `APPIMAGE_EXTRACT_AND_RUN=1`) the
 * runtime unpacks the image into a directory named after its hash, stays
 * behind as this process's parent, and deletes that directory once the app
 * exits. A FUSE-mounted run replaces the runtime with the app instead.
 */
export function appImageExtractingRuntimePid(
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
 * It closes every inherited descriptor above stderr first (`child_process`
 * passes on whatever the main process left without close-on-exec: files in
 * the old mount, the old crash handler's socket, listening sockets), then
 * waits for every listed pid: the old app, so the new one gets the
 * single-instance lock, and an extracting runtime, so it has finished deleting
 * the directory the new runtime extracts into again. POSIX `sh` cannot close
 * descriptors above 9; `AppRun` needs bash anyway.
 */
export const APPIMAGE_RELAUNCH_SCRIPT = [
  'for fd in /proc/$$/fd/*; do fd=${fd##*/}; if [ "$fd" -gt 2 ]; then eval "exec $fd>&-"; fi; done',
  'for pid in $0; do while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done; done',
  'exec "$@"',
].join('\n')

/** Drop this run's mount from the search paths `AppRun` prefixed, so restarts do not pile them up. */
export function appImageRelaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  const appDir = env.APPDIR
  if (!appDir) return next
  for (const name of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
    const value = next[name]
    if (value === undefined) continue
    const kept = value.split(':').filter(entry => entry !== appDir && !entry.startsWith(`${appDir}/`))
    if (kept.length === 0) delete next[name]
    else next[name] = kept.join(':')
  }
  return next
}

/**
 * Schedule a new app process with `args` once this one exits.
 *
 * Outside an AppImage this is `app.relaunch({ args })`. Inside one, Electron's
 * relauncher cannot restart the app: its default target lives in this run's
 * `/tmp/.mount_*` FUSE mount, which is torn down with this process, and
 * targeting `$APPIMAGE` instead fails because Chromium starts the relauncher
 * helper with `no_new_privs`, so the new runtime's setuid `fusermount` cannot
 * mount the image. A detached shell spawned from the main process keeps normal
 * privileges, waits for this pid to exit, then execs the AppImage file. An
 * extracted run restarts extracted, since the runtime consumes
 * `--appimage-extract-and-run` and FUSE is usually why it was used.
 */
export function relaunchApp(
  app: { relaunch(options: { args: string[] }): void },
  args: readonly string[],
  environment: RelaunchEnvironment = {},
): void {
  const platform = environment.platform ?? process.platform
  const env = environment.env ?? process.env
  const appImage = platform === 'linux' ? env.APPIMAGE : undefined
  if (!appImage) {
    app.relaunch({ args: [...args] })
    return
  }
  const reportError = environment.reportError
    ?? ((cause: Error) => { console.error(`AppImage relaunch failed: ${cause.message}`) })
  const runtimePid = 'runtimePid' in environment ? environment.runtimePid : appImageExtractingRuntimePid(appImage)
  const pids = [environment.pid ?? process.pid, ...(runtimePid === undefined ? [] : [runtimePid])]
  const childEnv = appImageRelaunchEnvironment(env)
  if (runtimePid !== undefined) childEnv.APPIMAGE_EXTRACT_AND_RUN = '1'
  const child = (environment.spawn ?? spawn)('/usr/bin/env',
    ['bash', '-c', APPIMAGE_RELAUNCH_SCRIPT, pids.join(' '), appImage, ...args],
    { detached: true, stdio: 'ignore', env: childEnv })
  child.on('error', reportError)
  child.unref()
}
