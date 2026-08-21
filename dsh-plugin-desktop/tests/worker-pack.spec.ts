import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import {
  DESKTOP_DEFAULT_AGENT_PRESET,
  desktopAgentPresetConfig,
  OFFICE_IM_RECOMMENDED_PLUGINS,
  WORKER_PACK_CATALOG_SOURCE_KEY,
  WORKER_PACK_RECOMMENDED_PLUGINS,
  workerPackCatalogSelected,
} from '../src/worker-pack.ts'

describe('desktop worker pack', () => {
  it('overrides the upstream standard preset default with code', () => {
    expect(DESKTOP_DEFAULT_AGENT_PRESET).toBe('code')
    expect(desktopAgentPresetConfig({ default: 'standard', includeUserRoot: true })).toEqual({
      default: 'code',
      includeUserRoot: true,
    })
  })

  it('recommends workspace plugins without pinning unaudited versions', () => {
    expect(WORKER_PACK_RECOMMENDED_PLUGINS.map(plugin => plugin.packageName)).toEqual([
      'dsh-better-sidebar',
      'dsh-context',
    ])
    expect(WORKER_PACK_CATALOG_SOURCE_KEY).toBe('dsh-1024store')
  })

  it('recommends only official DingTalk Stream and WeCom AI Bot channels', () => {
    expect(OFFICE_IM_RECOMMENDED_PLUGINS.map(plugin => plugin.packageName)).toEqual([
      'dsh-dingtalk-channel',
      'dsh-wecom',
    ])
    expect(OFFICE_IM_RECOMMENDED_PLUGINS.map(plugin => plugin.role)).toEqual([
      'office-dingtalk',
      'office-wecom',
    ])
    const names = OFFICE_IM_RECOMMENDED_PLUGINS.map(plugin => plugin.packageName)
    expect(names).not.toContain('dsh-dingtalk')
    expect(names).not.toContain('dsh-im')
    expect(names).not.toContain('dsh-message')
    expect(names).not.toContain('dsh-messge-channels')
    expect(names).not.toContain('dsh-collaboration-channels')
  })

  it('keeps worker-pack locale keys aligned', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(zh.officeImTitle).toContain('钉钉')
    expect(en.officeImTitle.toLowerCase()).toContain('office')
  })

  it('treats the catalog as selected only after an explicit enabled source', () => {
    expect(workerPackCatalogSelected([])).toBe(false)
    expect(workerPackCatalogSelected([
      { enabled: false, builtInProviderKey: WORKER_PACK_CATALOG_SOURCE_KEY },
    ])).toBe(false)
    expect(workerPackCatalogSelected([
      { enabled: true, builtInProviderKey: WORKER_PACK_CATALOG_SOURCE_KEY },
    ])).toBe(true)
  })
})
