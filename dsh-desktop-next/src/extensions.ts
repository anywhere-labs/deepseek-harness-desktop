/** Narrow Host capabilities consumed by the existing plugin markets. */
import { installHostLogging } from './host/logging.ts'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { bundlePatchPaths, composeEntries, loadOverlayPatches, readProfilePlugins, resolveBundleDir, type ProfilePnpmInvocation } from '@deepseek-ai/dsh-app-boot'
import { installNotifications } from './notifications.ts'
import { HostPermissions } from './host-permissions.ts'
import { NEXT_PACKAGE, profileName } from './profiles.ts'
import { PNPM_IGNORE_MINIMUM_RELEASE_AGE } from './pnpm-policy.ts'

export const name = 'desktop-next-capabilities'
export const inject = ['profileContext']

export function apply(ctx: Context): void {
  installHostLogging(ctx)
  if (process.send) {
    const permissions = new HostPermissions(process)
    ctx.provide('desktopPermissions', permissions)
    ctx.effect(() => permissions.dispose, 'Next Host permission bridge')
  }
  if (process.send) installNotifications(ctx, notification => {
    if (process.connected) process.send?.({ type: 'notification', notification }, () => {})
  })
  const profile = ctx.profileContext
  const invocation = profile.packageManager
  if (!invocation) throw new Error('Next requires its bundled pnpm invocation')
  const runner = createPackageRunner(invocation, profile.dir)
  ctx.provide('desktopProfiles', { current: { name: profile.name, dir: profile.dir } })
  ctx.provide('desktopPnpm', runner)
  const shipped = JSON.parse(readFileSync(profile.installAnchor, 'utf8')) as { name: string; dependencies: Record<string, string> }
  ctx.provide('desktopPlugins', {
    list: () => readProfilePlugins({ binName: 'dsh-desktop-next', profileDir: profile.dir, installAnchor: profile.installAnchor })
      .dependencies.filter(item => item.bundle).map(item => {
        const mutable = item.name !== shipped.name && !Object.hasOwn(shipped.dependencies, item.name)
          && !item.name.startsWith('@deepseek-ai/')
        const dir = resolveBundleDir('dsh-desktop-next', item.name, profile.installAnchor, profile.dir)
        // dsh 0.1.7 lets a bundle declare an ordered list of patch files, not only one.
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string | string[] } } }
        const rows = composeEntries(bundlePatchPaths(dir, manifest.dsh.bundle).map(file => loadOverlayPatches('dsh-desktop-next', file)))
        const active = rows.length === 0 || [...ctx.loader.entries()].some(entry =>
          rows.some(row => row.id === entry.options.id) && !entry.disabled && entry.fiber?.state === 2 /* FiberState.ACTIVE */)
        return { bundleId: item.name, packageName: item.name, mutable, uninstallable: mutable,
          status: item.enabled && active ? 'active' : 'disabled' }
      }),
  })
  if (process.send) ctx.provide('desktopActions', {
    ...(process.platform === 'darwin' || process.platform === 'win32' ? { openTerminal: () => {
      if (!process.connected || !process.send) throw new Error('Next shell is unavailable')
      process.send({ type: 'desktop-action', action: 'terminal' }, () => {})
    } } : {}),
    requestRestart: () => new Promise<void>((resolve, reject) => {
      if (!process.connected || !process.send) { reject(new Error('Next shell is unavailable')); return }
      process.send({ type: 'desktop-action', action: 'restart' }, error => error ? reject(error) : resolve())
    }),
  })
  ctx.effect(() => () => runner.dispose(), 'Next package process disposal')
}

/** Own each process handle so a stale cancellation cannot kill its successor. */
export function createPackageRunner(invocation: ProfilePnpmInvocation, directory: string) {
  let active: { cancel(): void; done: Promise<unknown> } | undefined
  let disposed = false
  function start(args: readonly string[], cwd: string, signal?: AbortSignal, env: NodeJS.ProcessEnv = {}) {
    if (disposed) throw new Error('Package runner has been disposed')
    if (active) throw new Error('A profile package operation is already active')
    if (signal?.aborted) throw signal.reason ?? new Error('Package operation cancelled')
    if (!args.length || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid package arguments')
    if (!isAbsolute(cwd) || cwd.includes('\0')) throw new Error('Package invoking directory must be absolute')
    const child = spawn(invocation.command, [...args], {
      cwd, env: { ...process.env, ...invocation.env, ...env },
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const kill = (kind: NodeJS.Signals): void => {
      if (settled || !child.pid) return
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => { if (!settled) child.kill(kind) })
      } else {
        try { process.kill(-child.pid, kind) } catch { child.kill(kind) }
      }
    }
    const cancel = (): void => {
      if (settled || killTimer) return
      kill('SIGTERM')
      killTimer = setTimeout(() => kill('SIGKILL'), 2_000)
      killTimer.unref()
    }
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, exitSignal) => { resolve({ exitCode, signal: exitSignal }) })
    }).finally(() => {
      settled = true
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', cancel)
      if (active?.done === done) active = undefined
    })
    active = { cancel, done }
    void done.catch(() => {})
    signal?.addEventListener('abort', cancel, { once: true })
    return { stdout: child.stdout!, stderr: child.stderr!, done, cancel }
  }
  return {
    run(argv: readonly string[], signal?: AbortSignal) {
      if (!argv.length) throw new Error('Invalid pnpm arguments')
      // The Host invocation also serves the official manager; apply its policy only once here.
      const args = [...invocation.args, ...argv].filter(arg => arg !== PNPM_IGNORE_MINIMUM_RELEASE_AGE)
      return start([...args, PNPM_IGNORE_MINIMUM_RELEASE_AGE], directory, signal)
    },
    /** dshmarket uses the official CLI so installs/removals also reconcile Profile bundles. */
    runPlugin(argv: readonly string[], invokingDir: string, signal?: AbortSignal) {
      if (!argv.length) throw new Error('Invalid plugin arguments')
      return start(['--expose-internals', join(dirname(NEXT_PACKAGE), 'lib', 'plugin-cli.js'),
        profileName(basename(directory)), ...argv], invokingDir, signal, { DSH_HOME: dirname(dirname(directory)) })
    },
    async dispose(): Promise<void> {
      disposed = true
      const current = active
      current?.cancel()
      await current?.done.catch(() => {})
    },
  }
}

export function bundledPnpmEntry(anchor: string): string {
  const require = createRequire(anchor)
  return join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.mjs')
}
