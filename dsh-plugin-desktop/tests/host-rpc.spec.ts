import { MessageChannel } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { configureDeveloperLogging, initializeDeveloperLogging } from '../src/developer-logging.ts'
import { HostRpc } from '../src/host-rpc.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
function pair(timeout = 1000) {
  const { port1, port2 } = new MessageChannel()
  const peers = [port1, port2].map(port => new HostRpc({
    send: message => port.postMessage(message),
    listen: receive => { port.on('message', receive); return () => { port.off('message', receive) } },
  }, timeout)) as [HostRpc, HostRpc]
  cleanup.push(() => { peers.forEach(peer => peer.close()); port1.close(); port2.close() })
  return peers
}

describe('private Host control transport', () => {
  it('supports concurrent bidirectional calls, errors and unknown-method rejection', async () => {
    const [parent, child] = pair()
    child.handle('echo', async ([value]) => { await new Promise(resolve => setTimeout(resolve, 2)); return value })
    parent.handle('native', ([value]) => value + 1)
    child.handle('nested', async ([value]) => child.call('native', [value]))
    child.handle('fail', () => { throw new Error('fixture failure') })
    expect(await Promise.all([parent.call('echo', ['a']), parent.call('nested', [4])])).toEqual(['a', 5])
    await expect(parent.call('fail')).rejects.toThrow('fixture failure')
    await expect(parent.call('absent')).rejects.toThrow('Unknown Host operation')
  })
  it('propagates cancellation to active native operations', async () => {
    const [parent, child] = pair()
    let cancelled!: () => void
    const cancellation = new Promise<void>(resolve => { cancelled = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    child.handle('wait', (_args, signal) => new Promise<void>(resolve => {
      signal.addEventListener('abort', () => { cancelled(); resolve() }, { once: true }); entered()
    }))
    const controller = new AbortController()
    const call = parent.call('wait', [], controller.signal)
    const rejected = expect(call).rejects.toThrow('cancelled')
    await started; controller.abort()
    await rejected; await cancellation
  })
  it('rejects pending calls on exit and times out a nonresponsive peer', async () => {
    const [parent, child] = pair(20)
    child.handle('never', () => new Promise(() => {}))
    await expect(parent.call('never')).rejects.toThrow('timed out')
    const request = parent.call('pending')
    parent.close('worker exited')
    await expect(request).rejects.toThrow('worker exited')
    await expect(parent.call('later')).rejects.toThrow('closed')
  })
})

it('traces bidirectional IPC metadata without arguments or return values', async () => {
  const records: any[] = []
  initializeDeveloperLogging((_level, line) => records.push(JSON.parse(line)), 'ipc-test')
  configureDeveloperLogging({ developerLogging: true, logLevel: 'info' })
  try {
    const [parent, child] = pair()
    child.handle('echo', ([value]) => value)
    expect(await parent.call('echo', ['private payload'])).toBe('private payload')
    expect(records.map(record => record.event).sort()).toEqual(['call.complete', 'call.start', 'handle.complete', 'handle.start'])
    expect(records.every(record => record.fields.method === 'echo' && record.fields.requestId === 1)).toBe(true)
    expect(JSON.stringify(records)).not.toContain('private payload')
  } finally {
    configureDeveloperLogging({ developerLogging: false, logLevel: 'info' })
    initializeDeveloperLogging(() => {})
  }
})
