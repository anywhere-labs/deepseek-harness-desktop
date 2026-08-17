import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopRuntime, DesktopTrayItem } from '../src/runtime.ts'
import type { DesktopProfiles } from '../src/profile-service.ts'
import type { DesktopPnpm, DesktopPnpmHandle } from '../src/pnpm.ts'
import type { DesktopProfileSummary } from '../src/profile-manager.ts'
import { WEB_PROFILE_NAME } from '../src/profile-plugin-import.ts'
import { apply, inject, name } from '../src/plugin-import.ts'

function summary(
  name: string,
  bundles: readonly string[],
  overrides: Partial<DesktopProfileSummary> = {},
): DesktopProfileSummary {
  return {
    name,
    dir: `/profiles/${name}`,
    exists: true,
    bundles,
    webCapable: true,
    ...overrides,
  }
}

function handle(exitCode: number | null): DesktopPnpmHandle {
  return {
    stdout: { resume: vi.fn() },
    stderr: { resume: vi.fn() },
    done: Promise.resolve({ exitCode, signal: null }),
    cancel: vi.fn(),
  } as unknown as DesktopPnpmHandle
}

interface Harness {
  trayItem?: DesktopTrayItem
  events: string[]
  runPlugin: ReturnType<typeof vi.fn>
  confirm: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  requestRestart: ReturnType<typeof vi.fn>
  disposeRegistration: ReturnType<typeof vi.fn>
  disposeEffect?: () => void
}

function makeContext(
  profiles: DesktopProfiles,
  handleFor: (args: readonly string[]) => DesktopPnpmHandle = () => handle(0),
): { ctx: Context; harness: Harness } {
  const harness: Harness = {
    events: [],
    runPlugin: vi.fn((args: readonly string[]) => handleFor(args)),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
    requestRestart: vi.fn(async () => { harness.events.push('restart') }),
    disposeRegistration: vi.fn(),
  }
  const runtime = {
    registerTrayItem: (item: DesktopTrayItem) => {
      harness.trayItem = item
      return { refresh: () => {}, dispose: harness.disposeRegistration }
    },
    confirm: harness.confirm,
    updates: { notify: harness.notify },
    requestRestart: harness.requestRestart,
  } as unknown as DesktopRuntime
  const ctx = {
    desktopRuntime: runtime,
    desktopProfiles: profiles,
    desktopPnpm: { runPlugin: harness.runPlugin } as unknown as DesktopPnpm,
    logger: { warn: vi.fn(), error: vi.fn() },
    effect: (register: () => (() => void)) => {
      harness.disposeEffect = register()
      return harness.disposeEffect
    },
  } as unknown as Context
  return { ctx, harness }
}

const webProfiles = (bundles: readonly string[]): DesktopProfiles => ({
  current: { name: 'desktop', dir: '/profiles/desktop' },
  list: () => [
    summary('desktop', ['@deepseek-ai/dsh-base']),
    summary(WEB_PROFILE_NAME, ['@deepseek-ai/dsh-base', ...bundles]),
  ],
  select: async () => {},
})

describe('desktop plugin import Host plugin', () => {
  it('registers a profiles tray command that offers web bundles not yet present', () => {
    const { ctx, harness } = makeContext(webProfiles(['community-a', 'community-b']))
    apply(ctx)

    expect(name).toBe('desktop-plugin-import')
    expect(inject).toEqual(['desktopRuntime', 'desktopProfiles', 'desktopPnpm'])
    expect(harness.trayItem).toMatchObject({ group: 'profiles', order: 20 })
    expect(harness.trayItem?.label()).toBe('Import Web Profile Plugins…')
    expect(harness.trayItem?.enabled?.()).toBe(true)
  })

  it('disables the command when the web profile has nothing importable', () => {
    const profiles: DesktopProfiles = {
      current: { name: 'desktop', dir: '/profiles/desktop' },
      list: () => [
        summary('desktop', ['@deepseek-ai/dsh-base', 'community-a']),
        summary(WEB_PROFILE_NAME, ['@deepseek-ai/dsh-base', 'community-a']),
      ],
      select: async () => {},
    }
    const { ctx, harness } = makeContext(profiles)
    apply(ctx)
    expect(harness.trayItem?.enabled?.()).toBe(false)
  })

  it('disables the command when the web profile is absent', () => {
    const profiles: DesktopProfiles = {
      current: { name: 'desktop', dir: '/profiles/desktop' },
      list: () => [summary('desktop', ['@deepseek-ai/dsh-base'])],
      select: async () => {},
    }
    const { ctx, harness } = makeContext(profiles)
    apply(ctx)
    expect(harness.trayItem?.enabled?.()).toBe(false)
  })

  it('confirms, imports each bundle in order, notifies, and restarts on full success', async () => {
    const { ctx, harness } = makeContext(webProfiles(['community-a', 'community-b']))
    apply(ctx)

    await harness.trayItem?.invoke()

    expect(harness.confirm).toHaveBeenCalledOnce()
    expect(harness.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'Import Community Plugins',
      confirmLabel: 'Import',
    })
    expect(harness.runPlugin.mock.calls.map(call => call[0])).toEqual([
      ['add', 'community-a'],
      ['add', 'community-b'],
    ])
    expect(harness.runPlugin.mock.calls.map(call => call[1])).toEqual(['/profiles/desktop', '/profiles/desktop'])
    expect(harness.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Plugins Imported' }))
    expect(harness.events).toEqual(['restart'])
  })

  it('does nothing when the user declines the confirmation', async () => {
    const { ctx, harness } = makeContext(webProfiles(['community-a']))
    harness.confirm.mockResolvedValue(false)
    apply(ctx)

    await harness.trayItem?.invoke()

    expect(harness.confirm).toHaveBeenCalledOnce()
    expect(harness.runPlugin).not.toHaveBeenCalled()
    expect(harness.notify).not.toHaveBeenCalled()
    expect(harness.events).toEqual([])
  })

  it('does nothing when the command is invoked without an importable plan', async () => {
    const profiles: DesktopProfiles = {
      current: { name: 'desktop', dir: '/profiles/desktop' },
      list: () => [summary('desktop', [])],
      select: async () => {},
    }
    const { ctx, harness } = makeContext(profiles)
    apply(ctx)

    await harness.trayItem?.invoke()

    expect(harness.confirm).not.toHaveBeenCalled()
    expect(harness.runPlugin).not.toHaveBeenCalled()
  })

  it('reports partial failure without restarting', async () => {
    const { ctx, harness } = makeContext(
      webProfiles(['community-a', 'community-b']),
      args => handle(args[1] === 'community-b' ? 1 : 0),
    )
    apply(ctx)

    await harness.trayItem?.invoke()

    expect(harness.runPlugin).toHaveBeenCalledTimes(2)
    expect(harness.notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Plugin Import Incomplete',
      body: expect.stringContaining('community-b'),
    }))
    expect(harness.events).toEqual([])
  })

  it('treats a throwing install as a failure without restarting', async () => {
    const { ctx, harness } = makeContext(webProfiles(['community-a']), () => {
      throw new Error('another operation is running')
    })
    apply(ctx)

    await harness.trayItem?.invoke()

    expect(harness.notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Plugin Import Incomplete',
      body: expect.stringContaining('community-a'),
    }))
    expect(harness.events).toEqual([])
  })

  it('disposes the tray registration with the owning effect', () => {
    const { ctx, harness } = makeContext(webProfiles([]))
    apply(ctx)
    expect(harness.disposeRegistration).not.toHaveBeenCalled()

    harness.disposeEffect?.()
    expect(harness.disposeRegistration).toHaveBeenCalledOnce()
  })
})
