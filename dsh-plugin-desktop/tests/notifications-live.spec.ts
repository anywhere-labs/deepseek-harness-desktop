import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import * as Notifications from '../src/notifications.ts'

it('applies notification edits through the real Settings and Loader without remounting', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-notifications-')))
  const dir = join(home, 'profiles', 'test')
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['notification-test-bundle'])
  const bundle = join(dir, 'node_modules', 'notification-test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'notification-test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'desktop-notifications', name: 'cordis:notifications' },
  ] }]))
  writeFileSync(join(home, 'package.json'), '{"name":"notification-test"}\n')
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['notification-test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const notifyAttention = vi.fn()
  let jobListener: ((event: unknown) => void) | undefined
  const ctx = await boot('notifications-test', join(dir, 'cordis.yml'), readProfilePatches('notifications-test', profile), ctx => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    ctx.provide('desktopRuntime', { locale: 'en', notifyAttention } as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('jobs', { events: { subscribe: (_filter: unknown, listener: typeof jobListener) => {
      jobListener = listener
      return () => { jobListener = undefined }
    } } } as never)
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, notifications: Notifications })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'desktop-notifications')!
  const fiber = entry.fiber
  const session = { header: { id: 'direct' } } as Session
  const event = async (type: string, data: object): Promise<void> => {
    await ctx.parallel('session/event', session, { type, data } as SessionEvent)
  }
  const start = async (turn: number): Promise<void> => {
    await event('turn/start', { turn })
    await event('user/message', { source: { kind: 'user' } })
  }
  const end = async (turn: number, kind = 'completed'): Promise<void> => {
    await event('turn/end', { turn, reason: { kind } })
  }
  const job = (status: string): void => { jobListener?.({ type: 'settled', job: { status } }) }

  await start(1)
  await end(1)
  job('completed')
  expect(notifyAttention).toHaveBeenCalledTimes(2)
  notifyAttention.mockClear()

  await start(2)
  await ctx.settings.update('desktop-notifications', { enabled: false })
  expect(ctx.settings.describe().find(row => row.ns === 'desktop-notifications')?.value).toMatchObject({ enabled: false })
  await end(2)
  job('completed')
  job('failed')
  expect(notifyAttention).not.toHaveBeenCalled()

  await ctx.settings.update('desktop-notifications', { enabled: true, notifyOnTurnCompletion: false, notifyOnJobCompletion: false })
  await start(3)
  await end(3)
  job('completed')
  expect(notifyAttention).not.toHaveBeenCalled()
  await start(4)
  await end(4, 'error')
  job('failed')
  expect(notifyAttention.mock.calls.map(([notification]) => notification.title)).toEqual(['User Turn Failed', 'Background Job Failed'])
  notifyAttention.mockClear()

  await ctx.settings.update('desktop-notifications', { notifyOnTurnFailure: false, notifyOnJobFailure: false })
  await start(5)
  await end(5, 'error')
  job('failed')
  expect(notifyAttention).not.toHaveBeenCalled()
  await ctx.settings.update('desktop-notifications', { notifyOnTurnCompletion: true, notifyOnJobCompletion: true })
  await start(6)
  await end(6)
  job('completed')
  expect(notifyAttention).toHaveBeenCalledTimes(2)
  notifyAttention.mockClear()

  await event('turn/start', { turn: 7 })
  await event('user/message', { source: { kind: 'schedule' } })
  await end(7)
  expect(notifyAttention.mock.calls.map(([notification]) => notification.title)).toEqual(['Automation Task Completed'])
  notifyAttention.mockClear()
  await ctx.settings.update('desktop-notifications', { notifyOnScheduleCompletion: false })
  await event('turn/start', { turn: 8 })
  await event('user/message', { source: { kind: 'schedule' } })
  await end(8)
  expect(notifyAttention).not.toHaveBeenCalled()
  await event('turn/start', { turn: 9 })
  await event('user/message', { source: { kind: 'schedule' } })
  await end(9, 'error')
  expect(notifyAttention.mock.calls.map(([notification]) => notification.title)).toEqual(['Automation Task Failed'])
  expect(entry.fiber).toBe(fiber)
})
