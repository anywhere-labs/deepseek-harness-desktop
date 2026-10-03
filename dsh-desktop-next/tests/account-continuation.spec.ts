import { afterEach, expect, it, vi } from 'vitest'
import { registerDesktopOnboarding } from '../../dsh-plugin-desktop-beta/src/client/onboarding.tsx'

const hooks = vi.hoisted(() => ({ values: [] as unknown[], setters: [] as ReturnType<typeof vi.fn>[], effects: [] as (() => unknown)[] }))
// Vitest aliases these shared peers to Next's installed copies.
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: () => {
    const setter = vi.fn()
    hooks.setters.push(setter)
    return [hooks.values.shift(), setter]
  },
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect) },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'button', Toast: 'official-toast' }))
afterEach(() => { vi.unstubAllGlobals() })

function fixture(signedIn: boolean, required = false, failDismiss = false, overrides = {}) {
  const snapshot = { profile: 'work', required, accountPending: !required, edition: 'desktop', restartPending: false, input: { platform: 'darwin' }, ...overrides }
  hooks.values = [snapshot, '', 0, false]; hooks.setters = []; hooks.effects = []
  const bridge = {
    read: vi.fn(async (): Promise<typeof snapshot | null> => snapshot), finish: vi.fn(async () => {}),
    dismissAccount: vi.fn(async () => { if (failDismiss) throw new Error('save failed') }),
    applyPending: vi.fn(async () => {}),
  }
  vi.stubGlobal('window', { dshDesktopSetup: bridge })
  let Component: (props: any) => any = () => null
  const ctx = { slots: {
    inject: (_name: string, callback: () => void) => callback(),
    register: (_options: unknown, component: typeof Component) => { Component = component },
  } }
  const content = vi.fn((..._args: any[]) => 'Original wizard')
  registerDesktopOnboarding(ctx as any, content)
  const openLogin = vi.fn(), renderNext = vi.fn(), renderLoading = vi.fn(() => 'Loading')
  const props = { bridge, content, zh: true, accountStatus: signedIn ? 'credential-stored' : 'signed-out',
    openLogin, renderNext, renderLoading, renderNavigation: vi.fn(), renderSurface: (value: unknown) => value }
  const result = Component(props)
  const renderWithSnapshot = (value: unknown) => {
    hooks.values = [value, '', 0, false]
    return Component(props)
  }
  return { bridge, content, openLogin, result, snapshot, renderNext, renderWithSnapshot }
}

it('hands a Profile with no Desktop setup pending to the official decision', async () => {
  const view = fixture(false)
  view.bridge.read.mockResolvedValue(null)
  hooks.effects[0]!()
  await vi.waitFor(() => expect(hooks.setters[0]).toHaveBeenCalledWith(null))
  expect(view.renderWithSnapshot(null)).toBeUndefined()
  expect(view.renderNext).toHaveBeenCalledOnce()
})

it('hands an explicitly skipped Desktop setup to the official decision', async () => {
  const view = fixture(false, true)
  view.bridge.read.mockResolvedValue({ ...view.snapshot, required: false, accountPending: false })
  await view.content.mock.calls[0]![2]('work')
  expect(view.bridge.finish).toHaveBeenCalledWith('work', undefined)
  expect(hooks.setters[0]).toHaveBeenCalledWith(null)
  view.renderWithSnapshot(null)
  expect(view.renderNext).toHaveBeenCalledOnce()
})

it('hands an already signed-in Profile to the official flow without showing login', async () => {
  const view = fixture(true)
  expect(view.result).toBe('Loading')
  hooks.effects[1]!()
  await vi.waitFor(() => expect(hooks.setters[0]).toHaveBeenCalledWith(null))
  expect(view.bridge.dismissAccount).toHaveBeenCalledExactlyOnceWith('work')
  expect(view.openLogin).not.toHaveBeenCalled()
})

it('retains the continuation if acknowledging an already signed-in Profile fails', async () => {
  const view = fixture(true, false, true)
  hooks.effects[1]!()
  await vi.waitFor(() => expect(hooks.setters[1]).toHaveBeenCalledWith('Error: save failed'))
  expect(hooks.setters[0]).not.toHaveBeenCalledWith(null)
  expect(view.openLogin).not.toHaveBeenCalled()
})

it('does not acknowledge an unsigned account or interrupt the original Desktop wizard', () => {
  const view = fixture(false, true)
  hooks.effects[1]!()
  expect(view.content).toHaveBeenCalledOnce()
  expect(view.bridge.dismissAccount).not.toHaveBeenCalled()
  expect(view.openLogin).not.toHaveBeenCalled()
})

it('continues Desktop setup in the same renderer without applying or restarting', async () => {
  const view = fixture(false, true)
  const next = { ...view.snapshot, required: false, accountPending: true, restartPending: true }
  view.bridge.read.mockResolvedValue(next)
  await view.content.mock.calls[0]![2]('work', { market: 'disabled' })
  expect(view.bridge.finish).toHaveBeenCalledWith('work', { market: 'disabled' })
  expect(hooks.setters[0]).toHaveBeenCalledWith(next)
  expect(view.bridge.applyPending).not.toHaveBeenCalled()
})

it('retries reading after a successful save without submitting the wizard again', async () => {
  const view = fixture(false, true)
  view.bridge.read.mockRejectedValue(new Error('read failed'))
  await expect(view.content.mock.calls[0]![2]('work', {})).resolves.toBeUndefined()
  expect(hooks.setters[1]).toHaveBeenCalledWith('Error: read failed')
  expect(view.bridge.finish).toHaveBeenCalledOnce()
})

it('keeps Next waiting for its existing Host restart', async () => {
  const view = fixture(false, true, false, { edition: 'next' })
  await view.content.mock.calls[0]![2]('work', {})
  expect(hooks.setters[0]).toHaveBeenCalledWith(undefined)
  expect(view.bridge.read).not.toHaveBeenCalled()
})

it('retains pending application while an already signed-in user continues the official flow', async () => {
  const view = fixture(true, false, false, { restartPending: true })
  const next = { ...view.snapshot, accountPending: false }
  view.bridge.read.mockResolvedValue(next)
  hooks.effects[1]!()
  await vi.waitFor(() => expect(hooks.setters[0]).toHaveBeenCalledWith(next))
  expect(view.bridge.applyPending).not.toHaveBeenCalled()
})

it('applies saved settings only when the user explicitly requests the final restart', async () => {
  const view = fixture(false, false, false, { accountPending: false, restartPending: true })
  expect(view.renderNext).toHaveBeenCalledOnce()
  expect(view.bridge.applyPending).not.toHaveBeenCalled()
  expect(view.result.props.children[1].type).toBe('official-toast')
  view.result.props.children[1].props.actions[0].onClick()
  await vi.waitFor(() => expect(view.bridge.applyPending).toHaveBeenCalledExactlyOnceWith('work'))
})

it('dismisses the official toast without restarting or discarding saved settings', () => {
  const view = fixture(false, false, false, { accountPending: false, restartPending: true })
  view.result.props.children[1].props.onDone()
  expect(hooks.setters[0]).toHaveBeenCalledWith(null)
  expect(view.bridge.applyPending).not.toHaveBeenCalled()
  expect(view.bridge.finish).not.toHaveBeenCalled()
})
