import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

/** Run the installed official view; only React scheduling and external services are replaced. */
function fixture(nativeBridge = true, lastVisible: unknown = null, apiKeyBridge?: object) {
  const source = readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-ui-settings-account/client'), 'utf8')
    .replace('return module.exports;', 'module.exports.testEntry = DesktopOnboardingEntry; module.exports.readKeys = readOnboardingApiKeyPresence; return module.exports;')
  let entry: (props: any) => any
  let readKeys: (ctx: any) => Promise<boolean>
  const jsx = (type: any, props: any) => ({ type, props })
  const require = (id: string) => {
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
    if (id === 'react') return { useState: () => [lastVisible, vi.fn()], useEffect() {}, useLayoutEffect() {}, useRef: () => ({ current: null }) }
    if (id === 'react-dom') return { createPortal: (value: any) => value }
    if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: (value: any) => ({ getSnapshot: () => value }) }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Button: 'button' }
    throw new Error(`Unexpected dependency ${id}`)
  }
  runInNewContext(source, {
    ...(nativeBridge ? { dshDesktopSetup: {} } : {}), dshOnboarding: apiKeyBridge,
    window: { matchMedia: () => ({ matches: false }), __ModuleLoader__: { load: (module: any) => { const exported = module.factory(require); entry = exported.testEntry; readKeys = exported.readKeys } } }, URL, console,
  })
  const renderSlot = vi.fn((_name, props, options) => ({ ...props, fallback: options.fallback }))
  const useOnboarding = vi.fn(), useAccount = vi.fn(), openDesktopLogin = vi.fn()
  return { openDesktopLogin, readKeys: (ctx: any) => readKeys(ctx), renderSlot, useOnboarding, render: (step = 'welcome', status = 'ready', account = 'signed-out', visible = false) => {
    useOnboarding.mockImplementation((select: any) => select({ visible, status, progress: { step }, error: null }))
    useAccount.mockImplementation((select: any) => select({ view: { status: account } }))
    return entry!({ useOnboarding, useAccount, t: () => 'en', renderSlot, openDesktopLogin })
  } }
}

it.each([
  ['welcome', 'loading', 'signed-out', false],
  ['welcome', 'ready', 'signed-out', false],
  ['welcome', 'ready', 'credential-stored', true],
  ['process', 'error', 'credential-stored', true],
  ['done', 'ready', 'signed-out', false],
  ['done', 'ready', 'credential-stored', false],
])('always checks Desktop first, independently of official state %s/%s/%s', (step, status, account, visible) => {
  const view = fixture()
  const result = view.render(String(step), String(status), String(account), Boolean(visible))
  expect(view.renderSlot).toHaveBeenCalledWith('onboarding.desktop.before', expect.anything(), expect.anything())
  expect(view.useOnboarding).not.toHaveBeenCalled()
  expect(result.fallback.type.name).toBe('OnboardingSurface')
  const page = result.renderSurface('Existing Desktop wizard')
  expect(page.type(page.props).type.name).toBe('OnboardingSurface')
})

it.each([
  ['welcome', 'ready', 'signed-out', false, false],
  ['done', 'ready', 'signed-out', false, false],
  ['done', 'ready', 'credential-stored', false, false],
  ['welcome', 'ready', 'credential-stored', true, true],
  ['process', 'ready', 'credential-stored', true, true],
  ['welcome', 'loading', 'signed-out', false, true],
])('leaves the official trigger unchanged after Desktop releases the page: %s/%s/%s', (step, status, account, visible, expectedSurface) => {
  const view = fixture()
  const result = view.render(String(step), String(status), String(account), Boolean(visible))
  const official = result.renderNext()
  const page = official.type(official.props)
  expect(view.useOnboarding).toHaveBeenCalledOnce()
  if (expectedSurface) expect(page.type.name).toBe(status === 'loading' ? 'OnboardingSurface' : 'DesktopOnboarding')
  else expect(page).toBeNull()
})

it('keeps the original official fallback when the Desktop bridge is absent', () => {
  const view = fixture(false)
  const result = view.render()
  expect(result.fallback.type.name).toBe('OfficialDesktopOnboardingEntry')
})

it.each(['signed-out', 'credential-stored'])('exposes the official login action and reactive account state: %s', status => {
  const view = fixture()
  const result = view.render('welcome', 'ready', status)
  expect(result.accountStatus).toBe(status)
  result.openLogin()
  expect(view.openDesktopLogin).toHaveBeenCalledOnce()
})

it('renders the official navigation with Desktop callbacks and disabled state', () => {
  const onBack = vi.fn(), onSkip = vi.fn()
  const renderNavigation = fixture().render().renderNavigation
  const navigation = renderNavigation({ busy: true, onBack, onSkip })
  expect(navigation.type.name).toBe('DesktopOnboardingNavigation')
  const footer = navigation.type(navigation.props)
  expect(footer.type).toBe('footer')
  expect(footer.props.className).toMatch(/_navigation$/)
  expect(footer.props.children.map((child: any) => child.props.disabled)).toEqual([true, true])
  expect(footer.props.children[0].props.onClick).toBe(onBack)
  expect(footer.props.children[1].props.onClick).toBe(onSkip)
  const first = renderNavigation({ busy: false, onSkip })
  expect(first.type(first.props).props.children[0].type).toBe('span')
})

it('retains the official exit animation after its own completion', () => {
  const view = fixture(true, { visible: true, progress: { step: 'process' } })
  const official = view.render('done', 'ready', 'credential-stored').renderNext()
  const page = official.type(official.props)
  expect(page.type.name).toBe('DesktopOnboarding')
  expect(page.props.exiting).toBe(true)
})


it.each([true, false])('preserves the official native API-key decision when present: %s', async present => {
  const hasApiKey = vi.fn(async () => present)
  expect(await fixture(true, null, { hasApiKey }).readKeys({})).toBe(present)
  expect(hasApiKey).toHaveBeenCalledOnce()
})

it.each([true, false])('uses official provider and credential metadata when the shell has no native API-key method: %s', async configured => {
  const describe = vi.fn(async (refs: string[]) => ({ ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: ref === 'CUSTOM_KEY' && configured }])) }))
  const remote = {
    settings: { describe: async () => ({ ok: true, value: { namespaces: [
      { ns: 'llm-deepseek', value: { apiKeyEnv: 'OFFICIAL_KEY' } },
      { ns: 'custom', value: { providers: { example: { apiKeyEnv: 'CUSTOM_KEY' } } } },
    ] } }) },
    llm: { listConfigurableProviders: async () => ({ ok: true, value: [
      { settingsNs: 'llm-deepseek', settingsPath: [] },
      { settingsNs: 'custom', settingsPath: ['providers', 'example'] },
    ] }) }, credentials: { describe },
  }
  expect(await fixture().readKeys({ remote })).toBe(configured)
  expect(describe).toHaveBeenCalledExactlyOnceWith(['OFFICIAL_KEY', 'CUSTOM_KEY'])
})

it('does not report an API-key decision when credential discovery fails', async () => {
  await expect(fixture().readKeys({ remote: { settings: { describe: async () => ({ ok: false }) },
    llm: { listConfigurableProviders: async () => ({ ok: true, value: [] }) } } })).rejects.toThrow('directory unavailable')
})
