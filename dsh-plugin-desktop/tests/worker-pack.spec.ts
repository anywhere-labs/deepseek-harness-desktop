import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import {
  DESKTOP_DEFAULT_AGENT_PRESET,
  desktopAgentPresetConfig,
  findCatalogItemForPackage,
  isWorkerPackRecommendedPackage,
  OFFICE_IM_RECOMMENDED_PLUGINS,
  recommendedPackageInstalled,
  recommendedPluginsFor,
  summarizeWorkerPackInstallResults,
  WORKER_PACK_CATALOG_SOURCE_KEY,
  WORKBENCH_LATER_RECOMMENDED_PLUGINS,
  WORKER_PACK_RECOMMENDED_PLUGINS,
  workerPackBlocksCommunityPackage,
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
    expect(WORKBENCH_LATER_RECOMMENDED_PLUGINS.map(plugin => plugin.packageName)).toEqual([
      'dsh-web-mobile',
    ])
  })

  it('starts office IM from official DingTalk Stream and WeCom without gating community installs', () => {
    expect(OFFICE_IM_RECOMMENDED_PLUGINS.map(plugin => plugin.packageName)).toEqual([
      'dsh-dingtalk-channel',
      'dsh-wecom',
    ])
    expect(OFFICE_IM_RECOMMENDED_PLUGINS.map(plugin => plugin.role)).toEqual([
      'office-dingtalk',
      'office-wecom',
    ])
    for (const packageName of [
      'dsh-im',
      'dsh-message',
      'dsh-messge-channels',
      'dsh-collaboration-channels',
      'dsh-lark',
      'dsh-better-sidebar',
    ]) {
      expect(workerPackBlocksCommunityPackage(packageName)).toBe(false)
    }
  })

  it('keeps worker-pack locale keys aligned', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(zh.officeImBody).toContain('不是白名单')
    expect(zh.officeImBody).toContain('社区插件')
    expect(zh.workerBody).toContain('不会开机自动装')
    expect(zh.installWorkspace).toContain('一键安装')
    expect(en.officeImBody).toContain('not an allowlist')
    expect(en.officeImBody).toContain('community')
    expect(en.workerBody).toContain('nothing installs at launch')
    expect(en.installWorkspace).toContain('Install recommended workspace')
  })

  it('groups one-click packs without making them a silent boot list', () => {
    expect(recommendedPluginsFor('workspace').map(plugin => plugin.packageName)).toEqual([
      'dsh-better-sidebar',
      'dsh-context',
    ])
    expect(recommendedPluginsFor('office-im').map(plugin => plugin.packageName)).toEqual([
      'dsh-dingtalk-channel',
      'dsh-wecom',
    ])
    expect(recommendedPluginsFor('later').map(plugin => plugin.packageName)).toEqual([
      'dsh-web-mobile',
    ])
    expect(isWorkerPackRecommendedPackage('dsh-better-sidebar')).toBe(true)
    expect(isWorkerPackRecommendedPackage('dsh-im')).toBe(false)
  })

  it('matches installed recommendations and exact catalog package names', () => {
    expect(recommendedPackageInstalled('dsh-context', [
      { receipt: { packageName: 'dsh-context' } },
    ])).toBe(true)
    expect(recommendedPackageInstalled('dsh-context', [
      { packageName: 'dsh-better-sidebar' },
    ])).toBe(false)
    expect(findCatalogItemForPackage([
      { id: 'other', package: { name: 'dsh-im' } },
      { id: 'sidebar', package: { name: 'dsh-better-sidebar' } },
    ], 'dsh-better-sidebar')?.id).toBe('sidebar')
    expect(findCatalogItemForPackage([
      { id: 'fuzzy', package: { name: 'dsh-better-sidebar-extra' } },
    ], 'dsh-better-sidebar')).toBeUndefined()
  })

  it('summarizes user-initiated install results', () => {
    expect(summarizeWorkerPackInstallResults([
      { packageName: 'dsh-context', status: 'installed' },
      { packageName: 'dsh-better-sidebar', status: 'already' },
    ])).toBe('installRestart')
    expect(summarizeWorkerPackInstallResults([
      { packageName: 'dsh-context', status: 'installed' },
      { packageName: 'dsh-better-sidebar', status: 'missing' },
    ])).toBe('installPartial')
    expect(summarizeWorkerPackInstallResults([
      { packageName: 'dsh-context', status: 'missing' },
    ])).toBe('installMissing')
    expect(summarizeWorkerPackInstallResults([
      { packageName: 'dsh-context', status: 'failed', error: 'network' },
    ])).toBe('installError')
    expect(summarizeWorkerPackInstallResults([])).toBe('installError')
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
