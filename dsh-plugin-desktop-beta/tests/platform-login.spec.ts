import { MessageChannel } from 'node:worker_threads'
import { expect, it, vi } from 'vitest'
import { HostRpc } from '../src/host-rpc.ts'
import { bindNativeRuntime, createHostRuntime, runtimeSnapshot } from '../src/host-runtime-bridge.ts'
import {
  isPlatformLoginDestination,
  parseDesktopPlatformLoginRequest,
  watchPlatformLogin,
  type DesktopPlatformLoginRequest,
  type PlatformLoginAccount,
} from '../src/platform-login.ts'
import type { DesktopRuntime } from '../src/runtime.ts'

type Attempt = { id: string; phase: string; authorizeUrl?: string } | null

function account(states: Attempt[]): PlatformLoginAccount & { signals: AbortSignal[] } {
  const signals: AbortSignal[] = []
  return {
    signals,
    async *watch(signal) {
      signals.push(signal)
      for (const attempt of states) yield { attempt }
    },
  }
}

async function requests(states: Attempt[], external = () => false): Promise<DesktopPlatformLoginRequest[]> {
  const seen: DesktopPlatformLoginRequest[] = []
  await watchPlatformLogin(account(states), request => seen.push(request), external, new AbortController().signal)
  return seen
}

const URL_A = 'https://platform.deepseek.com/dsh/authorize?state=a'

it('opens the authorization page once per attempt, only after the Host has the URL', async () => {
  expect(await requests([
    null,
    { id: 'a', phase: 'initializing' },
    { id: 'a', phase: 'waiting-browser', authorizeUrl: URL_A },
    { id: 'a', phase: 'waiting-browser', authorizeUrl: URL_A },
    { id: 'a', phase: 'exchanging', authorizeUrl: URL_A },
    { id: 'a', phase: 'committing' },
    { id: 'a', phase: 'succeeded' },
    { id: 'a', phase: 'succeeded' },
  ])).toEqual([{ action: 'open', url: URL_A, external: false }, { action: 'close', focus: false }])
})

it('opens a retried attempt again after closing the cancelled one', async () => {
  const urlB = 'https://platform.deepseek.com/dsh/authorize?state=b'
  expect(await requests([
    { id: 'a', phase: 'waiting-browser', authorizeUrl: URL_A },
    { id: 'a', phase: 'cancelled' },
    { id: 'b', phase: 'waiting-browser', authorizeUrl: urlB },
  ])).toEqual([
    { action: 'open', url: URL_A, external: false },
    { action: 'close', focus: false },
    { action: 'open', url: urlB, external: false },
  ])
})

it.each(['failed', 'expired'])('returns focus to the app once when an attempt is %s', async (phase) => {
  expect(await requests([
    { id: 'a', phase: 'waiting-browser', authorizeUrl: URL_A },
    { id: 'a', phase },
    { id: 'a', phase },
  ])).toEqual([{ action: 'open', url: URL_A, external: false }, { action: 'close', focus: true }])
})

it('reads browser access when each page opens', async () => {
  let external = true
  const seen: DesktopPlatformLoginRequest[] = []
  const urlB = 'https://platform.deepseek.com/dsh/authorize?state=b'
  await watchPlatformLogin(account([
    { id: 'a', phase: 'waiting-browser', authorizeUrl: URL_A },
    { id: 'a', phase: 'cancelled' },
    { id: 'b', phase: 'waiting-browser', authorizeUrl: urlB },
  ]), (request) => {
    seen.push(request)
    external = false
  }, () => external, new AbortController().signal)
  expect(seen.filter(request => request.action === 'open')).toEqual([
    { action: 'open', url: URL_A, external: true },
    { action: 'open', url: urlB, external: false },
  ])
})

it('never hands the shell a destination outside HTTPS or loopback HTTP', async () => {
  expect(await requests([
    { id: 'a', phase: 'waiting-browser', authorizeUrl: 'http://platform.deepseek.com/dsh/authorize' },
    { id: 'a', phase: 'failed' },
  ])).toEqual([{ action: 'close', focus: true }])
})

it('passes its lifetime to the account stream', async () => {
  const source = account([])
  const lifetime = new AbortController()
  await watchPlatformLogin(source, () => {}, () => false, lifetime.signal)
  expect(source.signals).toEqual([lifetime.signal])
})

it.each([
  [URL_A, true],
  ['http://127.0.0.1:8787/dsh/authorize', true],
  ['http://localhost:8787/dsh/authorize', true],
  ['http://[::1]:8787/dsh/authorize', true],
  ['http://platform.deepseek.com/dsh/authorize', false],
  ['https://user:pass@platform.deepseek.com/', false],
  ['file:///C:/Windows/System32/calc.exe', false],
  ['javascript:alert(1)', false],
  ['not a url', false],
  [undefined, false],
])('accepts %s as a sign-in destination: %s', (url, accepted) => {
  expect(isPlatformLoginDestination(url)).toBe(accepted)
})

it('keeps only the declared fields of a request crossing the process boundary', () => {
  expect(parseDesktopPlatformLoginRequest({ action: 'open', url: URL_A, external: true, extra: 'x' }))
    .toEqual({ action: 'open', url: URL_A, external: true })
  expect(parseDesktopPlatformLoginRequest({ action: 'close', focus: false, url: URL_A }))
    .toEqual({ action: 'close', focus: false })
  for (const value of [
    null,
    'open',
    { action: 'open', url: URL_A },
    { action: 'open', url: 'file:///etc/passwd', external: false },
    { action: 'close' },
    { action: 'navigate', url: URL_A, external: false },
  ]) {
    expect(() => parseDesktopPlatformLoginRequest(value)).toThrow('invalid platform sign-in request')
  }
})

it('carries sign-in requests from the Host to the native runtime and refuses forged ones', async () => {
  const { port1, port2 } = new MessageChannel()
  const [parent, child] = [port1, port2].map(port => new HostRpc({
    send: value => port.postMessage(value),
    listen: receive => { port.on('message', receive); return () => { port.off('message', receive) } },
  })) as [HostRpc, HostRpc]
  const platformLogin = vi.fn()
  const native = {
    platform: 'win32', locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.7-beta.1', statePath: '/tmp/update' },
    platformLogin,
  } as unknown as DesktopRuntime
  const release = bindNativeRuntime(parent, native)
  try {
    createHostRuntime(child, runtimeSnapshot(native)).platformLogin({ action: 'open', url: URL_A, external: false })
    await vi.waitFor(() => { expect(platformLogin).toHaveBeenCalledWith({ action: 'open', url: URL_A, external: false }) })
    await expect(child.call('native:platformLogin', [{ action: 'open', url: 'file:///etc/passwd', external: false }]))
      .rejects.toThrow('invalid platform sign-in request')
    expect(platformLogin).toHaveBeenCalledOnce()
  } finally {
    await release()
    port1.close()
  }
})
