import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DesktopControlPeer } from '../src/control-protocol.ts'

function peers(maxFrameBytes?: number) {
  const leftToRight = new PassThrough()
  const rightToLeft = new PassThrough()
  const leftLogger = { error: vi.fn<(message: string) => void>() }
  const rightLogger = { error: vi.fn<(message: string) => void>() }
  const left = new DesktopControlPeer(rightToLeft, leftToRight, {
    logger: leftLogger,
    ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
  })
  const right = new DesktopControlPeer(leftToRight, rightToLeft, {
    logger: rightLogger,
    ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
  })
  return { left, right, leftToRight, rightToLeft, leftLogger, rightLogger }
}

describe('desktop WSL control protocol', () => {
  it('supports concurrent bidirectional requests and fire-and-forget events', async () => {
    const pair = peers()
    const event = vi.fn()
    pair.left.register('native/platform', params => ({ platform: 'win32', params }))
    pair.right.register('host/profile', params => ({ profile: 'desktop', params }))
    pair.right.register('host/ready', params => { event(params) })

    const [platform, profile] = await Promise.all([
      pair.right.call('native/platform', { generation: 1 }),
      pair.left.call('host/profile', { generation: 2 }),
    ])
    pair.left.notify('host/ready', { port: 1234 })

    await vi.waitFor(() => { expect(event).toHaveBeenCalledWith({ port: 1234 }) })
    expect(platform).toEqual({ platform: 'win32', params: { generation: 1 } })
    expect(profile).toEqual({ profile: 'desktop', params: { generation: 2 } })
    pair.left.close()
    pair.right.close()
  })

  it('propagates remote errors without their stack and rejects unknown methods', async () => {
    const pair = peers()
    pair.right.register('host/fail', () => { throw new Error('expected failure') })

    await expect(pair.left.call('host/fail')).rejects.toThrow('expected failure')
    await expect(pair.left.call('host/missing')).rejects.toThrow('unknown control method')
    pair.left.close()
    pair.right.close()
  })

  it('forwards cancellation to the active remote handler', async () => {
    const pair = peers()
    let remoteSignal: AbortSignal | undefined
    pair.right.register('host/wait', async (_params, signal) => {
      remoteSignal = signal
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      })
    })
    const controller = new AbortController()
    const request = pair.left.call('host/wait', null, controller.signal)
    await vi.waitFor(() => { expect(remoteSignal).toBeDefined() })
    controller.abort(new Error('caller stopped'))

    await expect(request).rejects.toThrow('caller stopped')
    await vi.waitFor(() => { expect(remoteSignal?.aborted).toBe(true) })
    pair.left.close()
    pair.right.close()
  })

  it('closes both pending and future work after an oversized frame', async () => {
    const pair = peers(1024)
    pair.right.register('host/wait', async () => await new Promise(() => {}))
    const pending = pair.left.call('host/wait')
    pair.rightToLeft.write(`${JSON.stringify({
      v: 1,
      kind: 'event',
      method: 'host/ready',
      params: 'x'.repeat(2_000),
    })}\n`)

    await expect(pending).rejects.toThrow('control frame exceeds byte limit')
    await expect(pair.left.call('host/again')).rejects.toThrow('control frame exceeds byte limit')
    pair.right.close()
  })

  it('rejects incomplete input when the owned child channel ends', async () => {
    const pair = peers()
    pair.right.register('host/wait', async () => await new Promise(() => {}))
    const pending = pair.left.call('host/wait')
    pair.rightToLeft.write('{"v":1')
    pair.rightToLeft.end()

    await expect(pending).rejects.toThrow('ended with an incomplete frame')
    pair.right.close()
  })
})
