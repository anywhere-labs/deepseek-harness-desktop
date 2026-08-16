import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopUpdateClientController,
  UPDATE_STATE_POLL_INTERVAL_MS,
} from '../src/client/update-controller.ts'
import { en, zh } from '../src/client/update-locales.ts'
import {
  primaryUpdateAction,
  updateStatusKey,
} from '../src/client/UpdateRow.tsx'
import type { DesktopUpdateState } from '../src/update-contract.ts'

const base: DesktopUpdateState = {
  phase: 'idle',
  currentVersion: '2.0.1',
  installMode: 'automatic',
}

function rpcWith(snapshot: () => DesktopUpdateState) {
  return {
    call: vi.fn(async () => ({ ok: true as const, value: snapshot() })),
  } satisfies ClientConnectionRpc
}

afterEach(() => { vi.useRealTimers() })

describe('desktop update browser controller', () => {
  it('loads, polls, and invokes only the fixed update channel', async () => {
    vi.useFakeTimers()
    let state = base
    const rpc = rpcWith(() => state)
    const controller = createDesktopUpdateClientController(rpc)
    await vi.waitFor(() => { expect(controller.store.getSnapshot()).toEqual(base) })

    state = { ...base, phase: 'current' }
    await vi.advanceTimersByTimeAsync(UPDATE_STATE_POLL_INTERVAL_MS)
    expect(controller.store.getSnapshot()).toEqual(state)
    await controller.check()
    expect(rpc.call).toHaveBeenLastCalledWith('/desktop-updates', 'check', {})

    controller.dispose()
    const calls = rpc.call.mock.calls.length
    await vi.advanceTimersByTimeAsync(UPDATE_STATE_POLL_INTERVAL_MS)
    expect(rpc.call).toHaveBeenCalledTimes(calls)
  })

  it('contains transport failures in operation-specific copy states', async () => {
    const rpc = {
      call: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: base })
        .mockRejectedValueOnce(new Error('offline')),
    } as unknown as ClientConnectionRpc
    const controller = createDesktopUpdateClientController(rpc, 60_000)
    await vi.waitFor(() => { expect(controller.store.getSnapshot()).toEqual(base) })

    await controller.download()

    expect(controller.store.getSnapshot()).toMatchObject({
      phase: 'error',
      errorOperation: 'download',
      errorReason: 'unknown',
    })
    controller.dispose()
  })

  it('keeps installation failures distinct and retryable', async () => {
    const downloaded: DesktopUpdateState = {
      phase: 'downloaded',
      currentVersion: '2.0.1',
      availableVersion: '2.0.2',
      installMode: 'automatic',
    }
    const rpc = {
      call: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: downloaded })
        .mockRejectedValueOnce(new Error('shutdown unavailable')),
    } as unknown as ClientConnectionRpc
    const controller = createDesktopUpdateClientController(rpc, 60_000)
    await vi.waitFor(() => { expect(controller.store.getSnapshot()).toEqual(downloaded) })

    await controller.install()

    expect(controller.store.getSnapshot()).toMatchObject({
      phase: 'error',
      availableVersion: '2.0.2',
      errorOperation: 'install',
      errorReason: 'unknown',
    })
    expect(updateStatusKey(controller.store.getSnapshot())).toBe('status.installUnknownError')
    expect(primaryUpdateAction(controller.store.getSnapshot())).toEqual({
      key: 'action.retryInstall',
      operation: 'install',
    })
    controller.dispose()
  })

  it('keeps a failed fixed release-page action visible and retryable', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const manual: DesktopUpdateState = {
      phase: 'available',
      currentVersion: '2.0.1',
      availableVersion: '2.0.2',
      installMode: 'manual',
    }
    const rpc = {
      call: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: manual })
        .mockRejectedValueOnce(new Error('no browser'))
        .mockResolvedValueOnce({ ok: true, value: null })
        .mockResolvedValueOnce({ ok: true, value: manual }),
    } as unknown as ClientConnectionRpc
    const controller = createDesktopUpdateClientController(rpc, 60_000)
    await vi.waitFor(() => { expect(controller.store.getSnapshot()).toEqual(manual) })

    await controller.openReleasePage()

    expect(controller.store.getSnapshot()).toMatchObject({
      phase: 'error',
      availableVersion: '2.0.2',
      errorReason: 'release-page-unavailable',
    })
    expect(primaryUpdateAction(controller.store.getSnapshot())).toEqual({
      key: 'action.release',
      operation: 'openReleasePage',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rpc.call).toHaveBeenCalledTimes(2)

    await controller.openReleasePage()
    expect(controller.store.getSnapshot()).toEqual(manual)
    expect(consoleError).toHaveBeenCalledWith(
      'desktop update release page failed to open:',
      expect.any(Error),
    )
    controller.dispose()
  })
})

describe('desktop update copy and actions', () => {
  it('keeps the Chinese and English dictionaries structurally aligned', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(zh['status.current']).toContain('GitHub 上的最新正式版本')
    expect(zh['status.releaseUnavailable']).toContain('客户端更新文件')
    expect(zh['status.checkNetworkError']).toContain('GitHub')
  })

  it.each([
    [{ ...base, phase: 'idle' }, 'status.idle', 'action.check'],
    [{ ...base, phase: 'checking' }, 'status.checking', 'action.checking'],
    [{ ...base, phase: 'current' }, 'status.current', 'action.recheck'],
    [{ ...base, phase: 'available', availableVersion: '2.0.2' }, 'status.available', 'action.download'],
    [{ ...base, phase: 'available', availableVersion: '2.0.2', installMode: 'manual' }, 'status.availableManual', 'action.release'],
    [{ ...base, phase: 'downloading', availableVersion: '2.0.2' }, 'status.downloading', 'action.cancel'],
    [{ ...base, phase: 'downloaded', availableVersion: '2.0.2' }, 'status.downloaded', 'action.install'],
    [{ ...base, phase: 'unsupported', installMode: 'unsupported' }, 'status.unsupported', 'action.release'],
    [{ ...base, phase: 'error', errorOperation: 'check', errorReason: 'network-unavailable' }, 'status.checkNetworkError', 'action.retryCheck'],
    [{ ...base, phase: 'error', errorOperation: 'check', errorReason: 'release-unavailable' }, 'status.releaseUnavailable', 'action.release'],
    [{ ...base, phase: 'error', errorOperation: 'download', errorReason: 'insufficient-space' }, 'status.insufficientSpace', 'action.retryDownload'],
    [{ ...base, phase: 'error', errorOperation: 'install', errorReason: 'unknown' }, 'status.installUnknownError', 'action.retryInstall'],
  ] as const)('maps phase %# to specific status and action copy', (state, status, action) => {
    expect(updateStatusKey(state)).toBe(status)
    expect(primaryUpdateAction(state).key).toBe(action)
  })
})
