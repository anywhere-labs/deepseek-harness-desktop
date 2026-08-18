import { describe, expect, it, vi } from 'vitest'
import type {
  DesktopStartupRecoverySnapshot,
} from '../src/startup-recovery-controller.ts'
import {
  parseDesktopStartupRecoveryAction,
  renderDesktopStartupRecoveryHtml,
  type DesktopStartupRecoveryViewModel,
} from '../src/startup-recovery-window.ts'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  shell: {},
}))

function viewModel(
  overrides: Partial<DesktopStartupRecoveryViewModel> = {},
): DesktopStartupRecoveryViewModel {
  return {
    locale: 'zh',
    failureStage: 'profile-composition',
    failureDetail: 'duplicate loader entry id "storage"',
    diagnostics: { status: 'saving' },
    busy: false,
    restartReady: false,
    ...overrides,
  }
}

describe('Desktop startup recovery document', () => {
  it('is a no-script local document with a deny-by-default CSP and a localized stage', () => {
    const html = renderDesktopStartupRecoveryHtml(viewModel())

    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('失败阶段')
    expect(html).toContain('插件配置组合')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain("object-src 'none'")
    expect(html).toContain("base-uri 'none'")
    expect(html).toContain("form-action 'none'")
    expect(html).toContain("frame-ancestors 'none'")
    expect(html).not.toMatch(/<script\b/iu)
    expect(html).not.toMatch(/\son[a-z]+\s*=/iu)
  })

  it('escapes failure, profile, bundle, diagnostics, and notice values', () => {
    const snapshot: DesktopStartupRecoverySnapshot = {
      profileName: 'desktop<img src=x onerror="profile-secret">',
      bundles: [{
        bundleId: 'bundle_00000000000000000000000000000000',
        packageName: 'plugin</code><script>bundle-secret</script>',
        status: 'active',
        owner: 'external',
        action: 'disable',
      }],
    }
    const html = renderDesktopStartupRecoveryHtml(viewModel({
      failureDetail: '<script>alert("failure<&\'")</script>',
      snapshot,
      snapshotError: '<img src=x onerror="snapshot-secret">',
      diagnostics: { status: 'saved', filename: '<private&".zip' },
      notice: {
        tone: 'success',
        title: '<b>rollback-secret</b>',
        body: 'restored & <complete>',
      },
    }))

    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b>rollback-secret</b>')
    expect(html).toContain('&lt;script&gt;alert(&quot;failure&lt;&amp;&#39;&quot;)&lt;/script&gt;')
    expect(html).toContain('desktop&lt;img src=x onerror=&quot;profile-secret&quot;&gt;')
    expect(html).toContain('plugin&lt;/code&gt;&lt;script&gt;bundle-secret&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=&quot;snapshot-secret&quot;&gt;')
    expect(html).toContain('&lt;private&amp;&quot;.zip')
    expect(html).toContain('&lt;b&gt;rollback-secret&lt;/b&gt;')
    expect(html).toContain('restored &amp; &lt;complete&gt;')
  })

  it('does not expose plugin or install mutation links without a controller snapshot', () => {
    const html = renderDesktopStartupRecoveryHtml(viewModel({
      failureStage: 'shell-environment',
      failureDetail: 'login shell failed',
      diagnostics: { status: 'failed' },
    }))

    expect(html).toContain('Shell 环境恢复')
    expect(html).toContain('dsh-recovery://export-diagnostics')
    expect(html).toContain('dsh-recovery://restart')
    expect(html).toContain('dsh-recovery://quit')
    expect(html).not.toContain('dsh-recovery://preview-disable')
    expect(html).not.toContain('dsh-recovery://preview-rollback')
    expect(html).not.toContain('dsh-recovery://preview-retry')
    expect(html).not.toContain('dsh-recovery://confirm-')
  })

  it('offers both rollback and one retry for a recovery-pending install', () => {
    const snapshot: DesktopStartupRecoverySnapshot = {
      profileName: 'desktop',
      bundles: [],
      pendingInstall: {
        recoveryId: 'recovery-transaction-0001',
        packageName: 'example-plugin',
        packageVersion: '1.2.3',
        phase: 'recovery-pending',
        rollbackAvailable: true,
        retryAvailable: true,
      },
    }
    const html = renderDesktopStartupRecoveryHtml(viewModel({ snapshot }))

    expect(html).toContain('最近一次受保护安装')
    expect(html).toContain('example-plugin@1.2.3')
    expect(html).toContain('恢复安装前配置')
    expect(html).toContain('仅重试一次')
    expect(html).toContain('dsh-recovery://preview-rollback?id=recovery-transaction-0001')
    expect(html).toContain('dsh-recovery://preview-retry?id=recovery-transaction-0001')
  })

  it('renders the explicit result of a completed rollback', () => {
    const html = renderDesktopStartupRecoveryHtml(viewModel({
      diagnostics: { status: 'saved', filename: 'diagnostics.zip' },
      notice: {
        tone: 'success',
        title: 'example-plugin',
        body: '安装前配置已恢复。请重新启动 Desktop。',
      },
      restartReady: true,
    }))

    expect(html).toContain('notice success')
    expect(html).toContain('example-plugin')
    expect(html).toContain('安装前配置已恢复。请重新启动 Desktop。')
    expect(html).toContain('class="button primary" href="dsh-recovery://restart"')
  })
})

describe('Desktop startup recovery action parser', () => {
  it('accepts only known actions with the expected id shape', () => {
    for (const action of [
      'home',
      'export-diagnostics',
      'show-diagnostics',
      'restart',
      'quit',
    ]) {
      expect(parseDesktopStartupRecoveryAction(`dsh-recovery://${action}`)).toEqual({ action })
    }

    for (const action of [
      'preview-disable',
      'confirm-disable',
      'preview-rollback',
      'confirm-rollback',
      'preview-retry',
      'confirm-retry',
    ]) {
      expect(parseDesktopStartupRecoveryAction(
        `dsh-recovery://${action}?id=opaque-id_0001`,
      )).toEqual({ action, id: 'opaque-id_0001' })
    }
  })

  it.each([
    'not a url',
    'https://restart',
    'dsh-recovery://unknown',
    'dsh-recovery://home/',
    'dsh-recovery://user:password@home',
    'dsh-recovery://home:1234',
    'dsh-recovery://home#fragment',
    'dsh-recovery://home?id=unexpected',
    'dsh-recovery://home?extra=value',
    'dsh-recovery://preview-disable',
    'dsh-recovery://preview-disable?id=short',
    'dsh-recovery://preview-disable?id=opaque-id_0001&id=opaque-id_0002',
    'dsh-recovery://preview-disable?id=opaque-id_0001&extra=value',
    `dsh-recovery://preview-disable?id=${'x'.repeat(161)}`,
  ])('rejects invalid or over-privileged navigation: %s', href => {
    expect(parseDesktopStartupRecoveryAction(href)).toBeUndefined()
  })
})
