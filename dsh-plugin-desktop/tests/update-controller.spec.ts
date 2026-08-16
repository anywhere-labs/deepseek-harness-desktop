import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopUpdateController,
  desktopUpdateErrorReason,
  DesktopUpdateFailure,
  MAX_AUTOMATIC_UPDATE_BYTES,
  type DesktopUpdaterAdapter,
  type UpdateCancellation,
} from '../src/update-controller.ts'

function createUpdater() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const updater: DesktopUpdaterAdapter = {
    on(event, listener) {
      const values = listeners.get(event) ?? new Set()
      values.add(listener)
      listeners.set(event, values)
    },
    off(event, listener) { listeners.get(event)?.delete(listener) },
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
  }
  return {
    updater,
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    listenerCount: () => [...listeners.values()].reduce((sum, values) => sum + values.size, 0),
  }
}

function available(version = '2.0.2', mode: unknown = 'automatic', size = 1024) {
  return {
    updateInfo: {
      version,
      desktopUpdateMode: mode,
      files: [{ size }],
    },
  }
}

describe('desktop update controller', () => {
  it('reports unsupported without a packaged provider', async () => {
    const controller = createDesktopUpdateController({
      currentVersion: '2.0.1',
      installMode: 'unsupported',
    })
    expect(controller.canCheck).toBe(false)
    expect(controller.getState()).toEqual({
      phase: 'unsupported',
      currentVersion: '2.0.1',
      installMode: 'unsupported',
    })
    await expect(controller.check()).resolves.toBe(controller.getState())
  })

  it('distinguishes current, automatic, and manual releases', async () => {
    const fixture = createUpdater()
    vi.mocked(fixture.updater.checkForUpdates)
      .mockImplementationOnce(async () => {
        fixture.emit('update-not-available', { version: '2.0.1' })
        return available('2.0.1')
      })
      .mockImplementationOnce(async () => available())
      .mockImplementationOnce(async () => available('2.0.3', 'manual'))
    const controller = createDesktopUpdateController({
      currentVersion: '2.0.1',
      installMode: 'automatic',
      updater: fixture.updater,
    })

    await expect(controller.check()).resolves.toMatchObject({ phase: 'current' })
    await expect(controller.check()).resolves.toMatchObject({
      phase: 'available', availableVersion: '2.0.2', installMode: 'automatic',
    })
    await expect(controller.check()).resolves.toMatchObject({
      phase: 'available', availableVersion: '2.0.3', installMode: 'manual',
    })
  })

  it('requires both artifacts, a declared size, and the byte ceiling for automatic installation', async () => {
    const fixture = createUpdater()
    vi.mocked(fixture.updater.checkForUpdates)
      .mockResolvedValueOnce(available('2.0.2', 'automatic', MAX_AUTOMATIC_UPDATE_BYTES + 1))
      .mockResolvedValueOnce({ updateInfo: { version: '2.0.3', desktopUpdateMode: 'automatic' } })
    const controller = createDesktopUpdateController({
      currentVersion: '2.0.1', installMode: 'automatic', updater: fixture.updater,
    })

    await expect(controller.check()).resolves.toMatchObject({ installMode: 'manual' })
    await expect(controller.check()).resolves.toMatchObject({ installMode: 'manual' })
  })

  it('classifies missing metadata, offline checks, disk pressure, and unknown failures', () => {
    expect(desktopUpdateErrorReason('check', Object.assign(new Error('latest-mac.yml 404'), { statusCode: 404 })))
      .toBe('release-unavailable')
    expect(desktopUpdateErrorReason('check', Object.assign(new Error('offline'), { code: 'ENOTFOUND' })))
      .toBe('network-unavailable')
    expect(desktopUpdateErrorReason('download', Object.assign(new Error('write failed'), { code: 'ENOSPC' })))
      .toBe('insufficient-space')
    expect(desktopUpdateErrorReason('download', new Error('signature rejected'))).toBe('unknown')
  })

  it('downloads once, publishes progress, and installs through the shared lifecycle', async () => {
    const fixture = createUpdater()
    const cancellation: UpdateCancellation = { cancel: vi.fn() }
    const requestInstall = vi.fn(async () => {})
    vi.mocked(fixture.updater.checkForUpdates).mockResolvedValue(available())
    vi.mocked(fixture.updater.downloadUpdate).mockImplementation(async () => {
      fixture.emit('download-progress', { percent: 47.6, transferred: 476, total: 1000 })
      fixture.emit('update-downloaded', { version: '2.0.2' })
    })
    const snapshots: string[] = []
    const controller = createDesktopUpdateController({
      currentVersion: '2.0.1',
      installMode: 'automatic',
      updater: fixture.updater,
      createCancellation: () => cancellation,
      requestInstall,
    })
    controller.subscribe(state => { snapshots.push(`${state.phase}:${Math.round(state.progress?.percent ?? 0)}`) })

    await controller.check()
    const first = controller.download()
    const second = controller.download()
    expect(first).toBe(second)
    await first
    expect(snapshots).toContain('downloading:48')
    expect(controller.getState()).toMatchObject({
      phase: 'downloaded', availableVersion: '2.0.2', progress: { percent: 100 },
    })
    await Promise.all([controller.install(), controller.install()])
    expect(requestInstall).toHaveBeenCalledOnce()
  })

  it('waits for cancellation cleanup before an immediate retry can start', async () => {
    const fixture = createUpdater()
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const cancel = vi.fn(() => { finish() })
    vi.mocked(fixture.updater.checkForUpdates).mockResolvedValue(available())
    vi.mocked(fixture.updater.downloadUpdate)
      .mockImplementationOnce(async () => await pending)
      .mockResolvedValueOnce(undefined)
    const controller = createDesktopUpdateController({
      currentVersion: '2.0.1',
      installMode: 'automatic',
      updater: fixture.updater,
      createCancellation: () => ({ cancel }),
    })
    await controller.check()
    void controller.download()

    await controller.cancel()
    expect(controller.getState()).toMatchObject({ phase: 'available' })
    await controller.download()
    expect(fixture.updater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('retains a downloaded candidate across the same release and replaces it with a newer one', async () => {
    const fixture = createUpdater()
    vi.mocked(fixture.updater.checkForUpdates)
      .mockResolvedValueOnce(available('2.0.2'))
      .mockResolvedValueOnce(available('2.0.2'))
      .mockResolvedValueOnce(available('2.0.3'))
    vi.mocked(fixture.updater.downloadUpdate).mockImplementation(async () => {
      fixture.emit('update-downloaded', { version: '2.0.2' })
    })
    const controller = createDesktopUpdateController({
      currentVersion: '2.0.1',
      installMode: 'automatic',
      updater: fixture.updater,
      createCancellation: () => ({ cancel: vi.fn() }),
    })
    await controller.check()
    await controller.download()
    await controller.check()
    expect(controller.getState()).toMatchObject({ phase: 'downloaded', availableVersion: '2.0.2' })
    await controller.check()
    expect(controller.getState()).toMatchObject({ phase: 'available', availableVersion: '2.0.3' })
  })

  it('contains listener failures and releases provider listeners', async () => {
    const fixture = createUpdater()
    vi.mocked(fixture.updater.checkForUpdates).mockResolvedValue(available())
    const controller = createDesktopUpdateController({
      currentVersion: '2.0.1', installMode: 'manual', updater: fixture.updater,
    })
    controller.subscribe(() => { throw new Error('observer failed') })

    await expect(controller.check()).resolves.toMatchObject({ phase: 'available' })
    expect(fixture.listenerCount()).toBeGreaterThan(0)
    await controller.dispose()
    expect(fixture.listenerCount()).toBe(0)
  })

  it('uses explicit terminal download categories', () => {
    expect(desktopUpdateErrorReason(
      'download',
      new DesktopUpdateFailure('download-too-large', 'too large'),
    )).toBe('download-too-large')
  })

  it('keeps the automatic byte-limit failure after provider cancellation settles', async () => {
    const fixture = createUpdater()
    let settle!: () => void
    const pending = new Promise<void>(resolve => { settle = resolve })
    const cancel = vi.fn(() => { settle() })
    vi.mocked(fixture.updater.checkForUpdates).mockResolvedValue(available())
    vi.mocked(fixture.updater.downloadUpdate).mockImplementation(async () => {
      fixture.emit('download-progress', {
        percent: 99,
        transferred: MAX_AUTOMATIC_UPDATE_BYTES + 1,
        total: MAX_AUTOMATIC_UPDATE_BYTES + 2,
      })
      await pending
    })
    const controller = createDesktopUpdateController({
      currentVersion: '2.0.1',
      installMode: 'automatic',
      updater: fixture.updater,
      createCancellation: () => ({ cancel }),
    })
    await controller.check()

    await controller.download()

    expect(cancel).toHaveBeenCalledOnce()
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      errorOperation: 'download',
      errorReason: 'download-too-large',
      installMode: 'manual',
    })
  })
})
