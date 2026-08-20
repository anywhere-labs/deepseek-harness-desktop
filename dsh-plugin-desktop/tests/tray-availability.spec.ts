import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const childProcess = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Listener[]>()
  const stdoutListeners = new Map<string, Listener[]>()
  let watcherPresent = true
  let autoSettle = true
  const child = {
    stdout: {
      on: vi.fn((event: string, listener: Listener) => {
        stdoutListeners.set(event, [...(stdoutListeners.get(event) ?? []), listener])
        return child.stdout
      }),
    },
    once: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return child
    }),
    kill: vi.fn(),
  }
  return {
    child,
    emit(event: string, ...args: unknown[]) {
      const current = [...(listeners.get(event) ?? [])]
      listeners.delete(event)
      for (const listener of current) listener(...args)
    },
    reset() {
      listeners.clear()
      stdoutListeners.clear()
      watcherPresent = true
      autoSettle = true
    },
    setWatcherPresent(present: boolean) { watcherPresent = present },
    setAutoSettle(enabled: boolean) { autoSettle = enabled },
    spawn: vi.fn((_command: string, args: string[]) => {
      // Auto-settle the StatusNotifier probe so tests never hang on the bus.
      if (autoSettle && args.includes('org.freedesktop.DBus.ListNames')) {
        queueMicrotask(() => {
          if (watcherPresent) {
            for (const listener of [...(stdoutListeners.get('data') ?? [])]) {
              listener(Buffer.from('  string "org.kde.StatusNotifierWatcher"\n'))
            }
          }
          const close = [...(listeners.get('close') ?? [])]
          listeners.delete('close')
          for (const listener of close) listener(0)
        })
      }
      return child
    }),
  }
})

vi.mock('node:child_process', () => ({ spawn: childProcess.spawn }))

import { isTrayAvailable, probeStatusNotifierWatcher } from '../src/tray-availability.ts'

describe('probeStatusNotifierWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    childProcess.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves true when the watcher name is listed on the session bus', async () => {
    await expect(probeStatusNotifierWatcher()).resolves.toBe(true)
  })

  it('resolves false when no watcher is listed', async () => {
    childProcess.setWatcherPresent(false)
    await expect(probeStatusNotifierWatcher()).resolves.toBe(false)
  })

  it('resolves false when the probe process exits with an error', async () => {
    const promise = probeStatusNotifierWatcher()
    childProcess.emit('error', new Error('dbus unavailable'))
    await expect(promise).resolves.toBe(false)
  })

  it('resolves false after a timeout without a watcher response', async () => {
    vi.useFakeTimers()
    try {
      // Disable the auto-settling queueMicrotask so the setTimeout path is
      // exercised; otherwise the microtask resolves the probe first.
      childProcess.setAutoSettle(false)
      const promise = probeStatusNotifierWatcher(1_000)
      const assertion = expect(promise).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(1_001)
      await assertion
      expect(childProcess.child.kill).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('isTrayAvailable', () => {
  const probe = vi.fn(async () => true)

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('requires a successfully created tray on every platform', async () => {
    await expect(isTrayAvailable('linux', false, probe)).resolves.toBe(false)
    await expect(isTrayAvailable('win32', false, probe)).resolves.toBe(false)
    await expect(isTrayAvailable('darwin', false, probe)).resolves.toBe(false)
  })

  it('skips the watcher probe outside Linux', async () => {
    await expect(isTrayAvailable('win32', true, probe)).resolves.toBe(true)
    await expect(isTrayAvailable('darwin', true, probe)).resolves.toBe(true)
    expect(probe).not.toHaveBeenCalled()
  })

  it('probes the watcher on Linux', async () => {
    probe.mockResolvedValueOnce(true)
    await expect(isTrayAvailable('linux', true, probe)).resolves.toBe(true)
    probe.mockResolvedValueOnce(false)
    await expect(isTrayAvailable('linux', true, probe)).resolves.toBe(false)
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
