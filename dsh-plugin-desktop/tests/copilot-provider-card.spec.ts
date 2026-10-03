// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopCopilotAuthorizationView } from '../src/copilot-authorization-contract.ts'
import { CopilotProviderCard } from '../src/client/CopilotProviderCard.tsx'
import { zh } from '../src/client/desktop-settings-locales.ts'

let root: Root | undefined
let container: HTMLDivElement | undefined

const provider = {
  provider: 'github-copilot',
  displayName: 'GitHub Copilot',
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'github-copilot'],
  active: false,
}

function mockFetch(initial: DesktopCopilotAuthorizationView) {
  let view = initial
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.endsWith('/models')) return new Response(JSON.stringify({ configured: true, models: [
      { id: 'gpt-5-mini', category: 'lightweight' },
      { id: 'gpt-5', category: 'versatile' },
      { id: 'gpt-5.1-codex-max', category: 'powerful', highCost: true },
      { id: 'unclassified-model' },
    ] }), { status: 200 })
    if (path.endsWith('/begin')) {
      view = {
        ...view,
        phase: 'authorizing',
        canCancel: true,
        notice: { message: 'Enter the code on GitHub.', url: 'https://github.com/login/device', code: 'ABCD-EFGH' },
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 202 })
    }
    if (path.endsWith('/cancel')) {
      view = { ...view, phase: 'cancelled' }
      return new Response(JSON.stringify({ accepted: true }), { status: 202 })
    }
    if (path.endsWith('/answer')) return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    return new Response(JSON.stringify(view), { status: 200 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function mount(providerRow = provider): Promise<HTMLDivElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const props = {
    provider: providerRow,
    configured: false,
    keyConfigured: false,
    t: (key: keyof typeof zh) => zh[key],
  }
  await act(async () => { root!.render(createElement(CopilotProviderCard, props as never)) })
  return container
}

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  vi.unstubAllGlobals()
})

describe('GitHub Copilot provider card', () => {
  it('offers GitHub sign-in and displays the device verification code', async () => {
    const fetch = mockFetch({
      available: true,
      configured: false,
      phase: 'idle',
      canCancel: false,
      methods: [{ id: 'oauth', label: 'Sign in with GitHub' }],
    })
    const node = await mount()
    await act(async () => { await Promise.resolve() })
    const start = node.querySelector<HTMLButtonElement>('button')!
    expect(start.textContent).toBe(zh.copilotSignIn)
    expect(start.disabled).toBe(false)

    await act(async () => { start.click(); await Promise.resolve(); await Promise.resolve() })
    expect(fetch).toHaveBeenCalledWith('/api/desktop/copilot-authorization/begin', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }))
    expect(node.textContent).toContain('ABCD-EFGH')
    const link = node.querySelector<HTMLAnchorElement>('a')!
    expect(link.href).toBe('https://github.com/login/device')
    expect(link.rel).toContain('noopener')
    expect(node.textContent).toContain(zh.copilotCancel)
  })

  it('displays GitHub-supplied categories and high-cost markers for signed-in models', async () => {
    const fetch = mockFetch({
      available: true, configured: true, phase: 'idle', canCancel: false, methods: [],
    })
    const node = await mount()
    expect(fetch).toHaveBeenCalledWith('/api/desktop/copilot-authorization/models', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', redirect: 'error',
    }))
    const rows = [...node.querySelectorAll('.dshDesktopCopilotModels li')].map(row => row.textContent)
    expect(rows).toEqual([
      'gpt-5-miniLightweight', 'gpt-5Versatile', `gpt-5.1-codex-maxPowerful${zh.copilotHighCost}`,
      `unclassified-model${zh.copilotCategoryUnavailable}`,
    ])
  })

  it('never requests model categories before sign-in', async () => {
    const fetch = mockFetch({ available: true, configured: false, phase: 'idle', canCancel: false, methods: [] })
    const node = await mount()
    expect(fetch.mock.calls.some(([path]) => String(path).endsWith('/models'))).toBe(false)
    expect(node.querySelector('.dshDesktopCopilotModels')).toBeNull()
  })

  it('offers retry when GitHub model categories are unavailable', async () => {
    mockFetch({ available: true, configured: true, phase: 'idle', canCancel: false, methods: [] })
    const original = globalThis.fetch
    let fails = true
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/models') && fails) return new Response('{}', { status: 503 })
      return original(input, init)
    })
    vi.stubGlobal('fetch', fetch)
    const node = await mount()
    expect(node.textContent).toContain(zh.copilotModelsUnavailable)
    fails = false
    await act(async () => { node.querySelector<HTMLButtonElement>('.dshDesktopCopilotModels button')!.click() })
    expect(node.textContent).toContain('gpt-5-miniLightweight')
  })

  it('does not render the sign-in extension for another pi-ai provider', async () => {
    mockFetch({ available: true, configured: false, phase: 'idle', canCancel: false, methods: [] })
    const node = await mount({ ...provider, provider: 'openai' })
    expect(node.querySelector('.dshDesktopCopilotCard')).toBeNull()
  })
})
