import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const component = () => null
  return {
    Button: component,
    Input: component,
    Modal: component,
    Pill: component,
    StateDot: component,
    Tooltip: component,
    IconCheckOutline16: component,
    IconChevronDownOutline14: component,
    IconChevronUpOutline14: component,
    IconCloseOutline16: component,
    IconCordisPluginOutline14: component,
    IconDataOutline16: component,
    IconDownloadOutline16: component,
    IconPlayOutline16: component,
    IconGlobeOutline14: component,
    IconPlusOutline16: component,
    IconRefreshOutline16: component,
    IconRightUpOutline16: component,
    IconSearchOutline16: component,
    IconSettingsOutline16: component,
    IconTrashOutline16: component,
    IconWarningOutline16: component,
  }
})

import { apply, inject, NS } from '../src/client/index.js'

interface TestContext {
  readonly effects: Array<{ effect: () => unknown; label: string }>
  readonly injections: Array<{ name: string; factory: () => unknown }>
  readonly registrations: Array<{ spec: Record<string, unknown>; component: unknown }>
  readonly context: Parameters<typeof apply>[0]
}

function testContext(): TestContext {
  const effects: TestContext['effects'] = []
  const injections: TestContext['injections'] = []
  const registrations: TestContext['registrations'] = []
  const context = {
    effect: (effect: () => unknown, label: string) => { effects.push({ effect, label }) },
    locale: {
      register: vi.fn(),
      bind: vi.fn(() => vi.fn()),
      getLocale: vi.fn(() => ({ active: 'en' })),
    },
    slots: {
      inject: (name: string, factory: () => unknown) => { injections.push({ name, factory }) },
      register: (spec: Record<string, unknown>, component: unknown) => {
        registrations.push({ spec, component })
        return spec
      },
    },
  } as unknown as Parameters<typeof apply>[0]
  return { effects, injections, registrations, context }
}

describe('community market client registration', () => {
  it('publishes the expected Loader dependency contract', () => {
    expect(inject).toEqual(['slots', 'locale'])
    expect(NS).toBe('community-market')
  })

  it('registers locale, styles, settings tab, sidebar launcher, and shell overlay effects', () => {
    const test = testContext()

    apply(test.context)

    expect(test.effects.map(value => value.label)).toEqual([
      'community-market: dictionaries',
      'community-market: styles',
    ])
    expect(test.injections.map(value => value.name)).toEqual([
      'settings.plugins.tab',
      'sidebar.footer.action',
      'shell.overlay',
    ])
  })

  it('projects all slot registrations with the market identity, locale, and shared view store', () => {
    const test = testContext()

    apply(test.context)
    test.injections.forEach(value => { value.factory() })

    expect(test.registrations).toHaveLength(3)
    expect(test.registrations.map(value => value.spec)).toEqual([
      expect.objectContaining({
        name: 'settings.plugins.tab',
        id: 'community-market',
        order: 20,
        locale: NS,
      }),
      expect.objectContaining({
        name: 'sidebar.footer.action',
        id: 'community-market',
        order: 10,
        locale: NS,
      }),
      expect.objectContaining({
        name: 'shell.overlay',
        id: 'community-market',
        order: 10,
        locale: NS,
      }),
    ])
    const [settings, launcher, overlay] = test.registrations.map(value => value.spec)
    expect(typeof settings?.label).toBe('function')
    expect(typeof settings?.inject).toBe('function')
    expect(typeof launcher?.label).toBe('function')
    expect(launcher?.store).toBe(overlay?.store)
    expect(typeof overlay?.inject).toBe('function')
  })
})
