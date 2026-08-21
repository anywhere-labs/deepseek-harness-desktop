/** Linux StatusNotifier availability probe shared by the native shell. */

import { spawn } from 'node:child_process'
import type { DesktopPlatform } from './runtime.ts'

const STATUS_NOTIFIER_WATCHER_NAME = 'org.kde.StatusNotifierWatcher'
const STATUS_NOTIFIER_PROBE_TIMEOUT_MS = 2_000

/**
 * Probe whether a StatusNotifier host is present on the Linux session bus.
 * A missing watcher means a Tray created by Electron is never displayed.
 * @returns false on any failure, timeout, or absent watcher (degrade-safe).
 */
export async function probeStatusNotifierWatcher(
  timeoutMs: number = STATUS_NOTIFIER_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    try {
      child = spawn('dbus-send', [
        '--session',
        '--print-reply',
        '--dest=org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.ListNames',
      ], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      settle(false)
      return
    }
    const probe = child
    if (probe === undefined) {
      settle(false)
      return
    }
    timer = setTimeout(() => {
      probe.kill()
      settle(false)
    }, timeoutMs)
    let output = ''
    if (probe.stdout !== null) {
      probe.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    }
    probe.once('error', () => { settle(false) })
    probe.once('close', (code) => {
      if (code !== 0) {
        settle(false)
        return
      }
      settle(output.includes(STATUS_NOTIFIER_WATCHER_NAME))
    })
  })
}

/**
 * Decide whether the native tray will be displayed for the active platform.
 * @param platform - current Electron platform.
 * @param canCreateTray - whether the Tray was constructed without error.
 * @param probeWatcher - overridable Linux watcher probe for tests.
 */
export async function isTrayAvailable(
  platform: DesktopPlatform,
  canCreateTray: boolean,
  probeWatcher: () => Promise<boolean> = probeStatusNotifierWatcher,
): Promise<boolean> {
  if (!canCreateTray) return false
  if (platform !== 'linux') return true
  return await probeWatcher()
}
